// ============================================
// services/listingsService.js
// Business Listings Sync Engine
//
// Keeps NAP (Name, Address, Phone) consistent
// across Google, Apple Maps, and Bing Places.
// This is what Yext charges $300-500/mo for.
//
// PLATFORM SUPPORT:
//
// Google Business Profile
//   API: My Business Business Information API v1
//   Auth: OAuth2 (already implemented in googleService.js)
//   Write: Yes — full NAP, hours, categories, description
//   Approval: Instant for most fields, ~3 days for name/address
//
// Apple Business Register
//   API: Apple Business Register API (free, no approval needed)
//   Auth: JWT signed with Apple private key
//   Write: Yes — submit updates, Apple reviews within 72h
//   Note: Requires Apple Developer account
//
// Bing Places
//   API: Bing Places API v2 (free)
//   Auth: API key
//   Write: Yes — name, address, phone, hours, website
//   Approval: ~24-48h for changes
// ============================================

const { query }        = require('../database/db');
const { getValidClient, makeGoogleAPICallWithRetry } = require('./googleService');
const logger           = require('../utils/logger');
const fetch            = require('node-fetch');
const crypto           = require('crypto');

// ============================================
// SCHEDULER ENTRY POINT
// Called daily — fetch current state from all
// platforms and detect divergences
// ============================================

async function runDailySync() {
  logger.info('Listings: Starting daily sync');

  try {
    // Get all active locations with listings configured
    const result = await query(
      `SELECT l.*, c.id AS customer_id
       FROM locations l
       JOIN customers c ON l.customer_id = c.id
       WHERE l.is_active = true
         AND l.address_line1 IS NOT NULL
         AND c.status = 'active'`,
      []
    );

    logger.info(`Listings: Processing ${result.rows.length} location(s)`);

    for (const location of result.rows) {
      try {
        await syncLocation(location);
      } catch (err) {
        logger.error(`Listings: sync failed for ${location.business_name}: ${err.message}`);
      }
      await sleep(1500); // Rate limit buffer between locations
    }

    logger.info('Listings: Daily sync complete');
  } catch (err) {
    logger.error('Listings: runDailySync error:', err.message);
  }
}

// ============================================
// SYNC ONE LOCATION
// Fetch current state from all platforms,
// compare to canonical, flag divergences
// ============================================

async function syncLocation(location) {
  // Get all platforms configured for this location
  const platforms = await query(
    `SELECT * FROM listing_platforms
     WHERE location_id = $1
       AND status != 'not_connected'`,
    [location.id]
  );

  for (const platform of platforms.rows) {
    try {
      await fetchAndCompare(location, platform);
    } catch (err) {
      logger.error(
        `Listings: fetch failed for ${location.business_name} ` +
        `on ${platform.platform}: ${err.message}`
      );
      await updatePlatformStatus(platform.id, 'error', err.message);
    }
  }

  // Recompute listing consistency score
  await updateConsistencyScore(location.id);
}

// ============================================
// FETCH AND COMPARE
// Get current state from a platform and
// compare it to the canonical NAP data
// ============================================

