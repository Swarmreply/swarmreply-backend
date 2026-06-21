// ============================================
// routes/reports.js
// Real analytics for the Pulse / Reports page — aggregated from the customer's
// own reviews. No mock data: every number here is computed from the reviews
// table for the locations this customer owns.
//
// GET /api/reports/analytics?range=30d|90d|12m|all
// ============================================

const express = require('express');
const router  = express.Router();
const { query } = require('../database/db');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const competitorService = require('../services/competitorService');

// Whitelist range -> SQL interval. Whitelisting (not interpolating user input)
// keeps this injection-safe.
const RANGE_INTERVALS = {
  '30d': "30 days",
  '90d': "90 days",
  '12m': "12 months",
};

// Current-window and prior-window intervals (prior = the equivalent span
// immediately before the current one, for honest period-over-period deltas).
const RANGE_CUR   = { '30d': '30 days',  '90d': '90 days',  '12m': '12 months' };
const RANGE_PRIOR = { '30d': '60 days',  '90d': '180 days', '12m': '24 months' };

// Theme detection for the Sentiment report. Each theme is a label plus the
// keywords that signal it; a review can match several. Praise vs. complaint
// is decided by the star rating, not the words.
const REPORT_THEMES = [
  ['Service & staff', ['staff','server','service','friendly','helpful','team','rude','attentive','welcoming','kind','professional']],
  ['Wait & speed',    ['wait','slow','quick','fast','prompt','long','delay','minutes','hour']],
  ['Quality',         ['quality','delicious','amazing','excellent','great','best','disappoint','poor','fresh','cold','perfect']],
  ['Value & price',   ['price','expensive','worth','value','overpriced','cheap','affordable','fair','cost']],
  ['Cleanliness',     ['clean','dirty','spotless','mess','tidy','sanitary']],
  ['Communication',   ['communicat','explain','listen','call','respond','update','clear','informed']],
  ['Atmosphere',      ['atmosphere','cozy','vibe','ambiance','comfortable','noisy','music','decor','relaxing']],
];

