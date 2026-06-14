// ════════════════════════════════════════════════════════════════
// Central SMS gateway
// ----------------------------------------------------------------
// Every outbound text in the app routes through sendText() so that:
//   1. A single launch gate (SMS_ENABLED) can hard-block ALL sending
//      until carrier A2P 10DLC registration is approved. Until the
//      env var SMS_ENABLED is exactly "true", nothing is sent.
//   2. Sends are fail-soft: a Twilio/carrier rejection is caught and
//      logged, never thrown — so a blocked or failed text can never
//      break webchat, review requests, surveys, campaigns, etc.
// ════════════════════════════════════════════════════════════════

let _client = null;
function twilioClient() {
  if (!_client && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    _client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
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
 * @returns {Promise<{sent:boolean, skipped?:boolean, failed?:boolean, reason?:string, sid?:string}>}
 */
async function sendText({ to, body, from }) {
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
  try {
    const msg = await client.messages.create({
      from: from || process.env.TWILIO_PHONE_NUMBER,
      to,
      body
    });
    return { sent: true, sid: msg.sid };
  } catch (err) {
    console.error('[smsGate] SMS send failed:', err && err.message ? err.message : err);
    return { sent: false, failed: true, reason: (err && err.message) || 'send_failed' };
  }
}

module.exports = { sendText, smsEnabled, smsLiveDate, smsStatus };
