// ============================================
// routes/platforms.js
// Multi-platform review management API
//
// Facebook OAuth:
//   GET  /api/platforms/facebook/connect     Start OAuth
//   GET  /api/platforms/facebook/callback    OAuth callback
//   GET  /api/platforms/facebook/pages       List available pages
//   POST /api/platforms/facebook/page        Select a page
//   POST /api/platforms/facebook/disconnect  Disconnect
//   GET  /api/platforms/facebook/status      Connection status
//
// Review destinations (all platforms):
//   GET  /api/platforms/destinations              All destinations
//   POST /api/platforms/destinations/yelp         Add Yelp URL
//   POST /api/platforms/destinations/custom       Add custom URL
//   POST /api/platforms/destinations/reorder      Reorder
//   PUT  /api/platforms/destinations/:platform    Update
//   DEL  /api/platforms/destinations/:platform    Disable
//
// Platform summary:
//   GET  /api/platforms/summary                   All platform statuses
// ============================================

const express         = require('express');
const router          = express.Router();
const facebookService = require('../services/facebookService');
const platformService = require('../services/platformService');
const { authenticateToken } = require('../middleware/auth');
const logger          = require('../utils/logger');

// ════════════════════════════════════════════
// FACEBOOK OAUTH
// ════════════════════════════════════════════

// GET /api/platforms/facebook/connect
// Returns the Facebook OAuth URL — frontend redirects user there
router.get('/facebook/connect', authenticateToken, (req, res) => {
  try {
    const url = facebookService.getAuthUrl(req.user.locationId);
    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate auth URL' });
  }
});

// GET /api/platforms/facebook/callback
// Facebook redirects here after user authorizes
// NOTE: This is called by Facebook directly — no auth token in query
router.get('/facebook/callback', async (req, res) => {
  try {
    const { code, state: locationId, error } = req.query;

    if (error) {
      logger.warn('Facebook OAuth denied:', error);
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard/integrations?fb=denied`);
    }

    if (!code || !locationId) {
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard/integrations?fb=error`);
    }

    const result = await facebookService.handleCallback(code, locationId);

    logger.info(`Facebook connected: ${result.pageName} for location ${locationId}`);
    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard/integrations?fb=connected&page=${encodeURIComponent(result.pageName)}`
    );
  } catch (err) {
    logger.error('Facebook callback error:', err.message);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard/integrations?fb=error&msg=${encodeURIComponent(err.message)}`);
  }
});

// GET /api/platforms/facebook/pages
// List all Facebook Pages the user manages — for page picker UI
router.get('/facebook/pages', authenticateToken, async (req, res) => {
  try {
    const pages = await facebookService.getAvailablePages(req.user.locationId);
    res.json({ success: true, pages });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/platforms/facebook/page
// Select which page to monitor
router.post('/facebook/page', authenticateToken, async (req, res) => {
  try {
    const { pageId, pageAccessToken, pageName } = req.body;
    if (!pageId || !pageAccessToken) {
      return res.status(400).json({ error: 'pageId and pageAccessToken required' });
    }
    await facebookService.selectPage(req.user.locationId, pageId, pageAccessToken, pageName);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/platforms/facebook/disconnect
router.post('/facebook/disconnect', authenticateToken, async (req, res) => {
  try {
    await facebookService.disconnect(req.user.locationId);
    await platformService.disableDestination(req.user.locationId, 'facebook');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/platforms/facebook/status
router.get('/facebook/status', authenticateToken, async (req, res) => {
  try {
    const status = await facebookService.getStatus(req.user.locationId);
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ════════════════════════════════════════════
// REVIEW DESTINATIONS
// ════════════════════════════════════════════

// GET /api/platforms/destinations
router.get('/destinations', authenticateToken, async (req, res) => {
  try {
    const destinations = await platformService.getDestinations(req.user.locationId);
    res.json({ success: true, destinations });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/platforms/destinations/yelp
// Add or update Yelp business URL
router.post('/destinations/yelp', authenticateToken, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });

    // Validate it looks like a Yelp URL
    if (!url.includes('yelp.com')) {
      return res.status(400).json({ error: 'Please enter a valid Yelp business URL' });
    }

    const reviewUrl = await platformService.addYelpDestination(req.user.locationId, url);
    res.json({ success: true, reviewUrl });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/platforms/destinations/custom
// Add a custom review platform link
router.post('/destinations/custom', authenticateToken, async (req, res) => {
  try {
    const { label, url } = req.body;
    if (!label || !url) return res.status(400).json({ error: 'label and url required' });

    const dest = await platformService.upsertDestination(req.user.locationId, {
      platform: 'custom',
      label,
      url,
      icon:      '🔗',
      sortOrder: 99
    });
    res.json({ success: true, destination: dest });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/platforms/destinations/reorder
// Set platform display order for templates and surveys
router.post('/destinations/reorder', authenticateToken, async (req, res) => {
  try {
    const { order } = req.body; // ['google', 'facebook', 'yelp']
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array' });

    await platformService.reorderDestinations(req.user.locationId, order);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/platforms/destinations/:platform
router.delete('/destinations/:platform', authenticateToken, async (req, res) => {
  try {
    await platformService.disableDestination(req.user.locationId, req.params.platform);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════

// GET /api/platforms/summary
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const summary = await platformService.getPlatformSummary(req.user.locationId);
    res.json({ success: true, summary });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
