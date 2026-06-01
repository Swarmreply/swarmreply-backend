// ============================================
// routes/webchat.js
// SwarmReply Webchat API Routes
//
// Public (no auth — called by the JS widget):
//   GET  /api/webchat/config/:token        Widget config
//   POST /api/webchat/session/start        Start a new session
//   POST /api/webchat/session/:id/message  Visitor sends a message
//   GET  /api/webchat/session/:id/stream   SSE stream for visitor
//
// Private (requires auth — called by dashboard):
//   GET  /api/webchat/inbox                All sessions for location
//   GET  /api/webchat/inbox/stats          Unread counts + stats
//   GET  /api/webchat/session/:id          Single session + messages
//   POST /api/webchat/session/:id/reply    Agent replies
//   POST /api/webchat/session/:id/resolve  Mark resolved
//   GET  /api/webchat/settings             Widget settings
//   PUT  /api/webchat/settings             Update widget settings
//   POST /api/webchat/settings/rotate-token Rotate embed token
// ============================================

const express = require('express');
const router  = express.Router();
const webchatService = require('../services/webchatService');
const { authenticateToken } = require('../middleware/auth');

// Resolve the location a dashboard request targets (token has customerId, not
// locationId). Accepts an optional explicit ?locationId / body.locationId for
// multi-location accounts; falls back to the customer's first active location.
async function getLocationId(req) {
  return webchatService.resolveLocationId(
    req.user.customerId || req.user.id,
    req.query.locationId || (req.body && req.body.locationId)
  );
}
const logger = require('../utils/logger');

// ── Rate limit specifically for widget public endpoints ───────────────────────
const rateLimit = require('express-rate-limit');
const widgetLimit = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 60,               // 60 requests per minute per IP
  message: { error: 'Too many requests' }
});

// ════════════════════════════════════════════
// PUBLIC ROUTES — no auth required
// These are called directly by the JS embed on
// customer websites — keep them fast and lean
// ════════════════════════════════════════════

