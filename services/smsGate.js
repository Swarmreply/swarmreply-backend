// ════════════════════════════════════════════════════════════════
// Central SMS gateway
// ----------------------------------------------------------------
// Every outbound text in the app routes through sendText() so that:
//   1. A single launch gate (SMS_ENABLED) can hard-block ALL sending
//      until texting is launched. Until the
//      env var SMS_ENABLED is exactly "true", nothing is sent.
//   2. Texts to a customer's contacts go out ONLY from that customer's own
//      verified toll-free number (see smsSenderService.js). Callers pass
//      customerId or locationId for those. Texts with no customer context
//      (e.g. alerts to a business owner) use SwarmReply's own
//      TWILIO_FROM_NUMBER.
//   3. Sends are fail-soft: a Twilio/carrier rejection is caught and
//      logged, never thrown — so a blocked or failed text can never
//      break webchat, review requests, surveys, campaigns, etc.
// ════════════════════════════════════════════════════════════════

let _client = null;
let _clientTried = false;
function twilioClient() {
  if (!_client && !_clientTried && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    _clientTried = true; // only attempt once per process — don't re-throw on every poll
    try {
      _client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    } catch (err) {
      // Credentials are set but the client could not be created — most often
      // because the "twilio" package isn't installed. Degrade to "not
      // configured" instead of crashing the request (this file is fail-soft).
      console.error('[smsGate] Twilio credentials are set but the client could not be initialized (is the "twilio" package in dependencies?):', err && err.message ? err.message : err);
      _client = null;
    }
  }
  return _client;
}

// The gate. Texting stays OFF until SMS_ENABLED === "true" in the environment.
function smsEnabled() {
  return process.env.SMS_ENABLED === 'true';
}

// Optional ISO date string shown in "SMS goes live ~" banners. If unset,
// the UI falls back to a generic "~2 weeks" message.
function smsLiveDate() {
  return process.env.SMS_LIVE_DATE || '';
}

// Status object for the frontend (drives banners + disabled send buttons).
function smsStatus() {
  return {
    enabled: smsEnabled(),
    configured: !!twilioClient(),
    liveDate: smsLiveDate()
  };
}

/**
 * Gated, fail-soft SMS send. NEVER throws.
 *
 * @param {object}  opts
 * @param {string}  opts.to
 * @param {string}  opts.body
 * @param {string} [opts.customerId]  send from this customer's own number
 * @param {string} [opts.locationId]  same, resolved via the location's customer
 * @param {string} [opts.statusCallback]
 * @returns {Promise<{sent:boolean, skipped?:boolean, failed?:boolean, reason?:string, sid?:string}>}
 *   reason 'sender_not_verified' = the customer has no approved number yet.
 */
async function sendText({ to, body, customerId, locationId, statusCallback }) {
  if (!to || !body) {
    return { sent: false, skipped: true, reason: 'missing_to_or_body' };
  }
  // Launch gate — refuse to send anything until explicitly enabled.
  if (!smsEnabled()) {
    return { sent: false, skipped: true, reason: 'sms_gated' };
  }
  const client = twilioClient();
  if (!client) {
    return { sent: false, skipped: true, reason: 'twilio_not_configured' };
  }

  let from;
  try {
    from = await resolveFrom({ customerId, locationId });
  } catch (err) {
    console.error('[smsGate] could not resolve sender:', err && err.message ? err.message : err);
    return { sent: false, failed: true, reason: 'sender_lookup_failed' };
  }
  if (from.reason) return { sent: false, skipped: true, reason: from.reason };

  try {
    const params = { from: from.number, to, body };
    if (statusCallback) params.statusCallback = statusCallback;
    const msg = await client.messages.create(params);
    return { sent: true, sid: msg.sid };
  } catch (err) {
    console.error('[smsGate] SMS send failed:', err && err.message ? err.message : err);
    return { sent: false, failed: true, reason: (err && err.message) || 'send_failed' };
  }
}

// Customer context → that customer's approved number, or a reason it can't send.
// No customer context → SwarmReply's own platform number.
async function resolveFrom({ customerId, locationId }) {
  if (customerId || locationId) {
    const { resolveSender } = require('./smsSenderService');
    const r = await resolveSender({ customerId, locationId });
    return r.from ? { number: r.from } : { reason: r.reason || 'sender_not_verified' };
  }
  const platform = process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER;
  return platform ? { number: platform } : { reason: 'twilio_not_configured' };
}

// Human-readable error for a failed sendText result (used by callers that throw).
function smsErrorMessage(result) {
  switch (result && result.reason) {
    case 'sms_gated':
      return 'SMS sending is not enabled yet.';
    case 'twilio_not_configured':
      return 'SMS is not configured on the server (Twilio credentials missing).';
    case 'sender_not_verified':
      return 'Your texting number is not approved yet. Finish "Business texting" in Settings — texts go out once carriers approve it.';
    case 'unknown_customer':
      return 'Could not find the account this text belongs to.';
    default:
      return 'SMS send failed: ' + ((result && result.reason) || 'unknown');
  }
}

module.exports = { sendText, smsEnabled, smsLiveDate, smsStatus, smsErrorMessage };
