// ============================================
// services/platformService.js
// Multi-platform coordination layer
//
// This is the central service that:
//   1. Manages review destinations per location
//      (which platforms are connected + their URLs)
//   2. Resolves the correct review link for a given
//      template or survey based on platform selection
//   3. Seeds default destinations when platforms connect
//   4. Provides the platform picker data for the UI
// ============================================

const { query } = require('../database/db');
const logger    = require('../utils/logger');

// Platform metadata — display info for the UI
const PLATFORM_META = {
  google: {
    label:    'Google',
    icon:     '🔍',
    color:    '#4285F4',
    helpText: 'Most important for local SEO and Maps ranking'
  },
  facebook: {
    label:    'Facebook',
    icon:     '📘',
    color:    '#1877F2',
    helpText: 'Great for community engagement and social proof'
  },
  yelp: {
    label:    'Yelp',
    icon:     '⭐',
    color:    '#D32323',
    helpText: 'Critical for restaurants, salons, and home services'
  },
  custom: {
    label:    'Custom link',
    icon:     '🔗',
    color:    '#666666',
    helpText: 'Any review platform — paste your direct review link'
  }
};

// ── DESTINATIONS ──────────────────────────────────────────────────────────────

/**
 * getDestinations()
 * All active review destinations for a location.
 * Returned ordered by sort_order.
 */
async function getDestinations(locationId) {
  const result = await query(
    `SELECT * FROM review_destinations
     WHERE location_id = $1 AND is_active = true
     ORDER BY sort_order ASC`,
    [locationId]
  );

  // Merge with platform metadata for the UI
  return result.rows.map(d => ({
    ...d,
    meta: PLATFORM_META[d.platform] || PLATFORM_META.custom
  }));
}

/**
 * upsertDestination()
 * Add or update a review destination.
 * Called when a platform is connected or URLs are changed.
 */
async function upsertDestination(locationId, { platform, label, url, icon, sortOrder = 99 }) {
  const result = await query(
    `INSERT INTO review_destinations
       (location_id, platform, label, url, icon, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (location_id, platform)
     DO UPDATE SET
       label      = EXCLUDED.label,
       url        = EXCLUDED.url,
       icon       = EXCLUDED.icon,
       is_active  = true,
       updated_at = NOW()
     RETURNING *`,
    [locationId, platform, label, url, icon || PLATFORM_META[platform]?.icon || '⭐', sortOrder]
  );
  return result.rows[0];
}

/**
 * disableDestination()
 * Soft-disable a destination (e.g. when platform is disconnected).
 */
async function disableDestination(locationId, platform) {
  await query(
    `UPDATE review_destinations
     SET is_active = false
     WHERE location_id = $1 AND platform = $2`,
    [locationId, platform]
  );
}

/**
 * reorderDestinations()
 * Set the display order — which platform shows first in templates and surveys.
 */
async function reorderDestinations(locationId, orderedPlatforms) {
  // orderedPlatforms: ['google', 'facebook', 'yelp']
  for (let i = 0; i < orderedPlatforms.length; i++) {
    await query(
      `UPDATE review_destinations
       SET sort_order = $3
       WHERE location_id = $1 AND platform = $2`,
      [locationId, orderedPlatforms[i], i]
    );
  }
}

// ── REVIEW LINK RESOLVER ──────────────────────────────────────────────────────

/**
 * resolveReviewLink()
 * Given a platform name and locationId, return the correct review URL.
 * Used by templates and surveys to get the right link.
 *
 * @param {string} locationId
 * @param {string} platform   - 'google' | 'facebook' | 'yelp' | 'custom'
 * @param {string} customUrl  - used when platform === 'custom'
 * @returns {string|null}     - the review URL
 */
async function resolveReviewLink(locationId, platform, customUrl = null) {
  if (platform === 'custom' && customUrl) return customUrl;

  if (platform === 'google') {
    // Google link stored directly on locations table
    const result = await query(
      `SELECT google_review_link FROM locations WHERE id = $1`,
      [locationId]
    );
    return result.rows[0]?.google_review_link || null;
  }

  // All other platforms stored in review_destinations
  const result = await query(
    `SELECT url FROM review_destinations
     WHERE location_id = $1 AND platform = $2 AND is_active = true`,
    [locationId, platform]
  );
  return result.rows[0]?.url || null;
}

