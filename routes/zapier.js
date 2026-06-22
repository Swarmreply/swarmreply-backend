// ============================================
// routes/zapier.js
// Two audiences in one router:
//   1. The dashboard (JWT auth) — create / rotate / revoke the API key
//   2. The SwarmReply Zapier app (X-API-Key auth) — auth test, dropdown
//      sources, REST-hook subscribe/unsubscribe, and the five actions.
// Endpoint keys match the Zapier app exactly:
//   triggers: new_review, new_negative_review, dynamic_locations, dynamic_templates
//   actions:  send_review_request, create_contact, get_location_stats,
//             find_location, find_contact
// ============================================

const express = require('express');
const crypto = require('crypto');
const { Resend } = require('resend');
const { query } = require('../database/db');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

const HOOK_EVENTS = ['new_review', 'new_negative_review'];
const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

// ── API-key auth for calls coming from Zapier ────────────────────────────────
async function authenticateApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'Missing X-API-Key header' });
  try {
    const r = await query(
      'SELECT id, name FROM customers WHERE zapier_api_key_hash = $1',
      [hashKey(key)]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid API key' });
    req.user = { customerId: r.rows[0].id, id: r.rows[0].id, name: r.rows[0].name };
    next();
  } catch (err) {
    logger.error('Zapier auth error:', err.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// DASHBOARD — API key management (JWT)
// ════════════════════════════════════════════════════════════════════════════

// GET /api/zapier/key — does a key exist? (never returns the key itself)
router.get('/key', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const r = await query(
      'SELECT zapier_api_key_hint, zapier_key_created_at FROM customers WHERE id = $1',
      [customerId]
    );
    const row = r.rows[0] || {};
    res.json({
      exists: !!row.zapier_api_key_hint,
      hint: row.zapier_api_key_hint || null,
      createdAt: row.zapier_key_created_at || null,
    });
  } catch (err) {
    logger.error('Zapier key status error:', err.message);
    res.status(500).json({ error: 'Failed to load key status' });
  }
});

// POST /api/zapier/key — generate (or rotate). The full key is returned ONCE;
// only its SHA-256 hash is stored. Rotating invalidates the previous key.
router.post('/key', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const key = 'sr_live_' + crypto.randomBytes(24).toString('hex');
    await query(
      `UPDATE customers SET
         zapier_api_key_hash = $1,
         zapier_api_key_hint = $2,
         zapier_key_created_at = NOW()
       WHERE id = $3`,
      [hashKey(key), key.slice(-4), customerId]
    );
    logger.info(`Zapier API key generated for customer ${customerId}`);
    res.json({ key });
  } catch (err) {
    logger.error('Zapier key generate error:', err.message);
    res.status(500).json({ error: 'Failed to generate key' });
  }
});

