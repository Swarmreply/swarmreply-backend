// ============================================
// services/integrationService.js
// Shared logic for all 6 integrations:
//   - Store / retrieve OAuth tokens (encrypted)
//   - Deduplicate incoming events
//   - Queue and fire review requests with delay
//   - Track stats + errors
// ============================================

const { query }   = require('../database/db');
const { encrypt, decrypt } = require('../middleware/encrypt');
const { sendReviewRequest } = require('./reviewRequestSender');
const logger      = require('../utils/logger');

// ── TOKEN STORAGE ─────────────────────────────────────────────────────────────

async function saveIntegration(locationId, provider, data) {
  const {
    accessToken, refreshToken, tokenExpiresAt,
    extraData, triggerEvent, delayMinutes, templateId
  } = data;

  const encAccess  = accessToken  ? encrypt(accessToken)  : null;
  const encRefresh = refreshToken ? encrypt(refreshToken) : null;

  await query(
    `INSERT INTO integrations
       (location_id, provider, status, access_token, refresh_token,
        token_expires_at, extra_data, trigger_event, delay_minutes, template_id)
     VALUES ($1,$2,'connected',$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (location_id, provider) DO UPDATE SET
       status          = 'connected',
       access_token    = COALESCE(EXCLUDED.access_token, integrations.access_token),
       refresh_token   = COALESCE(EXCLUDED.refresh_token, integrations.refresh_token),
       token_expires_at = COALESCE(EXCLUDED.token_expires_at, integrations.token_expires_at),
       extra_data      = COALESCE(EXCLUDED.extra_data, integrations.extra_data),
       trigger_event   = COALESCE(EXCLUDED.trigger_event, integrations.trigger_event),
       delay_minutes   = COALESCE(EXCLUDED.delay_minutes, integrations.delay_minutes),
       template_id     = COALESCE(EXCLUDED.template_id, integrations.template_id),
       last_error      = NULL,
       updated_at      = NOW()`,
    [locationId, provider, encAccess, encRefresh,
     tokenExpiresAt || null, extraData ? JSON.stringify(extraData) : null,
     triggerEvent || null, delayMinutes ?? 60, templateId || null]
  );
}

async function getIntegration(locationId, provider) {
  const res = await query(
    `SELECT i.*, l.customer_id,
            l.business_name, l.business_type, l.city
     FROM integrations i
     JOIN locations l ON l.id = i.location_id
     WHERE i.location_id = $1 AND i.provider = $2`,
    [locationId, provider]
  );
  if (!res.rows[0]) return null;
  const row = res.rows[0];
  if (row.access_token)  row.access_token  = decrypt(row.access_token);
  if (row.refresh_token) row.refresh_token = decrypt(row.refresh_token);
  return row;
}

async function getIntegrationByProvider(provider, extraMatch) {
  // Find integration matching provider + extra_data field (e.g. shop domain)
  const res = await query(
    `SELECT i.*, l.id as loc_id, l.customer_id,
            l.business_name, l.business_type
     FROM integrations i
     JOIN locations l ON l.id = i.location_id
     WHERE i.provider = $1
       AND i.status = 'connected'
       AND i.extra_data @> $2::jsonb`,
    [provider, JSON.stringify(extraMatch)]
  );
  if (!res.rows[0]) return null;
  const row = res.rows[0];
  if (row.access_token)  row.access_token  = decrypt(row.access_token);
  if (row.refresh_token) row.refresh_token = decrypt(row.refresh_token);
  return row;
}

async function disconnectIntegration(locationId, provider) {
  await query(
    `UPDATE integrations SET status='disconnected', access_token=NULL,
       refresh_token=NULL, updated_at=NOW()
     WHERE location_id=$1 AND provider=$2`,
    [locationId, provider]
  );
}

async function listIntegrations(locationId) {
  const res = await query(
    `SELECT provider, status, trigger_event, delay_minutes,
            follow_up_type, survey_template_id,
            triggers_received, requests_sent, last_triggered_at,
            last_error, last_error_at, extra_data, created_at
     FROM integrations WHERE location_id = $1
     ORDER BY created_at`,
    [locationId]
  );
  return res.rows;
}

// ── EVENT DEDUPLICATION ───────────────────────────────────────────────────────

async function isDuplicate(provider, externalId) {
  if (!externalId) return false;
  const res = await query(
    `SELECT 1 FROM integration_events
     WHERE provider=$1 AND external_id=$2 LIMIT 1`,
    [provider, externalId]
  );
  return res.rows.length > 0;
}

