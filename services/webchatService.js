// ============================================
// services/webchatService.js
// SwarmReply Webchat — core business logic
//
// Responsibilities:
//   - Widget config CRUD
//   - Session management (open, resolve, assign)
//   - Message send/receive (webchat + SMS bridge)
//   - Real-time via Server-Sent Events (SSE)
//   - Lead notifications (email + SMS to business)
//   - Twilio SMS bridge for offline visitors
// ============================================

const { query } = require('../database/db');
const { Resend } = require('resend');
const logger = require('../utils/logger');

const resend = new Resend(process.env.RESEND_API_KEY);
const { sendText } = require('./smsGate');

// Lazy Twilio init
let twilioClient = null;
function getTwilio() {
  if (!twilioClient && process.env.TWILIO_ACCOUNT_SID) {
    twilioClient = require('twilio')(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }
  return twilioClient;
}

// SSE clients store: sessionId → Set of res objects
const sseClients = new Map();

// ── WIDGET CONFIG ─────────────────────────────────────────────────────────────

/**
 * getConfig()
 * Load widget config by public token — called by the JS embed on every page load.
 * Returns only the fields the frontend needs (no PII like notify_email).
 */
async function getConfig(token) {
  const result = await query(
    `SELECT
       wc.widget_token,
       wc.brand_color, wc.text_color, wc.position,
       wc.button_icon, wc.button_size,
       wc.greeting_title, wc.greeting_subtitle,
       wc.avatar_emoji, wc.show_avatar,
       wc.collect_name, wc.collect_phone, wc.collect_email,
       wc.name_placeholder, wc.phone_placeholder, wc.email_placeholder,
       wc.welcome_message,
       wc.offline_enabled, wc.offline_message, wc.business_hours,
       wc.is_active,
       l.business_name
     FROM webchat_configs wc
     JOIN locations l ON l.id = wc.location_id
     WHERE wc.widget_token = $1`,
    [token]
  );
  return result.rows[0] || null;
}

/**
 * getConfigForDashboard()
 * Full config including notification settings — for the settings UI.
 */
async function getConfigForDashboard(locationId) {
  const result = await query(
    `SELECT * FROM webchat_configs WHERE location_id = $1`,
    [locationId]
  );
  if (result.rows[0]) return result.rows[0];

  // Auto-create default config if none exists
  const created = await query(
    `INSERT INTO webchat_configs (location_id)
     VALUES ($1)
     RETURNING *`,
    [locationId]
  );
  return created.rows[0];
}

/**
 * updateConfig()
 * Save widget settings from the dashboard.
 */
async function updateConfig(locationId, updates) {
  const allowed = [
    'brand_color','text_color','position','button_icon','button_size',
    'greeting_title','greeting_subtitle','avatar_emoji','show_avatar',
    'collect_name','collect_phone','collect_email',
    'name_placeholder','phone_placeholder','email_placeholder',
    'welcome_message','offline_enabled','offline_message',
    'business_hours','notify_email','notify_sms','sms_reply_enabled','is_active'
  ];

  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (!fields.length) throw new Error('No valid fields to update');

  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values    = fields.map(f => updates[f]);

  const result = await query(
    `UPDATE webchat_configs SET ${setClause}
     WHERE location_id = $1 RETURNING *`,
    [locationId, ...values]
  );
  return result.rows[0];
}

/**
 * rotateToken()
 * Generate a fresh embed token — invalidates all existing embeds for this location.
 */
async function rotateToken(locationId) {
  const result = await query(
    `UPDATE webchat_configs
     SET widget_token = encode(gen_random_bytes(24), 'hex')
     WHERE location_id = $1 RETURNING widget_token`,
    [locationId]
  );
  return result.rows[0]?.widget_token;
}

// ── SESSIONS ──────────────────────────────────────────────────────────────────

/**
 * startSession()
 * Called when a visitor submits the lead form and sends their first message.
 * Creates the session + stores the message + fires notifications.
 */
async function startSession({ token, visitorName, visitorPhone, visitorEmail, firstMessage, pageUrl, referrer, userAgent, ipAddress }) {
  // 1. Load config
  const config = await query(
    `SELECT id, location_id, notify_email, notify_sms, sms_reply_enabled, greeting_title, welcome_message
     FROM webchat_configs WHERE widget_token = $1 AND is_active = true`,
    [token]
  );
  if (!config.rows[0]) throw new Error('Widget not found or inactive');
  const cfg = config.rows[0];

  // 2. Create session
  const session = await query(
    `INSERT INTO webchat_sessions
       (config_id, location_id, visitor_name, visitor_phone, visitor_email, page_url, referrer, user_agent, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [cfg.id, cfg.location_id, visitorName, visitorPhone, visitorEmail, pageUrl, referrer, userAgent, ipAddress]
  );
  const sess = session.rows[0];

  // 3. Store the welcome bot message
  await query(
    `INSERT INTO webchat_messages (session_id, sender, sender_name, body, msg_type, channel)
     VALUES ($1, 'bot', 'SwarmReply', $2, 'text', 'webchat')`,
    [sess.id, cfg.welcome_message]
  );

  // 4. Store visitor's first message
  await query(
    `INSERT INTO webchat_messages (session_id, sender, sender_name, body, msg_type, channel)
     VALUES ($1, 'visitor', $2, $3, 'text', 'webchat')`,
    [sess.id, visitorName || 'Visitor', firstMessage]
  );

  // 5. Update unread count
  await query(
    `UPDATE webchat_sessions SET unread_count = 1 WHERE id = $1`,
    [sess.id]
  );

  // 6. Notify business asynchronously
  notifyBusiness(cfg, sess, visitorName, visitorPhone, firstMessage).catch(e =>
    logger.error('Webchat notify error:', e)
  );

  return { sessionId: sess.id, welcomeMessage: cfg.welcome_message };
}

/**
 * notifyBusiness()
 * Sends email + SMS to the business owner when a new chat comes in.
 */
async function notifyBusiness(cfg, session, visitorName, visitorPhone, firstMessage) {
  const locResult = await query(
    `SELECT business_name FROM locations WHERE id = $1`,
    [cfg.location_id]
  );
  const businessName = locResult.rows[0]?.business_name || 'your business';
  const name = visitorName || 'A visitor';
  const dashUrl = `${process.env.FRONTEND_URL}/dashboard/inbox?session=${session.id}`;

  // Email notification
  if (cfg.notify_email) {
    await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: cfg.notify_email,
      subject: `💬 New webchat from ${name} — ${businessName}`,
      html: `
        <div style="font-family:DM Sans,sans-serif;max-width:560px;margin:0 auto;padding:32px 0">
          <div style="background:#0a0a0a;border-radius:16px;padding:28px 32px;margin-bottom:20px">
            <div style="font-size:1.4rem;font-weight:700;color:#fff;margin-bottom:4px">💬 New webchat message</div>
            <div style="color:rgba(255,255,255,.5);font-size:.875rem">${businessName}</div>
          </div>
          <div style="background:#f8f7f4;border-radius:12px;padding:20px 24px;margin-bottom:16px">
            <div style="font-size:.75rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#7a7670;margin-bottom:8px">From</div>
            <div style="font-weight:600;margin-bottom:4px">${name}${visitorPhone ? ` · ${visitorPhone}` : ''}</div>
            <div style="font-size:.875rem;color:#4a4a48;font-style:italic;line-height:1.65">"${firstMessage}"</div>
          </div>
          <a href="${dashUrl}" style="display:block;text-align:center;padding:14px;background:#f5c842;color:#0a0a0a;border-radius:50px;font-weight:700;font-size:.9rem;text-decoration:none">Reply in dashboard →</a>
          <p style="text-align:center;font-size:.75rem;color:#aaa;margin-top:16px">SwarmReply Webchat — <a href="${process.env.FRONTEND_URL}" style="color:#aaa">swarmreply.com</a></p>
        </div>`
    });
  }

  // SMS notification to business owner
  if (cfg.notify_sms) {
    await sendText({
      to: cfg.notify_sms,
      body: `💬 New webchat from ${name}${visitorPhone ? ` (${visitorPhone})` : ''}: "${firstMessage.substring(0, 120)}"\n\nReply: ${dashUrl}`
    });
  }

  // SMS to visitor if phone provided — bridges conversation to text
  if (visitorPhone && cfg.sms_reply_enabled) {
    const optIn = await sendText({
      to: visitorPhone,
      body: `Hi ${name || 'there'}! 👋 Thanks for reaching out to ${businessName}. We'll text you right back at this number. — Powered by SwarmReply`
    });
    if (optIn.sent) {
      await query(
        `UPDATE webchat_sessions SET sms_opted_in = true WHERE id = $1`,
        [session.id]
      );
    }
  }
}

