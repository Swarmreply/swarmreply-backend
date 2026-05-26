// ============================================
// services/surveyService.js
// NPS & Post-Visit Survey Engine
//
// Flow:
//  1. Contact visits → survey send is queued
//  2. After send_delay_hours → email/SMS fires
//  3. Contact clicks link → public survey page loads
//  4. They choose a score → routing logic fires:
//       9-10 (promoter)  → "Great! Leave a Google review?"
//       7-8  (passive)   → "Thanks! Tell us more?" (optional)
//       0-6  (detractor) → "Sorry! What went wrong?" (private)
//  5. Response saved → stats updated
//  6. If promoter + clicked Google link → flagged for follow-up
// ============================================

const { Resend }  = require('resend');
const { query }   = require('../database/db');
const logger      = require('../utils/logger');

let _resend = null;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY || 'placeholder');
  return _resend;
}

// ── Twilio lazy init ─────────────────────────
let twilioClient = null;
function getTwilio() {
  if (!twilioClient && process.env.TWILIO_ACCOUNT_SID) {
    const twilio = require('twilio');
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }
  return twilioClient;
}

const SURVEY_BASE = process.env.FRONTEND_URL || 'https://swarmreply.com';

// ============================================
// CONFIG MANAGEMENT
// ============================================

async function getConfig(locationId) {
  const result = await query(
    `SELECT sc.*, l.business_name, l.google_review_link, l.logo_url as loc_logo
     FROM survey_configs sc
     JOIN locations l ON sc.location_id = l.id
     WHERE sc.location_id = $1`,
    [locationId]
  );

  if (result.rows.length) return result.rows[0];

  // Auto-create default config
  const created = await query(
    `INSERT INTO survey_configs (location_id) VALUES ($1) RETURNING *`,
    [locationId]
  );
  return created.rows[0];
}

async function updateConfig(locationId, settings) {
  const fields = [
    'is_enabled', 'send_channel', 'send_delay_hours',
    'question_text', 'low_label', 'high_label', 'scale_type',
    'promoter_min', 'passive_min',
    'promoter_action', 'promoter_url',
    'passive_action', 'detractor_action',
    'promoter_message', 'passive_message', 'detractor_message',
    'followup_question', 'followup_enabled',
    'logo_url', 'brand_color', 'button_text',
    'thank_you_title', 'thank_you_message',
    'email_subject', 'email_preview', 'sms_body'
  ];

  const setClauses = fields
    .filter(f => settings[f] !== undefined)
    .map((f, i) => `${f} = $${i + 2}`)
    .join(', ');

  const values = [
    locationId,
    ...fields
      .filter(f => settings[f] !== undefined)
      .map(f => settings[f])
  ];

  const result = await query(
    `UPDATE survey_configs SET ${setClauses}, updated_at = NOW()
     WHERE location_id = $1 RETURNING *`,
    values
  );

  return result.rows[0];
}

// ============================================
// SENDING
// ============================================

/**
 * sendSurvey()
 * Send a survey to one contact via email and/or SMS.
 * Called from:
 *  - Dashboard manual send
 *  - CSV import scheduler (after visit + delay)
 *  - Zapier action
 */
