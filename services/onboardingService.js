// ============================================
// services/onboardingService.js
// Data-driven onboarding engine.
//
// Steps are DATA, not code: to add a setup step in Q3/Q4, append one object to
// STEPS below (optionally behind a featureFlag). The progress %, points,
// milestone tiers, dependency gating, and "next step" all update automatically,
// and existing customers simply see the new step as "not done yet".
//
// Completion is DERIVED from real signals wherever possible (a step is done when
// the underlying thing is actually true), falling back to a stored flag for
// steps that can't be observed from data (e.g. "I added my Yelp link").
// ============================================

const { query } = require('../database/db');
const logger = require('../utils/logger');

// Milestone tiers, in order. A tier is "achieved" when every REQUIRED step in it
// (and all earlier tiers) is complete.
const MILESTONES = ['activate', 'optimize', 'pro'];
const MILESTONE_LABELS = {
  activate: 'Activated',
  optimize: 'Optimized',
  pro:      'Pro',
};

// ── THE STEP CONFIG ───────────────────────────────────────────────────────────
// id          stable identifier (also the key the frontend uses for UI + help)
// title       short label
// milestone   activate | optimize | pro
// required    counts toward "activated" (the ~10-minute core)
// points      weight toward the gamified score
// estMinutes  rough time estimate (drives the "X min left" copy)
// dependsOn   step ids that must be complete first (gates + ordering)
// featureFlag if set, the step is hidden until that flag is on (Q3/Q4 features)
// derive      OPTIONAL (ctx) => boolean; completion from real data. If omitted,
//             completion comes from the stored flag onboarding_state.flags[id].
const STEPS = [
  // ── Activate (the core ~10-minute flow) ──
  {
    id: 'business_details', title: 'Confirm your business details',
    milestone: 'activate', required: true, points: 10, estMinutes: 1,
    dependsOn: [], featureFlag: null,
    derive: (ctx) => ctx.locations > 0,
  },
  {
    id: 'connect_google', title: 'Connect your Google Business Profile',
    milestone: 'activate', required: true, points: 25, estMinutes: 2,
    dependsOn: ['business_details'], featureFlag: null,
    derive: (ctx) => ctx.connectedLocations > 0,
  },
  {
    id: 'review_link', title: 'Set your review link',
    milestone: 'activate', required: true, points: 15, estMinutes: 2,
    dependsOn: ['business_details'], featureFlag: null,
    derive: (ctx) => ctx.hasReviewUrl > 0,
  },
  {
    id: 'test_request', title: 'Send yourself a test review request',
    milestone: 'activate', required: true, points: 15, estMinutes: 1,
    dependsOn: ['review_link'], featureFlag: null,
    derive: (ctx) => ctx.reviewRequests > 0,
  },

  // ── Optimize ──
  {
    id: 'review_platforms', title: 'Add your review platforms (Yelp, Facebook)',
    milestone: 'optimize', required: false, points: 10, estMinutes: 2,
    dependsOn: ['business_details'], featureFlag: null,
    derive: (ctx) => ctx.otherReviewUrls > 0,
  },
  {
    id: 'keywords', title: 'Add keywords to track your local ranking',
    milestone: 'optimize', required: false, points: 15, estMinutes: 2,
    dependsOn: ['business_details'], featureFlag: null,
    derive: (ctx) => ctx.keywords > 0,
  },
  {
    id: 'ai_criteria', title: 'Set your AI search criteria',
    milestone: 'optimize', required: false, points: 15, estMinutes: 2,
    dependsOn: ['business_details'], featureFlag: null,
    derive: (ctx) => ctx.aiQueries > 0,
  },

  // ── Pro ──
  {
    id: 'connect_integration', title: 'Connect a CRM or scheduling tool',
    milestone: 'pro', required: false, points: 10, estMinutes: 3,
    dependsOn: ['business_details'], featureFlag: null,
    derive: (ctx) => ctx.integrations > 0,
  },
  {
    id: 'auto_reply_config', title: 'Configure your auto-reply tone',
    milestone: 'pro', required: false, points: 10, estMinutes: 2,
    dependsOn: ['business_details'], featureFlag: null,
    // Manual: tone defaults to "warm" on every location, so a derived signal
    // would be trivially true. The customer explicitly confirms their tone.
  },

  // ── Q4 (hidden until the 'social' feature flag is enabled) ──
  {
    id: 'social_posting', title: 'Connect your social accounts',
    milestone: 'pro', required: false, points: 10, estMinutes: 3,
    dependsOn: [], featureFlag: 'social',
    // flag-based; built in Q4.
  },
];