async function fetchAndCompare(location, platform) {
  let current = null;

  switch (platform.platform) {
    case 'google':
      current = await fetchGoogleListing(location, platform);
      break;
    case 'apple':
      current = await fetchAppleListing(location, platform);
      break;
    case 'bing':
      current = await fetchBingListing(location, platform);
      break;
    default:
      return;
  }

  if (!current) {
    logger.warn(`Listings: could not fetch ${platform.platform} for ${location.business_name}`);
    return;
  }

  // Compare current to canonical
  const divergedFields = detectDivergence(location, current);
  const hasDivergence  = divergedFields.length > 0;

  // Update platform record
  await query(
    `UPDATE listing_platforms SET
       current_name       = $1,
       current_address    = $2,
       current_phone      = $3,
       current_website    = $4,
       current_hours      = $5,
       status             = $6,
       has_divergence     = $7,
       diverged_fields    = $8,
       divergence_found_at = CASE WHEN $7 = true AND divergence_found_at IS NULL THEN NOW() ELSE divergence_found_at END,
       last_synced_at     = NOW(),
       last_sync_result   = 'success',
       sync_count         = sync_count + 1,
       updated_at         = NOW()
     WHERE id = $9`,
    [
      current.name,
      current.address,
      current.phone,
      current.website,
      current.hours ? JSON.stringify(current.hours) : null,
      hasDivergence ? 'diverged' : 'synced',
      hasDivergence,
      divergedFields,
      platform.id
    ]
  );

  // Log to history
  await logSyncHistory(location.id, platform.platform, 'detect',
    hasDivergence ? 'success' : 'no_change',
    hasDivergence ? { divergedFields } : null
  );

  if (hasDivergence) {
    logger.warn(
      `Listings: DIVERGENCE on ${platform.platform} for ` +
      `${location.business_name}: ${divergedFields.join(', ')}`
    );
  }
}

// ============================================
// DIVERGENCE DETECTION
// Compare canonical data to what the platform
// currently shows. Returns array of field names
// that don't match.
// ============================================

function detectDivergence(location, current) {
  const diverged = [];

  // Name check
  if (current.name && normalizeString(current.name) !== normalizeString(location.business_name)) {
    diverged.push('name');
  }

  // Phone check
  if (current.phone && normalizePhone(current.phone) !== normalizePhone(location.phone)) {
    diverged.push('phone');
  }

  // Website check
  if (current.website && normalizeUrl(current.website) !== normalizeUrl(location.website)) {
    diverged.push('website');
  }

  // Address check — compare normalized full address
  const canonicalAddress = buildFullAddress(location);
  if (current.address && canonicalAddress &&
      normalizeString(current.address) !== normalizeString(canonicalAddress)) {
    diverged.push('address');
  }

  return diverged;
}

// ============================================
// PUSH CANONICAL DATA TO PLATFORMS
// Called when user clicks "Sync now" or
// "Fix divergence" in the dashboard
// ============================================

async function pushToAllPlatforms(locationId) {
  const locResult = await query(
    'SELECT * FROM locations WHERE id = $1',
    [locationId]
  );
  if (!locResult.rows.length) throw new Error('Location not found');
  const location = locResult.rows[0];

  const platforms = await query(
    `SELECT * FROM listing_platforms
     WHERE location_id = $1
       AND status NOT IN ('not_connected')`,
    [locationId]
  );

  const results = {};

  for (const platform of platforms.rows) {
    try {
      let result;
      switch (platform.platform) {
        case 'google': result = await pushToGoogle(location, platform); break;
        case 'apple':  result = await pushToApple(location, platform);  break;
        case 'bing':   result = await pushToBing(location, platform);   break;
        default: continue;
      }
      results[platform.platform] = { success: true, ...result };
    } catch (err) {
      results[platform.platform] = { success: false, error: err.message };
      logger.error(`Listings: push to ${platform.platform} failed: ${err.message}`);
    }
  }

  // Recompute score after push
  await updateConsistencyScore(locationId);

  return results;
}

async function pushToOnePlatform(locationId, platformName) {
  const locResult = await query('SELECT * FROM locations WHERE id = $1', [locationId]);
  if (!locResult.rows.length) throw new Error('Location not found');
  const location = locResult.rows[0];

  const platResult = await query(
    'SELECT * FROM listing_platforms WHERE location_id = $1 AND platform = $2',
    [locationId, platformName]
  );
  if (!platResult.rows.length) throw new Error(`${platformName} not connected`);
  const platform = platResult.rows[0];

  switch (platformName) {
    case 'google': return await pushToGoogle(location, platform);
    case 'apple':  return await pushToApple(location, platform);
    case 'bing':   return await pushToBing(location, platform);
    default: throw new Error(`Unsupported platform: ${platformName}`);
  }
}

