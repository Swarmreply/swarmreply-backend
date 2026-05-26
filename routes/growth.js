// ============================================
// routes/growth.js
// All Growth & Agency plan API routes
// Merge into backend/routes/index.js
// ============================================

const competitorService = require('../services/competitorService');
const calendarService = require('../services/calendarService');
const variationEngine = require('../services/variationEngine');
const multiLanguageService = require('../services/multiLanguageService');

// ============================================
// PLAN GATE MIDDLEWARE
// Blocks Starter plan from Growth+ features
// ============================================
async function requireGrowthPlan(req, res, next) {
  const customerId = req.headers['x-customer-id'];
  if (!customerId) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const result = await query(
      'SELECT plan FROM customers WHERE id = $1',
      [customerId]
    );
    const plan = result.rows[0]?.plan;
    if (!['growth', 'agency'].includes(plan)) {
      return res.status(403).json({
        error: 'This feature requires the Growth or Agency plan',
        upgradeUrl: 'https://swarmreply.com/#pricing'
      });
    }
    next();
  } catch (error) {
    res.status(500).json({ error: 'Plan check failed' });
  }
}

// ============================================
// COMPETITOR BENCHMARKING ROUTES
// ============================================

// GET /api/competitors/:locationId
// Get competitor benchmark data
router.get('/competitors/:locationId', requireGrowthPlan, async (req, res) => {
  try {
    const data = await competitorService.getCompetitorBenchmark(req.params.locationId);
    res.json(data);
  } catch (error) {
    logger.error('Get competitors error:', error.message);
    res.status(500).json({ error: 'Failed to fetch competitor data' });
  }
});

// POST /api/competitors/:locationId/refresh
// Trigger fresh competitor search from Google Places
router.post('/competitors/:locationId/refresh', requireGrowthPlan, async (req, res) => {
  try {
    const competitors = await competitorService.findCompetitors(
      req.params.locationId,
      req.body.radiusMeters || 1500
    );
    res.json({ competitors, count: competitors.length });
  } catch (error) {
    logger.error('Refresh competitors error:', error.message);
    res.status(500).json({ error: 'Failed to refresh competitor data — ensure location has coordinates set' });
  }
});

// PUT /api/locations/:locationId/coordinates
// Update location coordinates for competitor search
router.put('/locations/:locationId/coordinates', async (req, res) => {
  const { latitude, longitude, googlePlaceId } = req.body;
  if (!latitude || !longitude) {
    return res.status(400).json({ error: 'latitude and longitude are required' });
  }
  try {
    await query(
      `UPDATE locations SET latitude = $1, longitude = $2, google_place_id = $3, updated_at = NOW()
       WHERE id = $4`,
      [latitude, longitude, googlePlaceId || null, req.params.locationId]
    );
    res.json({ success: true });
  } catch (error) {
    logger.error('Update coordinates error:', error.message);
    res.status(500).json({ error: 'Failed to update coordinates' });
  }
});

// ============================================
// REVIEW VOLUME CALENDAR ROUTES
// ============================================

// GET /api/calendar/:locationId?months=12
// Get calendar heatmap data
router.get('/calendar/:locationId', requireGrowthPlan, async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 12;
    const data = await calendarService.getCalendarData(req.params.locationId, months);
    res.json(data);
  } catch (error) {
    logger.error('Get calendar error:', error.message);
    res.status(500).json({ error: 'Failed to fetch calendar data' });
  }
});

// ============================================
// VARIATION ENGINE ROUTES
// ============================================

// GET /api/variation/:locationId/score
// Get variation score for a location
router.get('/variation/:locationId/score', requireGrowthPlan, async (req, res) => {
  try {
    const score = await variationEngine.getVariationScore(req.params.locationId);
    res.json(score);
  } catch (error) {
    logger.error('Get variation score error:', error.message);
    res.status(500).json({ error: 'Failed to calculate variation score' });
  }
});

// ============================================
// MULTI-LANGUAGE ROUTES
// ============================================

// GET /api/languages/supported
// Get list of supported languages
router.get('/languages/supported', (req, res) => {
  res.json({ languages: multiLanguageService.SUPPORTED_LANGUAGES });
});

// POST /api/languages/detect
// Detect language of a text string
router.post('/languages/detect', requireGrowthPlan, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    const result = await multiLanguageService.detectLanguage(text);
    res.json(result);
  } catch (error) {
    logger.error('Language detection error:', error.message);
    res.status(500).json({ error: 'Language detection failed' });
  }
});
