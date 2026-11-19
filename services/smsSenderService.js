// ════════════════════════════════════════════════════════════════
// Per-customer SMS senders
// ----------------------------------------------------------------
// US carriers require every business that texts its customers to be
// registered as its own sender. SwarmReply does that automatically:
//
//   1. The customer saves their business details once
//      (saveProfile → sms_business_profiles).
//   2. provisionForCustomer() buys a toll-free number for them and
//      submits a toll-free verification to Twilio (sms_senders).
//   3. The scheduler calls runSenderMaintenance() every few hours to
//      pick up verification results, retry failed steps, and start
//      provisioning for customers whose profile is complete.
//   4. smsGate.sendText() calls resolveSender() so texts to a
//      customer's contacts go out only from that customer's own
//      approved number.
//
// Two env switches, both off by default:
//   SMS_PROVISIONING_ENABLED=true  buy numbers + submit verifications
//   SMS_ENABLED=true               actually send texts (see smsGate.js)
// ════════════════════════════════════════════════════════════════

const { query } = require('../database/db');
const logger = require('../utils/logger');

const BUSINESS_TYPES = ['PRIVATE_PROFIT', 'PUBLIC_PROFIT', 'SOLE_PROPRIETOR', 'NON_PROFIT', 'GOVERNMENT'];
const MESSAGE_VOLUMES = ['10', '100', '1,000', '10,000', '100,000', '250,000', '500,000',
  '750,000', '1,000,000', '5,000,000', '10,000,000+'];
const VALID_USE_CASES = ['TWO_FACTOR_AUTHENTICATION', 'ACCOUNT_NOTIFICATIONS', 'CUSTOMER_CARE',
  'CHARITY_NONPROFIT', 'DELIVERY_NOTIFICATIONS', 'FRAUD_ALERT_MESSAGING', 'EVENTS',
  'HIGHER_EDUCATION', 'K12', 'MARKETING', 'POLLING_AND_VOTING',
  'PUBLIC_SERVICE_ANNOUNCEMENT', 'SECURITY_ALERT'];
const VALID_OPT_IN_TYPES = ['VERBAL', 'WEB_FORM', 'PAPER_FORM', 'VIA_TEXT', 'MOBILE_QR_CODE'];
const MAX_ATTEMPTS = 5;

// ── Config ────────────────────────────────────────────────────────

function provisioningEnabled() {
  return process.env.SMS_PROVISIONING_ENABLED === 'true';
}

function backendUrl() {
  return (process.env.BACKEND_URL || 'https://api.swarmreply.com').replace(/\/+$/, '');
}

function inboundWebhookUrl() {
  return `${backendUrl()}/api/sms/webhook/inbound`;
}

function useCaseCategories() {
  const raw = process.env.SMS_USE_CASE_CATEGORIES || 'CUSTOMER_CARE,MARKETING';
  const list = raw.split(',').map(s => s.trim().toUpperCase()).filter(s => VALID_USE_CASES.includes(s));
  return list.length ? list : ['CUSTOMER_CARE'];
}

function optInType() {
  const t = (process.env.SMS_OPT_IN_TYPE || 'VERBAL').trim().toUpperCase();
  return VALID_OPT_IN_TYPES.includes(t) ? t : 'VERBAL';
}

/** Env settings provisioning can't run without. Returned as a list of names. */
function missingConfig() {
  const missing = [];
  if (!process.env.TWILIO_ACCOUNT_SID) missing.push('TWILIO_ACCOUNT_SID');
  if (!process.env.TWILIO_AUTH_TOKEN) missing.push('TWILIO_AUTH_TOKEN');
  if (!process.env.SMS_OPT_IN_IMAGE_URL) missing.push('SMS_OPT_IN_IMAGE_URL');
  if (!process.env.BACKEND_URL) missing.push('BACKEND_URL');
  return missing;
}

let _client = null;
function twilio() {
  if (!_client) {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      throw new Error('Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)');
    }
    _client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return _client;
}

// Test hook — lets unit tests inject a fake Twilio client.
function _setTwilioClient(client) { _client = client; }

// ── Helpers ───────────────────────────────────────────────────────

function clean(v) {
  return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
}

