// ============================================
// services/sendMeter.js
// Fair-use email metering.
//
// Included allowance: EMAIL_CAP_PER_LOCATION (default 5,000) customer-facing
// emails per location per CALENDAR month. Counts the existing
// review_request_sends log -- single source of truth, no separate counter to
// drift out of sync. (Phase 3 extends the count to include survey-campaign
// sends so both tracks share the same cap.)
//
// Transactional/system emails (welcome, digests, alerts via emailService.js)
// are NOT metered -- they are not customer send volume.
//
// Override the cap with the EMAIL_CAP_PER_LOCATION Railway variable. Overage
// packs (sold separately) would raise this per account in a later phase.
// ============================================

const { query } = require('../database/db');
const logger = require('../utils/logger');

const EMAIL_CAP = parseInt(process.env.EMAIL_CAP_PER_LOCATION || '5000', 10);

// Customer-facing emails already sent for this location in the current month.
async function monthlyEmailCount(locationId) {
  const r = await query(
    `SELECT COUNT(*)::int AS count
       FROM review_request_sends
      WHERE location_id = $1
        AND channel = 'email'
        AND status = 'sent'
        AND created_at >= date_trunc('month', now())`,
    [locationId]
  );
  return r.rows[0].count;
}

// Throws an error tagged EMAIL_CAP_REACHED if the location is at/over its
// monthly allowance. Fails OPEN on a counting error so a transient DB hiccup
// never blocks a legitimate send -- only a real, confirmed over-cap blocks.
async function assertEmailCap(locationId) {
  if (!locationId) return;
  let used;
  try {
    used = await monthlyEmailCount(locationId);
  } catch (err) {
    logger.warn('sendMeter: count failed, allowing send -- ' + err.message);
    return;
  }
  if (used >= EMAIL_CAP) {
    const e = new Error(
      `Monthly email limit reached (${EMAIL_CAP.toLocaleString()} per location). ` +
      `It resets at the start of next month -- add an overage pack to send more.`
    );
    e.code = 'EMAIL_CAP_REACHED';
    throw e;
  }
}

module.exports = { monthlyEmailCount, assertEmailCap, EMAIL_CAP };
