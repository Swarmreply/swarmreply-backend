// ============================================
// routes/widget.js
// Merge into backend/routes/index.js
//
// TWO groups of routes:
//
// PUBLIC (no auth) — called by the embedded widget
//   GET  /widget/:token          → JSON data
//   GET  /widget/:token/badge    → badge SVG
//
// PRIVATE (auth required) — called by the dashboard
//   GET  /widgets/:locationId           → get config
//   PUT  /widgets/:locationId           → update config
//   POST /widgets/:locationId/rotate    → rotate token
//   GET  /widgets/:locationId/analytics → view stats
//   GET  /widgets/:locationId/preview   → preview data
// ============================================

const widgetService = require('../services/widgetService');

// ============================================
// PUBLIC ROUTES
// No authentication — these are called by the
// widget script on customer websites
// ============================================

/**
 * GET /api/widget/:token
 *
 * The hot path — called on every page load
 * that has the widget installed.
 *
 * Returns CORS headers so any domain can call it.
 * Rate limited to 1000 req/min per token by nginx/Railway.
 */
router.get('/widget/:token', async (req, res) => {
  // CORS — any origin can load the widget
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  res.setHeader('Content-Type', 'application/json');

  try {
    const data = await widgetService.getWidgetData(req.params.token);

    if (!data) {
      return res.status(404).json({ error: 'Widget not found' });
    }

    res.json(data);

  } catch (err) {
    logger.error('Widget public API error:', err.message);
    res.status(500).json({ error: 'Failed to load widget data' });
  }
});

/**
 * GET /api/widget/:token/badge
 *
 * Returns a standalone SVG badge showing:
 * ★ 4.8  (124 reviews)
 * Powered by SwarmReply
 *
 * Useful for email signatures, second embed option.
 */
router.get('/widget/:token/badge', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Type', 'image/svg+xml');

  try {
    const data = await widgetService.getWidgetData(req.params.token);

    if (!data) {
      return res.status(404).send('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    }

    const rating = data.stats.avgRating.toFixed(1);
    const count  = data.stats.totalReviews;
    const accent = data.accentColor || '#f5c842';
    const stars  = '★'.repeat(Math.round(data.stats.avgRating)) +
                   '☆'.repeat(5 - Math.round(data.stats.avgRating));

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="60" viewBox="0 0 220 60">
  <rect width="220" height="60" rx="10" fill="white" stroke="#e4e0d8" stroke-width="1"/>
  <text x="12" y="22" font-family="sans-serif" font-size="11" font-weight="700" fill="#0a0a0a">${escapeXml(data.businessName)}</text>
  <text x="12" y="40" font-family="sans-serif" font-size="18" fill="${accent}">${stars}</text>
  <text x="108" y="40" font-family="sans-serif" font-size="16" font-weight="700" fill="#0a0a0a">${rating}</text>
  <text x="108" y="52" font-family="sans-serif" font-size="9" fill="#7a7670">${count} Google reviews</text>
</svg>`;

    res.send(svg);

  } catch (err) {
    logger.error('Widget badge error:', err.message);
    res.status(500).send('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  }
});

// ============================================
// PRIVATE DASHBOARD ROUTES
// These require authentication (middleware applied
// in main routes/index.js)
// ============================================

/**
 * GET /api/widgets/:locationId
 * Get or create widget config for a location
 */
router.get('/widgets/:locationId', requireAuth, async (req, res) => {
  try {
    const config = await widgetService.getOrCreateWidgetConfig(req.params.locationId);
    res.json({ widget: config });
  } catch (err) {
    logger.error('Get widget config error:', err.message);
    res.status(500).json({ error: 'Failed to fetch widget config' });
  }
});

/**
 * PUT /api/widgets/:locationId
 * Update widget settings from the dashboard builder
 */
router.put('/widgets/:locationId', requireAuth, async (req, res) => {
  try {
    const updated = await widgetService.updateWidgetConfig(
      req.params.locationId,
      req.body
    );
    res.json({ widget: updated });
  } catch (err) {
    logger.error('Update widget config error:', err.message);
    res.status(500).json({ error: 'Failed to update widget' });
  }
});

/**
 * POST /api/widgets/:locationId/rotate
 * Generate a new widget token (invalidates old embed code)
 */
router.post('/widgets/:locationId/rotate', requireAuth, async (req, res) => {
  try {
    const newToken = await widgetService.rotateWidgetToken(req.params.locationId);
    res.json({
      token: newToken,
      message: 'Widget token rotated. Update the embed code on your website.'
    });
  } catch (err) {
    logger.error('Rotate token error:', err.message);
    res.status(500).json({ error: 'Failed to rotate token' });
  }
});

/**
 * GET /api/widgets/:locationId/analytics
 * View stats for the dashboard
 */
router.get('/widgets/:locationId/analytics', requireAuth, async (req, res) => {
  try {
    const analytics = await widgetService.getWidgetAnalytics(req.params.locationId);
    res.json({ analytics });
  } catch (err) {
    logger.error('Widget analytics error:', err.message);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

/**
 * GET /api/widgets/:locationId/preview
 * Returns the same data as the public endpoint
 * but requires authentication — for the live preview
 * in the dashboard builder
 */
router.get('/widgets/:locationId/preview', requireAuth, async (req, res) => {
  try {
    const config = await widgetService.getOrCreateWidgetConfig(req.params.locationId);
    const data   = await widgetService.getWidgetData(config.widget_token);
    res.json(data || { reviews: [], stats: { avgRating: 0, totalReviews: 0 } });
  } catch (err) {
    logger.error('Widget preview error:', err.message);
    res.status(500).json({ error: 'Failed to load preview' });
  }
});

// ============================================
// HELPER
// ============================================
function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