function toE164(phone) {
  const digits = clean(phone).replace(/[^\d+]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
  const d = digits.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return null;
}

function normalizeWebsite(url) {
  const u = clean(url);
  if (!u) return '';
  const withScheme = /^https?:\/\//i.test(u) ? u : 'https://' + u;
  try { return new URL(withScheme).toString(); } catch (_) { return ''; }
}

const MAP_TWILIO_STATUS = {
  PENDING_REVIEW: 'submitted',
  IN_REVIEW: 'submitted',
  TWILIO_APPROVED: 'approved',
  TWILIO_REJECTED: 'rejected',
};

// ── Business profile ──────────────────────────────────────────────

/**
 * Validate + normalize profile input. Returns { profile, errors } where
 * errors maps field name → message.
 */
function validateProfile(input = {}) {
  const errors = {};
  const p = {
    legal_business_name: clean(input.legal_business_name),
    doing_business_as:   clean(input.doing_business_as) || null,
    business_type:       clean(input.business_type || 'PRIVATE_PROFIT').toUpperCase(),
    ein:                 clean(input.ein).replace(/[^\d]/g, '') || null,
    website:             normalizeWebsite(input.website),
    street_address:      clean(input.street_address),
    city:                clean(input.city),
    state:               clean(input.state).toUpperCase(),
    postal_code:         clean(input.postal_code),
    country:             (clean(input.country) || 'US').toUpperCase(),
    contact_first_name:  clean(input.contact_first_name),
    contact_last_name:   clean(input.contact_last_name),
    contact_email:       clean(input.contact_email).toLowerCase(),
    contact_phone:       toE164(input.contact_phone),
    monthly_volume:      clean(input.monthly_volume) || '1,000',
  };

  const required = ['legal_business_name', 'street_address', 'city', 'state', 'postal_code',
    'contact_first_name', 'contact_last_name'];
  for (const f of required) if (!p[f]) errors[f] = 'Required';

  if (!p.website) errors.website = 'Enter your business website, e.g. https://example.com';
  if (!BUSINESS_TYPES.includes(p.business_type)) errors.business_type = 'Invalid business type';
  if (p.business_type !== 'SOLE_PROPRIETOR') {
    if (!p.ein) errors.ein = 'Required (your 9-digit EIN)';
    else if (p.ein.length !== 9) errors.ein = 'An EIN has 9 digits';
  }
  if (p.country !== 'US') errors.country = 'Only US businesses are supported right now';
  if (p.country === 'US' && p.postal_code && !/^\d{5}(-\d{4})?$/.test(p.postal_code)) {
    errors.postal_code = 'Enter a 5-digit ZIP code';
  }
  if (p.country === 'US' && p.state && !/^[A-Z]{2}$/.test(p.state)) {
    errors.state = 'Use the 2-letter state code, e.g. TX';
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.contact_email)) errors.contact_email = 'Enter a valid email';
  if (!p.contact_phone) errors.contact_phone = 'Enter a valid phone number';
  if (!MESSAGE_VOLUMES.includes(p.monthly_volume)) errors.monthly_volume = 'Invalid monthly volume';

  return { profile: p, errors };
}

async function getProfile(customerId) {
  const r = await query('SELECT * FROM sms_business_profiles WHERE customer_id = $1', [customerId]);
  return r.rows[0] || null;
}

async function saveProfile(customerId, input) {
  const { profile: p, errors } = validateProfile(input);
  if (Object.keys(errors).length) return { ok: false, errors };

  const r = await query(
    `INSERT INTO sms_business_profiles
       (customer_id, legal_business_name, doing_business_as, business_type, ein, website,
        street_address, city, state, postal_code, country,
        contact_first_name, contact_last_name, contact_email, contact_phone, monthly_volume)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (customer_id) DO UPDATE SET
       legal_business_name = EXCLUDED.legal_business_name,
       doing_business_as   = EXCLUDED.doing_business_as,
       business_type       = EXCLUDED.business_type,
       ein                 = EXCLUDED.ein,
       website             = EXCLUDED.website,
       street_address      = EXCLUDED.street_address,
       city                = EXCLUDED.city,
       state               = EXCLUDED.state,
       postal_code         = EXCLUDED.postal_code,
       country             = EXCLUDED.country,
       contact_first_name  = EXCLUDED.contact_first_name,
       contact_last_name   = EXCLUDED.contact_last_name,
       contact_email       = EXCLUDED.contact_email,
       contact_phone       = EXCLUDED.contact_phone,
       monthly_volume      = EXCLUDED.monthly_volume,
       updated_at          = NOW()
     RETURNING *`,
    [customerId, p.legal_business_name, p.doing_business_as, p.business_type, p.ein, p.website,
      p.street_address, p.city, p.state, p.postal_code, p.country,
      p.contact_first_name, p.contact_last_name, p.contact_email, p.contact_phone, p.monthly_volume]
  );
  return { ok: true, profile: r.rows[0] };
}

