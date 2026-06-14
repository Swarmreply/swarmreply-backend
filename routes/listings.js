// ============================================
// routes/listings.js
// Listings Health V1 API.
// Wires the listings sync engine (listingsService) +
// the guided-directory tier into the dashboard.
// Mounted at /api/listings
// ============================================

const express = require('express');
const router  = express.Router();
const { query } = require('../database/db');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const listingsService = require('../services/listingsService');

const MONITORED_DIRECTORIES = ['facebook', 'foursquare'];

// Every route: the location must belong to the caller's customer
async function ownLocation(req, res) {
  const r = await query(
    'SELECT id FROM locations WHERE id = $1 AND customer_id = $2',
    [req.params.locationId, req.user.customerId]
  );
  if (!r.rows.length) {
    res.status(404).json({ error: 'Location not found' });
    return false;
  }
  return true;
}

async function getDirectories(locationId) {
  const res = await query(
    `SELECT directory, status, note, verified_at, last_checked_at,
            found_name, found_phone, found_address, diverged_fields
     FROM listing_directories WHERE location_id = $1`,
    [locationId]
  );
  const byKey = Object.fromEntries(res.rows.map(r => [r.directory, r]));

  // Is Facebook actively connected for this location?
  const fb = await query(
    `SELECT is_active FROM connected_platforms
     WHERE location_id = $1 AND platform = 'facebook' AND is_active = true`,
    [locationId]
  ).catch(() => ({ rows: [] }));
  const facebookConnected = fb.rows.length > 0;

  // Foursquare monitoring is on once the server-side key exists (it's our key, not the customer's)
  const foursquareEnabled = !!process.env.FOURSQUARE_API_KEY;

  return MONITORED_DIRECTORIES.map(d => ({
    directory: d,
    status: byKey[d]?.status || 'not_setup',
    note: byKey[d]?.note || null,
    verified_at: byKey[d]?.verified_at || null,
    last_checked_at: byKey[d]?.last_checked_at || null,
    found_name: byKey[d]?.found_name || null,
    found_phone: byKey[d]?.found_phone || null,
    found_address: byKey[d]?.found_address || null,
    diverged_fields: byKey[d]?.diverged_fields || null,
    connected: d === 'facebook' ? facebookConnected : foursquareEnabled,
    keyGated: d === 'foursquare',
  }));
}

// GET /api/listings/:locationId — full dashboard
router.get('/:locationId', authenticateToken, async (req, res) => {
  try {
    if (!(await ownLocation(req, res))) return;
    const [dashboard, directories, gc] = await Promise.all([
      listingsService.getListingsDashboard(req.params.locationId),
      getDirectories(req.params.locationId),
      query('SELECT (refresh_token IS NOT NULL) AS connected FROM locations WHERE id = $1', [req.params.locationId]).catch(() => ({ rows: [] })),
    ]);
    const googleConnected = !!gc.rows[0]?.connected;
    res.json({ ...dashboard, directories, googleConnected });
  } catch (err) {
    logger.error('Listings dashboard error:', err.message);
    res.status(500).json({ error: 'Could not load listings' });
  }
});

// PUT /api/listings/:locationId — save canonical business info
router.put('/:locationId', authenticateToken, async (req, res) => {
  try {
    if (!(await ownLocation(req, res))) return;
    const dashboard = await listingsService.updateCanonicalNAP(req.params.locationId, req.body || {});
    const directories = await getDirectories(req.params.locationId);
    res.json({ ...dashboard, directories });
  } catch (err) {
    logger.error('Listings save error:', err.message);
    res.status(500).json({ error: 'Could not save business info' });
  }
});

// POST /api/listings/:locationId/push — push canonical to platform(s)
// body: { platform?: 'google' | 'apple' | 'bing' }  (omit = all connected)
router.post('/:locationId/push', authenticateToken, async (req, res) => {
  try {
    if (!(await ownLocation(req, res))) return;
    const { platform } = req.body || {};
    let results;
    if (platform) {
      try {
        results = { [platform]: { success: true, ...(await listingsService.pushToOnePlatform(req.params.locationId, platform)) } };
      } catch (e) {
        results = { [platform]: { success: false, error: e.message } };
      }
    } else {
      results = await listingsService.pushToAllPlatforms(req.params.locationId);
    }
    res.json({ results });
  } catch (err) {
    logger.error('Listings push error:', err.message);
    res.status(500).json({ error: err.message || 'Push failed' });
  }
});

// PUT /api/listings/:locationId/directories/:directory — guided status
// body: { status: 'not_setup' | 'verified' | 'attention', note? }
router.put('/:locationId/directories/:directory', authenticateToken, async (req, res) => {
  try {
    if (!(await ownLocation(req, res))) return;
    const { directory } = req.params;
    const { status, note } = req.body || {};
    if (!MONITORED_DIRECTORIES.includes(directory)) return res.status(400).json({ error: 'Unknown directory' });
    if (!['not_setup', 'verified', 'attention'].includes(status)) return res.status(400).json({ error: 'Unknown status' });
    await query(
      `INSERT INTO listing_directories (location_id, directory, status, note, verified_at, updated_at)
       VALUES ($1,$2,$3,$4, CASE WHEN $3 = 'verified' THEN NOW() ELSE NULL END, NOW())
       ON CONFLICT (location_id, directory) DO UPDATE SET
         status = $3, note = $4,
         verified_at = CASE WHEN $3 = 'verified' THEN NOW() ELSE listing_directories.verified_at END,
         updated_at = NOW()`,
      [req.params.locationId, directory, status, note || null]
    );
    res.json({ directories: await getDirectories(req.params.locationId) });
  } catch (err) {
    logger.error('Listings directory update error:', err.message);
    res.status(500).json({ error: 'Could not update directory' });
  }
});

// POST /api/listings/:locationId/scan — on-demand directory scan
router.post('/:locationId/scan', authenticateToken, async (req, res) => {
  try {
    if (!(await ownLocation(req, res))) return;
    const { scanLocation } = require('../services/directoryCheckService');
    const results = await scanLocation(req.params.locationId);
    res.json({ results, directories: await getDirectories(req.params.locationId) });
  } catch (err) {
    logger.error('Listings scan error:', err.message);
    res.status(500).json({ error: err.message || 'Scan failed' });
  }
});

module.exports = router;