/**
 * getSessions()
 * Load all sessions for a location — for the inbox dashboard.
 */
async function getSessions(locationId, { status = 'open', limit = 50, offset = 0 } = {}) {
  const result = await query(
    `SELECT
       s.id, s.visitor_name, s.visitor_phone, s.visitor_email,
       s.status, s.unread_count, s.page_url, s.created_at, s.updated_at,
       (SELECT body FROM webchat_messages WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1) AS last_message,
       (SELECT created_at FROM webchat_messages WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1) AS last_message_at
     FROM webchat_sessions s
     WHERE s.location_id = $1
       AND ($2 = 'all' OR s.status = $2)
     ORDER BY s.updated_at DESC
     LIMIT $3 OFFSET $4`,
    [locationId, status, limit, offset]
  );
  return result.rows;
}

/**
 * getMessages()
 * Load all messages for a session.
 */
async function getMessages(sessionId, locationId) {
  // Verify session belongs to this location
  const check = await query(
    `SELECT id FROM webchat_sessions WHERE id = $1 AND location_id = $2`,
    [sessionId, locationId]
  );
  if (!check.rows[0]) throw new Error('Session not found');

  // Mark as read
  await query(
    `UPDATE webchat_sessions SET unread_count = 0 WHERE id = $1`,
    [sessionId]
  );

  const result = await query(
    `SELECT id, sender, sender_name, body, msg_type, channel, created_at, read_at
     FROM webchat_messages
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId]
  );
  return result.rows;
}

/**
 * sendMessage()
 * Agent sends a message from the dashboard.
 * Optionally bridges to SMS if visitor opted in.
 */
async function sendMessage(sessionId, locationId, { body, agentId, agentName, sendSms = true }) {
  // Verify session
  const sess = await query(
    `SELECT s.*, wc.sms_reply_enabled
     FROM webchat_sessions s
     JOIN webchat_configs wc ON wc.id = s.config_id
     WHERE s.id = $1 AND s.location_id = $2`,
    [sessionId, locationId]
  );
  if (!sess.rows[0]) throw new Error('Session not found');
  const session = sess.rows[0];

  // Store message
  const msg = await query(
    `INSERT INTO webchat_messages
       (session_id, sender, sender_name, agent_id, body, msg_type, channel)
     VALUES ($1, 'agent', $2, $3, $4, 'text', 'webchat')
     RETURNING *`,
    [sessionId, agentName || 'Support', agentId || null, body]
  );

  // Update session timestamp
  await query(
    `UPDATE webchat_sessions SET updated_at = NOW(), status = 'active' WHERE id = $1`,
    [sessionId]
  );

  // Push to SSE clients listening on this session
  broadcastToSession(sessionId, {
    type: 'message',
    message: msg.rows[0]
  });

  // SMS bridge — text the visitor if they opted in
  if (sendSms && session.sms_opted_in && session.visitor_phone &&
      session.sms_reply_enabled) {
    await sendText({
      to: session.visitor_phone,
      body
    });
  }

  return msg.rows[0];
}

/**
 * receiveVisitorMessage()
 * Visitor sends a message from the chat widget (after session started).
 */
async function receiveVisitorMessage(sessionId, token, body) {
  // Verify token matches session
  const check = await query(
    `SELECT s.id, s.visitor_name, wc.notify_sms, wc.notify_email, l.business_name
     FROM webchat_sessions s
     JOIN webchat_configs wc ON wc.id = s.config_id
     JOIN locations l ON l.id = s.location_id
     WHERE s.id = $1 AND wc.widget_token = $2`,
    [sessionId, token]
  );
  if (!check.rows[0]) throw new Error('Invalid session');
  const sess = check.rows[0];

  // Store message
  const msg = await query(
    `INSERT INTO webchat_messages
       (session_id, sender, sender_name, body, msg_type, channel)
     VALUES ($1, 'visitor', $2, $3, 'text', 'webchat')
     RETURNING *`,
    [sessionId, sess.visitor_name || 'Visitor', body]
  );

  // Increment unread + update timestamp
  await query(
    `UPDATE webchat_sessions
     SET unread_count = unread_count + 1, updated_at = NOW()
     WHERE id = $1`,
    [sessionId]
  );

  // Broadcast to dashboard SSE
  broadcastToSession(sessionId, { type: 'message', message: msg.rows[0] });

  // Ping business owner via SMS for subsequent messages
  if (sess.notify_sms) {
    await sendText({
      to: sess.notify_sms,
      body: `💬 ${sess.visitor_name || 'Visitor'}: "${body.substring(0, 140)}"`
    }).catch(() => {});
  }

  // Trigger AI agent response asynchronously — don't block the API response
  triggerAIAgent(sessionId, sess.config_id, body).catch(e =>
    logger.error('AI agent trigger error:', e)
  );

  return msg.rows[0];
}

/**
 * triggerAIAgent()
 * Called after a visitor message is stored.
 * Generates an AI reply and saves + broadcasts it
 * if the agent is configured to respond.
 */
async function triggerAIAgent(sessionId, configId, visitorMessage) {
  const result = await aiAgent.generateAgentReply(sessionId, configId, visitorMessage);
  if (!result) return; // AI not configured or decided not to respond

  const { reply, requestsHandoff } = result;

  // Simulate typing delay for natural feel
  const delayCfg = await query(
    `SELECT reply_delay_ms FROM webchat_ai_configs WHERE config_id = $1`,
    [configId]
  );
  const delay = delayCfg.rows[0]?.reply_delay_ms ?? 1500;
  if (delay > 0) await new Promise(r => setTimeout(r, delay));

  // Broadcast typing indicator to visitor
  broadcastToSession(sessionId, { type: 'typing', sender: 'agent' });
  await new Promise(r => setTimeout(r, 1200));

  // Store AI message
  const msg = await query(
    `INSERT INTO webchat_messages
       (session_id, sender, sender_name, body, msg_type, channel)
     VALUES ($1, 'bot', 'AI Assistant', $2, 'text', 'webchat')
     RETURNING *`,
    [sessionId, reply]
  );

  // Update session
  await query(
    `UPDATE webchat_sessions SET updated_at = NOW(), status = 'active' WHERE id = $1`,
    [sessionId]
  );

  // Broadcast to visitor widget
  broadcastToSession(sessionId, { type: 'message', message: msg.rows[0] });

  // Update AI usage stats
  await query(
    `UPDATE webchat_ai_configs
     SET total_replies = total_replies + 1, last_used_at = NOW()
     WHERE config_id = $1`,
    [configId]
  );

  // Handle handoff request
  if (requestsHandoff) {
    await handleAIHandoff(sessionId, configId, visitorMessage, reply);
  }
}

/**
 * handleAIHandoff()
 * AI determined it can't handle this — log it, notify owner.
 */
async function handleAIHandoff(sessionId, configId, triggerMsg, aiReply) {
  // Log the handoff
  await query(
    `INSERT INTO webchat_handoffs (session_id, config_id, trigger_msg, ai_reply)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, configId, triggerMsg, aiReply]
  );

  // Update AI handoff count
  await query(
    `UPDATE webchat_ai_configs
     SET total_handoffs = total_handoffs + 1
     WHERE config_id = $1`,
    [configId]
  );

  // Notify business owner — someone needs a human
  const cfgResult = await query(
    `SELECT wc.notify_email, wc.notify_sms, l.business_name
     FROM webchat_configs wc
     JOIN locations l ON l.id = wc.location_id
     WHERE wc.id = $1`,
    [configId]
  );
  const cfg = cfgResult.rows[0];
  if (!cfg) return;

  const dashUrl = `${process.env.FRONTEND_URL}/dashboard/inbox?session=${sessionId}`;

  if (cfg.notify_sms) {
    await sendText({
      to:   cfg.notify_sms,
      body: `🚨 AI handoff needed — visitor needs a human. Reply now: ${dashUrl}`
    }).catch(() => {});
  }

  logger.info(`AI handoff logged for session ${sessionId}`);
}

