// ============================================
// routes/llmMonitor.js
// LLM Reputation Monitoring API
//
// GET  /api/llm/report          Latest scan report
// GET  /api/llm/history         Score history (chart data)
// POST /api/llm/scan            Trigger a manual scan
// GET  /api/llm/settings        Monitor configuration
// PUT  /api/llm/settings        Update configuration
// ============================================

const express = require('express');
const router  = express.Router();
const llm     = require('../services/llmMonitorService');
const { authenticateToken } = require('../middleware/auth');
const logger  = require('../utils/logger');

// GET /api/llm/report
router.get('/report', authenticateToken, async (req, res) => {
  try {
    const report = await llm.getLatestReport(req.user.locationId);
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/llm/history
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const { weeks = 8 } = req.query;
    const history = await llm.getHistoricalScores(req.user.locationId, parseInt(weeks));
    res.json({ success: true, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/llm/scan
// Trigger a manual scan — runs async, returns immediately
router.post('/scan', authenticateToken, async (req, res) => {
  try {
    const config = await llm.getOrCreateConfig(req.user.locationId);
    if (!config.is_active) {
      return res.status(400).json({ error: 'LLM monitoring is not enabled for this location' });
    }

    // Start scan async — don't block the response
    llm.runScan(req.user.locationId)
      .then(result => logger.info(`Manual scan complete: score=${result.visibilityScore}`))
      .catch(err  => logger.error(`Manual scan failed: ${err.message}`));

    res.json({ success: true, message: 'Scan started — check back in a few minutes for results' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/llm/settings
router.get('/settings', authenticateToken, async (req, res) => {
  try {
    const config = await llm.getOrCreateConfig(req.user.locationId);
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/llm/settings
router.put('/settings', authenticateToken, async (req, res) => {
  try {
    const config = await llm.updateConfig(req.user.locationId, req.body);
    res.json({ success: true, config });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// ── QUERY MANAGEMENT ─────────────────────────────────────────────────────────
const MAX_QUERIES     = 32;
const MAX_CUSTOM      = 24; // 8 auto-generated + up to 24 custom = 32 max

// GET /api/llm/queries
// Returns auto-generated + custom queries, locked state, and next scan time
router.get('/queries', authenticateToken, async (req, res) => {
  try {
    const { query } = require('../database/db');
    const llm = require('../services/llmMonitorService');

    // Get location + business info
    const locResult = await query(
      `SELECT l.business_name, l.business_type, l.city, l.state,
              lmc.custom_queries, lmc.next_scan_at, lmc.last_scan_at,
              lmc.scan_frequency
       FROM locations l
       JOIN llm_monitor_configs lmc ON lmc.location_id = l.id
       WHERE l.id = $1`,
      [req.user.locationId]
    );

    if (!locResult.rows[0]) {
      return res.status(404).json({ error: 'Monitor config not found' });
    }

    const biz = locResult.rows[0];
    const autoQueries    = llm.buildQueries(biz);
    const customQueries  = biz.custom_queries || [];

    // Queries are locked from 24h before the next scan until it completes
    const now            = new Date();
    const nextScan       = biz.next_scan_at ? new Date(biz.next_scan_at) : null;
    const hoursUntilScan = nextScan ? (nextScan - now) / 1000 / 3600 : null;
    const locked         = hoursUntilScan !== null && hoursUntilScan < 24;

    res.json({
      success:       true,
      autoQueries,
      customQueries,
      totalQueries:  autoQueries.length + customQueries.length,
      maxQueries:    MAX_QUERIES,
      maxCustom:     MAX_CUSTOM,
      remainingSlots: Math.max(0, MAX_CUSTOM - customQueries.length),
      locked,
      lockReason:    locked ? `Queries are locked within 24h of your next scan (${nextScan?.toISOString()})` : null,
      nextScanAt:    biz.next_scan_at,
      lastScanAt:    biz.last_scan_at,
    });
  } catch (err) {
    logger.error('Get queries error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/llm/queries
// Replace the full custom queries list
// Body: { customQueries: string[] }
router.put('/queries', authenticateToken, async (req, res) => {
  try {
    const { query } = require('../database/db');
    const llm = require('../services/llmMonitorService');
    const { customQueries } = req.body;

    if (!Array.isArray(customQueries)) {
      return res.status(400).json({ error: 'customQueries must be an array' });
    }

    // Check lock
    const cfg = await query(
      `SELECT next_scan_at FROM llm_monitor_configs WHERE location_id = $1`,
      [req.user.locationId]
    );

    if (cfg.rows[0]?.next_scan_at) {
      const hoursUntil = (new Date(cfg.rows[0].next_scan_at) - new Date()) / 1000 / 3600;
      if (hoursUntil < 24 && hoursUntil > 0) {
        return res.status(409).json({
          error: `Queries are locked within 24 hours of your scheduled scan. You can edit them again after the scan completes.`,
          locked: true,
          nextScanAt: cfg.rows[0].next_scan_at
        });
      }
    }

    // Get auto count to enforce total max
    const locResult = await query(
      `SELECT l.business_name, l.business_type, l.city, l.state
       FROM locations l WHERE l.id = $1`,
      [req.user.locationId]
    );
    const autoCount = llm.buildQueries(locResult.rows[0] || {}).length;
    const maxCustom = MAX_QUERIES - autoCount;

    if (customQueries.length > maxCustom) {
      return res.status(400).json({
        error: `Maximum ${MAX_QUERIES} total queries. You have ${autoCount} auto-generated, so you can add up to ${maxCustom} custom queries.`,
        maxCustom
      });
    }

    // Validate — no empty strings, max 200 chars each
    const cleaned = customQueries
      .map(q => String(q).trim())
      .filter(q => q.length > 0)
      .map(q => q.slice(0, 200));

    const deduped = [...new Set(cleaned)];

    await query(
      `UPDATE llm_monitor_configs
       SET custom_queries = $2, updated_at = NOW()
       WHERE location_id = $1`,
      [req.user.locationId, deduped]
    );

    logger.info(`Custom queries updated for location ${req.user.locationId}: ${deduped.length} queries`);
    res.json({
      success:       true,
      customQueries: deduped,
      totalQueries:  autoCount + deduped.length,
      remainingSlots: Math.max(0, maxCustom - deduped.length)
    });
  } catch (err) {
    logger.error('Update queries error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