// DELETE /api/zapier/key — revoke the key and remove every hook subscription.
// This is the "disconnect Zapier" action.
router.delete('/key', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    await query(
      `UPDATE customers SET
         zapier_api_key_hash = NULL,
         zapier_api_key_hint = NULL,
         zapier_key_created_at = NULL
       WHERE id = $1`,
      [customerId]
    );
    await query('DELETE FROM zapier_hooks WHERE customer_id = $1', [customerId]);
    logger.info(`Zapier disconnected for customer ${customerId}`);
    res.json({ success: true });
  } catch (err) {
    logger.error('Zapier disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect Zapier' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ZAPIER APP — everything below authenticates with X-API-Key
// ════════════════════════════════════════════════════════════════════════════

// GET /api/zapier/me — Zapier's auth test
router.get('/me', authenticateApiKey, async (req, res) => {
  res.json({ id: req.user.customerId, name: req.user.name || 'SwarmReply account' });
});

// GET /api/zapier/locations — dynamic_locations dropdown source
router.get('/locations', authenticateApiKey, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, business_name AS name FROM locations
       WHERE customer_id = $1 AND is_active = true
       ORDER BY business_name`,
      [req.user.customerId]
    );
    res.json(r.rows);
  } catch (err) {
    logger.error('Zapier locations error:', err.message);
    res.status(500).json({ error: 'Failed to load locations' });
  }
});

// GET /api/zapier/templates — dynamic_templates dropdown source
router.get('/templates', authenticateApiKey, async (req, res) => {
  try {
    const r = await query(
      'SELECT config FROM review_templates WHERE customer_id = $1',
      [req.user.customerId]
    ).catch(() => ({ rows: [] }));
    const saved = r.rows[0]?.config;
    res.json([
      { id: 'default', name: saved ? 'Your saved request template' : 'Default review request template' },
    ]);
  } catch (err) {
    res.json([{ id: 'default', name: 'Default review request template' }]);
  }
});

// POST /api/zapier/hooks — REST-hook subscribe (new_review / new_negative_review)
router.post('/hooks', authenticateApiKey, async (req, res) => {
  const { event, hookUrl } = req.body || {};
  if (!HOOK_EVENTS.includes(event)) {
    return res.status(400).json({ error: `event must be one of: ${HOOK_EVENTS.join(', ')}` });
  }
  if (!hookUrl || !/^https:\/\/hooks\.zapier\.com\//.test(hookUrl)) {
    return res.status(400).json({ error: 'hookUrl must be a https://hooks.zapier.com/ URL' });
  }
  try {
    const r = await query(
      `INSERT INTO zapier_hooks (customer_id, event, hook_url)
       VALUES ($1, $2, $3) RETURNING id`,
      [req.user.customerId, event, hookUrl]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (err) {
    logger.error('Zapier subscribe error:', err.message);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// DELETE /api/zapier/hooks/:id — REST-hook unsubscribe
router.delete('/hooks/:id', authenticateApiKey, async (req, res) => {
  try {
    await query(
      'DELETE FROM zapier_hooks WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.user.customerId]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error('Zapier unsubscribe error:', err.message);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// GET /api/zapier/hooks/sample?event=… — Zapier performList (sample data for
// the Zap editor). Returns recent real reviews, or a static sample if none.
router.get('/hooks/sample', authenticateApiKey, async (req, res) => {
  const negative = req.query.event === 'new_negative_review';
  try {
    const r = await query(
      `SELECT rv.id, rv.location_id, l.business_name, rv.platform, rv.reviewer_name,
              rv.star_rating, rv.review_text, rv.review_date
       FROM reviews rv JOIN locations l ON l.id = rv.location_id
       WHERE l.customer_id = $1 ${negative ? 'AND rv.star_rating <= 2' : ''}
       ORDER BY rv.review_date DESC NULLS LAST LIMIT 3`,
      [req.user.customerId]
    );
    if (r.rows.length) {
      return res.json(r.rows.map(rv => ({
        id: rv.id,
        location_id: rv.location_id,
        location_name: rv.business_name,
        platform: rv.platform || 'google',
        reviewer_name: rv.reviewer_name,
        rating: Number(rv.star_rating),
        text: rv.review_text,
        review_date: rv.review_date,
      })));
    }
    res.json([{
      id: 'sample-review-1',
      location_id: 'sample-location',
      location_name: 'Your Business',
      platform: 'google',
      reviewer_name: 'Jane Doe',
      rating: negative ? 1 : 5,
      text: negative ? 'Very disappointed with my visit.' : 'Wonderful experience, highly recommend!',
      review_date: new Date().toISOString(),
    }]);
  } catch (err) {
    logger.error('Zapier sample error:', err.message);
    res.status(500).json({ error: 'Failed to load samples' });
  }
});

// POST /api/zapier/review-request — send_review_request action.
// Mirrors POST /api/review-requests/send (routes/index.js); keep in sync.
router.post('/review-request', authenticateApiKey, async (req, res) => {
  try {
    const customerId = req.user.customerId;
    const { name, email, phone, locationId } = req.body || {};
    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'email is required' });
    }

    const custResult = await query('SELECT name FROM customers WHERE id=$1', [customerId]);
    const businessName = custResult.rows[0]?.name || 'Your Business';

    const tmplRes = await query(
      'SELECT config FROM review_templates WHERE customer_id=$1', [customerId]
    ).catch(() => ({ rows: [] }));
    const tmpl = tmplRes.rows[0]?.config || {};

    let locId = locationId || null;
    if (locId) {
      const own = await query('SELECT id FROM locations WHERE id=$1 AND customer_id=$2', [locId, customerId]);
      if (!own.rows.length) return res.status(404).json({ error: 'Location not found' });
    } else {
      const locResult = await query('SELECT id FROM locations WHERE customer_id=$1 LIMIT 1', [customerId]).catch(() => ({ rows: [] }));
      locId = locResult.rows[0]?.id || null;
    }

    const token = crypto.randomBytes(16).toString('hex');
    await query(
      `INSERT INTO review_requests (customer_id, location_id, contact_name, contact_email, contact_phone, trigger_source, trigger_ref, status)
       VALUES ($1,$2,$3,$4,$5,'zapier',$6,'sent')`,
      [customerId, locId, name || null, email.trim(), phone || null, token]
    );

    const reviewLink = 'https://app.swarmreply.com/review/' + token;
    const brandColor = tmpl.brandColor || '#f5c842';
    const brandLogo  = tmpl.brandLogo  || 'https://swarmreply.com/bee-logo.png';
    const logoAlign  = ({ left: 'left', middle: 'center', right: 'right' })[tmpl.brandLogoPosition] || 'left';
    const buttonText = tmpl.buttonText || 'Share Your Feedback →';
    const firstName  = (name || '').trim().split(' ')[0] || 'there';
    const bodyText = 'Hi ' + firstName + ',\n\nThank you for choosing ' + businessName + '! We would love to hear how we did. It only takes a moment.';

    const emailHtml = [
      '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
      '<body style="margin:0;padding:0;background:#f4f4f0;font-family:Arial,sans-serif">',
      '<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 16px">',
      '<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">',
      '<tr><td style="background:' + brandColor + ';padding:20px 32px;border-radius:12px 12px 0 0;text-align:' + logoAlign + '">',
      '<img src="' + brandLogo + '" alt="' + businessName + '" style="max-height:52px;max-width:180px;object-fit:contain">',
      '</td></tr>',
      '<tr><td style="background:#ffffff;padding:36px 32px">',
      '<h2 style="margin:0 0 16px;font-size:1.25rem;color:#0a0a0a">How did we do, ' + firstName + '?</h2>',
      '<div style="font-size:.9rem;line-height:1.75;color:#3a3a38;margin-bottom:28px">' + bodyText.replace(/\n/g,'<br>') + '</div>',
      '<div style="text-align:center;margin-bottom:8px">',
      '<a href="' + reviewLink + '" style="display:inline-block;background:' + brandColor + ';color:#0a0a0a;text-decoration:none;padding:14px 32px;border-radius:50px;font-weight:700;font-size:.95rem">' + buttonText + '</a>',
      '</td></tr>',
      '<tr><td style="background:' + brandColor + ';padding:14px 32px;border-radius:0 0 12px 12px;text-align:center">',
      '<span style="font-size:.72rem;color:#0a0a0a;opacity:.65">Sent by ' + businessName + ' via SwarmReply</span>',
      '</td></tr>',
      '</table></td></tr></table></body></html>'
    ].join('');

    if (!process.env.RESEND_TRANSACTIONAL_KEY && !process.env.RESEND_API_KEY) {
      return res.status(503).json({ error: 'Email not configured' });
    }
    const resend = new Resend(process.env.RESEND_TRANSACTIONAL_KEY || process.env.RESEND_API_KEY);
    const { data: sendData, error: sendError } = await resend.emails.send({
      from:    process.env.SMTP_FROM || 'SwarmReply <nick@swarmreply.com>',
      to:      [email.trim()],
      subject: 'How did we do, ' + firstName + '?',
      text:    bodyText + '\n\nShare your feedback: ' + reviewLink,
      html:    emailHtml,
    });
    if (sendError) {
      logger.error('Zapier review request send error:', JSON.stringify(sendError));
      return res.status(502).json({ error: sendError.message || 'Email provider rejected the send' });
    }

    logger.info('Zapier review request sent to ' + email);
    res.json({ success: true, id: sendData?.id || null, reviewLink });
  } catch (err) {
    logger.error('Zapier review-request error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/zapier/contacts — create_contact action (upsert by email)
router.post('/contacts', authenticateApiKey, async (req, res) => {
  const { name, email, phone, segment } = req.body || {};
  if (!email || !email.trim()) {
    return res.status(400).json({ error: 'email is required' });
  }
  try {
    const customerId = req.user.customerId;
    const existing = await query(
      'SELECT id FROM contacts WHERE customer_id=$1 AND LOWER(email)=LOWER($2)',
      [customerId, email.trim()]
    );
    if (existing.rows.length) {
      const r = await query(
        `UPDATE contacts SET name = COALESCE($1, name), phone = COALESCE($2, phone),
           segment = COALESCE($3, segment)
         WHERE id = $4 RETURNING id, name, email, phone, segment`,
        [name || null, phone || null, segment || null, existing.rows[0].id]
      );
      return res.json({ contact: r.rows[0], created: false });
    }
    const r = await query(
      `INSERT INTO contacts (customer_id, name, email, phone, segment)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, phone, segment`,
      [customerId, name || null, email.trim(), phone || null, segment || 'all']
    );
    res.status(201).json({ contact: r.rows[0], created: true });
  } catch (err) {
    logger.error('Zapier create contact error:', err.message);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// GET /api/zapier/contacts/find?email=… — find_contact action
router.get('/contacts/find', authenticateApiKey, async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email query param is required' });
  try {
    const r = await query(
      `SELECT id, name, email, phone, segment, last_request_at
       FROM contacts WHERE customer_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
      [req.user.customerId, email]
    );
    res.json({ found: r.rows.length > 0, contact: r.rows[0] || null });
  } catch (err) {
    logger.error('Zapier find contact error:', err.message);
    res.status(500).json({ error: 'Failed to find contact' });
  }
});