/**
 * resolveSession()
 * Mark a conversation as resolved.
 */
async function resolveSession(sessionId, locationId) {
  await query(
    `UPDATE webchat_sessions
     SET status = 'resolved', resolved_at = NOW(), unread_count = 0
     WHERE id = $1 AND location_id = $2`,
    [sessionId, locationId]
  );
  broadcastToSession(sessionId, { type: 'resolved' });
}

// ── SERVER-SENT EVENTS ────────────────────────────────────────────────────────

/**
 * addSseClient()
 * Register a dashboard client to receive real-time updates for a session.
 */
function addSseClient(sessionId, res) {
  if (!sseClients.has(sessionId)) sseClients.set(sessionId, new Set());
  sseClients.get(sessionId).add(res);
  res.on('close', () => {
    sseClients.get(sessionId)?.delete(res);
    if (sseClients.get(sessionId)?.size === 0) sseClients.delete(sessionId);
  });
}

/**
 * broadcastToSession()
 * Push a JSON event to all SSE clients listening on this session.
 */
function broadcastToSession(sessionId, data) {
  const clients = sseClients.get(sessionId);
  if (!clients?.size) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch (e) { clients.delete(res); }
  }
}

// ── INBOX STATS ───────────────────────────────────────────────────────────────
async function getInboxStats(locationId) {
  const result = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'open')     AS open_count,
       COUNT(*) FILTER (WHERE status = 'active')   AS active_count,
       COUNT(*) FILTER (WHERE status = 'resolved') AS resolved_count,
       SUM(unread_count)                            AS total_unread,
       COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS last_24h
     FROM webchat_sessions
     WHERE location_id = $1`,
    [locationId]
  );
  return result.rows[0];
}

// ── AI AGENT CONFIG ───────────────────────────────────────────────────────────

async function getAIConfig(locationId) {
  const result = await query(
    `SELECT wac.*
     FROM webchat_ai_configs wac
     JOIN webchat_configs wc ON wc.id = wac.config_id
     WHERE wc.location_id = $1`,
    [locationId]
  );
  return result.rows[0] || null;
}

async function updateAIConfig(locationId, updates) {
  const allowed = [
    'is_enabled','mode','agent_name','faq_text','services_text',
    'custom_instructions','handoff_message','auto_notify_on_handoff',
    'max_reply_tokens','reply_delay_ms'
  ];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (!fields.length) throw new Error('No valid fields');

  // Ensure the parent webchat_configs row exists (auto-creates if missing),
  // then ensure an ai_config row exists for it — no row had ever been created,
  // so the previous UPDATE-only path silently saved nothing.
  const cfg = await getConfigForDashboard(locationId);
  const configId = cfg.id;

  const existing = await query(
    'SELECT id FROM webchat_ai_configs WHERE config_id = $1',
    [configId]
  );
  if (!existing.rows[0]) {
    await query('INSERT INTO webchat_ai_configs (config_id) VALUES ($1)', [configId]);
  }

  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values    = fields.map(f => updates[f]);

  const result = await query(
    `UPDATE webchat_ai_configs SET ${setClause}
     WHERE config_id = $1 RETURNING *`,
    [configId, ...values]
  );
  return result.rows[0];
}

async function getHandoffLog(locationId, limit = 20) {
  const result = await query(
    `SELECT wh.*, ws.visitor_name, ws.visitor_phone
     FROM webchat_handoffs wh
     JOIN webchat_sessions ws ON ws.id = wh.session_id
     JOIN webchat_configs wc ON wc.id = wh.config_id
     WHERE wc.location_id = $1
     ORDER BY wh.created_at DESC
     LIMIT $2`,
    [locationId, limit]
  );
  return result.rows;
}

// Resolve which location a dashboard request applies to.
// The JWT carries customerId but not locationId, so derive it: prefer an
// explicit (ownership-validated) request, else the customer's first active location.
async function resolveLocationId(customerId, requestedId) {
  if (!customerId) return null;
  if (requestedId) {
    const r = await query(
      'SELECT id FROM locations WHERE id = $1 AND customer_id = $2',
      [requestedId, customerId]
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  const r = await query(
    `SELECT id FROM locations
     WHERE customer_id = $1 AND is_active = true
     ORDER BY created_at ASC LIMIT 1`,
    [customerId]
  );
  return r.rows[0]?.id || null;
}

module.exports = {
  getConfig, getConfigForDashboard, updateConfig, rotateToken,
  startSession, getSessions, getMessages, sendMessage,
  receiveVisitorMessage, resolveSession,
  addSseClient, broadcastToSession,
  getInboxStats,
  getAIConfig, updateAIConfig, getHandoffLog,
  resolveLocationId
};