// ── Sender rows ───────────────────────────────────────────────────

async function getSender(customerId) {
  const r = await query(
    `SELECT * FROM sms_senders WHERE customer_id = $1 AND status <> 'released'
     ORDER BY created_at DESC LIMIT 1`,
    [customerId]
  );
  return r.rows[0] || null;
}

async function getOrCreateSender(customerId) {
  const existing = await getSender(customerId);
  if (existing) return existing;
  const r = await query(
    `INSERT INTO sms_senders (customer_id) VALUES ($1)
     ON CONFLICT DO NOTHING RETURNING *`,
    [customerId]
  );
  return r.rows[0] || getSender(customerId);
}

async function updateSender(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return null;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const r = await query(
    `UPDATE sms_senders SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, ...keys.map(k => fields[k])]
  );
  return r.rows[0];
}

/** Customer-facing status (no Twilio SIDs). */
function publicStatus(sender, profile) {
  return {
    provisioningEnabled: provisioningEnabled(),
    profileComplete: !!profile,
    status: sender ? sender.status : (profile ? 'queued' : 'needs_profile'),
    phoneNumber: sender ? sender.phone_number : null,
    rejectionReason: sender && sender.status === 'rejected' ? sender.rejection_reason : null,
    submittedAt: sender ? sender.submitted_at : null,
    approvedAt: sender ? sender.approved_at : null,
  };
}

async function getStatus(customerId) {
  const [profile, sender] = await Promise.all([getProfile(customerId), getSender(customerId)]);
  return { ...publicStatus(sender, profile), profile };
}

// ── Twilio: number purchase ───────────────────────────────────────

async function purchaseTollFreeNumber(customerId) {
  const client = twilio();
  const candidates = await client.availablePhoneNumbers('US').tollFree.list({ smsEnabled: true, limit: 5 });
  if (!candidates.length) throw new Error('Twilio has no SMS-capable toll-free numbers available right now');

  let lastErr = null;
  for (const c of candidates) {
    try {
      const params = {
        phoneNumber: c.phoneNumber,
        friendlyName: `SwarmReply customer ${customerId}`.slice(0, 64),
        smsUrl: inboundWebhookUrl(),
        smsMethod: 'POST',
      };
      if (process.env.TWILIO_ADDRESS_SID) params.addressSid = process.env.TWILIO_ADDRESS_SID;
      const num = await client.incomingPhoneNumbers.create(params);
      return { phoneNumber: num.phoneNumber, sid: num.sid };
    } catch (err) {
      // 21422 = number no longer available (someone else bought it) — try the next one
      lastErr = err;
      if (err && err.code !== 21422) throw err;
    }
  }
  throw lastErr || new Error('Could not purchase a toll-free number');
}

// ── Twilio: toll-free verification ────────────────────────────────

function buildVerificationPayload(profile, sender, customerId) {
  const brand = profile.doing_business_as || profile.legal_business_name;
  const payload = {
    businessName: profile.legal_business_name,
    businessWebsite: profile.website,
    notificationEmail: process.env.SMS_VERIFICATION_NOTIFY_EMAIL || profile.contact_email,
    useCaseCategories: useCaseCategories(),
    useCaseSummary:
      `${brand} uses SwarmReply to text its own customers after a purchase or appointment: ` +
      `requests to leave a review, short satisfaction surveys, replies to questions the customer ` +
      `started on the business's website chat, and occasional offers to customers who opted in. ` +
      `Customers give their mobile number to ${brand} and agree to receive texts. ` +
      `Every message names the business and supports STOP to opt out and HELP for help.`,
    productionMessageSample:
      `Hi Sam, thanks for choosing ${brand}! Would you mind leaving us a quick review? ` +
      `https://app.swarmreply.com/r/abc123 Reply STOP to opt out.`,
    optInImageUrls: [process.env.SMS_OPT_IN_IMAGE_URL],
    optInType: optInType(),
    messageVolume: profile.monthly_volume,
    tollfreePhoneNumberSid: sender.phone_number_sid,
    businessStreetAddress: profile.street_address,
    businessCity: profile.city,
    businessStateProvinceRegion: profile.state,
    businessPostalCode: profile.postal_code,
    businessCountry: profile.country,
    businessContactFirstName: profile.contact_first_name,
    businessContactLastName: profile.contact_last_name,
    businessContactEmail: profile.contact_email,
    businessContactPhone: profile.contact_phone,
    businessType: profile.business_type,
    externalReferenceId: String(customerId),
    additionalInformation:
      `Submitted by SwarmReply (software platform) on behalf of ${profile.legal_business_name}. ` +
      `Each SwarmReply customer gets its own dedicated toll-free number.`,
    optInKeywords: ['START'],
    optInConfirmationMessage:
      `${brand}: You're subscribed to texts from us. Msg frequency varies. Msg & data rates may apply. ` +
      `Reply HELP for help, STOP to opt out.`,
    helpMessageSample:
      `${brand}: For help, contact us at ${profile.contact_email}. Reply STOP to opt out.`,
    ageGatedContent: false,
  };
  if (profile.doing_business_as) payload.doingBusinessAs = profile.doing_business_as;
  if (profile.ein) {
    payload.businessRegistrationNumber = profile.ein;
    payload.businessRegistrationAuthority = 'EIN';
    payload.businessRegistrationCountry = 'US';
  }
  if (process.env.SMS_PRIVACY_POLICY_URL) payload.privacyPolicyUrl = process.env.SMS_PRIVACY_POLICY_URL;
  if (process.env.SMS_TERMS_URL) payload.termsAndConditionsUrl = process.env.SMS_TERMS_URL;
  return payload;
}