// GET /api/zapier/locations/find?name=… — find_location action
router.get('/locations/find', authenticateApiKey, async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name query param is required' });
  try {
    const r = await query(
      `SELECT id, business_name AS name FROM locations
       WHERE customer_id=$1 AND business_name ILIKE $2
       ORDER BY business_name LIMIT 5`,
      [req.user.customerId, '%' + name + '%']
    );
    res.json({ found: r.rows.length > 0, locations: r.rows });
  } catch (err) {
    logger.error('Zapier find location error:', err.message);
    res.status(500).json({ error: 'Failed to find location' });
  }
});

// GET /api/zapier/location-stats?locationId=… — get_location_stats action
router.get('/location-stats', authenticateApiKey, async (req, res) => {
  const { locationId } = req.query;
  try {
    const customerId = req.user.customerId;
    const r = await query(
      `SELECT l.id AS location_id, l.business_name,
              COUNT(rv.id) AS total_reviews,
              ROUND(AVG(rv.star_rating)::numeric, 1) AS avg_rating,
              COUNT(*) FILTER (WHERE rv.status = 'replied') AS replied,
              COUNT(*) FILTER (WHERE rv.created_at >= NOW() - INTERVAL '30 days') AS reviews_last_30d
       FROM locations l
       LEFT JOIN reviews rv ON rv.location_id = l.id
       WHERE l.customer_id = $1 ${locationId ? 'AND l.id = $2' : ''}
       GROUP BY l.id, l.business_name
       ORDER BY l.business_name`,
      locationId ? [customerId, locationId] : [customerId]
    );
    if (locationId && !r.rows.length) {
      return res.status(404).json({ error: 'Location not found' });
    }
    const fmt = (row) => ({
      location_id: row.location_id,
      location_name: row.business_name,
      total_reviews: parseInt(row.total_reviews) || 0,
      avg_rating: row.avg_rating != null ? Number(row.avg_rating) : null,
      response_rate: parseInt(row.total_reviews)
        ? Math.round((parseInt(row.replied) / parseInt(row.total_reviews)) * 100)
        : null,
      reviews_last_30_days: parseInt(row.reviews_last_30d) || 0,
    });
    res.json(locationId ? fmt(r.rows[0]) : { locations: r.rows.map(fmt) });
  } catch (err) {
    logger.error('Zapier location stats error:', err.message);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

module.exports = router;
