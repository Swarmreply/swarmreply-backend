// ============================================
// services/zapierHooks.js
// Fires REST-hook subscriptions registered by the SwarmReply Zapier app.
// Events match the Zapier app's trigger keys:
//   new_review          — every new review that arrives
//   new_negative_review — 1–2 star reviews only
// Never throws; a Zapier outage must not break review ingestion.
// A 410 response from Zapier means the Zap was turned off — we delete
// that subscription, per Zapier's REST-hook contract.
// ============================================

const axios = require('axios');
const { query } = require('../database/db');
const logger = require('../utils/logger');

function reviewPayload(review, location) {
  return {
    id: review.id,
    location_id: review.location_id || location.id,
    location_name: location.business_name || null,
    platform: review.platform || 'google',
    reviewer_name: review.reviewer_name || 'Anonymous',
    rating: review.star_rating != null ? Number(review.star_rating) : null,
    text: review.review_text || '',
    review_date: review.review_date || review.created_at || new Date().toISOString(),
  };
}

async function deliver(hook, payload) {
  try {
    await axios.post(hook.hook_url, payload, { timeout: 10000 });
  } catch (err) {
    if (err.response?.status === 410) {
      // Zap was deleted/paused on Zapier's side — drop the subscription
      await query('DELETE FROM zapier_hooks WHERE id = $1', [hook.id])
        .catch(e => logger.warn('zapierHooks: cleanup failed:', e.message));
      logger.info(`zapierHooks: subscription ${hook.id} returned 410 — removed`);
    } else {
      logger.warn(`zapierHooks: delivery to ${hook.hook_url} failed: ${err.message}`);
    }
  }
}

// Fire hooks for a freshly ingested review. locationId → customer resolved here
// so callers (google/facebook sync) only need the review row they inserted.
async function fireNewReview(locationId, review) {
  try {
    const loc = await query(
      'SELECT id, customer_id, business_name FROM locations WHERE id = $1',
      [locationId]
    );
    if (!loc.rows.length) return;
    const location = loc.rows[0];

    const events = ['new_review'];
    if (Number(review.star_rating) <= 2) events.push('new_negative_review');

    const hooks = await query(
      `SELECT id, hook_url, event FROM zapier_hooks
       WHERE customer_id = $1 AND event = ANY($2)`,
      [location.customer_id, events]
    );
    if (!hooks.rows.length) return;

    const payload = reviewPayload(review, location);
    await Promise.all(hooks.rows.map(h => deliver(h, payload)));
  } catch (err) {
    logger.warn('zapierHooks.fireNewReview failed:', err.message);
  }
}

module.exports = { fireNewReview };
