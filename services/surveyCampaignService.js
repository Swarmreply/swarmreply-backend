// services/surveyCampaignService.js
// Survey campaign sending, shared by the immediate endpoint
// (POST /campaigns/survey-send) and the scheduled-send sweep so there is a
// single source of truth for the send path.
const { query } = require('../database/db');
const logger = require('../utils/logger');

// The branded survey-invite email. Moved here from routes/index.js so the live
// send and the scheduler render identical email.
function surveyCampaignEmailHtml({ firstName, businessName, brandColor, brandLogo, link }) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:#f4f4f0;font-family:Arial,sans-serif">' +
    '<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 16px">' +
    '<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">' +
    '<tr><td style="background:' + brandColor + ';padding:20px 32px;border-radius:12px 12px 0 0">' +
    '<img src="' + brandLogo + '" alt="' + businessName + '" style="max-height:52px;max-width:180px;object-fit:contain"></td></tr>' +
    '<tr><td style="background:#ffffff;padding:36px 32px">' +
    '<h2 style="margin:0 0 16px;font-size:1.25rem;color:#0a0a0a">How was your experience, ' + firstName + '?</h2>' +
    '<div style="font-size:.9rem;line-height:1.75;color:#3a3a38;margin-bottom:28px">' +
    'We&rsquo;d love your honest feedback about your experience with ' + businessName + '. It takes about 30 seconds and helps us do better.</div>' +
    '<div style="text-align:center"><a href="' + link + '" style="display:inline-block;background:' + brandColor + ';color:#0a0a0a;text-decoration:none;padding:14px 32px;border-radius:50px;font-weight:700;font-size:.95rem">Start the survey &rarr;</a></div>' +
    '</td></tr>' +
    '<tr><td style="background:' + brandColor + ';padding:14px 32px;border-radius:0 0 12px 12px;text-align:center">' +
    '<span style="font-size:.72rem;color:#0a0a0a;opacity:.65">Sent by ' + businessName + ' via SwarmReply</span></td></tr>' +
    '</table></td></tr></table></body></html>';
}

// Sends the chosen survey to every emailable contact in a segment.
// Returns { sent, failed, skipped, audience, capped }. capReached=true means the
// monthly email cap was already hit and nothing was sent.
async function runSurveyCampaign({ customerId, segment, templateId, contactEmails, locationId: locationIdParam }) {
  const seg = (segment || 'all').toString().trim().toLowerCase();
  const picked = Array.isArray(contactEmails)
    ? contactEmails.map((e) => (e || '').toString().trim().toLowerCase()).filter(Boolean)
    : [];

  // Validate the survey belongs to this customer; otherwise fall back to default.
  let tId = templateId || null;
  if (tId) {
    const ok = await query('SELECT id FROM survey_templates WHERE id=$1 AND customer_id=$2', [tId, customerId]).catch(() => ({ rows: [] }));
    if (!ok.rows.length) tId = null;
  }

  const custResult = await query('SELECT name FROM customers WHERE id=$1', [customerId]);
  const businessName = custResult.rows[0]?.name || 'Your Business';
  // Location resolution (5c-1/5c-2). A "forced" location from the caller (e.g.
  // an integration's location) is authoritative for the whole send. Otherwise
  // each contact resolves to its own location (5c-2), falling back to primary.
  let forcedLocationId = null;
  if (locationIdParam) {
    const okLoc = await query('SELECT id FROM locations WHERE id=$1 AND customer_id=$2', [locationIdParam, customerId]).catch(() => ({ rows: [] }));
    if (okLoc.rows.length) forcedLocationId = locationIdParam;
  }
  const primResult = await query('SELECT id FROM locations WHERE customer_id=$1 LIMIT 1', [customerId]).catch(() => ({ rows: [] }));
  const primaryLocationId = primResult.rows[0]?.id || null;
  const locationId = forcedLocationId || primaryLocationId;

  const tmplRes = await query('SELECT config FROM review_templates WHERE customer_id=$1', [customerId]).catch(() => ({ rows: [] }));
  const tmpl = tmplRes.rows[0]?.config || {};
  const brandColor = tmpl.brandColor || '#f5c842';
  const brandLogo = tmpl.brandLogo || 'https://swarmreply.com/bee-logo.png';

  // Audience: either a hand-picked list of contacts, or everyone in a segment.
  // Either way, only emailable contacts; opted-out are skipped below.
  const audRes = picked.length
    ? await query(
        `SELECT name, email, phone, location_id FROM contacts
          WHERE customer_id=$1 AND email IS NOT NULL AND email <> ''
            AND lower(email) = ANY($2)`,
        [customerId, picked]
      ).catch(() => ({ rows: [] }))
    : await query(
        `SELECT name, email, phone, location_id FROM contacts
          WHERE customer_id=$1 AND email IS NOT NULL AND email <> ''
            AND ($2 = 'all' OR lower(segment) = $2)`,
        [customerId, seg]
      ).catch(() => ({ rows: [] }));
  const audience = audRes.rows;
  if (!audience.length) return { sent: 0, failed: 0, skipped: 0, audience: 0, capped: false };

  // Skip opted-out contacts (column may not exist on older schemas).
  let optedOut = new Set();
  try {
    const oo = await query("SELECT lower(email) AS email FROM contacts WHERE customer_id=$1 AND opted_out=true AND email IS NOT NULL", [customerId]);
    optedOut = new Set(oo.rows.map((r) => r.email));
  } catch (e) { /* no opted_out column */ }

  // 5k/location/month cap — survey sends count too.
  const { EMAIL_CAP, monthlyEmailCount } = require('./sendMeter');
  let used = 0;
  try { used = await monthlyEmailCount(locationId); } catch (e) { /* fail open */ }
  const remaining = Math.max(0, EMAIL_CAP - used);
  if (remaining <= 0) return { sent: 0, failed: 0, skipped: 0, audience: audience.length, capped: true, capReached: true };

  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_TRANSACTIONAL_KEY || process.env.RESEND_API_KEY);
  const crypto = require('crypto');
  let sent = 0, failed = 0, skipped = 0, capped = false;

  for (const t of audience) {
    if (sent >= remaining) { capped = true; break; }
    const email = (t.email || '').trim();
    if (!email) { failed++; continue; }
    if (optedOut.has(email.toLowerCase())) { skipped++; continue; }
    const token = crypto.randomBytes(16).toString('hex');
    const firstName = (t.name || '').trim().split(' ')[0] || 'there';
    const rrLoc = forcedLocationId || t.location_id || primaryLocationId;
    await query(
      "INSERT INTO review_requests (customer_id, location_id, contact_name, contact_email, contact_phone, trigger_source, trigger_ref, status, template_id) VALUES ($1,$2,$3,$4,$5,'survey_campaign',$6,'sent',$7)",
      [customerId, rrLoc, t.name || null, email, t.phone || null, token, tId]
    ).catch((e) => logger.warn('survey campaign insert error:', e.message));
    const link = 'https://app.swarmreply.com/review/' + token;
    const html = surveyCampaignEmailHtml({ firstName, businessName, brandColor, brandLogo, link });
    try {
      const { data, error } = await resend.emails.send({
        from: process.env.SMTP_FROM || 'SwarmReply <nick@swarmreply.com>',
        to: [email],
        subject: 'How was your experience, ' + firstName + '?',
        text: 'Hi ' + firstName + ', we would love your feedback about your experience with ' + businessName + '. It takes 30 seconds: ' + link,
        html,
      });
      if (error || !data?.id) { failed++; }
      else {
        sent++;
        await query(
          "INSERT INTO review_request_sends (location_id, contact_name, contact_email, contact_phone, channel, status, message_id) VALUES ($1,$2,$3,$4,'email','sent',$5)",
          [locationId, t.name || null, email, t.phone || null, data.id]
        ).catch(() => {});
      }
    } catch (e) { failed++; logger.warn('survey email error ' + email + ':', e.message); }
    await new Promise((r) => setTimeout(r, 400));
  }

  logger.info('Survey campaign: ' + sent + ' sent, ' + failed + ' failed, ' + skipped + ' skipped' + (capped ? ' (hit monthly cap)' : ''));
  return { sent, failed, skipped, audience: audience.length, capped };
}

