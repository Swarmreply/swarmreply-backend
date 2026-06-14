// ============================================
const { sendText } = require('./smsGate');
// services/npsService.js
// NPS / Post-Visit Survey Engine
//
// FLOW:
//  1. Survey is triggered (manual, CSV import,
//     Open Dental, or Zapier)
//  2. We generate a unique token + survey URL
//  3. Send email or SMS with the link
//  4. Customer opens the survey page (public)
//  5. Customer taps a score (0–10)
//  6. Score >= threshold → thank you + redirect
//     to Google Reviews after a short delay
//  7. Score < threshold → thank you + optional
//     follow-up text field (captured privately)
//  8. We record the response and update NPS score
// ============================================

const { query }  = require('../database/db');
const { Resend } = require('resend');
const logger     = require('../utils/logger');
const crypto     = require('crypto');

const resend = new Resend(process.env.RESEND_API_KEY);

const SURVEY_BASE_URL = process.env.SURVEY_BASE_URL || 'https://swarmreply.com/s';

// ============================================
// CONFIG MANAGEMENT
// ============================================

async function getConfig(locationId) {
  let result = await query(
    `SELECT sc.*, l.business_name, l.google_review_link, l.phone
     FROM survey_configs sc
     JOIN locations l ON sc.location_id = l.id
     WHERE sc.location_id = $1`,
    [locationId]
  );

  if (result.rows.length) return result.rows[0];

  // Auto-create default config
  const locResult = await query('SELECT * FROM locations WHERE id = $1', [locationId]);
  if (!locResult.rows.length) throw new Error('Location not found');
  const loc = locResult.rows[0];

  const created = await query(
    `INSERT INTO survey_configs
     (location_id, business_name, google_review_link)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [locationId, loc.business_name, loc.google_review_link]
  );
  return created.rows[0];
}

async function updateConfig(locationId, settings) {
  const fields = [
    'is_enabled', 'question', 'promoter_threshold',
    'redirect_to_google', 'google_review_link', 'redirect_delay_ms',
    'ask_followup', 'followup_question', 'followup_placeholder',
    'promoter_thank_you', 'detractor_thank_you',
    'send_delay_hours', 'channel',
    'email_subject', 'email_from_name', 'sms_message',
    'accent_color', 'theme', 'logo_url'
  ];

  const updates = [];
  const values  = [locationId];
  let i = 2;

  for (const field of fields) {
    const camelKey = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (settings[camelKey] !== undefined) {
      updates.push(`${field} = $${i++}`);
      values.push(settings[camelKey]);
    } else if (settings[field] !== undefined) {
      updates.push(`${field} = $${i++}`);
      values.push(settings[field]);
    }
  }

  if (!updates.length) return getConfig(locationId);

  updates.push('updated_at = NOW()');

  const result = await query(
    `UPDATE survey_configs SET ${updates.join(', ')}
     WHERE location_id = $1
     RETURNING *`,
    values
  );

  return result.rows[0];
}

// ============================================
// SEND A SURVEY
// Called manually from dashboard or
// automatically from CSV import / scheduler
// ============================================

async function sendSurvey({ locationId, contact, channel, triggeredBy = 'manual' }) {
  const config = await getConfig(locationId);

  if (!config.is_enabled && triggeredBy !== 'manual') {
    logger.info(`Survey disabled for location ${locationId} — skipping`);
    return { success: false, reason: 'surveys_disabled' };
  }

  if (!contact.name || (!contact.email && !contact.phone)) {
    throw new Error('Contact needs name + email or phone');
  }

  // Generate unique survey token
  const token = crypto.randomBytes(16).toString('hex');
  const surveyUrl = `${SURVEY_BASE_URL}/${token}`;

  // Determine channel
  const sendChannel = channel || config.channel;
  const useEmail = (sendChannel === 'email' || sendChannel === 'both') && contact.email;
  const useSms   = (sendChannel === 'sms'   || sendChannel === 'both') && contact.phone;

  // Save the send record first (get the ID)
  const sendResult = await query(
    `INSERT INTO survey_sends
     (location_id, config_id, contact_name, contact_email, contact_phone,
      token, channel, triggered_by, status, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())
     RETURNING id`,
    [
      locationId, config.id, contact.name,
      contact.email || null, contact.phone || null,
      token,
      useEmail && useSms ? 'both' : useEmail ? 'email' : 'sms',
      triggeredBy
    ]
  );
  const sendId = sendResult.rows[0].id;

  let success = false;
  let messageId = null;
  let errorMsg = null;

  try {
    // ── Send email ──
    if (useEmail) {
      const subject = interpolate(config.email_subject, {
        customer_name: firstName(contact.name),
        business_name: config.business_name
      });

      const fromName = config.email_from_name || config.business_name || 'SwarmReply';

      const emailRes = await resend.emails.send({
        from:    `${fromName} <${process.env.EMAIL_FROM || 'hello@swarmreply.com'}>`,
        to:      contact.email,
        subject,
        html:    buildEmailHtml(config, contact, surveyUrl)
      });

      messageId = emailRes.id;
      success   = true;
    }

    // ── Send SMS ──
    if (useSms) {
      const smsText = interpolate(config.sms_message, {
        customer_name: firstName(contact.name),
        business_name: config.business_name,
        survey_link:   surveyUrl
      });

      const r = await sendText({ to: contact.phone, body: smsText, from: process.env.TWILIO_FROM_NUMBER });
      if (!r.sent) throw new Error(r.reason === 'sms_gated'
        ? 'SMS sending is not enabled yet — texting goes live once A2P 10DLC registration is approved.'
        : 'Twilio not configured');

      messageId = r.sid;
      success   = true;
    }

    // Mark as sent
    await query(
      `UPDATE survey_sends SET
         status = 'sent', message_id = $1, updated_at = NOW()
       WHERE id = $2`,
      [messageId, sendId]
    );

    logger.info(
      `Survey sent to ${contact.name} (${useEmail ? contact.email : contact.phone})`
    );

    return { success: true, token, surveyUrl, sendId };

  } catch (err) {
    errorMsg = err.message;
    logger.error(`Survey send failed for ${contact.name}: ${err.message}`);

    await query(
      `UPDATE survey_sends SET
         status = 'failed', error_message = $1, updated_at = NOW()
       WHERE id = $2`,
      [errorMsg, sendId]
    );

    return { success: false, error: errorMsg, sendId };
  }
}

// ============================================
// SURVEY PAGE DATA
// Called by the public survey page endpoint
// Returns everything needed to render the survey
// ============================================

async function getSurveyByToken(token) {
  const result = await query(
    `SELECT
       ss.*,
       sc.question,
       sc.promoter_threshold,
       sc.redirect_to_google,
       sc.google_review_link,
       sc.redirect_delay_ms,
       sc.ask_followup,
       sc.followup_question,
       sc.followup_placeholder,
       sc.promoter_thank_you,
       sc.detractor_thank_you,
       sc.accent_color,
       sc.theme,
       sc.logo_url,
       sc.business_name AS config_business_name,
       l.business_name
     FROM survey_sends ss
     JOIN survey_configs sc ON ss.config_id = sc.id
     JOIN locations l ON ss.location_id = l.id
     WHERE ss.token = $1`,
    [token]
  );

  if (!result.rows.length) return null;
  const row = result.rows[0];

  // Mark as opened if first time
  if (!row.opened_at) {
    await query(
      'UPDATE survey_sends SET opened_at = NOW() WHERE token = $1',
      [token]
    );
  }

  return {
    token:               row.token,
    alreadyResponded:    !!row.responded_at,
    contactName:         firstName(row.contact_name),
    businessName:        row.config_business_name || row.business_name,
    question:            row.question,
    promoterThreshold:   row.promoter_threshold,
    redirectToGoogle:    row.redirect_to_google,
    googleReviewLink:    row.google_review_link,
    redirectDelayMs:     row.redirect_delay_ms || 2000,
    askFollowup:         row.ask_followup,
    followupQuestion:    row.followup_question,
    followupPlaceholder: row.followup_placeholder,
    promoterThankYou:    row.promoter_thank_you,
    detractorThankYou:   row.detractor_thank_you,
    accentColor:         row.accent_color || '#f5c842',
    theme:               row.theme || 'light',
    logoUrl:             row.logo_url
  };
}

// ============================================
// RECORD RESPONSE
// Called when the customer submits their score
// ============================================

async function recordResponse(token, score, followupText, meta = {}) {
  // Validate
  if (score < 0 || score > 10) throw new Error('Score must be 0–10');

  // Get the send record
  const result = await query(
    `SELECT ss.*, sc.promoter_threshold, sc.google_review_link,
            sc.redirect_to_google, sc.redirect_delay_ms
     FROM survey_sends ss
     JOIN survey_configs sc ON ss.config_id = sc.id
     WHERE ss.token = $1`,
    [token]
  );

  if (!result.rows.length) throw new Error('Survey not found');
  const send = result.rows[0];

  if (send.responded_at) {
    // Already responded — return existing result without re-saving
    return buildResponseResult(send, score, send.promoter_threshold);
  }

  const threshold  = send.promoter_threshold || 9;
  const isPromoter = score >= threshold;
  const isDetractor = score <= 6;
  const isPassive  = !isPromoter && !isDetractor;

  // Save response
  await query(
    `UPDATE survey_sends SET
       nps_score     = $1,
       followup_text = $2,
       is_promoter   = $3,
       is_detractor  = $4,
       is_passive    = $5,
       responded_at  = NOW(),
       ip_address    = $6,
       user_agent    = $7,
       updated_at    = NOW()
     WHERE token = $8`,
    [
      score, followupText || null,
      isPromoter, isDetractor, isPassive,
      meta.ipAddress || null,
      meta.userAgent || null,
      token
    ]
  );

  // Refresh NPS cache for the location (async)
  refreshNpsCache(send.location_id).catch(() => {});

  logger.info(
    `Survey response recorded: score=${score} ` +
    `(${isPromoter ? 'promoter' : isDetractor ? 'detractor' : 'passive'}) ` +
    `for location ${send.location_id}`
  );

  return buildResponseResult(
    { ...send, promoter_threshold: threshold },
    score,
    threshold
  );
}

function buildResponseResult(send, score, threshold) {
  const isPromoter  = score >= threshold;
  const isDetractor = score <= 6;

  return {
    score,
    isPromoter,
    isDetractor,
    isPassive:     !isPromoter && !isDetractor,
    shouldRedirect: isPromoter && send.redirect_to_google && send.google_review_link,
    redirectUrl:    (isPromoter && send.redirect_to_google) ? send.google_review_link : null,
    redirectDelay:  send.redirect_delay_ms || 2000
  };
}

// ============================================
// NPS ANALYTICS
// ============================================

async function getNpsAnalytics(locationId, days = 30) {
  // Recent responses
  const result = await query(
    `SELECT
       COUNT(*) FILTER (WHERE responded_at IS NOT NULL) AS total_responses,
       COUNT(*) AS total_sent,
       COUNT(*) FILTER (WHERE is_promoter = true)  AS promoters,
       COUNT(*) FILTER (WHERE is_passive  = true)  AS passives,
       COUNT(*) FILTER (WHERE is_detractor = true) AS detractors,
       ROUND(AVG(nps_score)::numeric, 1)            AS avg_score
     FROM survey_sends
     WHERE location_id = $1
       AND sent_at >= NOW() - INTERVAL '${days} days'`,
    [locationId]
  );

  const r = result.rows[0];
  const totalResponses = parseInt(r.total_responses) || 0;
  const promoters  = parseInt(r.promoters)  || 0;
  const detractors = parseInt(r.detractors) || 0;

  // NPS = % promoters - % detractors (0-10 scale)
  const npsScore = totalResponses > 0
    ? Math.round(((promoters - detractors) / totalResponses) * 100)
    : null;

  // Daily trend for chart
  const trend = await query(
    `SELECT
       DATE(responded_at) AS day,
       ROUND(AVG(nps_score)::numeric, 1) AS avg_score,
       COUNT(*) AS responses
     FROM survey_sends
     WHERE location_id = $1
       AND responded_at IS NOT NULL
       AND responded_at >= NOW() - INTERVAL '${days} days'
     GROUP BY DATE(responded_at)
     ORDER BY day`,
    [locationId]
  );

  // Recent responses with text
  const recent = await query(
    `SELECT
       contact_name, nps_score, followup_text,
       is_promoter, is_passive, is_detractor,
       responded_at
     FROM survey_sends
     WHERE location_id = $1
       AND responded_at IS NOT NULL
     ORDER BY responded_at DESC
     LIMIT 20`,
    [locationId]
  );

  return {
    npsScore,
    totalSent:      parseInt(r.total_sent) || 0,
    totalResponses,
    responseRate:   r.total_sent > 0
                      ? Math.round((totalResponses / parseInt(r.total_sent)) * 100)
                      : 0,
    promoters,
    passives:       parseInt(r.passives) || 0,
    detractors,
    avgScore:       parseFloat(r.avg_score) || 0,
    trend:          trend.rows,
    recent:         recent.rows.map(row => ({
      name:         firstName(row.contact_name),
      score:        row.nps_score,
      feedback:     row.followup_text,
      type:         row.is_promoter ? 'promoter' : row.is_detractor ? 'detractor' : 'passive',
      date:         row.responded_at
    }))
  };
}

async function getSurveyHistory(locationId, limit = 30) {
  const result = await query(
    `SELECT
       id, contact_name, contact_email, contact_phone,
       channel, status, triggered_by,
       nps_score, is_promoter, is_detractor, is_passive,
       followup_text, sent_at, responded_at,
       redirected_to_google
     FROM survey_sends
     WHERE location_id = $1
     ORDER BY sent_at DESC
     LIMIT $2`,
    [locationId, limit]
  );
  return result.rows;
}

// ============================================
// NPS CACHE REFRESH
// Called after each response and daily by scheduler
// ============================================

async function refreshNpsCache(locationId) {
  try {
    const analytics = await getNpsAnalytics(locationId, 90);

    await query(
      `UPDATE survey_configs SET
         cached_nps_score     = $1,
         cached_response_count = $2,
         cached_promoter_pct  = $3,
         cached_detractor_pct = $4,
         cache_updated_at     = NOW()
       WHERE location_id = $5`,
      [
        analytics.npsScore,
        analytics.totalResponses,
        analytics.totalResponses > 0
          ? Math.round((analytics.promoters / analytics.totalResponses) * 100)
          : 0,
        analytics.totalResponses > 0
          ? Math.round((analytics.detractors / analytics.totalResponses) * 100)
          : 0,
        locationId
      ]
    );
  } catch (err) {
    logger.error(`refreshNpsCache failed for ${locationId}: ${err.message}`);
  }
}

// ============================================
// EMAIL HTML BUILDER
// The email the customer receives
// ============================================

function buildEmailHtml(config, contact, surveyUrl) {
  const name     = firstName(contact.name);
  const bizName  = config.business_name;
  const accent   = config.accent_color || '#f5c842';
  const isDark   = config.theme === 'dark';
  const bg       = isDark ? '#0a0a0a' : '#f8f7f4';
  const cardBg   = isDark ? '#141414' : '#ffffff';
  const text     = isDark ? '#ffffff' : '#0a0a0a';
  const muted    = isDark ? 'rgba(255,255,255,.5)' : '#7a7670';

  const scores = [0,1,2,3,4,5,6,7,8,9,10];

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>How was your visit?</title></head>
<body style="margin:0;padding:0;background:${bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:560px;margin:0 auto;padding:40px 20px;">

  ${config.logo_url
    ? `<div style="text-align:center;margin-bottom:28px;"><img src="${config.logo_url}" alt="${bizName}" style="height:44px;object-fit:contain;"></div>`
    : `<div style="text-align:center;margin-bottom:28px;font-size:28px;">🐝</div>`
  }

  <div style="background:${cardBg};border-radius:20px;padding:40px 36px;border:1px solid rgba(0,0,0,0.06);">

    <p style="font-size:22px;font-weight:700;color:${text};margin:0 0 8px;line-height:1.2;font-family:Georgia,serif;">
      How was your visit, ${name}?
    </p>
    <p style="font-size:15px;color:${muted};margin:0 0 28px;line-height:1.6;">
      ${config.question}
    </p>

    <!-- Score buttons -->
    <table cellpadding="0" cellspacing="4" style="width:100%;margin-bottom:12px;">
      <tr>
        ${scores.map(s => `
        <td style="text-align:center;">
          <a href="${surveyUrl}?score=${s}"
             style="display:inline-block;width:36px;height:36px;line-height:36px;border-radius:50%;
                    background:${s >= (config.promoter_threshold || 9) ? accent : s >= 7 ? '#f0eeea' : '#fee2e2'};
                    color:${s >= (config.promoter_threshold || 9) ? '#0a0a0a' : s >= 7 ? '#7a7670' : '#c0392b'};
                    font-size:13px;font-weight:700;text-decoration:none;text-align:center;">
            ${s}
          </a>
        </td>`).join('')}
      </tr>
    </table>

    <div style="display:flex;justify-content:space-between;font-size:11px;color:${muted};margin-bottom:32px;padding:0 2px;">
      <span>Not at all likely</span>
      <span>Extremely likely</span>
    </div>

    <p style="font-size:12px;color:${muted};text-align:center;margin:0;line-height:1.6;">
      Takes 10 seconds · Your feedback stays private unless you choose to share it publicly
    </p>

  </div>

  <p style="font-size:12px;color:${muted};text-align:center;margin-top:24px;line-height:1.6;">
    ${bizName} · Powered by SwarmReply<br>
    <a href="${surveyUrl}/unsubscribe" style="color:${muted};">Unsubscribe</a>
  </p>

</div>
</body>
</html>`;
}

// ============================================
// HELPERS
// ============================================

function interpolate(template, vars) {
  if (!template) return '';
  return template
    .replace(/{{customer_name}}/g, vars.customer_name || '')
    .replace(/{{business_name}}/g, vars.business_name || '')
    .replace(/{{survey_link}}/g,   vars.survey_link   || '');
}

function firstName(name) {
  if (!name) return 'there';
  return name.trim().split(/\s+/)[0];
}

function getTwilio() {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    const twilio = require('twilio');
    return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return null;
}

module.exports = {
  getConfig,
  updateConfig,
  sendSurvey,
  getSurveyByToken,
  recordResponse,
  getNpsAnalytics,
  getSurveyHistory,
  refreshNpsCache
};