async function submitVerification(profile, sender, customerId) {
  const client = twilio();
  const payload = buildVerificationPayload(profile, sender, customerId);

  // A rejected verification that Twilio still lets us edit is updated in
  // place; otherwise the old one is removed and a fresh one created.
  if (sender.verification_sid) {
    if (sender.edit_allowed) {
      const { tollfreePhoneNumberSid, ...updatable } = payload; // number can't change on update
      const v = await client.messaging.v1.tollfreeVerifications(sender.verification_sid).update(updatable);
      return v;
    }
    try {
      await client.messaging.v1.tollfreeVerifications(sender.verification_sid).remove();
    } catch (err) {
      logger.warn(`[smsSender] could not remove old verification ${sender.verification_sid}: ${err.message}`);
    }
  }
  return client.messaging.v1.tollfreeVerifications.create(payload);
}

// ── Provisioning ──────────────────────────────────────────────────

/**
 * Buy a number (if needed) and submit verification (if needed) for one
 * customer. Idempotent: safe to call repeatedly; each step is skipped once
 * done. Never throws — returns { ok, status, reason?, error? }.
 */
async function provisionForCustomer(customerId, { force = false } = {}) {
  if (!provisioningEnabled()) return { ok: false, reason: 'provisioning_disabled' };
  const missing = missingConfig();
  if (missing.length) return { ok: false, reason: 'not_configured', missing };

  const cust = await query('SELECT id, status FROM customers WHERE id = $1', [customerId]);
  if (!cust.rows[0]) return { ok: false, reason: 'customer_not_found' };
  if (!['active', 'trialing', 'past_due'].includes(cust.rows[0].status)) {
    return { ok: false, reason: 'customer_not_active' };
  }

  const profile = await getProfile(customerId);
  if (!profile) return { ok: false, reason: 'needs_profile' };

  let sender = await getOrCreateSender(customerId);
  if (!sender) return { ok: false, reason: 'could_not_create_sender' };
  if (sender.status === 'approved') return { ok: true, status: 'approved' };
  if (sender.status === 'submitted' && !force) return { ok: true, status: 'submitted' };
  if (sender.status === 'rejected' && !force) return { ok: false, status: 'rejected', reason: 'rejected' };
  if (sender.status === 'failed' && sender.attempts >= MAX_ATTEMPTS && !force) {
    return { ok: false, status: 'failed', reason: 'max_attempts' };
  }

  try {
    if (!sender.phone_number_sid) {
      const num = await purchaseTollFreeNumber(customerId);
      sender = await updateSender(sender.id, {
        phone_number: num.phoneNumber,
        phone_number_sid: num.sid,
        status: 'number_purchased',
        last_error: null,
      });
      logger.info(`[smsSender] bought ${num.phoneNumber} for customer ${customerId}`);
    }

    const v = await submitVerification(profile, sender, customerId);
    const mapped = MAP_TWILIO_STATUS[v.status] || 'submitted';
    sender = await updateSender(sender.id, {
      verification_sid: v.sid,
      twilio_status: v.status,
      status: mapped,
      rejection_reason: mapped === 'rejected' ? (v.rejectionReason || null) : null,
      edit_allowed: v.editAllowed == null ? null : !!v.editAllowed,
      submitted_at: new Date(),
      approved_at: mapped === 'approved' ? new Date() : null,
      last_error: null,
      attempts: 0,
    });
    logger.info(`[smsSender] verification ${v.sid} submitted for customer ${customerId} (${v.status})`);
    return { ok: true, status: sender.status };
  } catch (err) {
    const msg = (err && err.message) || String(err);
    logger.error(`[smsSender] provisioning failed for customer ${customerId}: ${msg}`);
    await updateSender(sender.id, {
      status: 'failed',
      last_error: msg.slice(0, 1000),
      attempts: (sender.attempts || 0) + 1,
    });
    return { ok: false, status: 'failed', reason: 'twilio_error', error: msg };
  }
}

