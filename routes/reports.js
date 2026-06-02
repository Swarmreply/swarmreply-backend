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

module.exports = router;
