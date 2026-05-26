// ============================================
// services/zapierService.js
// Fires webhook payloads to Zapier when
// trigger events happen in SwarmReply.
//
// How Zapier REST hooks work:
//  1. User turns on a Zap → Zapier calls our
//     SUBSCRIBE endpoint with a callback URL
//  2. When an event fires, we POST to that URL
//  3. User turns off Zap → Zapier calls our
//     UNSUBSCRIBE endpoint
//
// We also expose a POLLING endpoint as a
// fallback — Zapier calls it on first run to
// load sample data and deduplicate.
// ============================================

const { query } = require('../database/db');
const logger = require('../utils/logger');

// ============================================
// HOOK MANAGEMENT
// Subscribe / unsubscribe lifecycle
// ============================================

/**
 * subscribeHook()
 * Called when a user turns on a Zap.
 * Stores the callback URL so we can fire
 * events to it later.
 */
async function subscribeHook({ customerId, locationId, event, targetUrl }) {
  // Remove any existing subscription for this
  // customer + location + event combo first
  await query(
    `DELETE FROM zapier_hooks
     WHERE customer_id = $1
       AND event = $2
       AND ($3::uuid IS NULL OR location_id = $3)`,
    [customerId, event, locationId || null]
  );

  const result = await query(
    `INSERT INTO zapier_hooks
     (customer_id, location_id, event, target_url)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [customerId, locationId || null, event, targetUrl]
  );

  logger.info(`Zapier hook subscribed: ${event} for customer ${customerId}`);
  return { id: result.rows[0].id };
}

/**
 * unsubscribeHook()
 * Called when a user turns off a Zap.
 * Removes the callback URL.
 */
async function unsubscribeHook({ customerId, event, targetUrl }) {
  await query(
    `DELETE FROM zapier_hooks
     WHERE customer_id = $1
       AND event = $2
       AND target_url = $3`,
    [customerId, event, targetUrl]
  );
  logger.info(`Zapier hook unsubscribed: ${event} for customer ${customerId}`);
}

// ============================================
// EVENT FIRING
// Called from reviewProcessor when events fire
// ============================================

/**
 * fireReviewEvent()
 * Called every time a new review is saved.
 * Finds all active subscriptions for this
 * customer and event, then fires them.
 *
 * @param {Object} review  - Full review row from DB
 * @param {Object} location - Location row from DB
 */
async function fireReviewEvent(review, location) {
  try {
    const isNegative = review.star_rating <= 2;

    // Build events to fire
    const eventsToFire = ['new_review'];
    if (isNegative) eventsToFire.push('new_negative_review');

    for (const event of eventsToFire) {
      // Find all hooks subscribed to this event
      // for this customer (optionally filtered by location)
      const hooks = await query(
        `SELECT id, target_url, location_id
         FROM zapier_hooks
         WHERE customer_id = $1
           AND event = $2
           AND (location_id IS NULL OR location_id = $3)`,
        [location.customer_id, event, location.id]
      );

      if (!hooks.rows.length) continue;

      const payload = buildReviewPayload(review, location);

      // Fire to all matching hook URLs (parallel)
      await Promise.allSettled(
        hooks.rows.map(hook => sendWebhook(hook.target_url, payload))
      );

      logger.info(
        `Zapier: fired '${event}' to ${hooks.rows.length} hook(s) ` +
        `for review ${review.id}`
      );
    }
  } catch (err) {
    // Never let Zapier firing crash the main review processor
    logger.error('zapierService.fireReviewEvent error:', err.message);
  }
}

/**
 * sendWebhook()
 * POST the payload to Zapier's callback URL.
 * Zapier expects an array of objects.
 * Retries once on failure.
 */
async function sendWebhook(targetUrl, payload) {
  const body = JSON.stringify([payload]); // Zapier expects an array

  const attemptFetch = async () => {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SwarmReply-Zapier/1.0'
      },
      body,
      signal: AbortSignal.timeout(10000) // 10s timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from Zapier hook`);
    }
    return response;
  };

  try {
    return await attemptFetch();
  } catch (err) {
    // Retry once after 2 seconds
    logger.warn(`Zapier webhook first attempt failed, retrying: ${err.message}`);
    await new Promise(r => setTimeout(r, 2000));
    try {
      return await attemptFetch();
    } catch (retryErr) {
      logger.error(`Zapier webhook retry failed for ${targetUrl}: ${retryErr.message}`);
      // Don't throw — a failed Zapier hook should never crash anything
    }
  }
}

