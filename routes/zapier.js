// ============================================
// routes/zapier.js
// Backend API endpoints called by the
// Zapier CLI integration.
//
// Merge into backend/routes/index.js
//
// ALL routes are prefixed /api/zapier/
//
// Auth: every request must include
//   X-Api-Key: sr_live_xxxxx
// header. The requireZapierAuth middleware
// validates it and attaches req.zapierCustomer.
// ============================================

const zapierService  = require('../services/zapierService');
const reviewRequestSender = require('../services/reviewRequestSender');

// ============================================
// AUTH MIDDLEWARE
// Applied to every /api/zapier/* route
// ============================================

async function requireZapierAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({
      error: 'Missing X-Api-Key header',
      hint: 'Add your SwarmReply API key from Settings → API Access'
    });
  }

  const customer = await zapierService.validateApiKey(apiKey);

  if (!customer) {
    return res.status(401).json({
      error: 'Invalid or inactive API key',
      hint: 'Generate a new key in your SwarmReply dashboard under Settings → API Access'
    });
  }

  req.zapierCustomer = customer;
  next();
}

// ============================================
// AUTH TEST
// Zapier calls this to verify the API key works
// when the user connects their account
// ============================================

// GET /api/zapier/auth/test
router.get('/zapier/auth/test', requireZapierAuth, (req, res) => {
  const c = req.zapierCustomer;
  res.json({
    success: true,
    id:    c.id,
    email: c.email,
    name:  c.name,
    plan:  c.plan
  });
});

// ============================================
// TRIGGERS — REST HOOKS
// Zapier subscribes/unsubscribes when Zaps
// are turned on/off
// ============================================

// POST /api/zapier/hooks/subscribe
// Zapier sends: { hookUrl, event, locationId? }
router.post('/zapier/hooks/subscribe', requireZapierAuth, async (req, res) => {
  const { hookUrl, event, locationId } = req.body;

  if (!hookUrl || !event) {
    return res.status(400).json({ error: 'hookUrl and event are required' });
  }

  try {
    const result = await zapierService.subscribeHook({
      customerId: req.zapierCustomer.id,
      locationId: locationId || null,
      event,
      targetUrl: hookUrl
    });
    res.status(201).json(result);
  } catch (err) {
    logger.error('Zapier subscribe error:', err.message);
    res.status(500).json({ error: 'Failed to subscribe hook' });
  }
});

// DELETE /api/zapier/hooks/unsubscribe
router.delete('/zapier/hooks/unsubscribe', requireZapierAuth, async (req, res) => {
  const { hookUrl, event } = req.body;
  try {
    await zapierService.unsubscribeHook({
      customerId: req.zapierCustomer.id,
      event,
      targetUrl: hookUrl
    });
    res.json({ success: true });
  } catch (err) {
    logger.error('Zapier unsubscribe error:', err.message);
    res.status(500).json({ error: 'Failed to unsubscribe hook' });
  }
});

// ============================================
// TRIGGERS — POLLING
// Used for sample data and as REST hook fallback
// Must return newest first. Must include `id`.
// ============================================

