// ============================================
// routes/sms.js
// Per-customer texting numbers (toll-free) + Twilio webhooks
//
// Customer (dashboard, JWT):
//   GET  /api/sms/sender            Status of the customer's number + their saved profile
//   PUT  /api/sms/sender/profile    Save business details; starts/resubmits provisioning
//   POST /api/sms/sender/provision  Retry provisioning now
//
// Twilio (signature-validated, no JWT):
//   POST /api/sms/webhook/inbound   Texts people send to a customer's number (STOP/START/HELP…)
//   POST /api/sms/webhook/status    Delivery status callbacks
// ============================================

const express = require('express');
const router = express.Router();
const { authenticateToken, requireRole } = require('../middleware/auth');
const sender = require('../services/smsSenderService');
const { query } = require('../database/db');
const logger = require('../utils/logger');

const OPT_OUT_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT'];
const OPT_IN_KEYWORDS = ['START', 'YES', 'UNSTOP'];
const HELP_KEYWORDS = ['HELP', 'INFO'];

const OWNER_ROLES = ['owner', 'admin', 'customer'];

function customerIdOf(req) {
  return req.user.customerId || req.user.id;
}

// ── Customer endpoints ────────────────────────────────────────────

router.get('/sms/sender', authenticateToken, async (req, res) => {
  try {
    const status = await sender.getStatus(customerIdOf(req));
    res.json({
      ...status,
      options: { businessTypes: sender.BUSINESS_TYPES, monthlyVolumes: sender.MESSAGE_VOLUMES },
    });
  } catch (err) {
    logger.error('[sms] get sender failed: ' + err.message);
    res.status(500).json({ error: 'Could not load texting status' });
  }
});

router.put('/sms/sender/profile', authenticateToken, requireRole(OWNER_ROLES), async (req, res) => {
  try {
    const customerId = customerIdOf(req);
    const saved = await sender.saveProfile(customerId, req.body || {});
    if (!saved.ok) return res.status(400).json({ error: 'Please fix the highlighted fields', fields: saved.errors });

    // Kick off provisioning in the background — Twilio calls can take a few
    // seconds and the scheduler retries anything that fails.
    sender.onProfileSaved(customerId).catch(err =>
      logger.error(`[sms] provisioning after profile save failed for ${customerId}: ${err.message}`));

    const status = await sender.getStatus(customerId);
    res.json(status);
  } catch (err) {
    logger.error('[sms] save profile failed: ' + err.message);
    res.status(500).json({ error: 'Could not save your business details' });
  }
});

router.post('/sms/sender/provision', authenticateToken, requireRole(OWNER_ROLES), async (req, res) => {
  try {
    const customerId = customerIdOf(req);
    const result = await sender.onProfileSaved(customerId);
    const status = await sender.getStatus(customerId);
    res.json({ result: { ok: result.ok, status: result.status, reason: result.reason }, ...status });
  } catch (err) {
    logger.error('[sms] provision failed: ' + err.message);
    res.status(500).json({ error: 'Could not start texting setup' });
  }
});

// ── Twilio webhooks ───────────────────────────────────────────────

// Twilio signs each webhook with the auth token over the exact public URL.
// Behind Railway's proxy req.protocol/host aren't reliable, so the URL is
// rebuilt from BACKEND_URL.
function validTwilioRequest(req) {
  if (process.env.TWILIO_SKIP_SIGNATURE_CHECK === 'true' && process.env.NODE_ENV !== 'production') return true;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.get('X-Twilio-Signature');
  if (!token || !signature) return false;
  const base = (process.env.BACKEND_URL || 'https://api.swarmreply.com').replace(/\/+$/, '');
  const url = base + req.originalUrl;
  try {
    return require('twilio').validateRequest(token, signature, url, req.body || {});
  } catch (_) {
    return false;
  }
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

router.post('/sms/webhook/inbound', async (req, res) => {
  if (!validTwilioRequest(req)) return res.status(403).send('Invalid signature');

  const from = req.body.From || '';
  const to = req.body.To || '';
  const body = (req.body.Body || '').toString();
  const keyword = body.trim().toUpperCase();

  let action = 'none';
  try {
    const customerId = await sender.findCustomerByNumber(to);
    if (OPT_OUT_KEYWORDS.includes(keyword)) action = 'opt_out';
    else if (OPT_IN_KEYWORDS.includes(keyword)) action = 'opt_in';
    else if (HELP_KEYWORDS.includes(keyword)) action = 'help';

    if (action === 'opt_out' || action === 'opt_in') {
      // Records the opt-out / opt-in so no feature texts this person again.
      const { processInboundSMS } = require('../services/smsCampaignService');
      await processInboundSMS(from, keyword);
    }

    await query(
      `INSERT INTO sms_inbound_messages (customer_id, from_number, to_number, body, message_sid, action)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [customerId, from, to, body.slice(0, 1600), req.body.MessageSid || null, action]
    );
  } catch (err) {
    logger.error('[sms] inbound webhook error: ' + err.message);
  }

  // Twilio's built-in toll-free keyword handling already replies to
  // STOP/START/HELP, so we answer with empty TwiML to avoid double replies.
  res.type('text/xml').send(EMPTY_TWIML);
});

async function handleStatusCallback(req, res) {
  if (!validTwilioRequest(req)) return res.status(403).send('Invalid signature');
  try {
    const { MessageSid, MessageStatus } = req.body;
    if (MessageSid && MessageStatus) {
      const { processDeliveryWebhook } = require('../services/smsCampaignService');
      await processDeliveryWebhook(MessageSid, MessageStatus);
    }
  } catch (err) {
    logger.error('[sms] status webhook error: ' + err.message);
  }
  res.sendStatus(204);
}

router.post('/sms/webhook/status', handleStatusCallback);
// Older campaign sends pointed their status callback here.
router.post('/campaigns/webhook/delivery', handleStatusCallback);

module.exports = router;
module.exports.validTwilioRequest = validTwilioRequest;