// Feature flags that are live today. A step whose featureFlag is NOT in this set
// is hidden from the wizard entirely (so Q4 steps don't appear early).
function enabledFeatureFlags() {
  const raw = (process.env.ONBOARDING_FEATURES || '').split(',').map(s => s.trim()).filter(Boolean);
  return new Set(raw);
}

// ── Gather the real-data signals once, then derive each step from them ──────────
async function gatherContext(customerId) {
  const ctx = {
    locations: 0, connectedLocations: 0, toneSet: 0, hasReviewUrl: 0, otherReviewUrls: 0,
    reviewRequests: 0, keywords: 0, aiQueries: 0, integrations: 0, flags: {},
  };

  // locations aggregate (mirrors the signals the old status route used)
  try {
    const r = await query(
      `SELECT
         COUNT(id) AS total_locations,
         COUNT(CASE WHEN platform IS NOT NULL AND platform != '' THEN 1 END) AS connected_locations,
         COUNT(CASE WHEN tone IS NOT NULL AND tone != '' THEN 1 END) AS tone_set,
         COUNT(CASE WHEN google_review_url IS NOT NULL AND google_review_url != '' THEN 1 END) AS has_review_url,
         COUNT(CASE WHEN (facebook_review_url IS NOT NULL AND facebook_review_url != '')
                      OR (yelp_review_url IS NOT NULL AND yelp_review_url != '') THEN 1 END) AS has_other_review_url
       FROM locations WHERE customer_id = $1`,
      [customerId]
    );
    const row = r.rows[0] || {};
    ctx.locations          = parseInt(row.total_locations)     || 0;
    ctx.connectedLocations = parseInt(row.connected_locations) || 0;
    ctx.toneSet            = parseInt(row.tone_set)             || 0;
    ctx.hasReviewUrl       = parseInt(row.has_review_url)       || 0;
    ctx.otherReviewUrls    = parseInt(row.has_other_review_url) || 0;
  } catch (e) { logger.warn('onboarding ctx locations:', e.message); }

  try {
    const r = await query('SELECT COUNT(id) AS c FROM review_requests WHERE customer_id=$1', [customerId]);
    ctx.reviewRequests = parseInt(r.rows[0]?.c) || 0;
  } catch (e) { /* table may be absent pre-launch */ }

  try {
    const r = await query(
      `SELECT COUNT(*) AS c FROM rank_keywords k JOIN locations l ON l.id = k.location_id WHERE l.customer_id=$1`,
      [customerId]
    );
    ctx.keywords = parseInt(r.rows[0]?.c) || 0;
  } catch (e) { /* no keywords table/rows yet */ }

  try {
    const r = await query('SELECT custom_queries FROM llm_settings WHERE customer_id=$1', [customerId]);
    const cq = r.rows[0]?.custom_queries;
    const hasQueries = Array.isArray(cq) ? cq.length > 0 : (cq ? true : false);
    if (hasQueries) ctx.aiQueries = 1;
    else {
      const rep = await query('SELECT 1 FROM llm_reports WHERE customer_id=$1 LIMIT 1', [customerId]);
      ctx.aiQueries = rep.rows.length ? 1 : 0;
    }
  } catch (e) { /* no llm settings yet */ }

  try {
    const r = await query(
      `SELECT COUNT(*) AS c FROM integrations i JOIN locations l ON l.id = i.location_id
        WHERE l.customer_id=$1 AND i.status='connected'`,
      [customerId]
    );
    ctx.integrations = parseInt(r.rows[0]?.c) || 0;
  } catch (e) { /* none connected */ }

  // Stored flags (for steps with no derivable signal) + started/completed/dismissed
  try {
    const r = await query('SELECT onboarding_state FROM customers WHERE id=$1', [customerId]);
    ctx.flags = (r.rows[0]?.onboarding_state?.flags) || {};
    ctx.state = r.rows[0]?.onboarding_state || {};
  } catch (e) { ctx.flags = {}; ctx.state = {}; }

  return ctx;
}

