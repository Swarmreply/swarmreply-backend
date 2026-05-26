// ============================================
// routes/data.js
// Merge into backend/routes/index.js
// ============================================

const dataService = require('../services/dataService');

// GET /api/data/:locationId
// Returns all new metrics in one call
router.get('/data/:locationId', requireAuth, async (req, res) => {
  try {
    const data = await dataService.getAllDataMetrics(
      req.params.locationId,
      {
        days:   parseInt(req.query.days)   || 30,
        weeks:  parseInt(req.query.weeks)  || 12,
        months: parseInt(req.query.months) || 12
      }
    );
    res.json(data);
  } catch (err) {
    logger.error('Data metrics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Individual endpoints for granular control
router.get('/data/:locationId/quality',  requireAuth, async (req, res) => {
  try { res.json(await dataService.getReplyQuality(req.params.locationId, parseInt(req.query.days) || 30)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/data/:locationId/velocity', requireAuth, async (req, res) => {
  try { res.json(await dataService.getReviewVelocity(req.params.locationId, parseInt(req.query.weeks) || 12)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/data/:locationId/ratings',  requireAuth, async (req, res) => {
  try { res.json(await dataService.getRatingHistory(req.params.locationId, parseInt(req.query.months) || 12)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/data/:locationId/hours',    requireAuth, async (req, res) => {
  try { res.json(await dataService.getHourOfDayAnalysis(req.params.locationId, parseInt(req.query.days) || 90)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/data/:locationId/surveys',  requireAuth, async (req, res) => {
  try { res.json(await dataService.getSurveyTrends(req.params.locationId, parseInt(req.query.weeks) || 12)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