// GET /api/zapier/triggers/new-review
router.get('/zapier/triggers/new-review', requireZapierAuth, async (req, res) => {
  try {
    const reviews = await zapierService.getRecentReviews({
      customerId:   req.zapierCustomer.id,
      locationId:   req.query.location_id || null,
      negativeOnly: false
    });
    res.json(reviews);
  } catch (err) {
    logger.error('Zapier trigger new-review error:', err.message);
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

// GET /api/zapier/triggers/new-negative-review
router.get('/zapier/triggers/new-negative-review', requireZapierAuth, async (req, res) => {
  try {
    const reviews = await zapierService.getRecentReviews({
      customerId:   req.zapierCustomer.id,
      locationId:   req.query.location_id || null,
      negativeOnly: true
    });
    res.json(reviews);
  } catch (err) {
    logger.error('Zapier trigger negative-review error:', err.message);
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

// ============================================
// ACTIONS
// ============================================

// POST /api/zapier/actions/send-review-request
// Send an email or SMS review request to one contact
router.post('/zapier/actions/send-review-request', requireZapierAuth, async (req, res) => {
  const {
    contact_name,
    contact_email,
    contact_phone,
    location_id,
    template_id,
    channel        // 'email' | 'sms' — optional override
  } = req.body;

  if (!contact_name) {
    return res.status(400).json({ error: 'contact_name is required' });
  }
  if (!contact_email && !contact_phone) {
    return res.status(400).json({ error: 'contact_email or contact_phone is required' });
  }
  if (!location_id) {
    return res.status(400).json({ error: 'location_id is required' });
  }

  try {
    // Verify location belongs to this customer
    const locResult = await query(
      'SELECT * FROM locations WHERE id = $1 AND customer_id = $2',
      [location_id, req.zapierCustomer.id]
    );
    if (!locResult.rows.length) {
      return res.status(404).json({ error: 'Location not found' });
    }
    const location = locResult.rows[0];

    // Get template — use provided or fall back to default
    let templateId = template_id;
    if (!templateId) {
      const tmplResult = await query(
        `SELECT id FROM review_request_templates
         WHERE location_id = $1
           AND is_default = true
           AND channel = $2
         LIMIT 1`,
        [location_id, channel || 'email']
      );
      if (tmplResult.rows.length) {
        templateId = tmplResult.rows[0].id;
      }
    }

    if (!templateId) {
      return res.status(400).json({
        error: 'No template found. Pass template_id or ensure default templates are set up.'
      });
    }

    const result = await reviewRequestSender.sendReviewRequest({
      templateId,
      contact: {
        name:  contact_name,
        email: contact_email || null,
        phone: contact_phone || null
      },
      location,
      customerId: req.zapierCustomer.id
    });

    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Send failed' });
    }

    res.status(201).json({
      id:      result.sendId || require('crypto').randomUUID(),
      success: true,
      channel: result.channel,
      message: `Review request sent to ${contact_name} via ${result.channel}`
    });

  } catch (err) {
    logger.error('Zapier action send-review-request error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/zapier/actions/create-contact
// Add a contact to SwarmReply's send history
// (prevents double-sending in future CSV imports)
router.post('/zapier/actions/create-contact', requireZapierAuth, async (req, res) => {
  const { name, email, phone, location_id, visit_date, notes } = req.body;

  if (!name || (!email && !phone)) {
    return res.status(400).json({ error: 'name and email or phone are required' });
  }

  try {
    // Insert into csv_import_contacts as a standalone record
    // (import_id = null means it was created via API)
    const result = await query(
      `INSERT INTO csv_import_contacts
       (location_id, name, email, phone, visit_date, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [location_id || null, name, email || null, phone || null, visit_date || null, notes || null]
    );

    const id = result.rows[0]?.id || require('crypto').randomUUID();
    res.status(201).json({ id, name, email, phone, success: true });

  } catch (err) {
    logger.error('Zapier create-contact error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/zapier/actions/get-location-stats
// Returns current stats for a location
// Used as a Zapier action that outputs data
// (e.g. "get my rating" → use in a Slack message)
router.get('/zapier/actions/location-stats', requireZapierAuth, async (req, res) => {
  const { location_id } = req.query;

  try {
    const locQuery = location_id
      ? 'SELECT * FROM locations WHERE id = $1 AND customer_id = $2'
      : 'SELECT * FROM locations WHERE customer_id = $1 LIMIT 1';
    const locParams = location_id
      ? [location_id, req.zapierCustomer.id]
      : [req.zapierCustomer.id];

    const locResult = await query(locQuery, locParams);
    if (!locResult.rows.length) {
      return res.status(404).json({ error: 'Location not found' });
    }
    const loc = locResult.rows[0];

    // Get stats
    const statsResult = await query(
      `SELECT
         COUNT(*) AS total_reviews,
         ROUND(AVG(star_rating)::numeric, 1) AS avg_rating,
         COUNT(*) FILTER (WHERE status = 'replied') AS replied_count,
         COUNT(*) FILTER (WHERE star_rating <= 2) AS negative_count,
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS reviews_last_30_days
       FROM reviews
       WHERE location_id = $1`,
      [loc.id]
    );

    const s = statsResult.rows[0];
    res.json({
      id:                    loc.id,
      business_name:         loc.business_name,
      platform:              loc.platform,
      total_reviews:         parseInt(s.total_reviews),
      avg_rating:            parseFloat(s.avg_rating) || 0,
      reply_count:           parseInt(s.replied_count),
      negative_count:        parseInt(s.negative_count),
      reviews_last_30_days:  parseInt(s.reviews_last_30_days),
      response_rate:         s.total_reviews > 0
                               ? Math.round((s.replied_count / s.total_reviews) * 100)
                               : 0
    });

  } catch (err) {
    logger.error('Zapier location-stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// SEARCHES
// ============================================

// GET /api/zapier/searches/find-location
// Find a location by name or ID
router.get('/zapier/searches/find-location', requireZapierAuth, async (req, res) => {
  const { name, id } = req.query;

  if (!name && !id) {
    return res.status(400).json({ error: 'name or id query parameter required' });
  }

  try {
    const result = await query(
      `SELECT
         l.id, l.business_name, l.business_type,
         l.platform, l.is_active, l.last_synced_at,
         COUNT(r.id) AS total_reviews,
         ROUND(AVG(r.star_rating)::numeric, 1) AS avg_rating
       FROM locations l
       LEFT JOIN reviews r ON r.location_id = l.id
       WHERE l.customer_id = $1
         AND (
           ($2::text IS NOT NULL AND LOWER(l.business_name) LIKE '%' || LOWER($2) || '%')
           OR
           ($3::uuid IS NOT NULL AND l.id = $3)
         )
       GROUP BY l.id
       ORDER BY l.business_name
       LIMIT 5`,
      [req.zapierCustomer.id, name || null, id || null]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'No location found matching that name' });
    }

    const loc = result.rows[0];
    res.json({
      id:            loc.id,
      business_name: loc.business_name,
      business_type: loc.business_type || '',
      platform:      loc.platform,
      is_active:     loc.is_active,
      total_reviews: parseInt(loc.total_reviews),
      avg_rating:    parseFloat(loc.avg_rating) || 0,
      last_synced:   loc.last_synced_at
    });

  } catch (err) {
    logger.error('Zapier find-location error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/zapier/searches/find-contact
// Check if a contact has been sent a review request recently
// Useful in Zaps to avoid sending duplicate requests
router.get('/zapier/searches/find-contact', requireZapierAuth, async (req, res) => {
  const { email, phone } = req.query;

  if (!email && !phone) {
    return res.status(400).json({ error: 'email or phone query parameter required' });
  }

  try {
    const result = await query(
      `SELECT
         rrс.id, rrс.name, rrс.email, rrс.phone,
         rrс.status, rrс.sent_at, rrс.visit_date,
         l.business_name
       FROM csv_import_contacts rrс
       JOIN locations l ON rrс.location_id = l.id
       WHERE l.customer_id = $1
         AND (
           ($2::text IS NOT NULL AND LOWER(rrс.email) = LOWER($2))
           OR
           ($3::text IS NOT NULL AND rrс.phone = $3)
         )
       ORDER BY rrс.created_at DESC
       LIMIT 1`,
      [req.zapierCustomer.id, email || null, phone || null]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const c = result.rows[0];
    res.json({
      id:            c.id,
      name:          c.name,
      email:         c.email,
      phone:         c.phone,
      status:        c.status,
      sent_at:       c.sent_at,
      visit_date:    c.visit_date,
      business_name: c.business_name
    });

  } catch (err) {
    logger.error('Zapier find-contact error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// DYNAMIC DROPDOWNS
// Zapier calls these to populate dropdown
// fields in the Zap editor
// ============================================

// GET /api/zapier/dynamic/locations
// Powers the "Location" dropdown in every trigger/action
router.get('/zapier/dynamic/locations', requireZapierAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, business_name, platform
       FROM locations
       WHERE customer_id = $1 AND is_active = true
       ORDER BY business_name`,
      [req.zapierCustomer.id]
    );

    res.json(result.rows.map(l => ({
      id:      l.id,
      name:    `${l.business_name} (${l.platform})`
    })));
  } catch (err) {
    logger.error('Zapier dynamic locations error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/zapier/dynamic/templates
// Powers the "Template" dropdown in send-review-request
router.get('/zapier/dynamic/templates', requireZapierAuth, async (req, res) => {
  const { location_id } = req.query;

  try {
    const result = await query(
      `SELECT t.id, t.name, t.channel
       FROM review_request_templates t
       JOIN locations l ON t.location_id = l.id
       WHERE l.customer_id = $1
         AND ($2::uuid IS NULL OR t.location_id = $2)
       ORDER BY t.is_default DESC, t.name`,
      [req.zapierCustomer.id, location_id || null]
    );

    res.json(result.rows.map(t => ({
      id:   t.id,
      name: `${t.name} (${t.channel.toUpperCase()})`
    })));
  } catch (err) {
    logger.error('Zapier dynamic templates error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// API KEY MANAGEMENT (dashboard use)
// ============================================

// GET /api/zapier/key
// Returns current API key for the logged-in customer
router.get('/zapier/key', async (req, res) => {
  const customerId = req.query.customerId;
  if (!customerId) return res.status(400).json({ error: 'customerId required' });

  try {
    const key = await zapierService.getApiKey(customerId);
    res.json({ apiKey: key ? `${key.substring(0, 12)}...` : null, hasKey: !!key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/zapier/key/generate
// Generate or rotate the API key
router.post('/zapier/key/generate', async (req, res) => {
  const { customerId } = req.body;
  if (!customerId) return res.status(400).json({ error: 'customerId required' });

  try {
    const key = await zapierService.generateApiKey(customerId);
    res.json({ apiKey: key, message: 'API key generated — copy it now, it won\'t be shown again in full' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