// GET /api/reports/analytics
router.get('/analytics', authenticateToken, async (req, res) => {
  const customerId = req.user.customerId;
  const range = RANGE_INTERVALS[req.query.range] ? req.query.range : '90d';
  const interval = RANGE_INTERVALS[range] || null; // null => all time

  // A reusable WHERE fragment scoping to this customer's locations, plus an
  // optional time window. $1 is always the customerId.
  const periodClause = interval ? `AND rv.created_at >= NOW() - INTERVAL '${interval}'` : '';

  try {
    // 1) Totals (whole account, all-time) + response rate.
    const totalsQ = await query(
      `SELECT
         COUNT(rv.id)                                                   AS total_reviews,
         COUNT(CASE WHEN rv.status = 'replied' THEN 1 END)              AS total_replied,
         ROUND(AVG(rv.star_rating)::numeric, 1)                         AS avg_rating,
         COUNT(CASE WHEN rv.created_at >= NOW() - INTERVAL '30 days' THEN 1 END) AS reviews_30d
       FROM locations l
       JOIN reviews rv ON rv.location_id = l.id
       WHERE l.customer_id = $1`,
      [customerId]
    );

    // 2) Star-rating distribution within the selected period.
    const distQ = await query(
      `SELECT rv.star_rating AS stars, COUNT(*) AS count
       FROM locations l
       JOIN reviews rv ON rv.location_id = l.id
       WHERE l.customer_id = $1 ${periodClause}
       GROUP BY rv.star_rating`,
      [customerId]
    );

    // 3) Volume + average by month within the selected period.
    const monthlyQ = await query(
      `SELECT to_char(date_trunc('month', rv.created_at), 'YYYY-MM') AS month,
              COUNT(*)                               AS count,
              ROUND(AVG(rv.star_rating)::numeric, 1) AS avg
       FROM locations l
       JOIN reviews rv ON rv.location_id = l.id
       WHERE l.customer_id = $1 ${periodClause}
       GROUP BY 1
       ORDER BY 1`,
      [customerId]
    );

    // 4) Breakdown by platform within the selected period.
    const platformQ = await query(
      `SELECT COALESCE(rv.platform, 'other')        AS platform,
              COUNT(*)                               AS count,
              ROUND(AVG(rv.star_rating)::numeric, 1) AS avg
       FROM locations l
       JOIN reviews rv ON rv.location_id = l.id
       WHERE l.customer_id = $1 ${periodClause}
       GROUP BY 1
       ORDER BY count DESC`,
      [customerId]
    );

    const t = totalsQ.rows[0] || {};
    const totalReviews = Number(t.total_reviews) || 0;
    const totalReplied = Number(t.total_replied) || 0;

    // Normalise the distribution into a fixed 5..1 shape so the frontend never
    // has to guess which buckets exist.
    const distMap = {};
    for (const r of distQ.rows) distMap[Number(r.stars)] = Number(r.count);
    const distribution = [5, 4, 3, 2, 1].map(stars => ({
      stars,
      count: distMap[stars] || 0,
    }));

    res.json({
      range,
      totals: {
        totalReviews,
        avgRating:    t.avg_rating !== null && t.avg_rating !== undefined ? Number(t.avg_rating) : null,
        replied:      totalReplied,
        responseRate: totalReviews > 0 ? Math.round((totalReplied / totalReviews) * 100) : 0,
        reviews30d:   Number(t.reviews_30d) || 0,
      },
      distribution,
      byMonth: monthlyQ.rows.map(r => ({
        month: r.month,
        count: Number(r.count),
        avg:   r.avg !== null ? Number(r.avg) : null,
      })),
      byPlatform: platformQ.rows.map(r => ({
        platform: r.platform,
        count:    Number(r.count),
        avg:      r.avg !== null ? Number(r.avg) : null,
      })),
    });
  } catch (err) {
    logger.error('Reports analytics error:', err.message);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

// ============================================
// GET /api/reports/insights?range=30d|90d|12m|all&locationId=&platform=
// One payload powering all eight reports. Scoped to the customer's locations,
// with optional location + platform filters. Time windows are whitelisted, and
// location/platform are passed as bound params, so this is injection-safe.
// ============================================
router.get('/insights', authenticateToken, async (req, res) => {
  const customerId = req.user.customerId || req.user.id;
  const range = (req.query.range === 'all' || RANGE_CUR[req.query.range]) ? req.query.range : '90d';
  const locationId = req.query.locationId && req.query.locationId !== 'all' ? String(req.query.locationId) : null;
  const platform   = req.query.platform   && req.query.platform   !== 'all' ? String(req.query.platform)   : null;

  const curInt    = RANGE_CUR[range] || null;            // null => all time
  const priorInt  = RANGE_PRIOR[range] || null;
  const bucket    = (range === '12m' || range === 'all') ? 'month' : 'week';
  const curWin    = curInt   ? `AND rv.created_at >= NOW() - INTERVAL '${curInt}'` : '';
  const priorWin  = curInt   ? `AND rv.created_at >= NOW() - INTERVAL '${priorInt}' AND rv.created_at < NOW() - INTERVAL '${curInt}'` : null;
  const sWin      = curInt   ? `AND sr.completed_at >= NOW() - INTERVAL '${curInt}'` : '';
  const sPriorWin = curInt   ? `AND sr.completed_at >= NOW() - INTERVAL '${priorInt}' AND sr.completed_at < NOW() - INTERVAL '${curInt}'` : null;
  const rqWin     = curInt   ? `AND rr.created_at >= NOW() - INTERVAL '${curInt}'` : '';

  const rScope = `WHERE l.customer_id = $1
      AND ($2::text IS NULL OR l.id::text = $2::text)
      AND ($3::text IS NULL OR rv.platform = $3::text)`;
  const sScope = `WHERE sr.customer_id = $1 AND ($2::text IS NULL OR sr.location_id::text = $2::text)`;
  const rqScope = `WHERE rr.customer_id = $1 AND ($2::text IS NULL OR rr.location_id::text = $2::text)`;
  const rParams = [customerId, locationId, platform];
  const sParams = [customerId, locationId];

  const reviewsRepl = `FROM locations l JOIN reviews rv ON rv.location_id = l.id LEFT JOIN replies rp ON rp.review_id = rv.id`;
  const reviewsBase = `FROM locations l JOIN reviews rv ON rv.location_id = l.id`;
  const coreSelect = `SELECT COUNT(rv.id) total,
        COUNT(CASE WHEN rv.status='replied' THEN 1 END) replied,
        ROUND(AVG(rv.star_rating)::numeric,2) avg_rating,
        ROUND(AVG(CASE WHEN rv.status='replied'
              THEN EXTRACT(EPOCH FROM (rp.posted_at - rv.created_at))/3600 END)::numeric,1) avg_resp_hours,
        COUNT(CASE WHEN rv.created_at >= NOW() - INTERVAL '30 days' THEN 1 END) reviews_30d`;
  const npsSelect = `SELECT COUNT(*) FILTER (WHERE nps_score IS NOT NULL) total,
        COUNT(*) FILTER (WHERE nps_score >= 9) promoters,
        COUNT(*) FILTER (WHERE nps_score BETWEEN 7 AND 8) passives,
        COUNT(*) FILTER (WHERE nps_score <= 6) detractors,
        ROUND(100.0 * COUNT(*) FILTER (WHERE would_return AND nps_score IS NOT NULL) / NULLIF(COUNT(*) FILTER (WHERE nps_score IS NOT NULL),0)) would_return_pct,
        ROUND(100.0 * COUNT(*) FILTER (WHERE left_review AND nps_score IS NOT NULL) / NULLIF(COUNT(*) FILTER (WHERE nps_score IS NOT NULL),0)) left_review_pct`;

  try {
    const [
      coreR, corePriorR, distR, platOptsR, byPlatR, trendR, respR,
      textsR, leaderR, npsR, npsPriorR, reasonsR, funnelR, funnelChR, locListR,
    ] = await Promise.all([
      query(`${coreSelect} ${reviewsRepl} ${rScope} ${curWin}`, rParams),
      priorWin ? query(`${coreSelect} ${reviewsRepl} ${rScope} ${priorWin}`, rParams) : Promise.resolve({ rows: [{}] }),
      query(`SELECT rv.star_rating stars, COUNT(*) count ${reviewsBase} ${rScope} ${curWin} GROUP BY 1`, rParams),
      query(`SELECT DISTINCT rv.platform FROM locations l JOIN reviews rv ON rv.location_id=l.id WHERE l.customer_id=$1 AND rv.platform IS NOT NULL`, [customerId]),
      query(`SELECT COALESCE(rv.platform,'other') platform, COUNT(*) count, ROUND(AVG(rv.star_rating)::numeric,2) avg ${reviewsBase} ${rScope} ${curWin} GROUP BY 1 ORDER BY count DESC`, rParams),
      query(`SELECT to_char(date_trunc('${bucket}', rv.created_at),'YYYY-MM-DD') period, COUNT(*) count, ROUND(AVG(rv.star_rating)::numeric,2) avg ${reviewsBase} ${rScope} ${curWin} GROUP BY 1 ORDER BY 1`, rParams),
      query(`SELECT COUNT(*) replied_count, ROUND(AVG(h)::numeric,1) avg_hours,
                ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h))::numeric,1) median_hours,
                COUNT(*) FILTER (WHERE h <= 24) within24, COUNT(*) FILTER (WHERE h <= 48) within48
              FROM (SELECT EXTRACT(EPOCH FROM (rp.posted_at - rv.created_at))/3600 h
                    FROM locations l JOIN reviews rv ON rv.location_id=l.id JOIN replies rp ON rp.review_id=rv.id
                    ${rScope} ${curWin} AND rv.status='replied' AND rp.posted_at IS NOT NULL) t`, rParams),
      query(`SELECT rv.star_rating stars, rv.review_text text ${reviewsBase} ${rScope} ${curWin} AND rv.review_text IS NOT NULL ORDER BY rv.created_at DESC LIMIT 400`, rParams),
      query(`SELECT l.id, l.business_name name, COUNT(rv.id) reviews,
                ROUND(AVG(rv.star_rating)::numeric,2) avg_rating,
                COUNT(CASE WHEN rv.status='replied' THEN 1 END) replied
              FROM locations l
              LEFT JOIN reviews rv ON rv.location_id = l.id ${curInt ? `AND rv.created_at >= NOW() - INTERVAL '${curInt}'` : ''}
              WHERE l.customer_id = $1 AND ($2::text IS NULL OR l.id::text = $2::text)
              GROUP BY l.id, l.business_name ORDER BY avg_rating DESC NULLS LAST`, sParams),
      query(`${npsSelect} FROM survey_responses sr ${sScope} ${sWin}`, sParams),
      sPriorWin ? query(`${npsSelect} FROM survey_responses sr ${sScope} ${sPriorWin}`, sParams) : Promise.resolve({ rows: [{}] }),
      query(`SELECT detractor_q1 reason, COUNT(*) count FROM survey_responses sr ${sScope} AND sr.path='Detractor' AND sr.detractor_q1 IS NOT NULL ${sWin} GROUP BY 1 ORDER BY count DESC LIMIT 6`, sParams),
      query(`SELECT COUNT(*) sent,
                COUNT(*) FILTER (WHERE rr.status IN ('clicked','completed')) clicked,
                COUNT(*) FILTER (WHERE rr.status = 'completed') completed
              FROM review_requests rr ${rqScope} ${rqWin}`, sParams),
      query(`SELECT COALESCE(rr.trigger_source,'other') channel, COUNT(*) sent,
                COUNT(*) FILTER (WHERE rr.status IN ('clicked','completed')) clicked,
                COUNT(*) FILTER (WHERE rr.status = 'completed') completed
              FROM review_requests rr ${rqScope} ${rqWin} GROUP BY 1 ORDER BY sent DESC`, sParams),
      query(`SELECT id, business_name name FROM locations WHERE customer_id = $1 ORDER BY created_at ASC`, [customerId]),
    ]);

    const num = (v) => (v === null || v === undefined ? null : Number(v));
    const core  = coreR.rows[0] || {};
    const prior = corePriorR.rows[0] || {};
    const nps   = npsR.rows[0] || {};
    const npsP  = npsPriorR.rows[0] || {};

    const total = num(core.total) || 0;
    const replied = num(core.replied) || 0;
    const responseRate = total ? Math.round((replied / total) * 100) : 0;
    const pTotal = num(prior.total) || 0;
    const pReplied = num(prior.replied) || 0;
    const pResponseRate = pTotal ? Math.round((pReplied / pTotal) * 100) : 0;

    const npsScore = (t, n) => { const tt = num(n.total) || 0; return tt ? Math.round(100 * ((num(n.promoters)||0) - (num(n.detractors)||0)) / tt) : null; };
    const curNps = npsScore(range, nps);
    const priorNps = npsScore(range, npsP);

    // Reputation score (0–100): rating 50, response 25, nps 15, momentum 10.
    const repScore = (avg, rr, npsVal, cur, prev) => {
      if (!avg && !rr && npsVal === null) return null;
      const ratingN = (Number(avg) || 0) / 5;
      const respN   = (Number(rr) || 0) / 100;
      const npsN    = npsVal === null ? ratingN : ((npsVal + 100) / 200);
      const momentum = prev == null ? 0.5 : cur > prev ? 1 : cur === prev ? 0.5 : 0;
      return Math.max(0, Math.min(100, Math.round(50 * ratingN + 25 * respN + 15 * npsN + 10 * momentum)));
    };
    const curScore   = repScore(core.avg_rating, responseRate, curNps, total, priorWin ? pTotal : null);
    const priorScore = priorWin ? repScore(prior.avg_rating, pResponseRate, priorNps, pTotal, null) : null;

    // Sentiment + themes (computed from review text).
    const distMap = {}; for (const r of distR.rows) distMap[Number(r.stars)] = Number(r.count);
    const distribution = [5,4,3,2,1].map(s => ({ stars: s, count: distMap[s] || 0 }));
    const positive = (distMap[5]||0) + (distMap[4]||0);
    const neutral  = (distMap[3]||0);
    const negative = (distMap[2]||0) + (distMap[1]||0);

    const praise = {}, complaint = {}, examples = {};
    for (const [label] of REPORT_THEMES) { praise[label] = 0; complaint[label] = 0; }
    for (const row of textsR.rows) {
      const txt = (row.text || '').toLowerCase();
      const isPraise = Number(row.stars) >= 4;
      for (const [label, words] of REPORT_THEMES) {
        if (words.some(w => txt.includes(w))) {
          if (isPraise) praise[label]++; else complaint[label]++;
          const key = label + '|' + (isPraise ? 'p' : 'c');
          if (!examples[key] && row.text && row.text.length <= 160) examples[key] = row.text;
        }
      }
    }
    const themeList = (map, kind) => REPORT_THEMES
      .map(([label]) => ({ theme: label, count: map[label], example: examples[label + '|' + kind] || null }))
      .filter(t => t.count > 0).sort((a,b) => b.count - a.count).slice(0, 6);

    const resp = respR.rows[0] || {};
    const repliedCount = num(resp.replied_count) || 0;

    res.json({
      range,
      filters: { locationId, platform },
      locations: locListR.rows.map(r => ({ id: r.id, name: r.name })),
      platforms: platOptsR.rows.map(r => r.platform).filter(Boolean),
      hasData: total > 0,
      scorecard: {
        reputationScore: curScore,
        reputationScoreDelta: priorScore == null || curScore == null ? null : curScore - priorScore,
        avgRating: num(core.avg_rating),
        avgRatingDelta: priorWin && core.avg_rating != null && prior.avg_rating != null ? +(num(core.avg_rating) - num(prior.avg_rating)).toFixed(2) : null,
        totalReviews: total,
        reviewsDelta: priorWin ? total - pTotal : null,
        responseRate,
        responseRateDelta: priorWin ? responseRate - pResponseRate : null,
        avgResponseHours: num(core.avg_resp_hours),
        responseHoursDelta: priorWin && core.avg_resp_hours != null && prior.avg_resp_hours != null ? +(num(core.avg_resp_hours) - num(prior.avg_resp_hours)).toFixed(1) : null,
        nps: curNps,
        npsDelta: priorWin && curNps != null && priorNps != null ? curNps - priorNps : null,
        reviews30d: num(core.reviews_30d) || 0,
      },
      trend: { bucket, points: trendR.rows.map(r => ({ period: r.period, count: Number(r.count), avg: r.avg != null ? Number(r.avg) : null })) },
      distribution,
      byPlatform: byPlatR.rows.map(r => ({ platform: r.platform, count: Number(r.count), avg: r.avg != null ? Number(r.avg) : null })),
      response: {
        responseRate,
        repliedCount,
        avgHours: num(resp.avg_hours),
        medianHours: num(resp.median_hours),
        within24: num(resp.within24) || 0,
        within48: num(resp.within48) || 0,
        within24Pct: repliedCount ? Math.round((num(resp.within24) / repliedCount) * 100) : 0,
        within48Pct: repliedCount ? Math.round((num(resp.within48) / repliedCount) * 100) : 0,
      },
      sentiment: {
        positive, neutral, negative,
        praiseThemes: themeList(praise, 'p'),
        complaintThemes: themeList(complaint, 'c'),
      },
      leaderboard: leaderR.rows.map(r => {
        const rev = Number(r.reviews) || 0;
        return { id: r.id, name: r.name, reviews: rev, avgRating: r.avg_rating != null ? Number(r.avg_rating) : null,
                 responseRate: rev ? Math.round((Number(r.replied) / rev) * 100) : 0 };
      }),
      funnel: {
        sent: num(funnelR.rows[0]?.sent) || 0,
        clicked: num(funnelR.rows[0]?.clicked) || 0,
        completed: num(funnelR.rows[0]?.completed) || 0,
        byChannel: funnelChR.rows.map(r => ({ channel: r.channel, sent: Number(r.sent), clicked: Number(r.clicked), completed: Number(r.completed) })),
      },
      nps: {
        score: curNps,
        scoreDelta: priorWin && curNps != null && priorNps != null ? curNps - priorNps : null,
        total: num(nps.total) || 0,
        promoters: num(nps.promoters) || 0,
        passives: num(nps.passives) || 0,
        detractors: num(nps.detractors) || 0,
        wouldReturnPct: num(nps.would_return_pct) || 0,
        leftReviewPct: num(nps.left_review_pct) || 0,
        reasons: reasonsR.rows.map(r => ({ reason: r.reason, count: Number(r.count) })),
      },
    });
  } catch (err) {
    logger.error('Reports insights error:', err.message);
    res.status(500).json({ error: 'Failed to load insights' });
  }
});

// ============================================
// COMPETITORS — Get Found › AI Competitors (nearby benchmark)
// Google Places nearby benchmark: your rating + review count vs the nearest
// businesses in your category. First scan is user-initiated ("Try scanning
// now"); after that scheduler.competitors re-scans weekly. We only read here.
// ============================================

// In-flight scans, so a manual refresh doesn't overlap with itself.
const scanningLocations = new Set();

async function primaryLocation(customerId) {
  const r = await query(
    'SELECT id, business_name, city, state FROM locations WHERE customer_id=$1 ORDER BY created_at ASC LIMIT 1',
    [customerId]
  ).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

async function primaryLocationId(customerId) {
  const loc = await primaryLocation(customerId);
  return loc ? loc.id : null;
}

// GET /api/reports/competitors — read the latest nearby benchmark (no scan).
router.get('/competitors', authenticateToken, async (req, res) => {
  const customerId = req.user.customerId || req.user.id;
  try {
    const loc = await primaryLocation(customerId);
    const configured = !!process.env.GOOGLE_PLACES_API_KEY;
    if (!loc) {
      return res.json({ benchmark: { hasData: false, reason: 'no_location' }, configured, businessName: null, geoReady: false });
    }
    const benchmark = await competitorService.getCompetitorBenchmark(loc.id)
      .catch(() => ({ hasData: false }));
    res.json({
      benchmark,
      configured,
      businessName: loc.business_name || null,
      geoReady: !!(loc.city && loc.state),
    });
  } catch (err) {
    logger.error('Reports competitors error:', err.message);
    res.status(500).json({ error: 'Failed to load competitors' });
  }
});

// POST /api/reports/competitors/refresh — "Try scanning now". Runs the first
// scan and, by creating snapshots, opts this location into the weekly refresh.
router.post('/competitors/refresh', authenticateToken, async (req, res) => {
  const customerId = req.user.customerId || req.user.id;
  try {
    const locationId = await primaryLocationId(customerId);
    if (!locationId) return res.status(400).json({ error: 'No location to scan' });
    if (!process.env.GOOGLE_PLACES_API_KEY) {
      return res.status(503).json({ error: 'Competitor scanning is not configured yet.' });
    }
    if (scanningLocations.has(locationId)) {
      return res.status(409).json({ error: 'A scan is already running — give it a moment.' });
    }
    scanningLocations.add(locationId);
    try {
      await competitorService.findCompetitors(locationId);
      const benchmark = await competitorService.getCompetitorBenchmark(locationId);
      res.json({ benchmark });
    } finally {
      scanningLocations.delete(locationId);
    }
  } catch (err) {
    logger.error('Competitor refresh error:', err.message);
    res.status(500).json({ error: err.message || 'Refresh failed' });
  }
});

// GET /api/reports/survey-responses — filterable responses + per-question answers.
// Powers the Responses Explorer. Filters: days, classification, channel, q (keyword).
router.get('/survey-responses', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const days = Math.min(3650, Math.max(1, parseInt(req.query.days || '90', 10) || 90));
    const cls = (req.query.classification || 'all').toLowerCase();
    const channel = (req.query.channel || 'all').toLowerCase();
    const kw = (req.query.q || '').trim();
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '300', 10) || 300));
    const templateId = (req.query.templateId && req.query.templateId !== 'all') ? String(req.query.templateId) : null;

    const where = ['sr.customer_id = $1', 'sr.completed_at >= NOW() - ($2)::interval'];
    const params = [customerId, days + ' days'];
    let i = 3;
    if (templateId) { where.push(`sr.template_id = $${i}`); params.push(templateId); i++; }
    if (['promoter', 'passive', 'detractor'].includes(cls)) { where.push(`lower(sr.path) = $${i}`); params.push(cls); i++; }
    if (['email', 'sms'].includes(channel)) { where.push(`sr.channel = $${i}`); params.push(channel); i++; }
    if (kw) {
      where.push(`(EXISTS (SELECT 1 FROM survey_answers sa WHERE sa.response_uid = sr.uid AND sa.answer_text ILIKE $${i}) OR sr.detractor_q1 ILIKE $${i} OR sr.detractor_q2 ILIKE $${i})`);
      params.push('%' + kw + '%'); i++;
    }

    const respR = await query(
      `SELECT sr.uid, sr.completed_at, sr.nps_score, sr.path, sr.channel, sr.location_id,
              sr.detractor_q1, sr.detractor_q2, rr.contact_name, rr.contact_email
         FROM survey_responses sr
         LEFT JOIN review_requests rr ON rr.id = sr.review_request_id
        WHERE ${where.join(' AND ')}
        ORDER BY sr.completed_at DESC NULLS LAST
        LIMIT ${limit}`,
      params
    ).catch((e) => { logger.warn('survey-responses query: ' + e.message); return { rows: [] }; });

    const responses = respR.rows;
    const uids = responses.map((r) => r.uid).filter(Boolean);

    const answersByUid = {};
    if (uids.length) {
      const aR = await query(
        `SELECT response_uid, block_type, question_text, answer_text, answer_number, answer_options
           FROM survey_answers WHERE response_uid = ANY($1) ORDER BY created_at ASC`,
        [uids]
      ).catch(() => ({ rows: [] }));
      for (const a of aR.rows) {
        (answersByUid[a.response_uid] = answersByUid[a.response_uid] || []).push({
          type: a.block_type, question: a.question_text,
          text: a.answer_text, number: a.answer_number, options: a.answer_options,
        });
      }
    }

    const out = responses.map((r) => {
      let answers = answersByUid[r.uid] || [];
      if (!answers.length && (r.detractor_q1 || r.detractor_q2)) {
        answers = [
          r.detractor_q1 ? { type: 'open_text', question: 'What fell short?', text: r.detractor_q1 } : null,
          r.detractor_q2 ? { type: 'open_text', question: 'What could we do better?', text: r.detractor_q2 } : null,
        ].filter(Boolean);
      }
      return {
        uid: r.uid, completedAt: r.completed_at, score: r.nps_score,
        classification: r.path, channel: r.channel, locationId: r.location_id,
        contactName: r.contact_name, contactEmail: r.contact_email, answers,
      };
    });

    res.json({ responses: out, total: out.length });
  } catch (err) {
    logger.error('GET /reports/survey-responses error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/survey-questions — per-question answer distributions (for charts).
router.get('/survey-questions', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const days = Math.min(3650, Math.max(1, parseInt(req.query.days || '90', 10) || 90));
    const templateId = (req.query.templateId && req.query.templateId !== 'all') ? String(req.query.templateId) : null;
    const params = [customerId, days + ' days'];
    const tClause = templateId ? ' AND sr.template_id = $3' : '';
    if (templateId) params.push(templateId);
    const rowsR = await query(
      `SELECT sa.question_text AS question, sa.block_type AS type,
              COALESCE(NULLIF(sa.answer_text, ''), sa.answer_number::text) AS value,
              COUNT(*)::int AS count
         FROM survey_answers sa
         JOIN survey_responses sr ON sr.uid = sa.response_uid
        WHERE sr.customer_id = $1
          AND sr.completed_at >= NOW() - ($2)::interval
          AND sa.question_text IS NOT NULL
          AND sa.block_type IN ('multiple_choice','dropdown','yes_no','rating','star','smiley','nps')
          AND COALESCE(NULLIF(sa.answer_text, ''), sa.answer_number::text) IS NOT NULL${tClause}
        GROUP BY sa.question_text, sa.block_type, value
        ORDER BY sa.question_text, count DESC`,
      params
    ).catch((e) => { logger.warn('survey-questions query: ' + e.message); return { rows: [] }; });

    const byQ = {}; const order = [];
    for (const r of rowsR.rows) {
      const key = r.question + '||' + r.type;
      if (!byQ[key]) { byQ[key] = { question: r.question, type: r.type, total: 0, options: [] }; order.push(key); }
      byQ[key].options.push({ value: r.value, count: r.count });
      byQ[key].total += r.count;
    }
    const questions = order.map((k) => {
      const qd = byQ[k];
      if (['rating', 'star', 'smiley', 'nps'].includes(qd.type)) {
        let sum = 0, nn = 0;
        qd.options.forEach((o) => { const v = parseFloat(o.value); if (!isNaN(v)) { sum += v * o.count; nn += o.count; } });
        qd.avg = nn ? Math.round((sum / nn) * 10) / 10 : null;
        qd.options.sort((a, b) => parseFloat(a.value) - parseFloat(b.value));
      }
      return qd;
    });
    res.json({ questions });
  } catch (err) {
    logger.error('GET /reports/survey-questions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/survey-nps?days=&templateId= — NPS aggregate for one survey
// (or all). Counts only scored responses, so custom surveys return total 0.
router.get('/survey-nps', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const days = Math.min(3650, Math.max(1, parseInt(req.query.days || '90', 10) || 90));
    const templateId = (req.query.templateId && req.query.templateId !== 'all') ? String(req.query.templateId) : null;
    const params = [customerId, days + ' days'];
    const tClause = templateId ? ' AND sr.template_id = $3' : '';
    if (templateId) params.push(templateId);

    const aggR = await query(
      `SELECT COUNT(*)::int total,
              COUNT(*) FILTER (WHERE nps_score >= 9)::int promoters,
              COUNT(*) FILTER (WHERE nps_score BETWEEN 7 AND 8)::int passives,
              COUNT(*) FILTER (WHERE nps_score <= 6)::int detractors,
              ROUND(100.0 * COUNT(*) FILTER (WHERE would_return) / NULLIF(COUNT(*),0)) would_return_pct
         FROM survey_responses sr
        WHERE sr.customer_id = $1 AND sr.completed_at >= NOW() - ($2)::interval
          AND sr.nps_score IS NOT NULL${tClause}`,
      params
    ).catch((e) => { logger.warn('survey-nps agg: ' + e.message); return { rows: [{}] }; });
    const a = aggR.rows[0] || {};
    const total = Number(a.total) || 0;
    const promoters = Number(a.promoters) || 0;
    const detractors = Number(a.detractors) || 0;
    const score = total ? Math.round(100 * (promoters - detractors) / total) : null;

    const reasonsR = await query(
      `SELECT detractor_q1 reason, COUNT(*)::int count
         FROM survey_responses sr
        WHERE sr.customer_id = $1 AND sr.completed_at >= NOW() - ($2)::interval
          AND lower(sr.path) = 'detractor' AND sr.detractor_q1 IS NOT NULL${tClause}
        GROUP BY 1 ORDER BY count DESC LIMIT 6`,
      params
    ).catch(() => ({ rows: [] }));

    res.json({
      nps: {
        score, total, scoreDelta: null,
        promoters, passives: Number(a.passives) || 0, detractors,
        wouldReturnPct: Number(a.would_return_pct) || 0,
        reasons: reasonsR.rows.map((r) => ({ reason: r.reason, count: Number(r.count) })),
      },
    });
  } catch (err) {
    logger.error('GET /reports/survey-nps error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
