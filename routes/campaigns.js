// ============================================
// routes/campaigns.js
// SMS Marketing Campaign API
//
// Contacts:
//   GET  /api/campaigns/contacts              List contacts
//   POST /api/campaigns/contacts              Add/update contact
//   POST /api/campaigns/contacts/import       Bulk import
//   GET  /api/campaigns/contacts/stats        Count + opt-out stats
//   GET  /api/campaigns/contacts/tags         All tags for location
//   DEL  /api/campaigns/contacts/:id          Remove contact
//
// Segments:
//   GET  /api/campaigns/segments              List segments
//   POST /api/campaigns/segments              Create segment
//   POST /api/campaigns/segments/preview      Preview count for filters
//
// Campaigns:
//   GET  /api/campaigns                       List campaigns
//   POST /api/campaigns                       Create campaign
//   GET  /api/campaigns/:id                   Get campaign + stats
//   PUT  /api/campaigns/:id                   Update draft campaign
//   DEL  /api/campaigns/:id                   Delete draft campaign
//   POST /api/campaigns/:id/launch            Launch / schedule
//   POST /api/campaigns/:id/cancel            Cancel scheduled campaign
//
// Webhooks (Twilio — no auth):
//   POST /api/campaigns/webhook/inbound       Inbound SMS (STOP/replies)
//   POST /api/campaigns/webhook/delivery      Delivery status update
// ============================================

const express = require('express');
const router  = express.Router();
const sms     = require('../services/smsCampaignService');
const { authenticateToken } = require('../middleware/auth');
const logger  = require('../utils/logger');

// ── CONTACTS ─────────────────────────────────────────────────────────────────

router.get('/contacts', authenticateToken, async (req, res) => {
  try {
    const { limit = 100, offset = 0, tag, search } = req.query;
    const result = await sms.getContacts(req.user.locationId,
      { limit: parseInt(limit), offset: parseInt(offset), tag, search });
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/contacts/stats', authenticateToken, async (req, res) => {
  try {
    const stats = await sms.getContactStats(req.user.locationId);
    res.json({ success: true, stats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/contacts/tags', authenticateToken, async (req, res) => {
  try {
    const tags = await sms.getAllTags(req.user.locationId);
    res.json({ success: true, tags });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/contacts', authenticateToken, async (req, res) => {
  try {
    const contact = await sms.upsertContact(req.user.locationId, req.body);
    res.json({ success: true, contact });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/contacts/import', authenticateToken, async (req, res) => {
  try {
    const { contacts, source = 'import' } = req.body;
    if (!Array.isArray(contacts) || !contacts.length) {
      return res.status(400).json({ error: 'contacts array required' });
    }
    const result = await sms.bulkImportContacts(req.user.locationId, contacts, source);
    res.json({ success: true, ...result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── SEGMENTS ──────────────────────────────────────────────────────────────────

router.get('/segments', authenticateToken, async (req, res) => {
  try {
    const segments = await sms.getSegments(req.user.locationId);
    res.json({ success: true, segments });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/segments', authenticateToken, async (req, res) => {
  try {
    const { name, filters } = req.body;
    if (!name || !filters) return res.status(400).json({ error: 'name and filters required' });
    const segment = await sms.createSegment(req.user.locationId, { name, filters });
    res.json({ success: true, segment });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/segments/preview', authenticateToken, async (req, res) => {
  try {
    const count = await sms.previewSegment(req.user.locationId, req.body.filters || {});
    res.json({ success: true, count });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── CAMPAIGNS ────────────────────────────────────────────────────────────────

router.get('/', authenticateToken, async (req, res) => {
  try {
    const campaigns = await sms.getCampaigns(req.user.locationId);
    res.json({ success: true, campaigns });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, message, audience, segmentId, targetTags, sendAt, timezone } = req.body;
    if (!name || !message) return res.status(400).json({ error: 'name and message required' });
    const campaign = await sms.createCampaign(req.user.locationId,
      { name, message, audience, segmentId, targetTags, sendAt, timezone });
    res.json({ success: true, campaign });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const stats = await sms.getCampaignStats(req.params.id, req.user.locationId);
    if (!stats) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ success: true, campaign: stats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const campaign = await sms.updateCampaign(req.params.id, req.user.locationId, req.body);
    res.json({ success: true, campaign });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    await sms.deleteCampaign(req.params.id, req.user.locationId);
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/:id/launch', authenticateToken, async (req, res) => {
  try {
    const result = await sms.launchCampaign(req.params.id, req.user.locationId);
    res.json({ success: true, ...result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/:id/cancel', authenticateToken, async (req, res) => {
  try {
    const { query } = require('../database/db');
    await query(
      `UPDATE sms_campaigns SET status = 'cancelled'
       WHERE id = $1 AND location_id = $2 AND status = 'scheduled'`,
      [req.params.id, req.user.locationId]
    );
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── TWILIO WEBHOOKS (no auth) ─────────────────────────────────────────────────

// POST /api/campaigns/webhook/inbound
// Twilio posts here when a customer replies (STOP, START, or any text)
router.post('/webhook/inbound', async (req, res) => {
  try {
    const { From, Body } = req.body;
    if (!From || !Body) return res.status(400).send('Missing From or Body');

    const result = await sms.processInboundSMS(From, Body);
    logger.info(`Inbound SMS from ${From}: action=${result.action}`);

    // Respond with TwiML
    const reply = result.reply || '';
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>${reply ? `<Message>${reply}</Message>` : ''}</Response>`);
  } catch (err) {
    logger.error('Inbound SMS webhook error:', err.message);
    res.set('Content-Type', 'text/xml');
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
});

// POST /api/campaigns/webhook/delivery
// Twilio posts here to update delivery status
router.post('/webhook/delivery', async (req, res) => {
  try {
    const { MessageSid, MessageStatus } = req.body;
    if (MessageSid && MessageStatus) {
      await sms.processDeliveryWebhook(MessageSid, MessageStatus);
    }
    res.status(204).send();
  } catch (err) {
    logger.error('Delivery webhook error:', err.message);
    res.status(204).send();
  }
});


// ── USAGE / LIMITS ────────────────────────────────────────────────────────────

// GET /api/campaigns/usage
// Returns current month usage + plan limit — used by dashboard
router.get('/usage', authenticateToken, async (req, res) => {
  try {
    const summary = await sms.getUsageSummary(req.user.locationId);
    res.json({ success: true, usage: summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