function isComplete(step, ctx) {
  if (typeof step.derive === 'function') {
    try { return !!step.derive(ctx); } catch { return false; }
  }
  return !!ctx.flags[step.id];
}

// ── Compute the full status object the API returns ──────────────────────────────
async function computeStatus(customerId) {
  const ctx = await gatherContext(customerId);
  const flags = enabledFeatureFlags();

  // Visible steps = no feature flag, or a flag that is currently enabled.
  const visible = STEPS.filter(s => !s.featureFlag || flags.has(s.featureFlag));

  const completedMap = {};
  for (const s of visible) completedMap[s.id] = isComplete(s, ctx);

  const steps = visible.map(s => ({
    id: s.id,
    title: s.title,
    milestone: s.milestone,
    required: s.required,
    points: s.points,
    estMinutes: s.estMinutes,
    dependsOn: s.dependsOn,
    manual: typeof s.derive !== 'function',
    completed: completedMap[s.id],
    locked: s.dependsOn.some(d => !completedMap[d]),
  }));

  const totalPoints   = steps.reduce((a, s) => a + s.points, 0);
  const earnedPoints  = steps.reduce((a, s) => a + (s.completed ? s.points : 0), 0);
  const pct           = totalPoints ? Math.round((earnedPoints / totalPoints) * 100) : 0;
  const completedCount = steps.filter(s => s.completed).length;

  // Required ("activate core") progress
  const requiredSteps = steps.filter(s => s.required);
  const requiredDone  = requiredSteps.filter(s => s.completed).length;
  const activated     = requiredSteps.length > 0 && requiredDone === requiredSteps.length;

  // Highest milestone tier achieved (all REQUIRED steps in it + earlier complete).
  // A milestone with no required steps is achieved once the previous tier is.
  let milestoneTier = null;
  for (const m of MILESTONES) {
    const tierRequired = visible.filter(s => s.milestone === m && s.required);
    const allDone = tierRequired.every(s => completedMap[s.id]);
    if (allDone) milestoneTier = m; else break;
  }

  // Next best step: first visible, incomplete, unlocked step in config order.
  const next = steps.find(s => !s.completed && !s.locked);
  const minutesLeft = steps.filter(s => !s.completed).reduce((a, s) => a + (s.estMinutes || 0), 0);

  return {
    onboarding: {
      activated,
      completed: completedCount === steps.length,
      dismissed: !!ctx.state?.dismissed,
      pct,
      earnedPoints,
      totalPoints,
      completedCount,
      totalSteps: steps.length,
      requiredDone,
      requiredTotal: requiredSteps.length,
      milestoneTier,
      milestoneLabel: milestoneTier ? MILESTONE_LABELS[milestoneTier] : null,
      nextStepId: next ? next.id : null,
      minutesLeft,
      startedAt: ctx.state?.started_at || null,
      steps,
    },
  };
}

// ── Persist a flag-based step completion (derived steps ignore this, but we
// still record the click so the UI can react instantly). ───────────────────────
async function markStep(customerId, stepId, value = true) {
  const known = STEPS.some(s => s.id === stepId);
  if (!known) throw new Error('Unknown onboarding step: ' + stepId);
  await query(
    `UPDATE customers
        SET onboarding_state = jsonb_set(
              jsonb_set(COALESCE(onboarding_state, '{}'::jsonb), '{flags}', COALESCE(onboarding_state->'flags', '{}'::jsonb)),
              ARRAY['flags', $2], to_jsonb($3::boolean), true)
      WHERE id = $1`,
    [customerId, stepId, value]
  );
}

async function setStateField(customerId, field, value) {
  await query(
    `UPDATE customers
        SET onboarding_state = jsonb_set(COALESCE(onboarding_state, '{}'::jsonb), ARRAY[$2], to_jsonb($3), true)
      WHERE id = $1`,
    [customerId, field, value]
  );
}

module.exports = { STEPS, MILESTONES, MILESTONE_LABELS, computeStatus, markStep, setStateField, gatherContext };
