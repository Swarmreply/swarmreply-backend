// ============================================
// services/directoryCheckService.js
// Listings Health V1.5 — automated NAP scanning for
// guided directories. We can't WRITE to these sites,
// but we can READ several of them and flag drift:
//
//   facebook    — page token already stored (no config)
//   yelp        — Yelp Fusion business-match (YELP_API_KEY, free)
//   foursquare  — Places match (FOURSQUARE_API_KEY, free)
//
// BBB / Yellow Pages / Nextdoor / Angi have no public
// read APIs — those stay manual, with staleness hints
// computed in the UI.
// ============================================

const axios = require('axios');
const { query } = require('../database/db');
const logger = require('../utils/logger');
const {
  normalizeString, normalizePhone, normalizeUrl, buildFullAddress,
} = require('./listingsService');

const CHECKABLE = ['facebook', 'yelp', 'foursquare'];

// ── Per-directory fetchers ─────────────────────
// Each returns { name, phone, address, website } or null
// (null = could not check; never treated as divergence).

async function fetchFacebookPage(location) {
  const fb = await query(
    `SELECT access_token, page_id FROM connected_platforms
     WHERE location_id = $1 AND platform = 'facebook' AND is_active = true`,
    [location.id]
  );
  if (!fb.rows.length) return null;
  const { data } = await axios.get(
    `https://graph.facebook.com/v19.0/${fb.rows[0].page_id}`,
    {
      params: {
        fields: 'name,phone,website,single_line_address',
        access_token: fb.rows[0].access_token,
      },
      timeout: 10000,
    }
  );
  return {
    name: data.name || null,
    phone: data.phone || null,
    address: data.single_line_address || null,
    website: data.website || null,
  };
}

async function fetchYelp(location) {
  const key = process.env.YELP_API_KEY;
  if (!key) return null;
  if (!location.address_line1 || !location.city || !location.state) return null;
  const { data } = await axios.get('https://api.yelp.com/v3/businesses/matches', {
    headers: { Authorization: `Bearer ${key}` },
    params: {
      name: location.business_name,
      address1: location.address_line1,
      city: location.city,
      state: location.state,
      country: location.country || 'US',
    },
    timeout: 10000,
  });
  const b = data.businesses && data.businesses[0];
  if (!b) return null;
  return {
    name: b.name || null,
    phone: b.phone || null,
    address: (b.location?.display_address || []).join(', ') || null,
    website: null, // Yelp match doesn't return the business website
  };
}

async function fetchFoursquare(location) {
  const key = process.env.FOURSQUARE_API_KEY;
  if (!key) return null;
  if (!location.address_line1 || !location.city || !location.state) return null;
  const { data } = await axios.get('https://api.foursquare.com/v3/places/match', {
    headers: { Authorization: key },
    params: {
      name: location.business_name,
      address: location.address_line1,
      city: location.city,
      state: location.state,
      cc: (location.country || 'US').toLowerCase(),
    },
    timeout: 10000,
  });
  const p = data.place;
  if (!p) return null;
  return {
    name: p.name || null,
    phone: p.tel || null,
    address: p.location?.formatted_address || null,
    website: p.website || null,
  };
}

const FETCHERS = { facebook: fetchFacebookPage, yelp: fetchYelp, foursquare: fetchFoursquare };

// ── Divergence (reuses the engine's normalizers) ──

function diff(location, found) {
  const fields = [];
  if (found.name && normalizeString(found.name) !== normalizeString(location.business_name)) fields.push('name');
  if (found.phone && location.phone && normalizePhone(found.phone) !== normalizePhone(location.phone)) fields.push('phone');
  if (found.website && location.website && normalizeUrl(found.website) !== normalizeUrl(location.website)) fields.push('website');
  const canonical = buildFullAddress(location);
  if (found.address && canonical && normalizeString(found.address) !== normalizeString(canonical)) fields.push('address');
  return fields;
}

function noteFor(directory, fields, found) {
  const pretty = { facebook: 'Facebook', yelp: 'Yelp', foursquare: 'Foursquare' }[directory] || directory;
  const detail = fields.includes('phone') && found.phone ? ` (shows ${found.phone})` : '';
  return `${pretty} lists a different ${fields.join(', ')}${detail}`;
}

// ── Scan one location ──────────────────────────

async function scanLocation(locationId) {
  const locRes = await query('SELECT * FROM locations WHERE id = $1', [locationId]);
  if (!locRes.rows.length) throw new Error('Location not found');
  const location = locRes.rows[0];

  const results = {};
  for (const directory of CHECKABLE) {
    try {
      const found = await FETCHERS[directory](location);
      if (!found) { results[directory] = { checked: false, reason: 'not configured or not found' }; continue; }

      const fields = diff(location, found);
      const diverged = fields.length > 0;

      // Status rules: divergence always flags 'attention'. A clean check
      // restores auto-flagged rows to 'verified', and never touches
      // rows the owner hasn't engaged with ('not_setup' stays put —
      // we just record what we found so the UI can show it).
      await query(
        `INSERT INTO listing_directories
           (location_id, directory, status, note, diverged_fields,
            found_name, found_phone, found_address, found_website,
            last_checked_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
         ON CONFLICT (location_id, directory) DO UPDATE SET
           status = CASE
             WHEN $10 THEN 'attention'
             WHEN listing_directories.status = 'attention' THEN 'verified'
             ELSE listing_directories.status END,
           note = $4,
           diverged_fields = $5,
           found_name = $6, found_phone = $7, found_address = $8, found_website = $9,
           last_checked_at = NOW(), updated_at = NOW()`,
        [
          locationId, directory,
          diverged ? 'attention' : 'not_setup',
          diverged ? noteFor(directory, fields, found) : null,
          diverged ? fields : null,
          found.name, found.phone, found.address, found.website,
          diverged,
        ]
      );
      results[directory] = { checked: true, diverged, fields };
      if (diverged) {
        logger.warn(`Listings scan: ${directory} divergence for ${location.business_name}: ${fields.join(', ')}`);
      }
    } catch (err) {
      results[directory] = { checked: false, error: err.message };
      logger.error(`Listings scan: ${directory} check failed for ${location.business_name}: ${err.message}`);
    }
  }
  return results;
}

// ── Weekly sweep (scheduler entry point) ───────

async function runWeeklyDirectoryScan() {
  logger.info('Listings: starting weekly directory scan');
  const locs = await query(
    `SELECT l.id FROM locations l
     JOIN customers c ON c.id = l.customer_id
     WHERE l.is_active = true AND c.status = 'active'
       AND l.address_line1 IS NOT NULL`
  );
  for (const row of locs.rows) {
    try { await scanLocation(row.id); }
    catch (err) { logger.error(`Listings scan failed for location ${row.id}: ${err.message}`); }
    await new Promise(r => setTimeout(r, 1200)); // rate-limit buffer
  }
  logger.info(`Listings: weekly directory scan complete (${locs.rows.length} location(s))`);
}

module.exports = { scanLocation, runWeeklyDirectoryScan, CHECKABLE };