/**
 * resolveAllLinks()
 * Returns ALL active review links for a location — used when
 * show_platform_choice or show_all_platforms is true.
 * Returns array of { platform, label, url, icon } sorted by sort_order.
 */
async function resolveAllLinks(locationId) {
  // Get Google from locations table
  const locResult = await query(
    `SELECT google_review_link FROM locations WHERE id = $1`,
    [locationId]
  );
  const googleUrl = locResult.rows[0]?.google_review_link;

  // Get all other destinations
  const destResult = await query(
    `SELECT platform, label, url, icon FROM review_destinations
     WHERE location_id = $1 AND is_active = true
     ORDER BY sort_order ASC`,
    [locationId]
  );

  const links = [];

  // Google first (always sort_order 0)
  if (googleUrl) {
    links.push({
      platform: 'google',
      label:    'Leave a Google review',
      url:      googleUrl,
      icon:     '🔍'
    });
  }

  // All other destinations
  destResult.rows.forEach(d => {
    if (!links.find(l => l.platform === d.platform)) {
      links.push(d);
    }
  });

  return links;
}

// ── PLATFORM STATUS SUMMARY ───────────────────────────────────────────────────

/**
 * getPlatformSummary()
 * Returns all platform connection statuses for a location.
 * Used by the Integrations dashboard page.
 */
async function getPlatformSummary(locationId) {
  // Google — check locations table
  const locResult = await query(
    `SELECT google_review_link, access_token IS NOT NULL AS google_connected
     FROM locations WHERE id = $1`,
    [locationId]
  );
  const loc = locResult.rows[0];

  // Other platforms
  const platResult = await query(
    `SELECT platform, page_name, is_active, last_synced_at,
            total_reviews, avg_rating, auto_reply
     FROM connected_platforms
     WHERE location_id = $1`,
    [locationId]
  );

  // Yelp + custom from review_destinations (URL-only)
  const destResult = await query(
    `SELECT platform, label, url, is_active
     FROM review_destinations
     WHERE location_id = $1`,
    [locationId]
  );

  const summary = {
    google: {
      connected:    !!loc?.google_connected,
      review_link:  loc?.google_review_link,
      auto_reply:   true,
      meta:         PLATFORM_META.google
    }
  };

  // OAuth-connected platforms (Facebook etc.)
  platResult.rows.forEach(p => {
    summary[p.platform] = {
      connected:     p.is_active,
      page_name:     p.page_name,
      last_synced:   p.last_synced_at,
      total_reviews: p.total_reviews,
      avg_rating:    p.avg_rating,
      auto_reply:    p.auto_reply,
      meta:          PLATFORM_META[p.platform] || {}
    };
  });

  // URL-only platforms
  destResult.rows.forEach(d => {
    if (!summary[d.platform]) {
      summary[d.platform] = {
        connected:   d.is_active,
        review_link: d.url,
        url_only:    true,
        auto_reply:  false,
        meta:        PLATFORM_META[d.platform] || {}
      };
    }
  });

  return summary;
}

/**
 * seedGoogleDestination()
 * Called when a location is first set up or updates their Google review link.
 * Ensures Google always appears in review_destinations.
 */
async function seedGoogleDestination(locationId, googleReviewUrl) {
  await upsertDestination(locationId, {
    platform:  'google',
    label:     'Leave a Google review',
    url:       googleReviewUrl,
    icon:      '🔍',
    sortOrder: 0
  });
}

/**
 * addYelpDestination()
 * Simple URL-only Yelp entry — no API, just a link.
 */
async function addYelpDestination(locationId, yelpUrl) {
  // Normalise to direct write-a-review URL if possible
  let reviewUrl = yelpUrl;
  if (yelpUrl && !yelpUrl.includes('write_review')) {
    reviewUrl = yelpUrl.replace(/\/?$/, '/write_review');
  }

  await upsertDestination(locationId, {
    platform:  'yelp',
    label:     'Leave a Yelp review',
    url:       reviewUrl,
    icon:      '⭐',
    sortOrder: 3
  });

  logger.info(`Yelp destination added for location ${locationId}: ${reviewUrl}`);
  return reviewUrl;
}

module.exports = {
  PLATFORM_META,
  getDestinations,
  upsertDestination,
  disableDestination,
  reorderDestinations,
  resolveReviewLink,
  resolveAllLinks,
  getPlatformSummary,
  seedGoogleDestination,
  addYelpDestination
};