async function logEvent(integrationId, provider, eventType, externalId, payload) {
  const res = await query(
    `INSERT INTO integration_events
       (integration_id, provider, event_type, external_id, payload)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (provider, external_id) WHERE external_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [integrationId, provider, eventType, externalId || null,
     JSON.stringify(payload)]
  );
  return res.rows[0]?.id;
}

async function markEventProcessed(eventId, reviewRequestSent, error = null) {
  await query(
    `UPDATE integration_events
     SET processed=true, review_request_sent=$2, error=$3
     WHERE id=$1`,
    [eventId, reviewRequestSent, error]
  );
}

// ── REVIEW REQUEST TRIGGER ────────────────────────────────────────────────────

/**
 * executeSend — performs the actual send (template lookup + email/SMS).
 * countTrigger=false when called from the scheduler sweep, since the
 * trigger was already counted when the event was queued.
 */
async function executeSend(integration, contact, eventId, countTrigger = true) {
  try {
    // Get default template for this location
    const tmplRes = await query(
      `SELECT id FROM review_request_templates
       WHERE location_id = $1 AND is_default = true
       LIMIT 1`,
      [integration.location_id]
    );

    const templateId = integration.template_id || tmplRes.rows[0]?.id;
    if (!templateId) {
      logger.warn(`No template for integration ${integration.id}`);
      return { success: false, error: 'No review request template configured' };
    }

    // Get full location row
    const locRes = await query(
      'SELECT * FROM locations WHERE id = $1',
      [integration.location_id]
    );
    const location = locRes.rows[0];
    if (!location) return { success: false, error: 'Location not found' };

    const result = await sendReviewRequest({
      templateId,
      contact,
      location,
      customerId: integration.customer_id,
    });

    // Update stats
    await query(
      `UPDATE integrations
       SET triggers_received = triggers_received + CASE WHEN $4 THEN 1 ELSE 0 END,
           requests_sent     = requests_sent + CASE WHEN $2 THEN 1 ELSE 0 END,
           last_triggered_at = NOW(),
           last_error        = CASE WHEN $2 THEN NULL ELSE $3 END,
           last_error_at     = CASE WHEN $2 THEN NULL ELSE NOW() END,
           updated_at        = NOW()
       WHERE id = $1`,
      [integration.id, result.success, result.error || null, countTrigger]
    );

    if (eventId) {
      await markEventProcessed(eventId, result.success, result.error);
    }

    return result;
  } catch (err) {
    logger.error(`executeSend error [${integration.provider}]:`, err.message);
    await query(
      `UPDATE integrations SET
         triggers_received = triggers_received + 1,
         last_error        = $2,
         last_error_at     = NOW(),
         status            = 'error',
         updated_at        = NOW()
       WHERE id = $1`,
      [integration.id, err.message]
    );
    return { success: false, error: err.message };
  }
}

/**
 * delayedSendAt — anchor (Date | ISO string | null) + the integration's
 * configured delay_minutes. Null anchor = now.
 */
function delayedSendAt(integration, anchor = null) {
  const base = anchor ? new Date(anchor) : new Date();
  const safeBase = isNaN(base.getTime()) ? new Date() : base;
  const delayMin = Number.isFinite(Number(integration.delay_minutes))
    ? Number(integration.delay_minutes) : 60;
  return new Date(safeBase.getTime() + delayMin * 60 * 1000);
}

/**
 * triggerReviewRequest — entry point for every integration webhook.
 * opts.sendAt   — when to send (Date). Past/near-now sends immediately.
 * opts.externalRef — provider event ref so cancellations can withdraw it.
 */
async function triggerReviewRequest(integration, contact, eventId, opts = {}) {
  const { sendAt = null, externalRef = null } = opts;

  // 5b-1: survey automation — this integration sends a survey instead of a
  // review request. Queued into scheduled_survey_sends (a one-contact list); the
  // every-minute sweep (processDueScheduledSurveySends) fires it, immediate or
  // delayed. survey_template_id may be null → the account's default survey.
  if (integration.follow_up_type === 'survey') {
    const email = ((contact && contact.email) || '').trim();
    if (!email) {
      logger.warn(`${integration.provider} survey automation: event has no contact email — skipping`);
      return { success: false, error: 'no contact email' };
    }
    let customerId = integration.customer_id;
    if (!customerId && integration.location_id) {
      const lr = await query('SELECT customer_id FROM locations WHERE id=$1', [integration.location_id]).catch(() => ({ rows: [] }));
      customerId = lr.rows[0]?.customer_id || null;
    }
    if (!customerId) {
      logger.warn(`${integration.provider} survey automation: could not resolve customer — skipping`);
      return { success: false, error: 'no customer' };
    }

    // Ensure the contact exists (integration events often arrive for people not
    // yet imported) so the survey send — which targets the contacts table by
    // email — can reach them. Never overwrites an existing contact.
    await query(
      `INSERT INTO contacts (customer_id, name, email, phone, segment)
       VALUES ($1,$2,$3,$4,'all')
       ON CONFLICT (customer_id, lower(email)) WHERE email IS NOT NULL DO NOTHING`,
      [customerId, (contact && contact.name) || null, email, (contact && contact.phone) || null]
    ).catch((e) => logger.warn('survey automation contact ensure skipped: ' + e.message));

    const when = (sendAt && sendAt.getTime() > Date.now()) ? sendAt : new Date(Date.now() + 1000);
    await query(
      `INSERT INTO scheduled_survey_sends
         (customer_id, location_id, survey_template_id, segment, send_at, status, contact_emails)
       VALUES ($1,$2,$3,'all',$4,'pending',$5)`,
      [customerId, integration.location_id || null, integration.survey_template_id || null, when, JSON.stringify([email])]
    );
    await query(
      `UPDATE integrations
       SET triggers_received = triggers_received + 1,
           last_triggered_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [integration.id]
    );
    logger.info(`Scheduled ${integration.provider} survey for ${when.toISOString()}`);
    return { success: true, scheduled: true, survey: true, sendAt: when };
  }

  // Immediate path (no delay configured, or anchor already passed)
  if (!sendAt || sendAt.getTime() <= Date.now() + 5000) {
    return executeSend(integration, contact, eventId, true);
  }

  // Scheduled path
  await query(
    `INSERT INTO scheduled_review_requests
       (integration_id, provider, contact, event_id, external_ref, send_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [integration.id, integration.provider, JSON.stringify(contact),
     eventId != null ? String(eventId) : null, externalRef, sendAt]
  );
  await query(
    `UPDATE integrations
     SET triggers_received = triggers_received + 1,
         last_triggered_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [integration.id]
  );
  logger.info(`Scheduled ${integration.provider} review request for ${sendAt.toISOString()}`);
  return { success: true, scheduled: true, sendAt };
}

