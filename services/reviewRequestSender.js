// ============================================
// services/reviewRequestSender.js
// Sends review request emails and SMS directly
// through SwarmReply — like Birdeye
// Requires: Resend (email) + Twilio (SMS)
// ============================================

const { Resend } = require('resend');
const { query } = require('../database/db');
const { previewTemplate } = require('./reviewRequestService');
const logger = require('../utils/logger');

const resend = new Resend(process.env.RESEND_API_KEY);

// Twilio client — lazy init so app starts without Twilio if not configured
let twilioClient = null;
function getTwilio() {
  if (!twilioClient && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    const twilio = require('twilio');
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return twilioClient;
}

// ============================================
// SEND A REVIEW REQUEST
// ============================================

/**
 * sendReviewRequest()
 * Send a review request email or SMS to a single contact
 *
 * @param {Object} params
 * @param {string} params.templateId - Template ID to use
 * @param {Object} params.contact - { name, email, phone }
 * @param {Object} params.location - Location row from DB
 * @param {string} params.customerId - Customer ID for rate limiting
 * @returns {Object} Send result { success, messageId, error }
 */
async function sendReviewRequest(params) {
  const { templateId, contact, location, customerId } = params;

  try {
    // Validate contact
    if (!contact.name || (!contact.email && !contact.phone)) {
      throw new Error('Contact must have a name and either email or phone');
    }

    // Fetch template
    const tResult = await query(
      'SELECT * FROM review_request_templates WHERE id = $1',
      [templateId]
    );
    if (!tResult.rows.length) {
      throw new Error(`Template ${templateId} not found`);
    }
    const template = tResult.rows[0];

    // Check rate limits — max 100 sends per location per day
    const todaySends = await query(
      `SELECT COUNT(*) as count FROM review_request_sends
       WHERE location_id = $1
       AND created_at >= NOW() - INTERVAL '24 hours'`,
      [location.id]
    );
    if (parseInt(todaySends.rows[0].count) >= 100) {
      throw new Error('Daily send limit reached (100/day). Resets in 24 hours.');
    }

    // Check we haven't already sent to this contact recently (30 days)
    const recentSend = await query(
      `SELECT id FROM review_request_sends
       WHERE location_id = $1
       AND contact_email = $2
       AND created_at >= NOW() - INTERVAL '30 days'`,
      [location.id, contact.email || '']
    );
    if (recentSend.rows.length > 0) {
      throw new Error(`Already sent to ${contact.email} in the last 30 days`);
    }

    // Render template with real contact data
    const rendered = renderTemplate(template.body, template.subject, contact, location);

    let result;

    // Send based on channel
    if (template.channel === 'email') {
      if (!contact.email) throw new Error('Email template requires contact email address');
      result = await sendEmail(rendered, contact, location);
    } else if (template.channel === 'sms') {
      if (!contact.phone) throw new Error('SMS template requires contact phone number');
      result = await sendSMS(rendered.body, contact, location);
    }

    // Log the send
    await query(
      `INSERT INTO review_request_sends
       (location_id, template_id, contact_name, contact_email, contact_phone, channel, status, message_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'sent', $7)`,
      [
        location.id, templateId,
        contact.name, contact.email || null, contact.phone || null,
        template.channel, result.messageId || null
      ]
    );

    // Update template send count
    await query(
      `UPDATE review_request_templates
       SET send_count = send_count + 1, last_sent_at = NOW()
       WHERE id = $1`,
      [templateId]
    );

    logger.info(`Review request sent to ${contact.email || contact.phone} for ${location.business_name}`);
    return { success: true, messageId: result.messageId };

  } catch (error) {
    logger.error(`Failed to send review request:`, error.message);

    // Log the failed send
    await query(
      `INSERT INTO review_request_sends
       (location_id, template_id, contact_name, contact_email, contact_phone, channel, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, 'failed', $7)`,
      [
        params.location?.id, params.templateId,
        params.contact?.name, params.contact?.email || null,
        params.contact?.phone || null, 'unknown', error.message
      ]
    ).catch(() => {}); // Don't throw if logging fails

    return { success: false, error: error.message };
  }
}

/**
 * sendBulk()
 * Send review requests to multiple contacts
 * Processes with 500ms delay between each to avoid spam flags
 *
 * @param {Array} contacts - Array of { name, email, phone }
 * @param {string} templateId
 * @param {Object} location
 * @param {string} customerId
 * @returns {Object} { sent, failed, skipped, results }
 */
async function sendBulk(contacts, templateId, location, customerId) {
  const results = { sent: 0, failed: 0, skipped: 0, details: [] };

  for (const contact of contacts) {
    const result = await sendReviewRequest({ templateId, contact, location, customerId });

    if (result.success) {
      results.sent++;
    } else if (result.error?.includes('Already sent')) {
      results.skipped++;
    } else {
      results.failed++;
    }

    results.details.push({ contact: contact.name, ...result });

    // Rate limit: 500ms between sends
    await new Promise(r => setTimeout(r, 500));
  }

  logger.info(`Bulk send complete for ${location.business_name}: ${results.sent} sent, ${results.failed} failed, ${results.skipped} skipped`);
  return results;
}

// ============================================
// EMAIL SENDER
// ============================================

async function sendEmail(rendered, contact, location) {
  const result = await resend.emails.send({
    from: `${location.business_name} <${process.env.REVIEW_REQUEST_FROM_EMAIL || process.env.EMAIL_FROM}>`,
    to: contact.email,
    subject: rendered.subject || `How was your experience at ${location.business_name}?`,
    text: rendered.body, // Plain text version
    html: buildEmailHTML(rendered.body, location)
  });

  return { messageId: result.data?.id };
}

/**
 * buildEmailHTML()
 * Wrap plain text body in a clean HTML email template
 */
function buildEmailHTML(body, location) {
  // Convert line breaks to HTML
  const htmlBody = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
    // Make URLs clickable
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#0d0d0d;font-weight:600">$1</a>');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8f7f4;font-family:Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;padding:40px 20px">
    <div style="background:white;border-radius:16px;padding:36px;border:1px solid #e4e0d8">
      <p style="font-size:15px;line-height:1.8;color:#0d0d0d;margin:0">${htmlBody}</p>
    </div>
    <p style="font-size:11px;color:#7a7670;text-align:center;margin-top:24px">
      Sent on behalf of ${location.business_name}
    </p>
  </div>
</body>
</html>`;
}

// ============================================
// SMS SENDER
// ============================================

async function sendSMS(body, contact, location) {
  const twilio = getTwilio();
  if (!twilio) {
    throw new Error('SMS not configured — add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER to env');
  }

  // Format phone number
  const phone = formatPhone(contact.phone);
  if (!phone) throw new Error(`Invalid phone number: ${contact.phone}`);

  const message = await twilio.messages.create({
    body: body,
    from: process.env.TWILIO_FROM_NUMBER,
    to: phone
  });

  return { messageId: message.sid };
}

/**
 * formatPhone()
 * Ensure phone number is in E.164 format for Twilio
 * e.g. (555) 123-4567 → +15551234567
 */
function formatPhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return null;
}

// ============================================
// TEMPLATE RENDERER
// ============================================

/**
 * renderTemplate()
 * Replace template variables with real contact data
 */
function renderTemplate(body, subject, contact, location) {
  function replace(text) {
    if (!text) return '';
    return text
      .replace(/\{\{customer_name\}\}/g, contact.name?.split(' ')[0] || contact.name || 'there')
      .replace(/\{\{business_name\}\}/g, location.business_name || 'us')
      .replace(/\{\{owner_name\}\}/g, location.owner_name || 'The Team')
      .replace(/\{\{review_link\}\}/g, location.google_review_link || 'https://g.page/r/your-review-link');
  }
  return { subject: replace(subject), body: replace(body) };
}

// ============================================
// SEND HISTORY
// ============================================

/**
 * getSendHistory()
 * Get send history for a location
 */
async function getSendHistory(locationId, limit = 50) {
  try {
    const result = await query(
      `SELECT * FROM review_request_sends
       WHERE location_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [locationId, limit]
    );
    return result.rows;
  } catch (error) {
    logger.error('Failed to get send history:', error.message);
    throw error;
  }
}

/**
 * getDailyStats()
 * Get today's send stats for a location
 */
async function getDailyStats(locationId) {
  try {
    const result = await query(
      `SELECT
         COUNT(*) as total_today,
         COUNT(CASE WHEN status = 'sent' THEN 1 END) as sent_today,
         COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_today,
         100 - COUNT(*) as remaining_today
       FROM review_request_sends
       WHERE location_id = $1
       AND created_at >= NOW() - INTERVAL '24 hours'`,
      [locationId]
    );
    return result.rows[0];
  } catch (error) {
    logger.error('Failed to get daily stats:', error.message);
    return { total_today: 0, sent_today: 0, failed_today: 0, remaining_today: 100 };
  }
}

module.exports = {
  sendReviewRequest,
  sendBulk,
  getSendHistory,
  getDailyStats
};
