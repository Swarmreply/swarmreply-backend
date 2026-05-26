// ============================================
// services/webchatAiAgent.js
// SwarmReply AI Chat Agent
//
// Powers the AI auto-responder inside webchat.
// Claude acts as a knowledgeable, on-brand
// business representative — answering questions,
// capturing intent, and routing to a human
// when needed.
//
// Design principles:
//   - Never pretend to be human
//   - Never make up facts about the business
//   - Always capture lead info before helping
//   - Hand off gracefully when stuck
//   - Respect HIPAA for healthcare businesses
//   - Match the business tone setting exactly
// ============================================

const Anthropic = require('@anthropic-ai/sdk');
const { query }  = require('../database/db');
const industryTemplates = require('./industryTemplates');
const logger     = require('../utils/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── AGENT MODES ───────────────────────────────────────────────────────────────
const AGENT_MODE = {
  ALWAYS_ON:  'always_on',   // AI replies to everything, 24/7
  AFTER_HOURS:'after_hours', // AI only outside business hours
  FIRST_REPLY:'first_reply', // AI sends one auto-reply then waits for human
  OFF:        'off'          // AI disabled — human only
};

// ── TONE MAP ──────────────────────────────────────────────────────────────────
const TONE_INSTRUCTIONS = {
  warm:         'Warm, friendly, and personal. Use the visitor\'s first name. Sound like a real person who cares.',
  professional: 'Professional and polished. Clear and efficient. Respectful but not overly familiar.',
  casual:       'Casual and conversational. Relaxed tone. Short sentences. Friendly but not formal.',
  empathetic:   'Empathetic and understanding. Acknowledge feelings first. Patient and reassuring.'
};

// ── MAIN ENTRY POINT ──────────────────────────────────────────────────────────

/**
 * shouldAIRespond()
 * Decides whether the AI agent should respond to this message.
 * Returns true/false based on mode and business hours.
 */
async function shouldAIRespond(sessionId, configId) {
  const result = await query(
    `SELECT
       wca.mode, wca.is_enabled,
       wc.business_hours,
       (SELECT COUNT(*) FROM webchat_messages
        WHERE session_id = $1 AND sender = 'agent') AS agent_reply_count
     FROM webchat_ai_configs wca
     JOIN webchat_configs wc ON wc.id = wca.config_id
     WHERE wca.config_id = $2`,
    [sessionId, configId]
  );

  if (!result.rows[0]) return false;
  const { mode, is_enabled, business_hours, agent_reply_count } = result.rows[0];

  if (!is_enabled) return false;

  switch (mode) {
    case AGENT_MODE.ALWAYS_ON:
      return true;

    case AGENT_MODE.FIRST_REPLY:
      // Only if no agent (human) replies yet — AI breaks the ice
      return parseInt(agent_reply_count) === 0;

    case AGENT_MODE.AFTER_HOURS:
      return !isWithinBusinessHours(business_hours);

    case AGENT_MODE.OFF:
    default:
      return false;
  }
}

/**
 * generateAgentReply()
 * Core function — builds context-aware prompt and calls Claude.
 *
 * @param {string} sessionId  - webchat session UUID
 * @param {string} configId   - webchat_configs UUID
 * @param {string} newMessage - latest visitor message
 * @returns {string|null}     - AI reply text, or null if agent should not reply
 */
async function generateAgentReply(sessionId, configId, newMessage) {
  try {
    // 1. Load everything we need
    const [businessData, sessionData, historyData, agentConfig] = await Promise.all([
      getBusinessContext(configId),
      getSessionContext(sessionId),
      getMessageHistory(sessionId),
      getAgentConfig(configId)
    ]);

    if (!businessData || !agentConfig) return null;

    // 2. Check if AI should respond
    const shouldRespond = await shouldAIRespond(sessionId, configId);
    if (!shouldRespond) return null;

    // 3. Build conversation history for Claude
    const conversationHistory = buildConversationHistory(historyData, newMessage);

    // 4. Build system prompt with full business context
    const systemPrompt = buildSystemPrompt(businessData, sessionData, agentConfig);

    // 5. Call Claude with retry
    const reply = await callClaude(systemPrompt, conversationHistory, agentConfig);
    if (!reply) return null;

    // 6. Check if AI wants to hand off to human
    const handoff = detectHandoffRequest(reply);

    // 7. Sanitise reply
    const clean = sanitiseReply(reply, businessData);

    logger.info(`AI agent replied to session ${sessionId}: ${clean.length} chars, handoff=${handoff}`);

    return { reply: clean, requestsHandoff: handoff };

  } catch (err) {
    logger.error('AI agent error:', err.message);
    return null;
  }
}

// ── PROMPT BUILDERS ───────────────────────────────────────────────────────────

function buildSystemPrompt(business, session, agentConfig) {
  const tone     = TONE_INSTRUCTIONS[business.tone] || TONE_INSTRUCTIONS.warm;
  const name     = session.visitor_name || 'the visitor';
  const faq      = agentConfig.faq_text
    ? `\nFREQUENTLY ASKED QUESTIONS (answer from these exactly):\n${agentConfig.faq_text}\n`
    : '';
  const custom   = agentConfig.custom_instructions
    ? `\nADDITIONAL INSTRUCTIONS:\n${agentConfig.custom_instructions}\n`
    : '';
  const services = agentConfig.services_text
    ? `\nSERVICES / OFFERINGS:\n${agentConfig.services_text}\n`
    : '';
  const phone    = business.contact_phone
    ? `Business phone: ${business.contact_phone}`
    : '';
  const email    = business.contact_email
    ? `Business email: ${business.contact_email}`
    : '';

  const healthcareRules = business.is_healthcare ? `
HEALTHCARE COMPLIANCE — STRICT RULES:
- NEVER confirm or deny any appointment, treatment, or procedure
- NEVER reference specific medical conditions or treatments in context of this visitor
- For clinical questions, always direct to phone or email only
- Do not store, repeat, or reference any health information the visitor shares
- These rules are non-negotiable HIPAA requirements
` : '';

  return `You are the AI assistant for ${business.business_name}, a ${business.business_type || 'local business'}.
You are having a live webchat conversation with ${name}.

IDENTITY:
- You are an AI assistant — never claim to be a human
- You represent ${business.business_name} and answer on their behalf
- You are knowledgeable, helpful, and act in the business's best interest
- If asked if you are a bot or AI, confirm it honestly and warmly

TONE:
${tone}

BUSINESS INFORMATION:
Business name: ${business.business_name}
Type: ${business.business_type || 'local business'}
${phone}
${email}
${services}
${faq}

CORE RULES:
1. Only answer questions you can answer accurately from the information provided
2. If you don't know something, say so clearly and offer to connect them with a human
3. Never make up prices, hours, availability, or policies
4. Always try to capture a lead (name + phone) if not already collected
5. Keep replies concise — 1-3 short paragraphs maximum
6. Never use markdown formatting (no **, no bullet points with -)
7. Use plain conversational text only
8. If the visitor expresses urgency, frustration, or a complaint — immediately offer to connect to a human

HANDOFF SIGNALS — include exactly [HANDOFF] on its own line if:
- The visitor asks to speak to a human or real person
- You cannot answer their question accurately
- The visitor is upset, angry, or has a complaint
- The question involves pricing negotiation or custom quotes
- Any medical, legal, or safety concern

${healthcareRules}
${custom}

CONTEXT:
- Page they came from: ${session.page_url || 'unknown'}
- Visitor name collected: ${session.visitor_name || 'not yet'}
- Visitor phone collected: ${session.visitor_phone ? 'yes' : 'not yet'}

Remember: You are representing a real local business. Be helpful, be honest, and hand off to a human whenever in doubt.`;
}

function buildConversationHistory(history, newMessage) {
  // Convert stored messages to Claude's format
  // Claude needs alternating user/assistant messages
  const messages = [];

  for (const msg of history) {
    if (msg.sender === 'visitor') {
      messages.push({ role: 'user', content: msg.body });
    } else if (msg.sender === 'agent' || msg.sender === 'bot') {
      messages.push({ role: 'assistant', content: msg.body });
    }
    // Skip system messages
  }

  // Add new message if not already in history
  if (newMessage) {
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== newMessage) {
      messages.push({ role: 'user', content: newMessage });
    }
  }

  // Claude requires the conversation to start with 'user'
  // and must end with 'user'
  if (!messages.length) {
    messages.push({ role: 'user', content: newMessage || 'Hello' });
  }

  return messages;
}

