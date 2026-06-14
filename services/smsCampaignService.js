// ============================================
const { smsEnabled } = require('./smsGate');
// services/smsCampaignService.js
// SMS Marketing Campaigns
//
// Handles:
//   - Contact list management + opt-outs
//   - Segment building + audience preview
//   - Campaign CRUD + scheduling
//   - Send engine (batched, rate-limited, TCPA-safe)
//   - Delivery tracking via Twilio webhooks
//   - Opt-out processing (STOP replies)
// ============================================

const { query } = require('../database/db');
const logger    = require('../utils/logger');

// Lazy Twilio init
let _twilio = null;
function getTwilio() {
  if (!_twilio && process.env.TWILIO_ACCOUNT_SID) {
    _twilio = require('twilio')(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }
  return _twilio;
}

// ── OPT-OUT KEYWORDS (TCPA) ──────────────────────────────────────────────────
const OPT_OUT_KEYWORDS  = ['STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT'];
const OPT_IN_KEYWORDS   = ['START','YES','UNSTOP'];

// Twilio rate limit: 1 msg/sec on long code, ~100/min on short code
const SEND_DELAY_MS = 1100;
const BATCH_SIZE    = 50;

// ── CONTACTS ─────────────────────────────────────────────────────────────────

async function getContacts(locationId, { limit = 100, offset = 0, tag = null, search = null } = {}) {
  let where = 'WHERE c.location_id = $1 AND c.opted_in = true';
  const params = [locationId];
  let p = 2;

  if (tag) {
    where += ` AND $${p} = ANY(c.tags)`;
    params.push(tag); p++;
  }
  if (search) {
    where += ` AND (c.name ILIKE $${p} OR c.phone ILIKE $${p})`;
    params.push(`%${search}%`); p++;
  }

  const result = await query(
    `SELECT c.*, COUNT(*) OVER() AS total_count
     FROM sms_contacts c
     ${where}
     ORDER BY c.created_at DESC
     LIMIT $${p} OFFSET $${p+1}`,
    [...params, limit, offset]
  );

  return {
    contacts:   result.rows,
    total:      parseInt(result.rows[0]?.total_count || 0),
    limit,
    offset
  };
}

async function upsertContact(locationId, { name, phone, email, source = 'manual', tags = [], notes, lastVisit, visitCount, totalSpend }) {
  // Check global opt-out first
  const clean = formatPhone(phone);
  if (!clean) throw new Error(`Invalid phone number: ${phone}`);

  const optedOut = await query(
    `SELECT 1 FROM sms_opt_outs WHERE phone = $1`,
    [clean]
  );
  if (optedOut.rows[0]) {
    return { skipped: true, reason: 'opted_out', phone: clean };
  }

  const result = await query(
    `INSERT INTO sms_contacts
       (location_id, name, phone, email, source, tags, notes,
        last_visit, visit_count, total_spend)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (location_id, phone)
     DO UPDATE SET
       name        = EXCLUDED.name,
       email       = COALESCE(EXCLUDED.email, sms_contacts.email),
       tags        = ARRAY(SELECT DISTINCT unnest(sms_contacts.tags || EXCLUDED.tags)),
       notes       = COALESCE(EXCLUDED.notes, sms_contacts.notes),
       last_visit  = GREATEST(sms_contacts.last_visit, EXCLUDED.last_visit),
       visit_count = GREATEST(sms_contacts.visit_count, EXCLUDED.visit_count),
       total_spend = COALESCE(EXCLUDED.total_spend, sms_contacts.total_spend),
       opted_in    = true,
       updated_at  = NOW()
     RETURNING *`,
    [locationId, name, clean, email || null, source,
     tags, notes || null, lastVisit || null,
     visitCount || 0, totalSpend || null]
  );
  return result.rows[0];
}

async function bulkImportContacts(locationId, contacts, source = 'import') {
  let imported = 0, skipped = 0, failed = 0;

  for (const c of contacts) {
    try {
      const result = await upsertContact(locationId, { ...c, source });
      if (result.skipped) skipped++;
      else imported++;
    } catch (err) {
      failed++;
      logger.warn(`Contact import failed: ${err.message}`);
    }
  }
  return { imported, skipped, failed };
}

async function optOutContact(phone, reason = 'STOP reply', locationId = null) {
  const clean = formatPhone(phone);
  if (!clean) return;

  // Add to global opt-out list
  await query(
    `INSERT INTO sms_opt_outs (phone, reason, location_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (phone) DO NOTHING`,
    [clean, reason, locationId]
  );

  // Mark opted out in all location contact lists
  await query(
    `UPDATE sms_contacts
     SET opted_in = false, opted_out_at = NOW()
     WHERE phone = $1`,
    [clean]
  );

  logger.info(`Opt-out recorded: ${clean} (${reason})`);
}

async function getContactStats(locationId) {
  const result = await query(
    `SELECT
       COUNT(*)                             AS total,
       COUNT(*) FILTER (WHERE opted_in)     AS opted_in,
       COUNT(*) FILTER (WHERE NOT opted_in) AS opted_out,
       COUNT(DISTINCT unnest(tags))         AS unique_tags
     FROM sms_contacts
     WHERE location_id = $1`,
    [locationId]
  );
  return result.rows[0];
}

async function getAllTags(locationId) {
  const result = await query(
    `SELECT DISTINCT unnest(tags) AS tag, COUNT(*) AS count
     FROM sms_contacts
     WHERE location_id = $1 AND opted_in = true
     GROUP BY tag
     ORDER BY count DESC`,
    [locationId]
  );
  return result.rows;
}

// ── SEGMENTS ──────────────────────────────────────────────────────────────────

async function getSegments(locationId) {
  const result = await query(
    `SELECT * FROM sms_segments
     WHERE location_id = $1
     ORDER BY created_at DESC`,
    [locationId]
  );
  return result.rows;
}

async function buildSegmentQuery(locationId, filters = {}) {
  let where = ['c.location_id = $1', 'c.opted_in = true'];
  const params = [locationId];
  let p = 2;

  if (filters.tags?.length) {
    where.push(`c.tags && $${p}::text[]`);
    params.push(filters.tags); p++;
  }
  if (filters.min_visits) {
    where.push(`c.visit_count >= $${p}`);
    params.push(filters.min_visits); p++;
  }
  if (filters.last_visit_days) {
    where.push(`c.last_visit >= NOW() - INTERVAL '${parseInt(filters.last_visit_days)} days'`);
  }
  if (filters.source) {
    where.push(`c.source = $${p}`);
    params.push(filters.source); p++;
  }
  if (filters.min_spend) {
    where.push(`c.total_spend >= $${p}`);
    params.push(filters.min_spend); p++;
  }

  return { where: where.join(' AND '), params };
}

async function previewSegment(locationId, filters) {
  const { where, params } = await buildSegmentQuery(locationId, filters);
  const result = await query(
    `SELECT COUNT(*) AS count FROM sms_contacts c WHERE ${where}`,
    params
  );
  return parseInt(result.rows[0].count);
}

async function getSegmentContacts(locationId, filters) {
  const { where, params } = await buildSegmentQuery(locationId, filters);
  const result = await query(
    `SELECT id, name, phone FROM sms_contacts c WHERE ${where}`,
    params
  );
  return result.rows;
}

async function createSegment(locationId, { name, filters }) {
  const count = await previewSegment(locationId, filters);
  const result = await query(
    `INSERT INTO sms_segments (location_id, name, filters, contact_count)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [locationId, name, JSON.stringify(filters), count]
  );
  return result.rows[0];
}

// ── CAMPAIGNS ────────────────────────────────────────────────────────────────

async function getCampaigns(locationId, { limit = 20, offset = 0 } = {}) {
  const result = await query(
    `SELECT * FROM sms_campaigns
     WHERE location_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [locationId, limit, offset]
  );
  return result.rows;
}

async function getCampaign(id, locationId) {
  const result = await query(
    `SELECT * FROM sms_campaigns WHERE id = $1 AND location_id = $2`,
    [id, locationId]
  );
  return result.rows[0] || null;
}

async function createCampaign(locationId, { name, message, audience = 'all', segmentId, targetTags = [], sendAt, timezone }) {
  // Validate message length
  if (!message?.trim()) throw new Error('Message is required');
  if (message.length > 160) throw new Error('Message must be 160 characters or less');

  // Preview recipient count
  const recipientCount = await countRecipients(locationId, { audience, segmentId, targetTags });

  const result = await query(
    `INSERT INTO sms_campaigns
       (location_id, name, message, audience, segment_id,
        target_tags, send_at, timezone, total_recipients)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [locationId, name, message.trim(), audience,
     segmentId || null, targetTags, sendAt || null,
     timezone || 'America/Los_Angeles', recipientCount]
  );
  return result.rows[0];
}

async function updateCampaign(id, locationId, updates) {
  const allowed = ['name', 'message', 'audience', 'segment_id',
                   'target_tags', 'send_at', 'timezone', 'send_window'];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (!fields.length) throw new Error('No valid fields to update');

  const setClause = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
  const values    = fields.map(f => updates[f]);

  const result = await query(
    `UPDATE sms_campaigns SET ${setClause}
     WHERE id = $1 AND location_id = $2 AND status = 'draft'
     RETURNING *`,
    [id, locationId, ...values]
  );
  if (!result.rows[0]) throw new Error('Campaign not found or not in draft status');
  return result.rows[0];
}

async function deleteCampaign(id, locationId) {
  await query(
    `DELETE FROM sms_campaigns
     WHERE id = $1 AND location_id = $2 AND status = 'draft'`,
    [id, locationId]
  );
}

async function countRecipients(locationId, { audience, segmentId, targetTags }) {
  if (audience === 'all') {
    const r = await query(
      `SELECT COUNT(*) FROM sms_contacts
       WHERE location_id = $1 AND opted_in = true`,
      [locationId]
    );
    return parseInt(r.rows[0].count);
  }
  if (audience === 'tags' && targetTags?.length) {
    const r = await query(
      `SELECT COUNT(*) FROM sms_contacts
       WHERE location_id = $1 AND opted_in = true AND tags && $2`,
      [locationId, targetTags]
    );
    return parseInt(r.rows[0].count);
  }
  if (audience === 'segment' && segmentId) {
    const seg = await query(
      `SELECT filters FROM sms_segments WHERE id = $1`,
      [segmentId]
    );
    if (seg.rows[0]) {
      return previewSegment(locationId, seg.rows[0].filters);
    }
  }
  return 0;
}

// ── SEND ENGINE ───────────────────────────────────────────────────────────────

/**
 * launchCampaign()
 * Validates, queues recipients, and starts sending.
 * If send_at is in the future, marks as scheduled.
 * If send_at is null or past, sends immediately.
 */
async function launchCampaign(id, locationId) {
  const campaign = await getCampaign(id, locationId);
  if (!campaign) throw new Error('Campaign not found');
  if (campaign.status !== 'draft') throw new Error(`Cannot launch — status is ${campaign.status}`);

  // Resolve recipients
  const contacts = await resolveRecipients(campaign);
  if (!contacts.length) throw new Error('No eligible recipients found');

  // ── PLAN LIMIT CHECK ──────────────────────────────────────────────────────
  // Throws a user-friendly error if the campaign exceeds the monthly cap.
  await checkCampaignLimit(locationId, contacts.length);

  // Queue sends
  await query(
    `INSERT INTO sms_campaign_sends
       (campaign_id, contact_id, location_id, phone)
     SELECT $1, c.id, c.location_id, c.phone
     FROM sms_contacts c
     WHERE c.id = ANY($2::uuid[])
     ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
    [id, contacts.map(c => c.id)]
  );

  // Update recipient count
  await query(
    `UPDATE sms_campaigns
     SET total_recipients = $2, status = $3, updated_at = NOW()
     WHERE id = $1`,
    [id, contacts.length,
     campaign.send_at && new Date(campaign.send_at) > new Date() ? 'scheduled' : 'sending']
  );

  // If scheduled for future, scheduler will pick it up
  if (campaign.send_at && new Date(campaign.send_at) > new Date()) {
    logger.info(`Campaign ${id} scheduled for ${campaign.send_at}`);
    return { scheduled: true, recipients: contacts.length, sendAt: campaign.send_at };
  }

  // Send immediately (async — don't block the API response)
  sendCampaignBatch(id, locationId, campaign.message).catch(err =>
    logger.error(`Campaign ${id} send error:`, err.message)
  );

  return { sending: true, recipients: contacts.length };
}

async function resolveRecipients(campaign) {
  const { location_id, audience, segment_id, target_tags } = campaign;

  if (audience === 'all') {
    const r = await query(
      `SELECT c.id, c.phone FROM sms_contacts c
       LEFT JOIN sms_opt_outs o ON o.phone = c.phone
       WHERE c.location_id = $1 AND c.opted_in = true AND o.phone IS NULL`,
      [location_id]
    );
    return r.rows;
  }

  if (audience === 'tags' && target_tags?.length) {
    const r = await query(
      `SELECT c.id, c.phone FROM sms_contacts c
       LEFT JOIN sms_opt_outs o ON o.phone = c.phone
       WHERE c.location_id = $1 AND c.opted_in = true
         AND c.tags && $2 AND o.phone IS NULL`,
      [location_id, target_tags]
    );
    return r.rows;
  }

  if (audience === 'segment' && segment_id) {
    const seg = await query(
      `SELECT filters FROM sms_segments WHERE id = $1`,
      [segment_id]
    );
    if (seg.rows[0]) {
      return getSegmentContacts(location_id, seg.rows[0].filters);
    }
  }

  return [];
}

async function sendCampaignBatch(campaignId, locationId, message) {
  if (!smsEnabled()) throw new Error('SMS sending is not enabled yet — texting goes live once A2P 10DLC registration is approved.');
  const twilio = getTwilio();
  if (!twilio) throw new Error('Twilio not configured');

  // Get pending sends in batches
  let offset = 0;
  let totalSent = 0, totalFailed = 0;

  while (true) {
    const batch = await query(
      `SELECT id, phone FROM sms_campaign_sends
       WHERE campaign_id = $1 AND status = 'pending'
       LIMIT $2 OFFSET $3`,
      [campaignId, BATCH_SIZE, offset]
    );

    if (!batch.rows.length) break;

    for (const send of batch.rows) {
      try {
        const msg = await twilio.messages.create({
          body:           message,
          from:           process.env.TWILIO_FROM_NUMBER,
          to:             send.phone,
          statusCallback: `${process.env.BACKEND_URL}/api/campaigns/webhook/delivery`
        });

        await query(
          `UPDATE sms_campaign_sends
           SET status = 'sent', twilio_sid = $2, sent_at = NOW()
           WHERE id = $1`,
          [send.id, msg.sid]
        );
        totalSent++;

      } catch (err) {
        // Twilio error 21610 = number opted out at carrier level
        const isOptOut = err.code === 21610 || err.code === 21614;
        await query(
          `UPDATE sms_campaign_sends
           SET status = $2, error_msg = $3
           WHERE id = $1`,
          [send.id, isOptOut ? 'opted_out' : 'failed', err.message]
        );
        if (isOptOut) await optOutContact(send.phone, 'carrier_opt_out');
        totalFailed++;
        logger.warn(`Campaign send failed for ${send.phone}: ${err.message}`);
      }

      // Rate limit: 1 message per second
      await new Promise(r => setTimeout(r, SEND_DELAY_MS));
    }

    offset += BATCH_SIZE;
  }

  // Mark campaign complete
  await query(
    `UPDATE sms_campaigns
     SET status = 'sent', sent_at = NOW(),
         total_sent   = $2, total_failed = $3,
         updated_at   = NOW()
     WHERE id = $1`,
    [campaignId, totalSent, totalFailed]
  );

  // Increment monthly usage counter (only count actually sent messages)
  await incrementCampaignUsage(locationId, totalSent);

  logger.info(`Campaign ${campaignId} complete: ${totalSent} sent, ${totalFailed} failed`);
}

/**
 * processInboundSMS()
 * Called by Twilio webhook when a customer replies.
 * Handles opt-outs (STOP) and opt-ins (START).
 */
async function processInboundSMS(from, body) {
  const keyword = body.trim().toUpperCase();

  if (OPT_OUT_KEYWORDS.includes(keyword)) {
    await optOutContact(from, 'STOP reply');
    logger.info(`Opt-out via STOP: ${from}`);
    return {
      reply: 'You have been unsubscribed and will receive no further messages. Reply START to re-subscribe.',
      action: 'opt_out'
    };
  }

  if (OPT_IN_KEYWORDS.includes(keyword)) {
    // Re-opt-in
    await query(`DELETE FROM sms_opt_outs WHERE phone = $1`, [from]);
    await query(
      `UPDATE sms_contacts SET opted_in = true, opted_out_at = NULL
       WHERE phone = $1`,
      [from]
    );
    logger.info(`Re-opt-in via START: ${from}`);
    return {
      reply: "You've been re-subscribed. Reply STOP at any time to unsubscribe.",
      action: 'opt_in'
    };
  }

  // Log as a campaign reply
  await query(
    `UPDATE sms_campaign_sends
     SET status = 'delivered'
     WHERE phone = $1 AND status = 'sent'
     ORDER BY sent_at DESC LIMIT 1`,
    [from]
  );

  return { action: 'reply', message: body };
}

/**
 * processDeliveryWebhook()
 * Called by Twilio status callback to update delivery status.
 */
async function processDeliveryWebhook(twilioSid, messageStatus) {
  const statusMap = {
    delivered:   'delivered',
    failed:      'failed',
    undelivered: 'undelivered'
  };

  const mapped = statusMap[messageStatus];
  if (!mapped) return;

  const result = await query(
    `UPDATE sms_campaign_sends
     SET status = $2, delivered_at = CASE WHEN $2 = 'delivered' THEN NOW() ELSE NULL END
     WHERE twilio_sid = $1
     RETURNING campaign_id`,
    [twilioSid, mapped]
  );

  if (result.rows[0] && mapped === 'delivered') {
    await query(
      `UPDATE sms_campaigns
       SET total_delivered = total_delivered + 1
       WHERE id = $1`,
      [result.rows[0].campaign_id]
    );
  }
}

async function getCampaignStats(campaignId, locationId) {
  const camp = await getCampaign(campaignId, locationId);
  if (!camp) return null;

  const sends = await query(
    `SELECT status, COUNT(*) FROM sms_campaign_sends
     WHERE campaign_id = $1 GROUP BY status`,
    [campaignId]
  );

  const statusCounts = {};
  sends.rows.forEach(r => { statusCounts[r.status] = parseInt(r.count); });

  const deliveryRate = camp.total_sent > 0
    ? Math.round((camp.total_delivered / camp.total_sent) * 100)
    : 0;

  return {
    ...camp,
    statusCounts,
    deliveryRate,
    optOutRate: camp.total_sent > 0
      ? Math.round((camp.total_opt_outs / camp.total_sent) * 100)
      : 0
  };
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function formatPhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return null;
}


// ── PLAN LIMITS ───────────────────────────────────────────────────────────────

/**
 * getPlanLimit(locationId)
 * Returns the monthly campaign SMS limit for a location's plan.
 * Returns null if unlimited (agency).
 */
async function getPlanLimit(locationId) {
  const result = await query(
    `SELECT spl.campaign_sms_per_month, spl.overage_per_sms, c.plan
     FROM locations l
     JOIN customers c ON c.id = l.customer_id
     JOIN sms_plan_limits spl ON spl.plan = c.plan
     WHERE l.id = $1`,
    [locationId]
  );
  return result.rows[0] || null;
}

/**
 * getCurrentUsage(locationId)
 * Returns how many campaign SMS have been sent this billing month.
 */
async function getCurrentUsage(locationId) {
  const now = new Date();
  const result = await query(
    `SELECT campaign_sms_sent, sms_limit, plan
     FROM sms_monthly_usage
     WHERE location_id = $1
       AND period_year  = $2
       AND period_month = $3`,
    [locationId, now.getFullYear(), now.getMonth() + 1]
  );
  return result.rows[0] || { campaign_sms_sent: 0, sms_limit: null };
}

/**
 * checkCampaignLimit(locationId, recipientCount)
 * Throws a clear, user-friendly error if the campaign would exceed the plan limit.
 * Returns { allowed, remaining, limit, plan } if OK.
 */
async function checkCampaignLimit(locationId, recipientCount) {
  const planData  = await getPlanLimit(locationId);
  const usageData = await getCurrentUsage(locationId);

  // Agency = unlimited
  if (!planData || planData.campaign_sms_per_month === null) {
    return { allowed: true, remaining: null, limit: null, plan: planData?.plan || 'agency' };
  }

  const limit     = planData.campaign_sms_per_month;
  const used      = usageData.campaign_sms_sent || 0;
  const remaining = Math.max(0, limit - used);

  if (recipientCount > remaining) {
    const planLabel = planData.plan === 'starter' ? 'Starter' : 'Growth';
    throw new Error(
      `SMS campaign limit reached. Your ${planLabel} plan includes ${limit.toLocaleString()} campaign SMS per month. ` +
      `You have used ${used.toLocaleString()} and have ${remaining.toLocaleString()} remaining. ` +
      `This campaign needs ${recipientCount.toLocaleString()} SMS. ` +
      `${remaining > 0 ? `You can send to ${remaining.toLocaleString()} contacts this month.` : 'Your limit resets on the 1st of next month.'} ` +
      `Upgrade to Growth for 2,000/month or contact us for Agency (unlimited).`
    );
  }

  return { allowed: true, remaining, limit, used, plan: planData.plan };
}

/**
 * incrementCampaignUsage(locationId, count)
 * Increments the monthly campaign SMS counter after a successful send.
 * Upserts the row if it doesn't exist yet.
 */
async function incrementCampaignUsage(locationId, count) {
  if (!count || count <= 0) return;

  const now      = new Date();
  const year     = now.getFullYear();
  const month    = now.getMonth() + 1;

  // Get plan info for snapshot
  const planData = await getPlanLimit(locationId);

  // Get customer_id for the row
  const locResult = await query(
    `SELECT customer_id FROM locations WHERE id = $1`,
    [locationId]
  );
  const customerId = locResult.rows[0]?.customer_id;
  if (!customerId) return;

  await query(
    `INSERT INTO sms_monthly_usage
       (location_id, customer_id, period_year, period_month,
        campaign_sms_sent, plan, sms_limit)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (location_id, period_year, period_month)
     DO UPDATE SET
       campaign_sms_sent = sms_monthly_usage.campaign_sms_sent + EXCLUDED.campaign_sms_sent,
       updated_at        = NOW()`,
    [locationId, customerId, year, month, count,
     planData?.plan || 'starter',
     planData?.campaign_sms_per_month || 500]
  );
}

/**
 * getUsageSummary(locationId)
 * Returns usage + limit for the billing dashboard widget.
 */
async function getUsageSummary(locationId) {
  const [planData, usageData] = await Promise.all([
    getPlanLimit(locationId),
    getCurrentUsage(locationId)
  ]);

  const limit     = planData?.campaign_sms_per_month || null;
  const used      = usageData?.campaign_sms_sent     || 0;
  const remaining = limit !== null ? Math.max(0, limit - used) : null;
  const pct       = limit !== null ? Math.round((used / limit) * 100) : 0;

  return {
    plan:           planData?.plan || 'starter',
    limit,
    used,
    remaining,
    pct,
    unlimited:      limit === null,
    nearLimit:      limit !== null && pct >= 80,
    atLimit:        limit !== null && remaining === 0,
    resetsOn:       new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)
  };
}

module.exports = {
  // Contacts
  getContacts, upsertContact, bulkImportContacts,
  optOutContact, getContactStats, getAllTags,
  // Segments
  getSegments, createSegment, previewSegment,
  // Campaigns
  getCampaigns, getCampaign, createCampaign,
  updateCampaign, deleteCampaign, countRecipients,
  launchCampaign, getCampaignStats,
  // Webhooks
  processInboundSMS, processDeliveryWebhook,
  // Limits
  checkCampaignLimit, getCurrentUsage, getUsageSummary,
  incrementCampaignUsage, getPlanLimit
};
