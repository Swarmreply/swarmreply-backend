// ============================================
// routes/listings.js
// Merge into backend/routes/index.js
// ============================================

const listingsService = require('../services/listingsService');

// GET /api/listings/:locationId
// Full dashboard data — NAP, all platforms, score, history
router.get('/listings/:locationId', requireAuth, async (req, res) => {
  try {
    const data = await listingsService.getListingsDashboard(req.params.locationId);
    res.json(data);
  } catch (err) {
    logger.error('Get listings dashboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/listings/:locationId/nap
// Update the canonical NAP data
router.put('/listings/:locationId/nap', requireAuth, async (req, res) => {
  try {
    const data = await listingsService.updateCanonicalNAP(req.params.locationId, req.body);
    res.json(data);
  } catch (err) {
    logger.error('Update NAP error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/listings/:locationId/sync
// Push canonical data to ALL platforms
router.post('/listings/:locationId/sync', requireAuth, async (req, res) => {
  try {
    const results = await listingsService.pushToAllPlatforms(req.params.locationId);
    res.json({ success: true, results });
  } catch (err) {
    logger.error('Sync all platforms error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/listings/:locationId/sync/:platform
// Push canonical data to ONE platform
router.post('/listings/:locationId/sync/:platform', requireAuth, async (req, res) => {
  try {
    const result = await listingsService.pushToOnePlatform(
      req.params.locationId,
      req.params.platform
    );
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error(`Sync ${req.params.platform} error:`, err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/listings/:locationId/scan
// Fetch current state from all platforms + detect divergences
router.post('/listings/:locationId/scan', requireAuth, async (req, res) => {
  try {
    const locResult = await query(
      'SELECT * FROM locations WHERE id = $1',
      [req.params.locationId]
    );
    if (!locResult.rows.length) {
      return res.status(404).json({ error: 'Location not found' });
    }
    await listingsService.syncLocation(locResult.rows[0]);
    const data = await listingsService.getListingsDashboard(req.params.locationId);
    res.json(data);
  } catch (err) {
    logger.error('Scan listings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