// Scheduler sweep (every minute). Claims due rows (pending -> sending) so
// overlapping sweeps can't double-send, runs each, and records the outcome.
async function processDueScheduledSurveySends() {
  const due = await query(
    `UPDATE scheduled_survey_sends
     SET status='sending'
     WHERE id IN (
       SELECT id FROM scheduled_survey_sends
       WHERE status='pending' AND send_at <= NOW()
       ORDER BY send_at LIMIT 10
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  ).catch((e) => { logger.error('scheduled survey claim error:', e.message); return { rows: [] }; });

  for (const row of due.rows) {
    try {
      const result = await runSurveyCampaign({
        customerId: row.customer_id,
        segment: row.segment,
        templateId: row.survey_template_id,
        contactEmails: row.contact_emails,
        locationId: row.location_id,
      });
      const failedSend = !!result.capReached;
      await query(
        `UPDATE scheduled_survey_sends
         SET status=$2, result=$3, error=$4, sent_at=NOW() WHERE id=$1`,
        [row.id, failedSend ? 'failed' : 'sent', JSON.stringify(result), failedSend ? 'Monthly email cap reached' : null]
      );
    } catch (err) {
      logger.error('processDueScheduledSurveySends row error:', err.message);
      await query(`UPDATE scheduled_survey_sends SET status='failed', error=$2 WHERE id=$1`, [row.id, err.message]).catch(() => {});
    }
  }
  if (due.rows.length) logger.info(`Survey schedule sweep: processed ${due.rows.length} due send(s)`);
}

// 5b-3: re-survey guard. True if this contact was surveyed within the last
// `withinDays` (a completed survey_campaign send) or already has one queued.
// Used by the automated triggers so a customer isn't surveyed twice in a short
// window. Manual sends bypass this — the user is choosing to send.
const RESURVEY_GUARD_DAYS = 30;

async function wasRecentlySurveyed(customerId, email, withinDays = RESURVEY_GUARD_DAYS) {
  const e = String(email || '').trim().toLowerCase();
  if (!customerId || !e) return false;
  const sent = await query(
    `SELECT 1 FROM review_requests
      WHERE customer_id=$1 AND lower(contact_email)=$2
        AND trigger_source='survey_campaign' AND status='sent'
        AND created_at > NOW() - make_interval(days => $3::int)
      LIMIT 1`,
    [customerId, e, withinDays]
  ).catch(() => ({ rows: [] }));
  if (sent.rows.length) return true;
  const pend = await query(
    "SELECT contact_emails FROM scheduled_survey_sends WHERE customer_id=$1 AND status IN ('pending','sending')",
    [customerId]
  ).catch(() => ({ rows: [] }));
  for (const row of pend.rows) {
    const arr = Array.isArray(row.contact_emails) ? row.contact_emails : [];
    if (arr.some((x) => String(x).toLowerCase() === e)) return true;
  }
  return false;
}

module.exports = { runSurveyCampaign, processDueScheduledSurveySends, surveyCampaignEmailHtml, wasRecentlySurveyed, RESURVEY_GUARD_DAYS };