/**
 * Called after a customer saves their profile. Starts provisioning, or
 * resubmits a rejected verification with the corrected details.
 */
async function onProfileSaved(customerId) {
  const sender = await getSender(customerId);
  const force = !!sender && ['rejected', 'failed'].includes(sender.status);
  return provisionForCustomer(customerId, { force });
}

// ── Status polling ────────────────────────────────────────────────

async function refreshVerification(sender) {
  const v = await twilio().messaging.v1.tollfreeVerifications(sender.verification_sid).fetch();
  const mapped = MAP_TWILIO_STATUS[v.status] || sender.status;
  const fields = {
    twilio_status: v.status,
    status: mapped,
    edit_allowed: v.editAllowed == null ? null : !!v.editAllowed,
    last_checked_at: new Date(),
  };
  if (mapped === 'approved' && sender.status !== 'approved') fields.approved_at = new Date();
  if (mapped === 'rejected') {
    const reasons = Array.isArray(v.rejectionReasons) && v.rejectionReasons.length
      ? v.rejectionReasons.map(r => r.reason || r.description || JSON.stringify(r)).join('; ')
      : v.rejectionReason;
    fields.rejection_reason = reasons || 'Rejected by the carrier review (no reason given)';
  }
  const updated = await updateSender(sender.id, fields);
  if (mapped !== sender.status) {
    logger.info(`[smsSender] customer ${sender.customer_id} verification ${sender.status} → ${mapped}`);
  }
  return updated;
}

/**
 * Scheduler entry point. Polls in-flight verifications, retries failed
 * provisioning, and starts provisioning for customers who completed their
 * profile but have no sender yet (e.g. profile saved before the switch was on).
 */
