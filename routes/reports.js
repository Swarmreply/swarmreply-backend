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
// COMPETITORS — Reports › Competitors
// Combines two data sources we already collect:
//  1. Google Places nearby benchmark (rating + review count, snapshotted daily)
//  2. AI-perceived competitors from the latest LLM visibility scan
// Day-one, zero customer effort: coordinates are resolved from the business
// name + city, and the nearby scan auto-runs in the background on first load.
// ============================================

// In-flight background scans, so rapid refetches don't launch duplicates.
const scanningLocations = new Set();

async function primaryLocationId(customerId) {
  const r = await query(
    'SELECT id FROM locations WHERE customer_id=$1 ORDER BY created_at ASC LIMIT 1',
    [customerId]
  ).catch(() => ({ rows: [] }));
  return r.rows[0] ? r.rows[0].id : null;
}

async function getAiCompetitors(customerId) {
  const r = await query(
    `SELECT report_data FROM llm_reports
      WHERE customer_id=$1 ORDER BY last_scan_at DESC NULLS LAST LIMIT 1`,
    [customerId]
  ).catch(() => ({ rows: [] }));
  const data = (r.rows[0] && r.rows[0].report_data) || {};
  const list = Array.isArray(data.topCompetitors) ? data.topCompetitors : [];
  // Normalise across the shapes we store ({competitor,mentions} or {name,reasons}).
  return list
    .map(c => ({
      name: c.competitor || c.name || '',
      mentions: c.mentions != null ? Number(c.mentions) : null,
      reasons: Array.isArray(c.reasons) ? c.reasons : [],
    }))
    .filter(c => c.name);
}

// GET /api/reports/competitors
router.get('/competitors', authenticateToken, async (req, res) => {
  const customerId = req.user.customerId || req.user.id;
  try {
    const locationId = await primaryLocationId(customerId);
    const aiCompetitors = await getAiCompetitors(customerId);

    if (!locationId) {
      return res.json({ benchmark: { hasData: false, reason: 'no_location' }, aiCompetitors, scanning: false });
    }

    const benchmark = await competitorService.getCompetitorBenchmark(locationId)
      .catch(() => ({ hasData: false }));

    // Day-one, zero-effort: with no nearby benchmark yet, kick off a background
    // scan (non-blocking) so it populates for the next load.
    let isScanning = scanningLocations.has(locationId);
    if (!benchmark.hasData && process.env.GOOGLE_PLACES_API_KEY && !isScanning) {
      scanningLocations.add(locationId);
      isScanning = true;
      competitorService.findCompetitors(locationId)
        .catch(e => logger.warn('competitor background scan failed: ' + e.message))
        .finally(() => scanningLocations.delete(locationId));
    }

    res.json({ benchmark, aiCompetitors, scanning: isScanning });
  } catch (err) {
    logger.error('Reports competitors error:', err.message);
    res.status(500).json({ error: 'Failed to load competitors' });
  }
});

// POST /api/reports/competitors/refresh — re-run the nearby scan on demand.
router.post('/competitors/refresh', authenticateToken, async (req, res) => {
  const customerId = req.user.customerId || req.user.id;
  try {
    const locationId = await primaryLocationId(customerId);
    if (!locationId) return res.status(400).json({ error: 'No location to scan' });
    if (!process.env.GOOGLE_PLACES_API_KEY) {
      return res.status(503).json({ error: 'Competitor scanning is not configured yet.' });
    }
    await competitorService.findCompetitors(locationId);
    const benchmark = await competitorService.getCompetitorBenchmark(locationId);
    res.json({ benchmark });
  } catch (err) {
    logger.error('Competitor refresh error:', err.message);
    res.status(500).json({ error: err.message || 'Refresh failed' });
  }
});

module.exports = router;