// ============================================
// GOOGLE BUSINESS PROFILE
// Uses existing OAuth client from googleService
// ============================================

async function fetchGoogleListing(location, platform) {
  try {
    const client = await getValidClient(location.id);

    const response = await makeGoogleAPICallWithRetry(async () => {
      const res = await client.request({
        url: `https://mybusinessbusinessinformation.googleapis.com/v1/${platform.platform_id}`,
        params: {
          readMask: 'title,phoneNumbers,storefrontAddress,websiteUri,regularHours,categories'
        }
      });
      return res.data;
    });

    return {
      name:    response.title,
      phone:   response.phoneNumbers?.primaryPhone,
      address: formatGoogleAddress(response.storefrontAddress),
      website: response.websiteUri,
      hours:   parseGoogleHours(response.regularHours)
    };
  } catch (err) {
    logger.error(`Google listing fetch failed: ${err.message}`);
    return null;
  }
}

async function pushToGoogle(location, platform) {
  const client = await getValidClient(location.id);

  const payload = {
    title:     location.business_name,
    websiteUri: location.website || null,
    phoneNumbers: location.phone ? {
      primaryPhone: location.phone
    } : undefined,
    storefrontAddress: {
      addressLines: [location.address_line1, location.address_line2].filter(Boolean),
      locality:      location.city,
      administrativeArea: location.state,
      postalCode:    location.zip,
      regionCode:    location.country || 'US'
    },
    regularHours: location.hours
      ? buildGoogleHours(location.hours)
      : undefined
  };

  // Remove undefined keys
  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

  // Build update mask — only include fields we're setting
  const updateMask = Object.keys(payload).join(',');

  await makeGoogleAPICallWithRetry(async () => {
    await client.request({
      method: 'PATCH',
      url: `https://mybusinessbusinessinformation.googleapis.com/v1/${platform.platform_id}`,
      params: { updateMask },
      data: payload
    });
  });

  await updatePlatformStatus(platform.id, 'pending_review', null, {
    name: location.business_name,
    address: buildFullAddress(location),
    phone: location.phone,
    website: location.website
  });

  await logSyncHistory(location.id, 'google', 'push', 'pending', {
    fields: Object.keys(payload)
  });

  return { message: 'Google listing update submitted — changes appear within minutes to 3 days depending on the field.' };
}

// ============================================
// APPLE MAPS
// Apple Business Register API
// Requires: Apple Developer account + private key
// Auth: JWT (RS256) signed with Apple private key
// ============================================