async function runSenderMaintenance() {
  if (!provisioningEnabled()) return { skipped: 'provisioning_disabled' };
  const missing = missingConfig();
  if (missing.length) {
    logger.warn(`[smsSender] provisioning is enabled but missing env: ${missing.join(', ')}`);
    return { skipped: 'not_configured', missing };
  }

  const summary = { checked: 0, provisioned: 0, errors: 0 };

  const inFlight = await query(
    `SELECT * FROM sms_senders WHERE status = 'submitted' AND verification_sid IS NOT NULL
     ORDER BY last_checked_at NULLS FIRST LIMIT 200`
  );
  for (const s of inFlight.rows) {
    try { await refreshVerification(s); summary.checked++; }
    catch (err) { summary.errors++; logger.warn(`[smsSender] status check failed for ${s.id}: ${err.message}`); }
  }

  const todo = await query(
    `SELECT DISTINCT p.customer_id
       FROM sms_business_profiles p
       JOIN customers c ON c.id = p.customer_id
       LEFT JOIN sms_senders s ON s.customer_id = p.customer_id AND s.status <> 'released'
      WHERE c.status IN ('active', 'trialing', 'past_due')
        AND (s.id IS NULL
             OR s.status IN ('pending', 'number_purchased')
             OR (s.status = 'failed' AND s.attempts < $1))
      LIMIT 50`,
    [MAX_ATTEMPTS]
  );
  for (const row of todo.rows) {
    const r = await provisionForCustomer(row.customer_id);
    if (r.ok) summary.provisioned++; else if (r.reason === 'twilio_error') summary.errors++;
  }

  return summary;
}

// ── Release ───────────────────────────────────────────────────────

/** Give the customer's number back to Twilio (e.g. after cancellation). Never throws. */
async function releaseForCustomer(customerId) {
  const sender = await getSender(customerId);
  if (!sender) return { ok: true, released: false };
  try {
    if (sender.phone_number_sid) {
      await twilio().incomingPhoneNumbers(sender.phone_number_sid).remove();
    }
    await updateSender(sender.id, { status: 'released', released_at: new Date() });
    logger.info(`[smsSender] released ${sender.phone_number || '(no number)'} for customer ${customerId}`);
    return { ok: true, released: true };
  } catch (err) {
    logger.error(`[smsSender] release failed for customer ${customerId}: ${err.message}`);
    await updateSender(sender.id, { last_error: `release failed: ${err.message}`.slice(0, 1000) });
    return { ok: false, error: err.message };
  }
}

// ── Sending + inbound routing ─────────────────────────────────────

/**
 * Which number should a text for this customer/location come from?
 * @returns {Promise<{from?:string, customerId?:string, reason?:string}>}
 */
async function resolveSender({ customerId, locationId } = {}) {
  let cid = customerId || null;
  if (!cid && locationId) {
    const r = await query('SELECT customer_id FROM locations WHERE id = $1', [locationId]);
    cid = r.rows[0] ? r.rows[0].customer_id : null;
  }
  if (!cid) return { reason: 'unknown_customer' };
  const r = await query(
    `SELECT phone_number FROM sms_senders
      WHERE customer_id = $1 AND status = 'approved' AND phone_number IS NOT NULL
      ORDER BY approved_at DESC NULLS LAST LIMIT 1`,
    [cid]
  );
  if (!r.rows[0]) return { customerId: cid, reason: 'sender_not_verified' };
  return { customerId: cid, from: r.rows[0].phone_number };
}

async function findCustomerByNumber(toNumber) {
  const r = await query(
    `SELECT customer_id FROM sms_senders WHERE phone_number = $1 AND status <> 'released' LIMIT 1`,
    [toNumber]
  );
  return r.rows[0] ? r.rows[0].customer_id : null;
}

// ── Admin ─────────────────────────────────────────────────────────

async function listSenders({ status } = {}) {
  const params = [];
  let where = '';
  if (status) { params.push(status); where = `WHERE s.status = $1`; }
  const r = await query(
    `SELECT s.id, s.customer_id, c.name AS customer_name, c.email AS customer_email,
            p.legal_business_name, s.phone_number, s.status, s.twilio_status,
            s.rejection_reason, s.last_error, s.attempts, s.submitted_at, s.approved_at,
            s.released_at, s.last_checked_at, s.created_at
       FROM sms_senders s
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN sms_business_profiles p ON p.customer_id = s.customer_id
       ${where}
      ORDER BY s.updated_at DESC
      LIMIT 500`,
    params
  );
  return r.rows;
}

module.exports = {
  provisioningEnabled,
  missingConfig,
  validateProfile,
  getProfile,
  saveProfile,
  getSender,
  getStatus,
  provisionForCustomer,
  onProfileSaved,
  runSenderMaintenance,
  releaseForCustomer,
  resolveSender,
  findCustomerByNumber,
  listSenders,
  buildVerificationPayload,
  inboundWebhookUrl,
  _setTwilioClient,
  BUSINESS_TYPES,
  MESSAGE_VOLUMES,
};