async function sendSurvey({ locationId, contact, source = 'manual', sourceId = null }) {
  const config = await getConfig(locationId);

  if (!config.is_enabled) {
    throw new Error('Surveys are not enabled for this location');
  }

  if (!contact.name || (!contact.email && !contact.phone)) {
    throw new Error('Contact requires a name and email or phone');
  }

  // Duplicate guard — don't send twice within 30 days
  const recent = await query(
    `SELECT id FROM survey_sends
     WHERE location_id = $1
       AND (contact_email = $2 OR contact_phone = $3)
       AND created_at >= NOW() - INTERVAL '30 days'`,
    [locationId, contact.email || '', contact.phone || '']
  );
  if (recent.rows.length > 0) {
    throw new Error(`Survey already sent to this contact in the last 30 days`);
  }

  const results = [];

  // Determine which channels to send
  const channels = [];
  if ((config.send_channel === 'email' || config.send_channel === 'both') && contact.email) {
    channels.push('email');
  }
  if ((config.send_channel === 'sms' || config.send_channel === 'both') && contact.phone) {
    channels.push('sms');
  }

  if (channels.length === 0) {
    throw new Error('No valid channel — contact needs email or phone matching survey config');
  }

  for (const channel of channels) {
    // Create send record with unique token
    const sendResult = await query(
      `INSERT INTO survey_sends
       (location_id, config_id, contact_name, contact_email, contact_phone,
        visit_date, source, source_id, channel, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
       RETURNING id, survey_token`,
      [
        locationId, config.id,
        contact.name, contact.email || null, contact.phone || null,
        contact.visitDate || null,
        source, sourceId || null,
        channel
      ]
    );

    const send = sendResult.rows[0];
    const surveyUrl = `${SURVEY_BASE}/survey/${send.survey_token}`;

    try {
      let messageId;

      if (channel === 'email') {
        messageId = await sendSurveyEmail({ config, contact, surveyUrl });
      } else {
        messageId = await sendSurveySMS({ config, contact, surveyUrl });
      }

      await query(
        `UPDATE survey_sends SET
           status = 'sent', sent_at = NOW(), message_id = $1
         WHERE id = $2`,
        [messageId, send.id]
      );

      // Increment total_sent on config
      await query(
        'UPDATE survey_configs SET total_sent = total_sent + 1 WHERE id = $1',
        [config.id]
      );

      results.push({ channel, success: true, token: send.survey_token });
      logger.info(`Survey sent via ${channel} to ${contact.email || contact.phone}`);

    } catch (err) {
      await query(
        `UPDATE survey_sends SET status = 'failed', error_message = $1 WHERE id = $2`,
        [err.message, send.id]
      );
      logger.error(`Survey send failed via ${channel}:`, err.message);
      results.push({ channel, success: false, error: err.message });
    }
  }

  return results;
}

// ============================================
// EMAIL TEMPLATE
// The most important piece — this is the first
// thing the customer sees. Needs to be warm,
// simple, and drive a click.
// ============================================

