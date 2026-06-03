// routes/rankTracking.js — Item 13
const express = require('express');
const router  = express.Router();
const { query }             = require('../database/db');
const { authenticateToken } = require('../middleware/auth');
const rank = require('../services/rankTrackingService');
const logger = require('../utils/logger');
const { captureError } = require('../utils/sentry');

async function getLocationId(customerId) {
  const r = await query('SELECT id FROM locations WHERE customer_id=$1 LIMIT 1',[customerId]);
  return r.rows[0]?.id;
}

// GET /api/rank — get full rank history for dashboard
router.get('/', authenticateToken, async (req, res) => {
  try {
    const locationId = await getLocationId(req.user.customerId);
    if (!locationId) return res.json({ keywords: [], lastChecked: null });
    const days    = parseInt(req.query.days) || 90;
    const history = await rank.getRankHistory(locationId, days);
    // Get last check time
    const lastRes = await query(
      'SELECT MAX(checked_at) as last FROM rank_results WHERE location_id=$1',[locationId]
    );
    res.json({ success: true, keywords: history, lastChecked: lastRes.rows[0]?.last || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rank/keywords — add a custom keyword
router.post('/keywords', authenticateToken, async (req, res) => {
  const { keyword } = req.body;
  if (!keyword?.trim()) return res.status(400).json({ error: 'keyword is required' });
  try {
    const locationId = await getLocationId(req.user.customerId);
    if (!locationId) return res.status(404).json({ error: 'No location found' });
    await rank.addKeyword(locationId, keyword);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/rank/keywords/:id — remove a keyword
router.delete('/keywords/:id', authenticateToken, async (req, res) => {
  try {
    const locationId = await getLocationId(req.user.customerId);
    await rank.removeKeyword(locationId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rank/check — trigger a manual rank check
router.post('/check', authenticateToken, async (req, res) => {
  try {
    if (!process.env.DATAFORSEO_LOGIN || !process.env.DATAFORSEO_PASSWORD) {
      return res.status(502).json({ error: 'Rank tracking is not configured yet. Add your DataForSEO credentials.' });
    }
    const locationId = await getLocationId(req.user.customerId);
    if (!locationId) return res.status(404).json({ error: 'No location found' });
    // Run async — don't block the response
    rank.runRankCheck(locationId).catch(e => { logger.error('Manual rank check error:', e.message); captureError(e, { where: 'rank-check', locationId }); });
    res.json({ success: true, message: 'Rank check started — results available in a few minutes' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
