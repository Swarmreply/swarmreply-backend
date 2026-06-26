// ============================================================================
// scheduler.snapshot.js
// Analytics P0 — nightly per-account state snapshot.
//
// Writes one row per account into analytics_daily_snapshot for the current day.
// This is the irreversible half of analytics: state metrics (billing, footprint,
// outcomes, activation milestones) that cannot be reconstructed retroactively.
// Stripe-sourced history can be backfilled later; this cannot, so it runs every
// night from the day it ships.
//
// Deliberately ONE set-based statement (no per-customer loop): the whole base is
// rolled up via LEFT JOINs over locations / integrations / reviews /
// review_requests / contacts / survey_responses, so it stays fast as the
// customer base grows. ON CONFLICT (snapshot_date, customer_id) makes a re-run
// on the same day idempotent (it refreshes that day's row).
//
// Onboarding/activation funnel is captured day-granular via derivable signals
// (has_location/has_integration/has_first_request/has_first_review) plus the
// stored onboarding_state — no dependency on the onboarding engine internals.
// ============================================================================

const { query } = require('./database/db');
const logger = require('./utils/logger');

const SNAPSHOT_SQL = `
INSERT INTO analytics_daily_snapshot (
  snapshot_date, customer_id, status, plan, is_demo, is_paying, account_age_days,
  location_count, integration_count, integrations_connected,
  contact_count, opted_out_count, review_count, avg_rating,
  requests_total, requests_completed, survey_responses, ai_visibility_score,
  onboarding_started, onboarding_completed,
  has_location, has_integration, has_first_request, has_first_review,
  mrr_cents
)
SELECT
  CURRENT_DATE,
  c.id,
  c.status,
  c.plan,
  COALESCE(c.is_demo, false),
  (c.stripe_subscription_id IS NOT NULL),
  GREATEST(0, (CURRENT_DATE - c.created_at::date)),
  COALESCE(loc.cnt, 0),
  COALESCE(intg.cnt, 0),
  COALESCE(intg.providers, '{}'::text[]),
  COALESCE(con.cnt, 0),
  COALESCE(con.opted, 0),
  COALESCE(rv.cnt, 0),
  rv.avg_rating,
  COALESCE(rq.total, 0),
  COALESCE(rq.completed, 0),
  COALESCE(sr.cnt, 0),
  vis.score,
  ((c.onboarding_state->>'started')   IS NOT NULL AND (c.onboarding_state->>'started')   <> 'false'),
  ((c.onboarding_state->>'completed') IS NOT NULL AND (c.onboarding_state->>'completed') <> 'false'),
  COALESCE(loc.cnt, 0)  > 0,
  COALESCE(intg.cnt, 0) > 0,
  COALESCE(rq.total, 0) > 0,
  COALESCE(rv.cnt, 0)   > 0,
  -- MRR (cents) from the graduated per-location pricing model, active locations
  -- only, for active non-demo accounts — matches the admin Revenue page formula
  -- (estimateMonthly: 1-2 @ $99, 3-25 @ $89, 26-99 @ $79).
  CASE WHEN c.status = 'active' AND COALESCE(c.is_demo, false) = false AND COALESCE(actloc.cnt, 0) >= 1
       THEN ( LEAST(actloc.cnt, 2) * 99
            + GREATEST(LEAST(actloc.cnt - 2, 23), 0) * 89
            + GREATEST(LEAST(actloc.cnt - 25, 74), 0) * 79 ) * 100
       ELSE 0 END
FROM customers c
LEFT JOIN (
  SELECT customer_id, COUNT(*) cnt
  FROM locations GROUP BY customer_id
) loc ON loc.customer_id = c.id
LEFT JOIN (
  SELECT customer_id, COUNT(*) cnt
  FROM locations WHERE is_active = true GROUP BY customer_id
) actloc ON actloc.customer_id = c.id
LEFT JOIN (
  SELECT l.customer_id,
         COUNT(DISTINCT i.provider) cnt,
         array_agg(DISTINCT i.provider) providers
  FROM integrations i JOIN locations l ON l.id = i.location_id
  WHERE i.status = 'connected'
  GROUP BY l.customer_id
) intg ON intg.customer_id = c.id
LEFT JOIN (
  SELECT customer_id, COUNT(*) cnt, COUNT(*) FILTER (WHERE opted_out) opted
  FROM contacts GROUP BY customer_id
) con ON con.customer_id = c.id
LEFT JOIN (
  SELECT l.customer_id, COUNT(*) cnt, ROUND(AVG(r.rating)::numeric, 2) avg_rating
  FROM reviews r JOIN locations l ON l.id = r.location_id
  GROUP BY l.customer_id
) rv ON rv.customer_id = c.id
LEFT JOIN (
  SELECT customer_id, COUNT(*) total,
         COUNT(*) FILTER (WHERE status = 'completed') completed
  FROM review_requests GROUP BY customer_id
) rq ON rq.customer_id = c.id
LEFT JOIN (
  SELECT customer_id, COUNT(*) cnt
  FROM survey_responses GROUP BY customer_id
) sr ON sr.customer_id = c.id
LEFT JOIN LATERAL (
  SELECT r.visibility_score AS score
  FROM llm_monitor_runs r JOIN locations l ON l.id = r.location_id
  WHERE l.customer_id = c.id AND r.status = 'complete'
  ORDER BY r.completed_at DESC NULLS LAST
  LIMIT 1
) vis ON true
ON CONFLICT (snapshot_date, customer_id) DO UPDATE SET
  status                 = EXCLUDED.status,
  plan                   = EXCLUDED.plan,
  is_demo                = EXCLUDED.is_demo,
  is_paying              = EXCLUDED.is_paying,
  account_age_days       = EXCLUDED.account_age_days,
  location_count         = EXCLUDED.location_count,
  integration_count      = EXCLUDED.integration_count,
  integrations_connected = EXCLUDED.integrations_connected,
  contact_count          = EXCLUDED.contact_count,
  opted_out_count        = EXCLUDED.opted_out_count,
  review_count           = EXCLUDED.review_count,
  avg_rating             = EXCLUDED.avg_rating,
  requests_total         = EXCLUDED.requests_total,
  requests_completed     = EXCLUDED.requests_completed,
  survey_responses       = EXCLUDED.survey_responses,
  ai_visibility_score    = EXCLUDED.ai_visibility_score,
  onboarding_started     = EXCLUDED.onboarding_started,
  onboarding_completed   = EXCLUDED.onboarding_completed,
  has_location           = EXCLUDED.has_location,
  has_integration        = EXCLUDED.has_integration,
  has_first_request      = EXCLUDED.has_first_request,
  has_first_review       = EXCLUDED.has_first_review,
  mrr_cents              = EXCLUDED.mrr_cents,
  captured_at            = now();
`;

/**
 * runDailySnapshot()
 * Roll up the full customer base into today's analytics_daily_snapshot rows.
 * Safe to call more than once per day (idempotent upsert).
 */
async function runDailySnapshot() {
  const started = Date.now();
  const result = await query(SNAPSHOT_SQL);
  const rows = result.rowCount || 0;
  logger.info(`snapshot: captured ${rows} account row(s) for ${new Date().toISOString().slice(0, 10)} in ${Date.now() - started}ms`);
  return rows;
}

module.exports = { runDailySnapshot };
