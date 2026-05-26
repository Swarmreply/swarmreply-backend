// ============================================
// routes/nps.js
// Merge into backend/routes/index.js
//
// PUBLIC routes — called by the survey page
//   GET  /survey/:token          → survey data
//   POST /survey/:token/respond  → submit score
//   POST /survey/:token/followup → submit text feedback
//
// PRIVATE routes — authenticated dashboard
//   GET  /nps/:locationId/config    → get settings
//   PUT  /nps/:locationId/config    → update settings
//   POST /nps/:locationId/send      → send a survey
//   GET  /nps/:locationId/analytics → NPS data
//   GET  /nps/:locationId/history   → send history
//   POST /nps/:locationId/preview   → preview email
// ============================================

const npsService = require('../services/npsService');

// ============================================
// PUBLIC — no auth
// ============================================

// GET /api/survey/:token
// Returns survey data to render the page
router.get('/survey/:token', async (req, res) => {
  // CORS — survey page is served from swarmreply.com
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const data = await npsService.getSurveyByToken(req.params.token);
    if (!data) return res.status(404).json({ error: 'Survey not found' });
    res.json(data);
  } catch (err) {
    logger.error('Get survey error:', err.message);
    res.status(500).json({ error: 'Failed to load survey' });
  }
});

// POST /api/survey/:token/respond
// Customer submits their NPS score
router.post('/survey/:token/respond', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { score } = req.body;
  if (score === undefined || score === null) {
    return res.status(400).json({ error: 'Score is required' });
  }

  try {
    const result = await npsService.recordResponse(
      req.params.token,
      parseInt(score),
      null,
      {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent']
      }
    );
    res.json(result);
  } catch (err) {
    logger.error('Record NPS response error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/survey/:token/followup
// Customer submits optional follow-up text
router.post('/survey/:token/followup', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { text } = req.body;

  try {
    await query(
      `UPDATE survey_sends SET
         followup_text = $1,
         updated_at    = NOW()
       WHERE token = $2`,
      [text || '', req.params.token]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error('Record followup error:', err.message);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

// OPTIONS preflight for CORS
router.options('/survey/:token', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// ============================================
// PRIVATE — requires auth
// ============================================

// GET /api/nps/:locationId/config
router.get('/nps/:locationId/config', requireAuth, async (req, res) => {
  try {
    const config = await npsService.getConfig(req.params.locationId);
    res.json({ config });
  } catch (err) {
    logger.error('Get NPS config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/nps/:locationId/config
router.put('/nps/:locationId/config', requireAuth, async (req, res) => {
  try {
    const config = await npsService.updateConfig(req.params.locationId, req.body);
    res.json({ config });
  } catch (err) {
    logger.error('Update NPS config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/nps/:locationId/send
// Send a survey to one contact manually
router.post('/nps/:locationId/send', requireAuth, async (req, res) => {
  const { contact, channel } = req.body;
  if (!contact?.name || (!contact?.email && !contact?.phone)) {
    return res.status(400).json({ error: 'Contact name + email or phone required' });
  }
  try {
    const result = await npsService.sendSurvey({
      locationId: req.params.locationId,
      contact,
      channel,
      triggeredBy: 'manual'
    });
    res.json(result);
  } catch (err) {
    logger.error('Send survey error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/nps/:locationId/analytics
router.get('/nps/:locationId/analytics', requireAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const data = await npsService.getNpsAnalytics(req.params.locationId, days);
    res.json(data);
  } catch (err) {
    logger.error('NPS analytics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/nps/:locationId/history
router.get('/nps/:locationId/history', requireAuth, async (req, res) => {
  try {
    const history = await npsService.getSurveyHistory(
      req.params.locationId,
      parseInt(req.query.limit) || 30
    );
    res.json({ history });
  } catch (err) {
    logger.error('NPS history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/nps/:locationId/preview-email
// Returns the HTML of the survey email for dashboard preview
router.post('/nps/:locationId/preview-email', requireAuth, async (req, res) => {
  try {
    const config = await npsService.getConfig(req.params.locationId);
    const html   = npsService.buildEmailHtml
      ? npsService.buildEmailHtml(config, { name: 'Jane Smith' }, '#preview-link')
      : '<p>Preview not available</p>';
    res.json({ html });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