async function sendSurveyEmail({ config, contact, surveyUrl }) {
  const firstName = contact.name.split(' ')[0];

  const subject = renderTokens(config.email_subject, { contact, config });
  const brandColor = config.brand_color || '#f5c842';
  const logoHtml = (config.logo_url || config.loc_logo)
    ? `<img src="${config.logo_url || config.loc_logo}" alt="${config.business_name}" style="max-height:48px;max-width:180px;margin-bottom:8px;display:block">`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#f8f7f4;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased">

<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f8f7f4">
<tr><td align="center" style="padding:40px 20px">

  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px">

    <!-- Header -->
    <tr><td style="text-align:center;padding-bottom:28px">
      ${logoHtml}
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;color:#0a0a0a;letter-spacing:-0.02em">${config.business_name || 'Your recent visit'}</div>
    </td></tr>

    <!-- Card -->
    <tr><td style="background:#ffffff;border-radius:20px;border:1px solid #e4e0d8;overflow:hidden">

      <!-- Top accent bar -->
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
      <tr><td style="height:5px;background:${brandColor};border-radius:20px 20px 0 0"></td></tr>
      </table>

      <!-- Body -->
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="padding:36px 36px 28px">
      <tr><td>

        <p style="font-size:17px;font-weight:600;color:#0a0a0a;margin:0 0 8px;line-height:1.4">Hi ${firstName},</p>
        <p style="font-size:15px;color:#7a7670;line-height:1.7;margin:0 0 28px;font-weight:300">Thank you for visiting <strong style="color:#0a0a0a">${config.business_name || 'us'}</strong>. Your experience means everything to us — we'd love to hear how it went.</p>

        <!-- Question -->
        <div style="background:#f8f7f4;border-radius:14px;padding:22px 24px;margin-bottom:24px;text-align:center">
          <p style="font-size:16px;font-weight:600;color:#0a0a0a;margin:0 0 18px;line-height:1.4">${config.question_text}</p>

          <!-- Scale labels -->
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:10px">
          <tr>
            <td style="font-size:11px;color:#b0aca6;text-align:left">${config.low_label}</td>
            <td style="font-size:11px;color:#b0aca6;text-align:right">${config.high_label}</td>
          </tr>
          </table>

          <!-- Score buttons — 0-10 as clickable links -->
          <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 auto">
          <tr>
            ${buildScoreButtons(surveyUrl, config.scale_type, brandColor)}
          </tr>
          </table>
        </div>

        <!-- CTA fallback text -->
        <p style="font-size:13px;color:#b0aca6;text-align:center;margin:0 0 4px">Tap a number above — it only takes 10 seconds.</p>

      </td></tr>
      </table>

    </td></tr>

    <!-- Footer -->
    <tr><td style="padding:20px 0;text-align:center">
      <p style="font-size:12px;color:#b0aca6;margin:0;line-height:1.6">
        You're receiving this because you recently visited ${config.business_name || 'us'}.<br>
        <a href="${surveyUrl}?unsubscribe=1" style="color:#b0aca6">Unsubscribe</a>
      </p>
      <p style="font-size:11px;color:#c8c4bc;margin:8px 0 0">Powered by <a href="https://swarmreply.com" style="color:#c8c4bc">SwarmReply</a></p>
    </td></tr>

  </table>
</td></tr>
</table>

</body>
</html>`;

  const result = await getResend().emails.send({
    from:    process.env.EMAIL_FROM || 'hello@swarmreply.com',
    to:      contact.email,
    subject,
    html,
    headers: {
      'X-Survey-Token': surveyUrl.split('/').pop()
    }
  });

  return result.data?.id || result.id;
}

// Build the score button row for the email
function buildScoreButtons(surveyUrl, scaleType, brandColor) {
  const scores = scaleType === '1-5'
    ? [1, 2, 3, 4, 5]
    : scaleType === '0-10'
    ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  return scores.map(s => {
    // Colour-code by expected sentiment
    const bg = s >= 9 ? brandColor
      : s >= 7 ? '#f0eeea'
      : '#f0eeea';
    const textColor = s >= 9 ? '#0a0a0a' : '#4a4a48';
    const border = s >= 9 ? brandColor : '#e4e0d8';

    return `<td style="padding:3px">
      <a href="${surveyUrl}?score=${s}"
         style="display:inline-block;width:36px;height:36px;line-height:36px;
                text-align:center;border-radius:10px;
                background:${bg};color:${textColor};
                font-size:14px;font-weight:600;
                border:1.5px solid ${border};
                text-decoration:none">
        ${s}
      </a>
    </td>`;
  }).join('');
}

// ============================================
// SMS TEMPLATE
// Short, warm, single link
// ============================================

async function sendSurveySMS({ config, contact, surveyUrl }) {
  const twilio = getTwilio();
  if (!twilio) throw new Error('Twilio not configured');

  const firstName = contact.name.split(' ')[0];
  const body = renderTokens(config.sms_body, {
    contact: { ...contact, firstName },
    config,
    surveyUrl
  });

  const message = await twilio.messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to:   contact.phone
  });

  return message.sid;
}

// ============================================
// PUBLIC SURVEY DATA
// Called by the survey page when it loads.
// Returns everything the frontend needs.
// ============================================

async function getSurveyData(token) {
  const result = await query(
    `SELECT
       ss.*,
       sc.question_text, sc.low_label, sc.high_label, sc.scale_type,
       sc.promoter_min, sc.passive_min,
       sc.promoter_action, sc.promoter_url,
       sc.passive_action, sc.detractor_action,
       sc.promoter_message, sc.passive_message, sc.detractor_message,
       sc.followup_question, sc.followup_enabled,
       sc.logo_url, sc.brand_color, sc.button_text,
       sc.thank_you_title, sc.thank_you_message,
       l.business_name, l.google_review_link, l.logo_url as loc_logo
     FROM survey_sends ss
     JOIN survey_configs sc ON ss.config_id = sc.id
     JOIN locations l ON ss.location_id = l.id
     WHERE ss.survey_token = $1`,
    [token]
  );

  if (!result.rows.length) return null;
  const row = result.rows[0];

  // Don't expose internal IDs or contact details
  return {
    token,
    businessName:       row.business_name,
    logoUrl:            row.logo_url || row.loc_logo,
    brandColor:         row.brand_color || '#f5c842',
    questionText:       row.question_text,
    lowLabel:           row.low_label,
    highLabel:          row.high_label,
    scaleType:          row.scale_type,
    followupQuestion:   row.followup_question,
    followupEnabled:    row.followup_enabled,
    buttonText:         row.button_text,
    thankYouTitle:      row.thank_you_title,
    thankYouMessage:    row.thank_you_message,
    // Routing data
    promoterMin:        row.promoter_min,
    passiveMin:         row.passive_min,
    promoterAction:     row.promoter_action,
    promoterUrl:        row.promoter_url || row.google_review_link,
    passiveAction:      row.passive_action,
    detractorAction:    row.detractor_action,
    promoterMessage:    row.promoter_message,
    passiveMessage:     row.passive_message,
    detractorMessage:   row.detractor_message,
    // Already responded?
    alreadyResponded:   !!row.responded_at,
    firstName:          row.contact_name?.split(' ')[0] || null
  };
}

// ============================================
// SUBMIT RESPONSE
// Called when the customer submits their score
// ============================================

async function submitResponse(token, { score, followupText, redirectedToReview }) {
  // Load the send record
  const result = await query(
    `SELECT ss.*, sc.promoter_min, sc.passive_min, sc.id as config_id
     FROM survey_sends ss
     JOIN survey_configs sc ON ss.config_id = sc.id
     WHERE ss.survey_token = $1`,
    [token]
  );

  if (!result.rows.length) throw new Error('Survey not found');
  const send = result.rows[0];

  if (send.responded_at) {
    // Already responded — idempotent, return success
    return { success: true, alreadyResponded: true };
  }

  // Determine label
  const label = score >= send.promoter_min ? 'promoter'
    : score >= send.passive_min           ? 'passive'
    : 'detractor';

  // Save response
  await query(
    `UPDATE survey_sends SET
       score               = $1,
       score_label         = $2,
       followup_text       = $3,
       redirected_to_review = $4,
       responded_at        = NOW(),
       status              = 'clicked',
       updated_at          = NOW()
     WHERE survey_token = $5`,
    [score, label, followupText || null, !!redirectedToReview, token]
  );

  // Update config stats
  await updateStats(send.config_id, send.location_id, label, score);

  logger.info(
    `Survey response: score=${score} (${label}) ` +
    `for location ${send.location_id}`
  );

  return { success: true, label };
}

// Recompute NPS stats after each response
async function updateStats(configId, locationId, newLabel, newScore) {
  const stats = await query(
    `SELECT
       COUNT(*) FILTER (WHERE score IS NOT NULL) as total,
       COUNT(*) FILTER (WHERE score_label = 'promoter') as promoters,
       COUNT(*) FILTER (WHERE score_label = 'passive') as passives,
       COUNT(*) FILTER (WHERE score_label = 'detractor') as detractors,
       ROUND(AVG(score)::numeric, 1) as avg_score
     FROM survey_sends
     WHERE config_id = $1 AND score IS NOT NULL`,
    [configId]
  );

  const s = stats.rows[0];
  const total      = parseInt(s.total) || 0;
  const promoters  = parseInt(s.promoters) || 0;
  const detractors = parseInt(s.detractors) || 0;

  // NPS = (promoters% - detractors%) on -100 to +100 scale
  const nps = total > 0
    ? Math.round(((promoters - detractors) / total) * 100)
    : null;

  await query(
    `UPDATE survey_configs SET
       total_responses  = $1,
       promoter_count   = $2,
       passive_count    = $3,
       detractor_count  = $4,
       avg_score        = $5,
       nps_score        = $6,
       updated_at       = NOW()
     WHERE id = $7`,
    [total, promoters, parseInt(s.passives) || 0, detractors,
     parseFloat(s.avg_score) || null, nps, configId]
  );
}

// ============================================
// DASHBOARD ANALYTICS
// ============================================

async function getAnalytics(locationId, days = 30) {
  const config = await getConfig(locationId);

  // Recent responses
  const responses = await query(
    `SELECT
       score, score_label, followup_text,
       contact_name, channel, responded_at, created_at
     FROM survey_sends
     WHERE location_id = $1
       AND score IS NOT NULL
       AND responded_at >= NOW() - INTERVAL '${days} days'
     ORDER BY responded_at DESC
     LIMIT 50`,
    [locationId]
  );

  // Trend — daily avg score for last 30 days
  const trend = await query(
    `SELECT
       DATE(responded_at) as date,
       ROUND(AVG(score)::numeric, 1) as avg_score,
       COUNT(*) as count
     FROM survey_sends
     WHERE location_id = $1
       AND score IS NOT NULL
       AND responded_at >= NOW() - INTERVAL '${days} days'
     GROUP BY DATE(responded_at)
     ORDER BY date`,
    [locationId]
  );

  // Score distribution
  const distribution = await query(
    `SELECT score, COUNT(*) as count
     FROM survey_sends
     WHERE location_id = $1 AND score IS NOT NULL
     GROUP BY score ORDER BY score`,
    [locationId]
  );

  // Recent private feedback (detractors)
  const feedback = await query(
    `SELECT contact_name, score, followup_text, responded_at
     FROM survey_sends
     WHERE location_id = $1
       AND score_label = 'detractor'
       AND followup_text IS NOT NULL
       AND followup_text != ''
     ORDER BY responded_at DESC
     LIMIT 10`,
    [locationId]
  );

  return {
    config,
    summary: {
      totalSent:       config.total_sent,
      totalResponses:  config.total_responses,
      responseRate:    config.total_sent > 0
                         ? Math.round((config.total_responses / config.total_sent) * 100)
                         : 0,
      avgScore:        config.avg_score,
      npsScore:        config.nps_score,
      promoters:       config.promoter_count,
      passives:        config.passive_count,
      detractors:      config.detractor_count
    },
    responses:    responses.rows,
    trend:        trend.rows,
    distribution: distribution.rows,
    feedback:     feedback.rows
  };
}

async function getSendHistory(locationId, limit = 30) {
  const result = await query(
    `SELECT
       id, contact_name, contact_email, contact_phone,
       channel, status, score, score_label,
       sent_at, responded_at, source, survey_token
     FROM survey_sends
     WHERE location_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [locationId, limit]
  );
  return result.rows;
}