// ============================================
// POLLING ENDPOINTS
// Used by Zapier for sample data on first load
// and as fallback if REST hooks aren't working.
// Must return newest items first.
// Must always return the same fields as the
// REST hook payload.
// ============================================

/**
 * getRecentReviews()
 * Returns the 3 most recent reviews for polling.
 * Zapier uses these as sample data when the user
 * sets up a Zap and tests it.
 */
async function getRecentReviews({ customerId, locationId, negativeOnly = false }) {
  const result = await query(
    `SELECT
       r.id,
       r.platform_review_id,
       r.reviewer_name,
       r.star_rating,
       r.review_text,
       r.review_date,
       r.language,
       r.status,
       r.created_at,
       l.id AS location_id,
       l.business_name,
       l.business_type,
       l.platform,
       c.id AS customer_id
     FROM reviews r
     JOIN locations l ON r.location_id = l.id
     JOIN customers c ON l.customer_id = c.id
     WHERE c.id = $1
       AND ($2::uuid IS NULL OR l.id = $2)
       ${negativeOnly ? 'AND r.star_rating <= 2' : ''}
       AND r.review_text IS NOT NULL
     ORDER BY r.created_at DESC
     LIMIT 3`,
    [customerId, locationId || null]
  );

  return result.rows.map(r => buildReviewPayload(r, {
    id: r.location_id,
    business_name: r.business_name,
    business_type: r.business_type,
    platform: r.platform,
    customer_id: r.customer_id
  }));
}

// ============================================
// PAYLOAD BUILDERS
// Consistent shape for both REST hooks
// and polling endpoints
// ============================================

function buildReviewPayload(review, location) {
  return {
    // Zapier requires a unique `id` field for deduplication
    id:              review.id,

    // Review data
    reviewer_name:   review.reviewer_name || 'Anonymous',
    star_rating:     review.star_rating,
    rating_label:    ratingLabel(review.star_rating),
    review_text:     review.review_text || '',
    review_date:     review.review_date
                       ? new Date(review.review_date).toISOString()
                       : new Date().toISOString(),
    language:        review.language || 'en',
    platform:        location.platform || 'google',
    is_negative:     review.star_rating <= 2,
    is_positive:     review.star_rating >= 4,

    // Location data — useful for multi-location Zaps
    location_id:     location.id,
    business_name:   location.business_name,
    business_type:   location.business_type || '',

    // Meta
    swarmreply_url:  `https://swarmreply.com/dashboard`,
    created_at:      review.created_at
                       ? new Date(review.created_at).toISOString()
                       : new Date().toISOString()
  };
}

function ratingLabel(stars) {
  const labels = { 1: '1 star', 2: '2 stars', 3: '3 stars', 4: '4 stars', 5: '5 stars' };
  return labels[stars] || `${stars} stars`;
}

// ============================================
// AUTH HELPERS
// ============================================

/**
 * validateApiKey()
 * Verify an API key from a Zapier request.
 * Returns the customer row if valid, null if not.
 */
async function validateApiKey(apiKey) {
  if (!apiKey || !apiKey.startsWith('sr_live_')) return null;

  const result = await query(
    `SELECT id, email, name, plan, status
     FROM customers
     WHERE api_key = $1
       AND status IN ('active', 'trial')`,
    [apiKey]
  );

  return result.rows[0] || null;
}

/**
 * generateApiKey()
 * Create a new API key for a customer.
 * Called from the dashboard "Generate API Key" button.
 */
async function generateApiKey(customerId) {
  const key = 'sr_live_' + require('crypto').randomBytes(24).toString('hex');

  await query(
    'UPDATE customers SET api_key = $1 WHERE id = $2',
    [key, customerId]
  );

  return key;
}

/**
 * getApiKey()
 * Get the current API key for a customer.
 * Used by the dashboard to display it.
 */
async function getApiKey(customerId) {
  const result = await query(
    'SELECT api_key FROM customers WHERE id = $1',
    [customerId]
  );
  return result.rows[0]?.api_key || null;
}

module.exports = {
  subscribeHook,
  unsubscribeHook,
  fireReviewEvent,
  getRecentReviews,
  buildReviewPayload,
  validateApiKey,
  generateApiKey,
  getApiKey
};