/**
 * cancelScheduledRequest — withdraw a pending send (e.g. appointment canceled).
 */
async function cancelScheduledRequest(provider, externalRef) {
  if (!externalRef) return 0;
  const res = await query(
    `UPDATE scheduled_review_requests
     SET status='canceled' WHERE provider=$1 AND external_ref=$2 AND status='pending'
     RETURNING id`,
    [provider, externalRef]
  );
  return res.rows.length;
}

/**
 * rescheduleScheduledRequest — move a pending send (e.g. appointment rescheduled).
 * Returns true if an existing pending row was moved.
 */
async function rescheduleScheduledRequest(provider, externalRef, newSendAt) {
  if (!externalRef) return false;
  const res = await query(
    `UPDATE scheduled_review_requests
     SET send_at=$3 WHERE provider=$1 AND external_ref=$2 AND status='pending'
     RETURNING id`,
    [provider, externalRef, newSendAt]
  );
  return res.rows.length > 0;
}

/**
 * processDueScheduledRequests — scheduler sweep (every minute).
 * Claims due rows first (pending → sending) so overlapping sweeps can't double-send.
 */
async function processDueScheduledRequests() {
  const due = await query(
    `UPDATE scheduled_review_requests
     SET status='sending'
     WHERE id IN (
       SELECT id FROM scheduled_review_requests
       WHERE status='pending' AND send_at <= NOW()
       ORDER BY send_at LIMIT 50
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  );
  for (const row of due.rows) {
    try {
      const integRes = await query(
        `SELECT i.*, l.customer_id, l.business_name, l.business_type
         FROM integrations i JOIN locations l ON l.id = i.location_id
         WHERE i.id = $1`,
        [row.integration_id]
      );
      const integration = integRes.rows[0];
      if (!integration || integration.status !== 'connected') {
        await query(`UPDATE scheduled_review_requests SET status='canceled',
          error='integration disconnected' WHERE id=$1`, [row.id]);
        continue;
      }
      const contact = typeof row.contact === 'string' ? JSON.parse(row.contact) : row.contact;
      const result = await executeSend(integration, contact, row.event_id, false);
      await query(
        `UPDATE scheduled_review_requests
         SET status=$2, error=$3, sent_at=NOW() WHERE id=$1`,
        [row.id, result.success ? 'sent' : 'failed', result.error || null]
      );
    } catch (err) {
      logger.error('processDueScheduledRequests row error:', err.message);
      await query(`UPDATE scheduled_review_requests SET status='failed', error=$2 WHERE id=$1`,
        [row.id, err.message]).catch(() => {});
    }
  }
  if (due.rows.length) logger.info(`Send-timing sweep: processed ${due.rows.length} due request(s)`);
}

module.exports = {
  saveIntegration, getIntegration, getIntegrationByProvider,
  disconnectIntegration, listIntegrations,
  isDuplicate, logEvent, markEventProcessed,
  triggerReviewRequest, delayedSendAt,
  cancelScheduledRequest, rescheduleScheduledRequest,
  processDueScheduledRequests,
};