// ── CLAUDE CALL ───────────────────────────────────────────────────────────────

async function callClaude(systemPrompt, messages, agentConfig) {
  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: agentConfig.max_reply_tokens || 400,
        system:     systemPrompt,
        messages
      });

      const text = response.content[0]?.text?.trim();
      if (!text || text.length < 5) throw new Error('Empty response from Claude');

      logger.debug(`AI agent tokens: ${response.usage.input_tokens} in, ${response.usage.output_tokens} out`);
      return text;

    } catch (err) {
      lastError = err;
      const retryable = err.status === 429 || err.status === 500 || err.status === 503;
      if (retryable && attempt < maxRetries) {
        const wait = Math.pow(2, attempt) * 1000;
        logger.warn(`AI agent attempt ${attempt} failed, retrying in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      break;
    }
  }

  logger.error('AI agent Claude call failed:', lastError?.message);
  return null;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function detectHandoffRequest(reply) {
  return reply.includes('[HANDOFF]');
}

function sanitiseReply(reply, business) {
  return reply
    .replace('[HANDOFF]', '')   // strip the handoff signal
    .replace(/\n{3,}/g, '\n\n') // collapse extra blank lines
    .trim();
}

function isWithinBusinessHours(businessHours) {
  if (!businessHours?.enabled) return true; // no hours set = always open

  const now   = new Date();
  const day   = ['sun','mon','tue','wed','thu','fri','sat'][now.getDay()];
  const hours = businessHours.hours?.[day];
  if (!hours?.open) return false;

  const [openH,  openM]  = hours.open.split(':').map(Number);
  const [closeH, closeM] = hours.close.split(':').map(Number);
  const nowMins  = now.getHours() * 60 + now.getMinutes();
  const openMins = openH  * 60 + openM;
  const closeMins= closeH * 60 + closeM;

  return nowMins >= openMins && nowMins <= closeMins;
}

// ── DATA LOADERS ──────────────────────────────────────────────────────────────

async function getBusinessContext(configId) {
  const result = await query(
    `SELECT
       l.business_name, l.business_type, l.tone,
       l.contact_email, l.always_include, l.never_include,
       l.custom_instructions, l.is_healthcare,
       lp.phone AS contact_phone
     FROM webchat_configs wc
     JOIN locations l ON l.id = wc.location_id
     LEFT JOIN location_phones lp ON lp.location_id = l.id AND lp.is_primary = true
     WHERE wc.id = $1`,
    [configId]
  );
  return result.rows[0] || null;
}

async function getSessionContext(sessionId) {
  const result = await query(
    `SELECT visitor_name, visitor_phone, visitor_email, page_url
     FROM webchat_sessions WHERE id = $1`,
    [sessionId]
  );
  return result.rows[0] || {};
}

async function getMessageHistory(sessionId) {
  const result = await query(
    `SELECT sender, body, created_at
     FROM webchat_messages
     WHERE session_id = $1
       AND msg_type = 'text'
       AND sender IN ('visitor','agent','bot')
     ORDER BY created_at ASC
     LIMIT 30`,
    [sessionId]
  );
  return result.rows;
}

async function getAgentConfig(configId) {
  const result = await query(
    `SELECT wac.*, l.business_type, l.business_name
     FROM webchat_ai_configs wac
     JOIN webchat_configs wc ON wc.id = wac.config_id
     JOIN locations l ON l.id = wc.location_id
     WHERE wac.config_id = $1`,
    [configId]
  );
  if (!result.rows[0]) return null;

  const cfg = result.rows[0];

  // If the owner hasn't filled in their knowledge base yet,
  // auto-inject the industry template as a fallback
  if (!cfg.faq_text && !cfg.services_text) {
    const industryKey = industryTemplates.getIndustryFromBusinessType(cfg.business_type);
    if (industryKey) {
      const tpl = industryTemplates.applyTemplate(industryKey, cfg.business_name);
      cfg.faq_text             = tpl.faq_text;
      cfg.services_text        = tpl.services_text;
      cfg.custom_instructions  = cfg.custom_instructions || tpl.custom_instructions;
      cfg._template_applied    = industryKey; // flag for logging
    }
  }

  return cfg;
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────

module.exports = {
  generateAgentReply,
  shouldAIRespond,
  isWithinBusinessHours,
  AGENT_MODE
};