// GET /api/webchat/config/:token
// Called on widget init — returns appearance + content config
router.get('/config/:token', widgetLimit, async (req, res) => {
  try {
    const config = await webchatService.getConfig(req.params.token);
    if (!config || !config.is_active) {
      return res.status(404).json({ error: 'Widget not found' });
    }
    // Cache for 5 minutes — CDN friendly
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ success: true, config });
  } catch (err) {
    logger.error('webchat config error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/webchat/session/start
// Visitor submits lead form + first message — creates session
router.post('/session/start', widgetLimit, async (req, res) => {
  try {
    const {
      token, visitorName, visitorPhone, visitorEmail,
      firstMessage, pageUrl, referrer
    } = req.body;

    if (!token || !firstMessage?.trim()) {
      return res.status(400).json({ error: 'token and firstMessage are required' });
    }

    const result = await webchatService.startSession({
      token,
      visitorName: visitorName?.trim(),
      visitorPhone: visitorPhone?.trim(),
      visitorEmail: visitorEmail?.trim(),
      firstMessage: firstMessage.trim(),
      pageUrl,
      referrer,
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip
    });

    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('webchat start session error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// POST /api/webchat/session/:id/message
// Visitor sends a follow-up message
router.post('/session/:id/message', widgetLimit, async (req, res) => {
  try {
    const { body, token } = req.body;
    if (!body?.trim() || !token) {
      return res.status(400).json({ error: 'body and token required' });
    }
    const msg = await webchatService.receiveVisitorMessage(
      req.params.id, token, body.trim()
    );
    res.json({ success: true, message: msg });
  } catch (err) {
    logger.error('webchat message error:', err);
    res.status(400).json({ error: err.message || 'Server error' });
  }
});

// GET /api/webchat/session/:id/stream
// SSE — visitor listens for agent replies in real time
router.get('/session/:id/stream', widgetLimit, async (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write(': connected\n\n');
  // Send heartbeat every 25s to prevent proxy timeout
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  webchatService.addSseClient(req.params.id, res);
  req.on('close', () => clearInterval(heartbeat));
});

// ════════════════════════════════════════════
// PRIVATE ROUTES — dashboard use only
// ════════════════════════════════════════════

// GET /api/webchat/inbox
// All sessions for the authenticated location
router.get('/inbox', authenticateToken, async (req, res) => {
  try {
    const { status = 'open', limit = 50, offset = 0 } = req.query;
    const sessions = await webchatService.getSessions(
      req.user.locationId,
      { status, limit: parseInt(limit), offset: parseInt(offset) }
    );
    res.json({ success: true, sessions });
  } catch (err) {
    logger.error('webchat inbox error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/webchat/inbox/stats
router.get('/inbox/stats', authenticateToken, async (req, res) => {
  try {
    const stats = await webchatService.getInboxStats(req.user.locationId);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/webchat/session/:id
// Single session with all messages
router.get('/session/:id', authenticateToken, async (req, res) => {
  try {
    const messages = await webchatService.getMessages(
      req.params.id, req.user.locationId
    );
    res.json({ success: true, messages });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/webchat/session/:id/reply
// Agent sends a reply from the dashboard
router.post('/session/:id/reply', authenticateToken, async (req, res) => {
  try {
    const { body, sendSms } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'body required' });

    const msg = await webchatService.sendMessage(
      req.params.id,
      req.user.locationId,
      {
        body: body.trim(),
        agentId:   req.user.id,
        agentName: req.user.name,
        sendSms:   sendSms !== false
      }
    );
    res.json({ success: true, message: msg });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/webchat/session/:id/resolve
router.post('/session/:id/resolve', authenticateToken, async (req, res) => {
  try {
    await webchatService.resolveSession(req.params.id, req.user.locationId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/webchat/settings
router.get('/settings', authenticateToken, async (req, res) => {
  try {
    const locationId = await getLocationId(req);
    if (!locationId) return res.status(400).json({ error: 'No location found. Add a location first.' });
    const config = await webchatService.getConfigForDashboard(locationId);
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/webchat/settings
router.put('/settings', authenticateToken, async (req, res) => {
  try {
    const locationId = await getLocationId(req);
    if (!locationId) return res.status(400).json({ error: 'No location found.' });
    const config = await webchatService.updateConfig(locationId, req.body);
    res.json({ success: true, config });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/webchat/settings/rotate-token
router.post('/settings/rotate-token', authenticateToken, async (req, res) => {
  try {
    const locationId = await getLocationId(req);
    if (!locationId) return res.status(400).json({ error: 'No location found.' });
    const token = await webchatService.rotateToken(locationId);
    res.json({ success: true, widget_token: token });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});


// ════════════════════════════════════════════
// AI AGENT ROUTES
// ════════════════════════════════════════════

// GET /api/webchat/ai/settings
// Load AI agent config for the dashboard
router.get('/ai/settings', authenticateToken, async (req, res) => {
  try {
    const locationId = await getLocationId(req);
    if (!locationId) return res.status(400).json({ error: 'No location found.' });
    const config = await webchatService.getAIConfig(locationId);
    res.json({ success: true, config: config || {} });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/webchat/ai/settings
// Save AI agent settings
router.put('/ai/settings', authenticateToken, async (req, res) => {
  try {
    const locationId = await getLocationId(req);
    if (!locationId) return res.status(400).json({ error: 'No location found.' });
    const config = await webchatService.updateAIConfig(locationId, req.body);
    res.json({ success: true, config });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/webchat/ai/handoffs
// Handoff log — what the AI couldn't handle
router.get('/ai/handoffs', authenticateToken, async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const handoffs = await webchatService.getHandoffLog(
      req.user.locationId, parseInt(limit)
    );
    res.json({ success: true, handoffs });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/webchat/ai/test
// Test the AI agent with a sample message — returns reply without storing
router.post('/ai/test', authenticateToken, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message required' });

    // Get agent config + build a mock context for preview
    const aiAgent = require('../services/webchatAiAgent');
    const webchatSvc = require('../services/webchatService');
    const cfg = await webchatSvc.getConfigForDashboard(req.user.locationId);
    if (!cfg) return res.status(404).json({ error: 'No webchat config found' });

    // Run the AI but don't store anything
    const result = await aiAgent.generateAgentReply(null, cfg.id, message, { dryRun: true });
    if (!result) return res.json({ success: true, reply: null, note: 'AI agent is disabled or mode would not respond' });

    res.json({ success: true, reply: result.reply, requestsHandoff: result.requestsHandoff });
  } catch (err) {
    logger.error('AI test error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});


// ── INDUSTRY TEMPLATES ───────────────────────────────────────────────────────

// GET /api/webchat/ai/templates
// List all available industry templates for the picker UI
router.get('/ai/templates', authenticateToken, (req, res) => {
  const industryTemplates = require('../services/industryTemplates');
  res.json({ success: true, templates: industryTemplates.getTemplateList() });
});

// POST /api/webchat/ai/templates/apply
// Apply an industry template to this location's AI config
// Only fills in fields the owner hasn't already customised
router.post('/ai/templates/apply', authenticateToken, async (req, res) => {
  try {
    const { industryKey, overwrite = false } = req.body;
    if (!industryKey) return res.status(400).json({ error: 'industryKey required' });

    const industryTemplates = require('../services/industryTemplates');
    const { query } = require('../database/db');

    // Get business name for placeholder replacement
    const locResult = await query(
      `SELECT business_name FROM locations WHERE id = $1`,
      [req.user.locationId]
    );
    const businessName = locResult.rows[0]?.business_name || 'our business';

    const tpl = industryTemplates.applyTemplate(industryKey, businessName);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });

    // Get existing AI config
    const existing = await query(
      `SELECT wac.* FROM webchat_ai_configs wac
       JOIN webchat_configs wc ON wc.id = wac.config_id
       WHERE wc.location_id = $1`,
      [req.user.locationId]
    );

    if (!existing.rows[0]) {
      return res.status(404).json({ error: 'AI config not found — set up webchat first' });
    }

    const cfg = existing.rows[0];

    // Only overwrite fields that are empty (unless overwrite=true)
    const updates = {};
    if (overwrite || !cfg.services_text)        updates.services_text        = tpl.services_text;
    if (overwrite || !cfg.faq_text)             updates.faq_text             = tpl.faq_text;
    if (overwrite || !cfg.custom_instructions)  updates.custom_instructions  = tpl.custom_instructions;
    if (overwrite || !cfg.agent_name)           updates.agent_name           = 'AI Assistant';

    if (!Object.keys(updates).length) {
      return res.json({
        success: true,
        message: 'No fields updated — your knowledge base already has content. Pass overwrite=true to replace.',
        fieldsUpdated: 0
      });
    }

    const fields = Object.keys(updates);
    const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    const values    = fields.map(f => updates[f]);

    await query(
      `UPDATE webchat_ai_configs SET ${setClause} WHERE id = $1`,
      [cfg.id, ...values]
    );

    // Also update the webchat widget greeting if blank
    if (overwrite || !cfg.greeting_title) {
      await query(
        `UPDATE webchat_configs
         SET greeting_title   = $2,
             welcome_message  = $3
         WHERE location_id    = $4
           AND ($5 OR greeting_title = 'Chat with us')`,
        [tpl.greeting_title, tpl.welcome_message,
         req.user.locationId, overwrite]
      );
    }

    logger.info(`Template applied: ${industryKey} for location ${req.user.locationId}`);
    res.json({
      success: true,
      template:      industryKey,
      fieldsUpdated: fields.length,
      fields
    });
  } catch (err) {
    logger.error('Apply template error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// GET /api/webchat/ai/templates/:key/preview
// Preview a template before applying — returns the full template content
router.get('/ai/templates/:key/preview', authenticateToken, async (req, res) => {
  try {
    const industryTemplates = require('../services/industryTemplates');
    const { query } = require('../database/db');

    const locResult = await query(
      `SELECT business_name FROM locations WHERE id = $1`,
      [req.user.locationId]
    );
    const businessName = locResult.rows[0]?.business_name || 'Your Business';
    const tpl = industryTemplates.applyTemplate(req.params.key, businessName);

    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    res.json({ success: true, template: tpl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