// ============================================
// SCHEDULER INTEGRATION
// Called from CSV import after visit delay
// ============================================

async function scheduleSurveyForContact(locationId, contact, visitDate) {
  const config = await getConfig(locationId);
  if (!config.is_enabled) return null;

  // Calculate send time
  const visitMs = visitDate
    ? new Date(visitDate).getTime()
    : Date.now();
  const sendAt = new Date(visitMs + config.send_delay_hours * 60 * 60 * 1000);

  // If send time is in the past, send now
  if (sendAt <= new Date()) {
    return sendSurvey({ locationId, contact, source: 'csv_import' });
  }

  // Otherwise queue it — the scheduler picks it up
  // We create a pending send record with no sent_at
  const result = await query(
    `INSERT INTO survey_sends
     (location_id, config_id, contact_name, contact_email, contact_phone,
      visit_date, source, channel, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'csv_import', $7, 'pending')
     RETURNING id`,
    [
      locationId, config.id,
      contact.name, contact.email || null, contact.phone || null,
      visitDate || null,
      config.send_channel === 'sms' ? 'sms' : 'email'
    ]
  );

  return { queued: true, id: result.rows[0].id, sendAt };
}

// ============================================
// HELPERS
// ============================================

function renderTokens(template, { contact, config, surveyUrl }) {
  if (!template) return '';
  const firstName = (contact.name || '').split(' ')[0];
  return template
    .replace(/\{\{first_name\}\}/g,    firstName)
    .replace(/\{\{name\}\}/g,          contact.name || '')
    .replace(/\{\{business_name\}\}/g, config.business_name || '')
    .replace(/\{\{survey_url\}\}/g,    surveyUrl || '')
    .replace(/\{\{brand_color\}\}/g,   config.brand_color || '#f5c842');
}

module.exports = {
  getConfig,
  updateConfig,
  sendSurvey,
  getSurveyData,
  submitResponse,
  getAnalytics,
  getSendHistory,
  scheduleSurveyForContact
};