function buildAppleJWT() {
  const privateKey = process.env.APPLE_MAPS_PRIVATE_KEY;
  const keyId      = process.env.APPLE_MAPS_KEY_ID;
  const teamId     = process.env.APPLE_MAPS_TEAM_ID;

  if (!privateKey || !keyId || !teamId) {
    throw new Error('Apple Maps credentials not configured. Add APPLE_MAPS_PRIVATE_KEY, APPLE_MAPS_KEY_ID, APPLE_MAPS_TEAM_ID to environment variables.');
  }

  const header  = { alg: 'ES256', kid: keyId };
  const payload = {
    iss: teamId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600
  };

  const base64Header  = Buffer.from(JSON.stringify(header)).toString('base64url');
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput  = `${base64Header}.${base64Payload}`;

  const sign      = crypto.createSign('SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKey, 'base64url');

  return `${signingInput}.${signature}`;
}

async function fetchAppleListing(location, platform) {
  try {
    if (!platform.platform_id) return null;

    const jwt = buildAppleJWT();
    const response = await fetch(
      `https://maps-api.apple.com/v1/place/${platform.platform_id}`,
      { headers: { Authorization: `Bearer ${jwt}` } }
    );

    if (!response.ok) {
      throw new Error(`Apple API ${response.status}`);
    }

    const data = await response.json();
    return {
      name:    data.name,
      phone:   data.telephone,
      address: data.formattedAddressLines?.join(', '),
      website: data.url
    };
  } catch (err) {
    logger.error(`Apple listing fetch failed: ${err.message}`);
    return null;
  }
}

async function pushToApple(location, platform) {
  try {
    const jwt = buildAppleJWT();

    const payload = {
      name:    location.business_name,
      phone:   location.phone,
      website: location.website,
      address: {
        street:     [location.address_line1, location.address_line2].filter(Boolean).join(' '),
        city:       location.city,
        state:      location.state,
        postalCode: location.zip,
        country:    location.country || 'US'
      }
    };

    const response = await fetch(
      platform.platform_id
        ? `https://maps-api.apple.com/v1/place/${platform.platform_id}`
        : `https://maps-api.apple.com/v1/place`,
      {
        method: platform.platform_id ? 'PUT' : 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Apple API error ${response.status}: ${err}`);
    }

    const data = await response.json();

    // Store platform ID if first time
    if (!platform.platform_id && data.id) {
      await query(
        'UPDATE listing_platforms SET platform_id = $1 WHERE id = $2',
        [data.id, platform.id]
      );
    }

    await updatePlatformStatus(platform.id, 'pending_review');
    await logSyncHistory(location.id, 'apple', 'push', 'pending');

    return { message: 'Apple Maps update submitted — Apple reviews changes within 72 hours.' };
  } catch (err) {
    // Apple credentials not set up yet
    if (err.message.includes('not configured')) {
      await updatePlatformStatus(platform.id, 'error', err.message);
      throw err;
    }
    throw err;
  }
}

// ============================================
// BING PLACES
// Bing Places for Business API
// Auth: API key (free from Microsoft)
// ============================================

async function fetchBingListing(location, platform) {
  try {
    const apiKey = process.env.BING_PLACES_API_KEY;
    if (!apiKey) return null;
    if (!platform.platform_id) return null;

    const response = await fetch(
      `https://bingplacesforpusiness.microsoft.com/api/v1/businesses/${platform.platform_id}`,
      { headers: { 'Ocp-Apim-Subscription-Key': apiKey } }
    );

    if (!response.ok) {
      throw new Error(`Bing API ${response.status}`);
    }

    const data = await response.json();
    return {
      name:    data.BusinessName,
      phone:   data.Phone,
      address: [data.AddressLine1, data.City, data.StateOrProvince, data.PostalCode].filter(Boolean).join(', '),
      website: data.WebsiteUrl
    };
  } catch (err) {
    logger.error(`Bing listing fetch failed: ${err.message}`);
    return null;
  }
}

async function pushToBing(location, platform) {
  const apiKey = process.env.BING_PLACES_API_KEY;
  if (!apiKey) throw new Error('BING_PLACES_API_KEY not configured');

  const payload = {
    BusinessName: location.business_name,
    Phone:        location.phone,
    AddressLine1: location.address_line1,
    City:         location.city,
    StateOrProvince: location.state,
    PostalCode:   location.zip,
    Country:      location.country || 'US',
    WebsiteUrl:   location.website
  };

  const url = platform.platform_id
    ? `https://bingplacesforpusiness.microsoft.com/api/v1/businesses/${platform.platform_id}`
    : `https://bingplacesforpusiness.microsoft.com/api/v1/businesses`;

  const response = await fetch(url, {
    method: platform.platform_id ? 'PUT' : 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Bing API error ${response.status}: ${err}`);
  }

  const data = await response.json();

  if (!platform.platform_id && data.Id) {
    await query(
      'UPDATE listing_platforms SET platform_id = $1 WHERE id = $2',
      [data.Id, platform.id]
    );
  }

  await updatePlatformStatus(platform.id, 'pending_review');
  await logSyncHistory(location.id, 'bing', 'push', 'pending');

  return { message: 'Bing Places updated — changes appear within 24-48 hours.' };
}

// ============================================
// CONSISTENCY SCORE
// 0–100 score based on how many platforms are
// synced and divergence-free.
// Used in the dashboard summary card.
// ============================================

async function updateConsistencyScore(locationId) {
  const result = await query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE status = 'synced')          AS synced,
       COUNT(*) FILTER (WHERE status = 'pending_review')  AS pending,
       COUNT(*) FILTER (WHERE has_divergence = true)      AS diverged
     FROM listing_platforms
     WHERE location_id = $1
       AND status != 'not_connected'`,
    [locationId]
  );

  const { total, synced, pending, diverged } = result.rows[0];
  const t = parseInt(total) || 0;
  if (t === 0) return;

  // Score: synced platforms / total, penalised for divergences
  const syncedCount   = parseInt(synced)  || 0;
  const pendingCount  = parseInt(pending) || 0;
  const divergedCount = parseInt(diverged)|| 0;

  const score = Math.max(0, Math.round(
    ((syncedCount + pendingCount * 0.5) / t * 100) - (divergedCount * 20)
  ));

  await query(
    `UPDATE locations SET
       listing_score    = $1,
       listing_score_at = NOW()
     WHERE id = $2`,
    [score, locationId]
  );

  return score;
}

// ============================================
// DASHBOARD API FUNCTIONS
// ============================================

async function getListingsDashboard(locationId) {
  const [locResult, platformsResult] = await Promise.all([
    query('SELECT * FROM locations WHERE id = $1', [locationId]),
    query(
      `SELECT * FROM listing_platforms WHERE location_id = $1 ORDER BY platform`,
      [locationId]
    )
  ]);

  if (!locResult.rows.length) throw new Error('Location not found');

  const location  = locResult.rows[0];
  const platforms = platformsResult.rows;

  // Ensure all 3 platform rows exist (create if missing)
  const existingPlatforms = platforms.map(p => p.platform);
  const allPlatforms = ['google', 'apple', 'bing'];

  for (const p of allPlatforms) {
    if (!existingPlatforms.includes(p)) {
      await query(
        `INSERT INTO listing_platforms (location_id, platform, status)
         VALUES ($1, $2, 'not_connected')
         ON CONFLICT (location_id, platform) DO NOTHING`,
        [locationId, p]
      );
    }
  }

  // Google is connected the moment the location has OAuth — promote it
  await query(
    `UPDATE listing_platforms lp SET status = 'connected', updated_at = NOW()
     FROM locations l
     WHERE lp.location_id = $1 AND lp.platform = 'google'
       AND lp.status = 'not_connected'
       AND l.id = lp.location_id AND l.refresh_token IS NOT NULL`,
    [locationId]
  );

  // Reload after ensuring all exist
  const freshPlatforms = await query(
    'SELECT * FROM listing_platforms WHERE location_id = $1 ORDER BY platform',
    [locationId]
  );

  // Get recent sync history
  const history = await query(
    `SELECT * FROM listing_sync_history
     WHERE location_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [locationId]
  );

  return {
    location: {
      id:             location.id,
      businessName:   location.business_name,
      addressLine1:   location.address_line1,
      addressLine2:   location.address_line2,
      city:           location.city,
      state:          location.state,
      zip:            location.zip,
      phone:          location.phone,
      website:        location.website,
      description:    location.description,
      hours:          location.hours,
      listingScore:   location.listing_score || 0,
      listingScoreAt: location.listing_score_at
    },
    platforms: freshPlatforms.rows,
    history:   history.rows,
    summary: {
      total:     freshPlatforms.rows.length,
      synced:    freshPlatforms.rows.filter(p => p.status === 'synced').length,
      diverged:  freshPlatforms.rows.filter(p => p.has_divergence).length,
      pending:   freshPlatforms.rows.filter(p => p.status === 'pending_review').length,
      score:     location.listing_score || 0
    }
  };
}

async function updateCanonicalNAP(locationId, data) {
  const {
    businessName, addressLine1, addressLine2, city, state, zip,
    country, phone, website, description, hours
  } = data;

  await query(
    `UPDATE locations SET
       business_name  = COALESCE($1,  business_name),
       address_line1  = COALESCE($2,  address_line1),
       address_line2  = COALESCE($3,  address_line2),
       city           = COALESCE($4,  city),
       state          = COALESCE($5,  state),
       zip            = COALESCE($6,  zip),
       country        = COALESCE($7,  country),
       phone          = COALESCE($8,  phone),
       website        = COALESCE($9,  website),
       description    = COALESCE($10, description),
       hours          = COALESCE($11::jsonb, hours),
       nap_updated_at = NOW(),
       updated_at     = NOW()
     WHERE id = $12`,
    [
      businessName, addressLine1, addressLine2, city, state, zip,
      country, phone, website, description,
      hours ? JSON.stringify(hours) : null,
      locationId
    ]
  );

  return await getListingsDashboard(locationId);
}

// ============================================
// HELPERS
// ============================================

function buildFullAddress(location) {
  return [
    location.address_line1,
    location.address_line2,
    location.city,
    location.state,
    location.zip
  ].filter(Boolean).join(', ');
}

function normalizeString(str) {
  if (!str) return '';
  return str.toLowerCase().trim().replace(/\s+/g, ' ');
}

function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '');
}

function normalizeUrl(url) {
  if (!url) return '';
  return url.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function formatGoogleAddress(addr) {
  if (!addr) return null;
  return [
    ...(addr.addressLines || []),
    addr.locality,
    addr.administrativeArea,
    addr.postalCode
  ].filter(Boolean).join(', ');
}

function parseGoogleHours(regularHours) {
  if (!regularHours?.periods) return null;
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const result = {};
  days.forEach(d => { result[d] = { closed: true }; });
  for (const period of regularHours.periods) {
    const day = days[period.openDay || 0];
    if (day) {
      result[day] = {
        open:   `${String(period.openTime?.hours || 0).padStart(2,'0')}:${String(period.openTime?.minutes || 0).padStart(2,'0')}`,
        close:  `${String(period.closeTime?.hours || 0).padStart(2,'0')}:${String(period.closeTime?.minutes || 0).padStart(2,'0')}`,
        closed: false
      };
    }
  }
  return result;
}

function buildGoogleHours(hours) {
  if (!hours) return undefined;
  const dayMap = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
  const periods = [];
  for (const [day, data] of Object.entries(hours)) {
    if (!data.closed && data.open && data.close) {
      const [oh, om] = data.open.split(':').map(Number);
      const [ch, cm] = data.close.split(':').map(Number);
      periods.push({
        openDay:   dayMap[day],
        closeDay:  dayMap[day],
        openTime:  { hours: oh, minutes: om },
        closeTime: { hours: ch, minutes: cm }
      });
    }
  }
  return { periods };
}

async function updatePlatformStatus(platformId, status, errorMsg = null, currentData = null) {
  await query(
    `UPDATE listing_platforms SET
       status         = $1,
       last_error     = $2,
       current_name   = COALESCE($3, current_name),
       current_address = COALESCE($4, current_address),
       current_phone  = COALESCE($5, current_phone),
       current_website = COALESCE($6, current_website),
       has_divergence = CASE WHEN $1 = 'synced' THEN false ELSE has_divergence END,
       updated_at     = NOW()
     WHERE id = $7`,
    [
      status, errorMsg,
      currentData?.name, currentData?.address,
      currentData?.phone, currentData?.website,
      platformId
    ]
  );
}

async function logSyncHistory(locationId, platform, action, status, changes = null) {
  await query(
    `INSERT INTO listing_sync_history
     (location_id, platform, action, status, changes_made)
     VALUES ($1, $2, $3, $4, $5)`,
    [locationId, platform, action, status, changes ? JSON.stringify(changes) : null]
  );
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  runDailySync,
  syncLocation,
  pushToAllPlatforms,
  pushToOnePlatform,
  getListingsDashboard,
  updateCanonicalNAP,
  updateConsistencyScore
};
