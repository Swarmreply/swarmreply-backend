// ============================================
// routes/surveys.js
// Merge into backend/routes/index.js
//
// PUBLIC (no auth) — the survey itself
//   GET  /survey/:token          → survey data
//   POST /survey/:token/respond  → submit score
//
// PRIVATE (auth required) — dashboard
//   GET  /surveys/:locationId/config    → get settings
//   PUT  /surveys/:locationId/config    → update settings
//   POST /surveys/:locationId/send      → manual send
//   GET  /surveys/:locationId/analytics → full analytics
//   GET  /surveys/:locationId/history   → send history
// ============================================

const surveyService = require('../services/surveyService');

// ── PUBLIC ROUTES ────────────────────────────

// GET /api/survey/:token
// Loads the survey data — called by the public survey page
router.get('/survey/:token', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const data = await surveyService.getSurveyData(req.params.token);
    if (!data) return res.status(404).json({ error: 'Survey not found or expired' });
    res.json(data);
  } catch (err) {
    logger.error('Get survey error:', err.message);
    res.status(500).json({ error: 'Failed to load survey' });
  }
});

// POST /api/survey/:token/respond
// Called when the customer submits their score
router.post('/survey/:token/respond', async (req, res) => {
  const { score, followupText, redirectedToReview } = req.body;

  if (score === undefined || score === null) {
    return res.status(400).json({ error: 'score is required' });
  }

  try {
    const result = await surveyService.submitResponse(
      req.params.token,
      { score: parseInt(score), followupText, redirectedToReview }
    );
    res.json(result);
  } catch (err) {
    logger.error('Submit survey response error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ── DASHBOARD ROUTES (AUTH) ───────────────────

// GET /api/surveys/:locationId/config
router.get('/surveys/:locationId/config', requireAuth, async (req, res) => {
  try {
    const config = await surveyService.getConfig(req.params.locationId);
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/surveys/:locationId/config
router.put('/surveys/:locationId/config', requireAuth, async (req, res) => {
  try {
    const updated = await surveyService.updateConfig(req.params.locationId, req.body);
    res.json({ config: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/surveys/:locationId/send
// Manual send from the dashboard
router.post('/surveys/:locationId/send', requireAuth, async (req, res) => {
  const { name, email, phone, visitDate } = req.body;
  if (!name || (!email && !phone)) {
    return res.status(400).json({ error: 'name and email or phone required' });
  }
  try {
    const results = await surveyService.sendSurvey({
      locationId: req.params.locationId,
      contact:    { name, email, phone, visitDate },
      source:     'manual'
    });
    res.json({ success: true, results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/surveys/:locationId/analytics
router.get('/surveys/:locationId/analytics', requireAuth, async (req, res) => {
  try {
    const data = await surveyService.getAnalytics(
      req.params.locationId,
      parseInt(req.query.days) || 30
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/surveys/:locationId/history
router.get('/surveys/:locationId/history', requireAuth, async (req, res) => {
  try {
    const history = await surveyService.getSendHistory(
      req.params.locationId,
      parseInt(req.query.limit) || 30
    );
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
