// ============================================
// routes/index.js
// All API routes for SwarmReply backend
// ============================================

const express = require('express');
const { Resend } = require('resend');
const router = express.Router();
const { query } = require('../database/db');
const googleService = require('../services/googleService');
const logger = require('../utils/logger');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { authenticateToken } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

// ============================================
// HEALTH CHECK
// ============================================

// GET /api/health
// Used by Railway/monitoring to check server is up
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// GOOGLE OAUTH ROUTES
// ============================================

// GET /api/auth/google?locationId=xxx
// Start Google OAuth flow for a location
router.get('/auth/google', (req, res) => {
  const { locationId } = req.query;

  if (!locationId) {
    return res.status(400).json({ error: 'locationId is required' });
  }

  const authUrl = googleService.getAuthUrl(locationId);
  res.redirect(authUrl);
});

// GET /api/auth/google/callback
// Google redirects here after customer authorizes
router.get('/auth/google/callback', async (req, res) => {
  const { code, state: locationId, error } = req.query;

  // Handle user denying access
  if (error) {
    logger.warn('Google OAuth denied:', error);
    return res.redirect(`${process.env.FRONTEND_URL}/dashboard?error=google_denied`);
  }

  if (!code || !locationId) {
    return res.redirect(`${process.env.FRONTEND_URL}/dashboard?error=invalid_callback`);
  }

  try {
    await googleService.exchangeCodeForTokens(code, locationId);
    logger.info(`Google OAuth complete for location: ${locationId}`);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?success=google_connected`);
  } catch (error) {
    logger.error('Google OAuth callback error:', error.message);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?error=oauth_failed`);
  }
});

// ============================================
// LOCATION ROUTES
// ============================================

// GET /api/locations?customerId=xxx
// Get all locations for a customer
router.get('/locations', authenticateToken, async (req, res) => {
  const { customerId } = req.query;

  if (!customerId) {
    return res.status(400).json({ error: 'customerId is required' });
  }

  try {
    const result = await query(
      `SELECT id, business_name, business_type, platform, tone,
              always_include, never_include, contact_email, auto_reply,
              is_active, last_synced_at, created_at
       FROM locations
       WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [customerId]
    );
    res.json({ locations: result.rows });
  } catch (error) {
    logger.error('Get locations error:', error.message);
    res.status(500).json({ error: 'Failed to fetch locations' });
  }
});

// POST /api/locations
// Create a new location
router.post('/locations', authenticateToken, async (req, res) => {
  const { customerId, businessName, businessType, platform, contactEmail, tone, isHealthcare } = req.body;

  if (!customerId || !businessName || !platform) {
    return res.status(400).json({ error: 'customerId, businessName, and platform are required' });
  }

  try {
    const result = await query(
      `INSERT INTO locations
       (customer_id, business_name, business_type, platform, contact_email, tone, is_healthcare)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, business_name, platform`,
      [customerId, businessName, businessType, platform, contactEmail, tone || 'warm', isHealthcare || false]
    );

    logger.info(`New location created: ${businessName} for customer ${customerId}`);

    // Keep Stripe per-location billing in sync with the actual location count.
    // Fire-and-forget: a billing hiccup must never block creating a location.
    require('../services/locationBilling')
      .syncLocationBilling(customerId)
      .catch(e => logger.warn('Location billing sync after create failed:', e.message));

    res.status(201).json({ location: result.rows[0] });
  } catch (error) {
    logger.error('Create location error:', error.message);
    res.status(500).json({ error: 'Failed to create location' });
  }
});

// PUT /api/locations/:id/settings
// Update location tone and keyword settings
router.put('/locations/:id/settings', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { tone, alwaysInclude, neverInclude, customInstructions, contactEmail, autoReply } = req.body;

  try {
    await query(
      `UPDATE locations
       SET tone = COALESCE($1, tone),
           always_include = COALESCE($2, always_include),
           never_include = COALESCE($3, never_include),
           custom_instructions = COALESCE($4, custom_instructions),
           contact_email = COALESCE($5, contact_email),
           auto_reply = COALESCE($6, auto_reply),
           updated_at = NOW()
       WHERE id = $7`,
      [tone, alwaysInclude, neverInclude, customInstructions, contactEmail, autoReply, id]
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('Update location settings error:', error.message);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ============================================
// REVIEW ROUTES
// ============================================

// GET /api/reviews?locationId=xxx&status=pending&limit=20
// Get reviews for a location
router.get('/reviews', authenticateToken, async (req, res) => {
  const { locationId, status, limit = 20, offset = 0 } = req.query;

  if (!locationId) {
    return res.status(400).json({ error: 'locationId is required' });
  }

  try {
    // Build query dynamically based on filters
    let sql = `
      SELECT rv.*, rp.generated_reply, rp.posted_reply, rp.status as reply_status, rp.posted_at
      FROM reviews rv
      LEFT JOIN replies rp ON rv.id = rp.review_id
      WHERE rv.location_id = $1
    `;
    const params = [locationId];

    if (status) {
      params.push(status);
      sql += ` AND rv.status = $${params.length}`;
    }

    sql += ` ORDER BY rv.review_date DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(sql, params);
    res.json({ reviews: result.rows });
  } catch (error) {
    logger.error('Get reviews error:', error.message);
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

// ============================================
// DASHBOARD STATS
// ============================================

// GET /api/stats?customerId=xxx
// Get dashboard statistics for a customer
router.get('/stats', authenticateToken, async (req, res) => {
  const { customerId } = req.query;

  if (!customerId) {
    return res.status(400).json({ error: 'customerId is required' });
  }

  try {
    const result = await query(
      `SELECT
         COUNT(rv.id) as total_reviews,
         COUNT(CASE WHEN rv.status = 'replied' THEN 1 END) as total_replied,
         COUNT(CASE WHEN rv.created_at >= NOW() - INTERVAL '30 days' THEN 1 END) as reviews_this_month,
         COUNT(CASE WHEN rv.status = 'replied' AND rv.created_at >= NOW() - INTERVAL '30 days' THEN 1 END) as replied_this_month,
         ROUND(AVG(rv.star_rating)::numeric, 1) as avg_rating,
         ROUND(AVG(CASE WHEN rv.status = 'replied' THEN
           EXTRACT(EPOCH FROM (rp.posted_at - rv.created_at))/3600
         END)::numeric, 1) as avg_response_hours
       FROM customers c
       JOIN locations l ON c.id = l.customer_id
       JOIN reviews rv ON l.id = rv.location_id
       LEFT JOIN replies rp ON rv.id = rp.review_id
       WHERE c.id = $1`,
      [customerId]
    );

    res.json({ stats: result.rows[0] });
  } catch (error) {
    logger.error('Get stats error:', error.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ACCOUNT — business details + notification preferences (Settings → Account)
// ════════════════════════════════════════════════════════════════════════════
router.get('/account', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const r = await query('SELECT name, email, notification_prefs FROM customers WHERE id=$1', [customerId]);
    const row = r.rows[0] || {};
    res.json({
      name: row.name || '',
      email: row.email || '',
      notificationPrefs: row.notification_prefs || { negative: true, all_reviews: false, weekly_digest: true },
    });
  } catch (err) {
    logger.error('GET /account error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.put('/account', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const { name, email, notificationPrefs } = req.body || {};

    if (email !== undefined && !/^[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const sets = [], params = [];
    let i = 1;
    if (name !== undefined)             { sets.push(`name=$${i++}`);               params.push(name); }
    if (email !== undefined)            { sets.push(`email=$${i++}`);              params.push(email.toLowerCase().trim()); }
    if (notificationPrefs !== undefined){ sets.push(`notification_prefs=$${i++}`); params.push(JSON.stringify(notificationPrefs)); }
    if (!sets.length) return res.json({ success: true });

    params.push(customerId);
    await query(`UPDATE customers SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${i}`, params);
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That email is already in use by another account.' });
    logger.error('PUT /account error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PULSE — analytics hub. One call returns real aggregates over the customer's
// reviews / replies / review_requests / survey_responses / campaigns / llm_reports.
// Headline stats respect ?range= (7d/30d/90d/12m); trend charts use natural
// fixed windows (12 months for ratings, 12 weeks for volume, 8 weeks sentiment).
// Everything is defensive: a missing/empty table yields zeros, never a 500.
// ════════════════════════════════════════════════════════════════════════════
router.get('/pulse', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const range = ['7d', '30d', '90d', '12m'].includes(req.query.range) ? req.query.range : '90d';
    const days = ({ '7d': 7, '30d': 30, '90d': 90, '12m': 365 })[range];
    const span = String(days) + ' days';
    const q = (sql, params) => query(sql, params).catch(() => ({ rows: [] }));

    const [ov, plat, rTrend, vTrend, sTrend, reqAgg, reqTrend, npsAgg, sms, camps, llm] = await Promise.all([
      // Review overview + rating distribution + reply timing (within range)
      q(`SELECT COUNT(rv.id) total,
                ROUND(AVG(rv.star_rating)::numeric,1) avg_rating,
                COUNT(*) FILTER (WHERE rv.star_rating>=4) positive,
                COUNT(*) FILTER (WHERE rv.star_rating=3)  neutral,
                COUNT(*) FILTER (WHERE rv.star_rating<=2) negative,
                COUNT(*) FILTER (WHERE rv.star_rating=5) s5,
                COUNT(*) FILTER (WHERE rv.star_rating=4) s4,
                COUNT(*) FILTER (WHERE rv.star_rating=3) s3,
                COUNT(*) FILTER (WHERE rv.star_rating=2) s2,
                COUNT(*) FILTER (WHERE rv.star_rating=1) s1,
                COUNT(*) FILTER (WHERE rv.status='replied') replied,
                ROUND(AVG(CASE WHEN rv.status='replied'
                  THEN EXTRACT(EPOCH FROM (rp.posted_at - rv.created_at))/3600 END)::numeric,1) avg_hours
         FROM locations l JOIN reviews rv ON l.id=rv.location_id
         LEFT JOIN replies rp ON rv.id=rp.review_id
         WHERE l.customer_id=$1 AND rv.created_at >= NOW() - ($2)::interval`, [customerId, span]),
      // By platform
      q(`SELECT rv.platform, ROUND(AVG(rv.star_rating)::numeric,1) avg, COUNT(*) cnt
         FROM locations l JOIN reviews rv ON l.id=rv.location_id
         WHERE l.customer_id=$1 AND rv.created_at >= NOW() - ($2)::interval
         GROUP BY rv.platform ORDER BY cnt DESC`, [customerId, span]),
      // Rating trend — monthly avg, last 12 months
      q(`SELECT date_trunc('month', rv.created_at) m, to_char(date_trunc('month', rv.created_at),'Mon YY') label,
                ROUND(AVG(rv.star_rating)::numeric,2) value
         FROM locations l JOIN reviews rv ON l.id=rv.location_id
         WHERE l.customer_id=$1 AND rv.created_at >= NOW() - INTERVAL '12 months'
         GROUP BY 1,2 ORDER BY 1`, [customerId]),
      // Volume trend — weekly, last 12 weeks
      q(`SELECT date_trunc('week', rv.created_at) w, COUNT(*) cnt
         FROM locations l JOIN reviews rv ON l.id=rv.location_id
         WHERE l.customer_id=$1 AND rv.created_at >= NOW() - INTERVAL '12 weeks'
         GROUP BY 1 ORDER BY 1`, [customerId]),
      // Sentiment trend — weekly positive %, last 8 weeks
      q(`SELECT date_trunc('week', rv.created_at) w,
                ROUND(100.0*COUNT(*) FILTER (WHERE rv.star_rating>=4)/NULLIF(COUNT(*),0)) pos_pct
         FROM locations l JOIN reviews rv ON l.id=rv.location_id
         WHERE l.customer_id=$1 AND rv.created_at >= NOW() - INTERVAL '8 weeks'
         GROUP BY 1 ORDER BY 1`, [customerId]),
      // Review requests (within range)
      q(`SELECT COUNT(*) sent, COUNT(*) FILTER (WHERE status='completed') completed
         FROM review_requests WHERE customer_id=$1 AND created_at >= NOW() - ($2)::interval`, [customerId, span]),
      // Requests weekly trend, 12 weeks
      q(`SELECT date_trunc('week', created_at) w, COUNT(*) cnt
         FROM review_requests WHERE customer_id=$1 AND created_at >= NOW() - INTERVAL '12 weeks'
         GROUP BY 1 ORDER BY 1`, [customerId]),
      // NPS (within range) from survey_responses
      q(`SELECT COUNT(*) total,
                COUNT(*) FILTER (WHERE nps_score>=9) promoters,
                COUNT(*) FILTER (WHERE nps_score BETWEEN 7 AND 8) passives,
                COUNT(*) FILTER (WHERE nps_score<=6) detractors,
                ROUND(AVG(nps_score)::numeric,1) avg
         FROM survey_responses WHERE customer_id=$1 AND completed_at >= NOW() - ($2)::interval`, [customerId, span]),
      // SMS usage
      q(`SELECT sms_sent, sms_limit FROM campaign_usage WHERE customer_id=$1`, [customerId]),
      // Recent campaigns
      q(`SELECT name, status, recipient_count, sent_count, created_at
         FROM campaigns WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 8`, [customerId]),
      // Latest AI-visibility report
      q(`SELECT report_data FROM llm_reports WHERE customer_id=$1 ORDER BY last_scan_at DESC NULLS LAST LIMIT 1`, [customerId]),
    ]);

    const o = ov.rows[0] || {};
    const num = (v) => (v == null ? 0 : Number(v));
    const total = num(o.total);
    const replied = num(o.replied);
    const positive = num(o.positive), neutral = num(o.neutral), negative = num(o.negative);

    const npsRow = npsAgg.rows[0] || {};
    const npsTotal = num(npsRow.total);
    const npsScore = npsTotal ? Math.round(((num(npsRow.promoters) - num(npsRow.detractors)) / npsTotal) * 100) : 0;

    const smsRow = sms.rows[0] || {};
    const report = llm.rows[0]?.report_data || {};
    const competitors = Array.isArray(report.competitors) ? report.competitors
      : (Array.isArray(report.competitor_breakdown) ? report.competitor_breakdown : []);

    res.json({
      range,
      overview: {
        avgRating: num(o.avg_rating),
        totalReviews: total,
        sentimentScore: total ? Math.round((positive / total) * 100) : 0,
        replyRate: total ? Math.round((replied / total) * 100) : 0,
      },
      sentiment: { positive, neutral, negative,
        trend: sTrend.rows.map(r => num(r.pos_pct)) },
      velocity: {
        total,
        trend: vTrend.rows.map(r => num(r.cnt)),
        weeklyAvg: vTrend.rows.length ? +(vTrend.rows.reduce((s, r) => s + num(r.cnt), 0) / vTrend.rows.length).toFixed(1) : 0,
        last4: vTrend.rows.slice(-4).reduce((s, r) => s + num(r.cnt), 0),
        prior4: vTrend.rows.slice(-8, -4).reduce((s, r) => s + num(r.cnt), 0),
      },
      ratings: {
        current: num(o.avg_rating),
        distribution: [5, 4, 3, 2, 1].map(st => ({ stars: st, count: num(o['s' + st]),
          pct: total ? Math.round((num(o['s' + st]) / total) * 100) : 0 })),
        byPlatform: plat.rows.map(p => ({ platform: p.platform || 'Other', avg: num(p.avg), count: num(p.cnt) })),
        trend: rTrend.rows.map(r => ({ label: r.label, value: num(r.value) })),
      },
      requests: (() => {
        const rr = reqAgg.rows[0] || {};
        const sent = num(rr.sent), completed = num(rr.completed);
        return { sent, completed, responseRate: sent ? Math.round((completed / sent) * 100) : 0,
          trend: reqTrend.rows.map(r => num(r.cnt)) };
      })(),
      nps: { score: npsScore, total: npsTotal, promoters: num(npsRow.promoters),
        passives: num(npsRow.passives), detractors: num(npsRow.detractors), avg: num(npsRow.avg) },
      reply: { total, replied, replyRate: total ? Math.round((replied / total) * 100) : 0,
        avgHours: num(o.avg_hours) },
      sms: { sent: num(smsRow.sms_sent), limit: num(smsRow.sms_limit) || 2000,
        campaigns: camps.rows.map(c => ({ name: c.name, status: c.status,
          recipients: num(c.recipient_count), sent: num(c.sent_count) })) },
      aivis: {
        visibilityScore: num(report.overall_score ?? report.visibility ?? report.visibility_score),
        mentions: num(report.total_mentions ?? report.mentions),
        competitors: competitors.slice(0, 5).map(c => ({
          competitor: c.competitor || c.name || 'Competitor', mentions: num(c.mentions) })),
      },
      keywords: [], // honest: needs review-text NLP (not yet available)
    });
  } catch (err) {
    logger.error('GET /pulse error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// STRIPE WEBHOOK
// ============================================

// POST /api/webhooks/stripe
// Handle Stripe subscription events
// IMPORTANT: Use raw body parser for this route (set in server.js)
const stripeWebhookHandler = async (req, res) => {
  const sig = req.headers['stripe-signature'];

  // Debug logging
  logger.info('Webhook received - body type: ' + typeof req.body + ' isBuffer: ' + Buffer.isBuffer(req.body));
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  logger.info('Webhook secret first 8 chars: ' + webhookSecret.substring(0, 8));
  logger.info('Sig header present: ' + !!sig);

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (error) {
    logger.error('Stripe webhook signature failed: ' + error.message);
    logger.error('Body is Buffer: ' + Buffer.isBuffer(req.body) + ' Body length: ' + (req.body ? req.body.length : 0));
    return res.status(400).json({ error: 'Invalid signature' });
  }

  logger.info(`Stripe event received: ${event.type}`);

  try {
    switch (event.type) {

      // New checkout completed — create customer account + send welcome email
      case 'checkout.session.completed': {
        const session = event.data.object;
        const email = session.customer_details?.email || session.customer_email;
        const name  = session.customer_details?.name || '';
        const stripeCustomerId = session.customer;
        const subscriptionId   = session.subscription;

        logger.info(`checkout.session.completed for ${email}`);

        if (!email) {
          logger.error('checkout.session.completed: no email found');
          break;
        }

        try {
          // Check if customer already exists
          const existing = await query(
            'SELECT id, welcome_email_sent FROM customers WHERE email = $1',
            [email]
          );

          let customerId;

          if (existing.rows.length === 0) {
            // Create new customer
            const bcrypt = require('bcryptjs');
            const crypto = require('crypto');
            const tempPassword = crypto.randomBytes(8).toString('hex');
            const hashedPassword = await bcrypt.hash(tempPassword, 12);

            const newCustomer = await query(
              `INSERT INTO customers
                (email, name, password_hash, stripe_customer_id, stripe_subscription_id, plan, status, welcome_email_sent)
               VALUES ($1, $2, $3, $4, $5, 'starter', 'active', false)
               RETURNING id`,
              [email, name, hashedPassword, stripeCustomerId, subscriptionId]
            );

            customerId = newCustomer.rows[0].id;
            logger.info(`New customer created: ${customerId}`);

            // Send welcome email with credentials
            const emailService = require('../services/emailService');
            const welcomeResetTok = await createPasswordReset(email, 168).catch(() => null); // 7-day setup link
            await emailService.sendWelcomeWithCredentials({
              email,
              name,
              plan: 'starter',
              tempPassword,
              resetUrl: welcomeResetTok
                ? 'https://app.swarmreply.com/reset-password?token=' + welcomeResetTok
                : 'https://app.swarmreply.com/forgot-password',
              dashUrl:  'https://app.swarmreply.com/dashboard',
            });

            await query(
              'UPDATE customers SET welcome_email_sent = true WHERE id = $1',
              [customerId]
            );

            logger.info(`Welcome email sent to ${email}`);

          } else {
            // Customer exists — update subscription
            customerId = existing.rows[0].id;
            await query(
              `UPDATE customers SET stripe_customer_id = $1, stripe_subscription_id = $2,
               status = 'active', updated_at = NOW() WHERE id = $3`,
              [stripeCustomerId, subscriptionId, customerId]
            );

            if (!existing.rows[0].welcome_email_sent) {
              const emailService = require('../services/emailService');
              await emailService.sendWelcomeEmail({ email, name }, 'your business');
              await query('UPDATE customers SET welcome_email_sent = true WHERE id = $1', [customerId]);
            }
          }
        } catch (err) {
          logger.error('checkout.session.completed handler error:', err.message);
        }
        break;
      }

      // New subscription created
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.metadata?.customerId;
        const plan = getPlanFromPriceId(subscription.items.data[0]?.price?.id);

        if (customerId) {
          await query(
            `UPDATE customers
             SET plan = $1, status = $2, updated_at = NOW()
             WHERE id = $3`,
            [plan, 'active', customerId]
          );
          logger.info(`Customer ${customerId} plan updated to ${plan}`);
        }
        break;
      }

      // Subscription cancelled
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.metadata?.customerId;

        if (customerId) {
          await query(
            "UPDATE customers SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
            [customerId]
          );

          // Deactivate all their locations
          await query(
            "UPDATE locations SET is_active = false WHERE customer_id = $1",
            [customerId]
          );

          logger.info(`Customer ${customerId} cancelled — locations deactivated`);
        }
        break;
      }

      // Payment failed
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        logger.warn(`Payment failed for customer: ${invoice.customer}`);
        // Could send alert email here
        break;
      }
    }

    res.json({ received: true });
  } catch (error) {
    logger.error(`Stripe webhook handler error for ${event.type}:`, error.message);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
};

router.post('/webhooks/stripe', stripeWebhookHandler);
router.post('/stripe/webhook', stripeWebhookHandler);

/**
 * getPlanFromPriceId()
 * Map Stripe price IDs to plan names
 */
function getPlanFromPriceId(priceId) {
  const planMap = {
    'price_starter_id': 'starter',   // Replace with real Stripe price IDs
    'price_growth_id': 'growth',
    'price_agency_id': 'agency'
  };
  return planMap[priceId] || 'starter';
}

// Integrations (all 6 third-party providers)
const { router: integrationRoutes, handleStripePaymentForReview } = require('./integrations');
router.use('/integrations', integrationRoutes);

// Billing
const billingRoutes = require('./billing');
router.use('/billing', billingRoutes);

// Team management
const teamRoutes = require('./team');
router.use('/team', teamRoutes);


// Approval workflow (Item 12)
const approvalRoutes = require('./approvals');
router.use('/approvals', approvalRoutes);

// Rank tracking (Item 13)
const rankRoutes = require('./rankTracking');
router.use('/rank', rankRoutes);

// Reputation widget (Item 14)
const repWidgetRoutes = require('./reputationWidget');
router.use('/rep-widget', repWidgetRoutes);

// Reports / Pulse analytics (real review-based aggregates)
const reportsRoutes = require('./reports');
router.use('/reports', reportsRoutes);

// ============================================
// CUSTOMER AUTH ROUTES
// ============================================

// POST /api/customers/login
// Team member login — email + password → JWT
router.post('/customers/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const normalizedEmail = email.toLowerCase().trim();
  const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  try {
    const bcrypt = require('bcryptjs');
    const jwt    = require('jsonwebtoken');
    const { v4: uuidv4 } = require('uuid');

    // Brute force check
    const recentFails = await query(
      `SELECT COUNT(*) FROM login_attempts
       WHERE email=$1 AND succeeded=false AND attempted_at > NOW()-INTERVAL '15 minutes'`,
      [normalizedEmail]
    ).catch(() => ({ rows: [{ count: 0 }] }));
    if (parseInt(recentFails.rows[0].count) >= 10) {
      return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
    }

    // Try team_members first (normal login)
    const memberResult = await query(
      `SELECT tm.id, tm.name, tm.email, tm.role, tm.password_hash,
              tm.status, tm.customer_id, c.plan, c.status as customer_status, c.is_demo
       FROM team_members tm
       JOIN customers c ON c.id = tm.customer_id
       WHERE LOWER(tm.email) = $1`,
      [normalizedEmail]
    );

    // If no team member, try direct customer login (demo accounts use customers table)
    let member = memberResult.rows[0];
    let isDirect = false;
    if (!member) {
      const custResult = await query(
        `SELECT id, name, email, plan, status, password_hash, is_demo
         FROM customers WHERE LOWER(email) = $1`,
        [normalizedEmail]
      );
      if (custResult.rows[0]) {
        const c = custResult.rows[0];
        member = {
          id: c.id, name: c.name, email: c.email,
          role: 'owner', password_hash: c.password_hash,
          status: 'active', customer_id: c.id,
          plan: c.plan, customer_status: c.status, is_demo: c.is_demo
        };
        isDirect = true;
      }
    }

    const dummyHash = '$2a$12$dummy.hash.to.prevent.timing.attacks.xxxxxxxxxx';
    const hashToCheck = member?.password_hash || dummyHash;
    const passwordValid = await bcrypt.compare(password, hashToCheck);

    await query(
      `INSERT INTO login_attempts (email, ip_address, succeeded) VALUES ($1,$2,$3)`,
      [normalizedEmail, ip, !!(member && passwordValid)]
    ).catch(() => {});

    if (!member || !passwordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (member.status === 'suspended') {
      return res.status(403).json({ error: 'Account suspended. Contact support.' });
    }
    if (member.customer_status === 'cancelled') {
      return res.status(403).json({ error: 'This account is no longer active.' });
    }

    // Update last login
    if (isDirect) {
      await query('UPDATE customers SET updated_at=NOW() WHERE id=$1', [member.id]).catch(()=>{});
    } else {
      await query('UPDATE team_members SET last_login_at=NOW() WHERE id=$1', [member.id]).catch(()=>{});
    }

    const accessToken = jwt.sign(
      { jti: uuidv4(), memberId: member.id, customerId: member.customer_id,
        email: member.email, name: member.name, role: member.role,
        plan: member.plan, is_demo: member.is_demo || false },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    logger.info(`Login: ${normalizedEmail} (${member.role}${member.is_demo ? ' demo' : ''})`);
    res.json({
      success: true, accessToken,
      member: { id: member.id, name: member.name, email: member.email,
                role: member.role, customerId: member.customer_id,
                plan: member.plan, is_demo: member.is_demo || false }
    });
  } catch (err) {
    logger.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// POST /api/customers/logout
router.post('/customers/logout', async (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (token) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.decode(token);
      if (decoded?.jti) {
        await query(
          `INSERT INTO revoked_tokens (jti, reason, expires_at)
           VALUES ($1,'logout',TO_TIMESTAMP($2)) ON CONFLICT (jti) DO NOTHING`,
          [decoded.jti, decoded.exp]
        ).catch(()=>{});
      }
    } catch(e) {}
  }
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════════
// PASSWORD RESET — forgot / verify / reset
// The frontend (forgot-password.js, reset-password.js) and the Stripe welcome
// email all reference these; none existed before, so reset was fully broken.
// Tokens are random; only their SHA-256 hash is stored (password_resets table).
// ════════════════════════════════════════════════════════════════════════════

// Create a reset token for an email, store its hash, return the raw token.
async function createPasswordReset(email, hours = 1) {
  const crypto = require('crypto');
  const raw  = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await query(
    `INSERT INTO password_resets (email, token_hash, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' hours')::interval)`,
    [email.toLowerCase().trim(), hash, String(hours)]
  );
  return raw;
}

// POST /api/auth/forgot-password  { email }
// Always returns success (no account enumeration).
router.post('/auth/forgot-password', async (req, res) => {
  try {
    const email = (req.body.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Email is required' });

    // Account-INDEPENDENT infra check: confirm the password_resets table exists.
    // Runs for every request regardless of whether the account exists, so a
    // failure here can't be used to enumerate accounts. If the migration wasn't
    // run, this throws → outer catch → 500 (a clear signal, not a silent success).
    await query('SELECT 1 FROM password_resets LIMIT 1');

    // Only send if the email belongs to a real account (customer or team member).
    const acct = await query(
      `SELECT name FROM customers WHERE LOWER(email)=$1
       UNION SELECT name FROM team_members WHERE LOWER(email)=$1 LIMIT 1`,
      [email]
    );

    if (acct.rows.length) {
      const raw = await createPasswordReset(email, 1);
      const resetUrl = 'https://app.swarmreply.com/reset-password?token=' + raw;
      const emailService = require('../services/emailService');
      const result = await emailService.sendPasswordReset({ email, name: acct.rows[0].name, resetUrl });
      if (!result || result.sent === false) {
        // Email provider failed (e.g. RESEND_API_KEY/EMAIL_FROM not set, domain
        // unverified). Surface as a server error so the user can retry rather
        // than being told to check an inbox that will never receive anything.
        logger.error('forgot-password: email send FAILED for ' + email + ' — ' + (result && result.error));
        return res.status(500).json({ error: 'Could not send the reset email. Please try again shortly.' });
      }
      logger.info('forgot-password: reset email sent to ' + email);
    } else {
      logger.info('forgot-password: no account found for ' + email + ' (no email sent)');
    }
    res.json({ success: true });
  } catch (err) {
    logger.error('forgot-password error: ' + err.message);
    res.status(500).json({ error: 'Could not process the request. Please try again.' });
  }
});

// GET /api/auth/reset-password/verify?token=  → { valid: bool }
// Lets the reset page pre-check the link without consuming the token.
router.get('/auth/reset-password/verify', async (req, res) => {
  try {
    const token = req.query.token || '';
    if (!token) return res.json({ valid: false });
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const r = await query(
      `SELECT id FROM password_resets
       WHERE token_hash=$1 AND used_at IS NULL AND expires_at > NOW() LIMIT 1`,
      [hash]
    );
    res.json({ valid: r.rows.length > 0 });
  } catch (err) {
    res.json({ valid: false });
  }
});

// POST /api/auth/reset-password  { token, password }
router.post('/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });
    if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const r = await query(
      `SELECT id, email FROM password_resets
       WHERE token_hash=$1 AND used_at IS NULL AND expires_at > NOW() LIMIT 1`,
      [hash]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });

    const { id: resetId, email } = r.rows[0];
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash(password, 12);

    // Update whichever account(s) hold this email.
    await query('UPDATE customers SET password_hash=$1, updated_at=NOW() WHERE LOWER(email)=$2', [passwordHash, email]).catch(() => {});
    await query('UPDATE team_members SET password_hash=$1 WHERE LOWER(email)=$2', [passwordHash, email]).catch(() => {});

    // Single-use
    await query('UPDATE password_resets SET used_at=NOW() WHERE id=$1', [resetId]);

    logger.info('Password reset completed for ' + email);
    res.json({ success: true });
  } catch (err) {
    logger.error('reset-password error:', err.message);
    res.status(500).json({ error: 'Could not reset password. Please try again.' });
  }
});


// Returns whether the customer has completed onboarding
// (has at least one connected location)
router.get('/onboarding/status', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;

    const result = await query(
      `SELECT
         COUNT(id) as total_locations,
         COUNT(CASE WHEN is_active = true THEN 1 END) as active_locations,
         COUNT(CASE WHEN platform IS NOT NULL AND platform != '' THEN 1 END) as connected_locations,
         COUNT(CASE WHEN tone IS NOT NULL AND tone != '' THEN 1 END) as tone_set,
         COUNT(CASE WHEN google_review_url IS NOT NULL AND google_review_url != '' THEN 1 END) as has_review_url
       FROM locations
       WHERE customer_id = $1`,
      [customerId]
    );
    const row = result.rows[0];

    // Real per-step signals (Option A — driven off actual data, no phantom columns)
    const step1_business   = parseInt(row.total_locations) > 0;
    const step2_google     = parseInt(row.connected_locations) > 0;
    const step3_tone       = parseInt(row.tone_set) > 0;

    const reqResult = await query(
      'SELECT COUNT(id) as c FROM review_requests WHERE customer_id=$1', [customerId]
    ).catch(() => ({ rows: [{ c: 0 }] }));
    const step4_request    = parseInt(reqResult.rows[0].c) > 0;

    const tmplResult = await query(
      'SELECT customer_id FROM review_templates WHERE customer_id=$1', [customerId]
    ).catch(() => ({ rows: [] }));
    const step5_survey     = tmplResult.rows.length > 0 || parseInt(row.has_review_url) > 0;

    const STEP_LABELS = [
      'Add your business',
      'Connect Google Business Profile',
      'Set your AI tone',
      'Send your first review request',
      'Set up your NPS survey',
    ];
    const stepFlags = [step1_business, step2_google, step3_tone, step4_request, step5_survey];
    const completedCount = stepFlags.filter(Boolean).length;
    // currentStep = first incomplete step (1-indexed), or 5 if all done
    const firstIncomplete = stepFlags.findIndex(s => !s);
    const currentStep = firstIncomplete === -1 ? 5 : firstIncomplete + 1;
    // Return steps as an ARRAY (the shape the onboarding wizard expects:
    // status.steps.find(st => st.step === n)?.completed).
    const steps = stepFlags.map((done, i) => ({
      step:      i + 1,
      completed: !!done,
      label:     STEP_LABELS[i],
    }));

    res.json({
      onboarding: {
        completed:        completedCount >= 5,
        completedCount,
        currentStep,
        steps,
        flags: {
          business_created:   step1_business,
          google_connected:   step2_google,
          tone_configured:    step3_tone,
          review_request_sent:step4_request,
          survey_configured:  step5_survey,
        },
        hasLocation:      step1_business,
        hasConnected:     step2_google,
        totalLocations:   parseInt(row.total_locations),
        activeLocations:  parseInt(row.active_locations),
      }
    });
  } catch (err) {
    logger.error('Onboarding status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── TEMPLATE TEST SEND ────────────────────────────────────────────────────────
// POST /api/templates/test-send
// Sends a real test email or SMS to the address/phone provided
router.post('/templates/test-send', authenticateToken, async (req, res) => {
  try {
    const { destination, template, thresholds, platforms } = req.body;
    const customerId = req.user.customerId || req.user.id;

    // Get customer business name for variable substitution
    const custResult = await query('SELECT name FROM customers WHERE id=$1', [customerId]);
    const businessName = custResult.rows[0]?.name || 'Your Business';

    const isPhone  = /^[+\d\s\-()]{7,}$/.test(destination) && !destination.includes('@');
    const testLink = 'https://app.swarmreply.com/review/preview';

    function fillVars(text) {
      return (text || '')
        .replace(/{name}/g,     'Test Customer')
        .replace(/{business}/g, businessName)
        .replace(/{link}/g,     testLink);
    }

    if (isPhone) {
      // SMS via Twilio
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken  = process.env.TWILIO_AUTH_TOKEN;
      const fromNumber = process.env.TWILIO_FROM_NUMBER;

      if (!accountSid || !authToken || !fromNumber) {
        return res.status(503).json({ error: 'SMS not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER to Railway env vars.' });
      }

      const twilio = require('twilio')(accountSid, authToken);
      await twilio.messages.create({
        body: fillVars(template.smsRequest),
        from: fromNumber,
        to:   destination,
      });

      logger.info('Test SMS sent to ' + destination);
      res.json({ success: true, channel: 'sms', destination });

    } else {
      // Email via Resend
      if (!process.env.RESEND_TRANSACTIONAL_KEY && !process.env.RESEND_API_KEY) {
        return res.status(503).json({ error: 'Email not configured. Add RESEND_TRANSACTIONAL_KEY to Railway env vars.' });
      }

      const resend = new Resend(process.env.RESEND_TRANSACTIONAL_KEY || process.env.RESEND_API_KEY);
      const body = fillVars(template.emailBody);
      const htmlBody = body.replace(/\n/g, '<br>');

      const brandColor = template.brandColor || '#f5c842';
      const brandLogo  = template.brandLogo  || 'https://swarmreply.com/bee-logo.png';
      const buttonText = template.buttonText || 'Share Your Feedback →';
      const buttonLink = testLink;

      const emailHtml = [
        '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
        '<body style="margin:0;padding:0;background:#f4f4f0;font-family:Arial,sans-serif">',
        '<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 16px">',
        '<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">',

        // Banner
        '<tr><td style="background:' + brandColor + ';padding:20px 32px;border-radius:12px 12px 0 0">',
        brandLogo
          ? '<img src="' + brandLogo + '" alt="' + businessName + '" style="max-height:52px;max-width:180px;object-fit:contain">'
          : '<span style="font-weight:800;font-size:1.15rem;color:#0a0a0a">' + businessName + '</span>',
        '</td></tr>',

        // Body
        '<tr><td style="background:#ffffff;padding:36px 32px">',
        '<h2 style="margin:0 0 16px;font-size:1.25rem;color:#0a0a0a">' + fillVars(template.emailSubject) + '</h2>',
        '<div style="font-size:.9rem;line-height:1.75;color:#3a3a38;white-space:pre-wrap;margin-bottom:28px">' + fillVars(body).split(testLink)[0] + '</div>',
        '<div style="text-align:center;margin-bottom:28px">',
        '<a href="' + buttonLink + '" style="display:inline-block;background:' + brandColor + ';color:#0a0a0a;text-decoration:none;padding:14px 32px;border-radius:50px;font-weight:700;font-size:.95rem">' + buttonText + '</a>',
        '</div>',
        ''  /* removed copy link */,
        '</td></tr>',

        // Footer
        '<tr><td style="background:' + brandColor + ';padding:14px 32px;border-radius:0 0 12px 12px;text-align:center">',
        '<span style="font-size:.72rem;color:#0a0a0a;opacity:.65">Sent by SwarmReply on behalf of ' + businessName + ' · <a href="#" style="color:#0a0a0a;opacity:.65">Unsubscribe</a></span>',
        '</td></tr>',

        '</table></td></tr></table></body></html>'
      ].join('');

      const { data: sendData, error: sendError } = await resend.emails.send({
        from:    process.env.SMTP_FROM || 'SwarmReply <hello@swarmreply.com>',
        to:      [destination],
        subject: '[TEST] ' + fillVars(template.emailSubject),
        text:    body,
        html:    emailHtml,
      });

      if (sendError) {
        logger.error('Resend error:', JSON.stringify(sendError));
        throw new Error(sendError.message || JSON.stringify(sendError));
      }
      if (!sendData?.id) {
        throw new Error('Email was not accepted by Resend. Make sure swarmreply.com is verified at resend.com/domains');
      }
      logger.info('Resend accepted email id: ' + sendData.id);

      logger.info('Test email sent to ' + destination);
      res.json({ success: true, channel: 'email', destination });
    }
  } catch (err) {
    logger.error('Test send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SURVEY RESULTS ────────────────────────────────────────────────────────────
// GET /api/surveys — returns all completed surveys for the customer
router.get('/surveys', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const { search, dateRange } = req.query;

    let whereClause = "WHERE rr.customer_id = $1 AND rr.status IN ('completed','sent','queued')";
    const params = [customerId];

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      whereClause += ` AND (LOWER(rr.contact_name) LIKE $${params.length} OR LOWER(rr.contact_email) LIKE $${params.length})`;
    }

    if (dateRange === 'today') {
      whereClause += ` AND rr.created_at >= NOW() - INTERVAL '1 day'`;
    } else if (dateRange === 'week') {
      whereClause += ` AND rr.created_at >= NOW() - INTERVAL '7 days'`;
    } else if (dateRange === 'month') {
      whereClause += ` AND rr.created_at >= NOW() - INTERVAL '30 days'`;
    }

    const result = await query(
      `SELECT
         rr.id,
         rr.contact_name    AS customer_name,
         rr.contact_email   AS customer_email,
         rr.status,
         rr.created_at      AS completed_at,
         sr.nps_score,
         sr.path,
         sr.left_review,
         sr.would_return,
         sr.detractor_q1,
         sr.detractor_q2
       FROM review_requests rr
       LEFT JOIN survey_responses sr ON sr.review_request_id = rr.id
       ${whereClause}
       ORDER BY rr.created_at DESC
       LIMIT 200`,
      params
    );

    res.json({ surveys: result.rows });
  } catch (err) {
    logger.error('Surveys GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SOCIAL MEDIA — OAuth Connect + Post Routes
// Env vars needed:
//   META_APP_ID, META_APP_SECRET
//   LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET
//   TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET
//   Google uses existing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
// ══════════════════════════════════════════════════════════════════════════════

const SOCIAL_REDIRECT = (process.env.APP_URL || 'https://swarmreply-backend-production.up.railway.app') + '/api/social/callback';
const FRONTEND_URL    = process.env.FRONTEND_URL || 'https://app.swarmreply.com';

// ── OAUTH START ───────────────────────────────────────────────────────────────
// GET /api/social/connect/:platform
// Redirects user to the platform's OAuth consent screen
router.get('/social/connect/:platform', authenticateToken, (req, res) => {
  const { platform } = req.params;
  const customerId   = req.user.customerId || req.user.id;
  const state        = Buffer.from(JSON.stringify({ customerId, platform, ts: Date.now() })).toString('base64');

  const urls = {
    meta: () => {
      const params = new URLSearchParams({
        client_id:     process.env.META_APP_ID,
        redirect_uri:  SOCIAL_REDIRECT + '/meta',
        scope:         'pages_manage_posts,instagram_content_publish,pages_read_engagement,business_management',
        state,
        response_type: 'code',
      });
      return 'https://www.facebook.com/v19.0/dialog/oauth?' + params;
    },
    linkedin: () => {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id:     process.env.LINKEDIN_CLIENT_ID,
        redirect_uri:  SOCIAL_REDIRECT + '/linkedin',
        state,
        scope:         'w_member_social,r_organization_social,w_organization_social,r_basicprofile',
      });
      return 'https://www.linkedin.com/oauth/v2/authorization?' + params;
    },
    google_posts: () => {
      const params = new URLSearchParams({
        client_id:     process.env.GOOGLE_CLIENT_ID,
        redirect_uri:  SOCIAL_REDIRECT + '/google_posts',
        response_type: 'code',
        scope:         'https://www.googleapis.com/auth/business.manage',
        access_type:   'offline',
        state,
      });
      return 'https://accounts.google.com/o/oauth2/auth?' + params;
    },
    tiktok: () => {
      const params = new URLSearchParams({
        client_key:    process.env.TIKTOK_CLIENT_KEY,
        redirect_uri:  SOCIAL_REDIRECT + '/tiktok',
        scope:         'video.upload,video.publish',
        response_type: 'code',
        state,
      });
      return 'https://www.tiktok.com/v2/auth/authorize?' + params;
    },
  };

  const urlFn = urls[platform];
  if (!urlFn) return res.status(400).json({ error: 'Unknown platform: ' + platform });

  try {
    res.redirect(urlFn());
  } catch (err) {
    logger.error('Social connect error:', err.message);
    res.redirect(FRONTEND_URL + '/dashboard/settings?error=social_connect_failed');
  }
});

// ── OAUTH CALLBACK ────────────────────────────────────────────────────────────
// GET /api/social/callback/:platform
router.get('/social/callback/:platform', async (req, res) => {
  const { platform } = req.params;
  const { code, state, error } = req.query;

  if (error) {
    logger.warn('Social OAuth denied:', platform, error);
    return res.redirect(FRONTEND_URL + '/dashboard/settings?error=social_denied&platform=' + platform);
  }

  try {
    const { customerId } = JSON.parse(Buffer.from(state, 'base64').toString());
    let accessToken, refreshToken, accountData = {};

    if (platform === 'meta') {
      const tokenRes = await fetch('https://graph.facebook.com/v19.0/oauth/access_token?' + new URLSearchParams({
        client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET,
        redirect_uri: SOCIAL_REDIRECT + '/meta', code,
      }));
      const tokens = await tokenRes.json();
      accessToken = tokens.access_token;

      // Get pages + Instagram accounts
      const pagesRes = await fetch('https://graph.facebook.com/v19.0/me/accounts?access_token=' + accessToken);
      const pages = await pagesRes.json();
      accountData = { pages: pages.data || [] };
    }

    else if (platform === 'linkedin') {
      const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code,
          redirect_uri: SOCIAL_REDIRECT + '/linkedin',
          client_id: process.env.LINKEDIN_CLIENT_ID, client_secret: process.env.LINKEDIN_CLIENT_SECRET,
        }),
      });
      const tokens = await tokenRes.json();
      accessToken = tokens.access_token;
      refreshToken = tokens.refresh_token;
    }

    else if (platform === 'google_posts') {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code,
          redirect_uri: SOCIAL_REDIRECT + '/google_posts',
          client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
        }),
      });
      const tokens = await tokenRes.json();
      accessToken = tokens.access_token;
      refreshToken = tokens.refresh_token;
    }

    else if (platform === 'tiktok') {
      const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_key: process.env.TIKTOK_CLIENT_KEY, client_secret: process.env.TIKTOK_CLIENT_SECRET,
          code, grant_type: 'authorization_code',
          redirect_uri: SOCIAL_REDIRECT + '/tiktok',
        }),
      });
      const tokens = await tokenRes.json();
      accessToken = tokens.data?.access_token;
      refreshToken = tokens.data?.refresh_token;
    }

    if (!accessToken) throw new Error('No access token received from ' + platform);

    // If the token save fails, the connection didn't actually persist — surface
    // an error instead of redirecting with ?connected (which would lie to the user).
    try {
      await query(
        `INSERT INTO social_connections (customer_id, platform, access_token, refresh_token, account_data, status)
         VALUES ($1,$2,$3,$4,$5,'connected')
         ON CONFLICT (customer_id, platform)
         DO UPDATE SET access_token=$3, refresh_token=$4, account_data=$5, status='connected', updated_at=NOW()`,
        [customerId, platform, accessToken, refreshToken || null, JSON.stringify(accountData)]
      );
    } catch (e) {
      logger.error('social_connections save error:', e.message);
      return res.redirect(FRONTEND_URL + '/dashboard/settings?error=social_save_failed&platform=' + platform);
    }

    logger.info('Social connected:', platform, 'for', customerId);
    res.redirect(FRONTEND_URL + '/dashboard/settings?connected=' + platform);

  } catch (err) {
    logger.error('Social callback error:', platform, err.message);
    res.redirect(FRONTEND_URL + '/dashboard/settings?error=social_callback_failed&platform=' + platform);
  }
});

// ── LIST CONNECTIONS ──────────────────────────────────────────────────────────
// GET /api/social/connections — which platforms this customer has connected.
// Backs the IntegrationsTab connected-state badges in settings.
router.get('/social/connections', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const result = await query(
      "SELECT platform, status, updated_at FROM social_connections WHERE customer_id=$1 AND status='connected'",
      [customerId]
    );
    const platforms = result.rows.map(r => r.platform);
    res.json({ success: true, platforms, connections: result.rows });
  } catch (err) {
    logger.error('Social connections list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DISCONNECT ────────────────────────────────────────────────────────────────
// POST /api/social/disconnect/:platform — actually revoke in the DB so the
// token can no longer be used by /social/post. (UI button was cosmetic before.)
router.post('/social/disconnect/:platform', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const { platform } = req.params;
    await query(
      "UPDATE social_connections SET status='disconnected', access_token=NULL, refresh_token=NULL, updated_at=NOW() WHERE customer_id=$1 AND platform=$2",
      [customerId, platform]
    );
    logger.info('Social disconnected:', platform, 'for', customerId);
    res.json({ success: true });
  } catch (err) {
    logger.error('Social disconnect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST TO SOCIAL ────────────────────────────────────────────────────────────
// POST /api/social/post
router.post('/social/post', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const { platforms, contentType, text, link, scheduleAt } = req.body;

    // Load connections
    const conns = await query(
      "SELECT platform, access_token, account_data FROM social_connections WHERE customer_id=$1 AND status='connected'",
      [customerId]
    ).catch(() => ({ rows: [] }));

    const connMap = {};
    conns.rows.forEach(r => { connMap[r.platform] = r; });

    const results = {};

    for (const platform of platforms) {
      try {
        const conn = connMap[platform === 'facebook' || platform === 'instagram' ? 'meta' : platform];
        if (!conn) { results[platform] = { status: 'error', error: 'Not connected' }; continue; }

        if (platform === 'facebook') {
          const pages = conn.account_data?.pages || [];
          if (!pages[0]) { results[platform] = { status: 'error', error: 'No Facebook Page found' }; continue; }
          const page = pages[0];
          const postRes = await fetch(`https://graph.facebook.com/v19.0/${page.id}/feed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text, link: link || undefined, access_token: page.access_token }),
          });
          const postData = await postRes.json();
          results[platform] = postData.id ? { status: 'live', post_id: postData.id } : { status: 'error', error: postData.error?.message };
        }

        else if (platform === 'linkedin') {
          const authorRes = await fetch('https://api.linkedin.com/v2/me', { headers: { Authorization: 'Bearer ' + conn.access_token } });
          const author = await authorRes.json();
          const urn = 'urn:li:person:' + author.id;
          const body = { author: urn, lifecycleState: 'PUBLISHED', specificContent: { 'com.linkedin.ugc.ShareContent': { shareCommentary: { text }, shareMediaCategory: 'NONE' } }, visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' } };
          const postRes = await fetch('https://api.linkedin.com/v2/ugcPosts', { method: 'POST', headers: { Authorization: 'Bearer ' + conn.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const postData = await postRes.json();
          results[platform] = postData.id ? { status: 'live', post_id: postData.id } : { status: 'error', error: JSON.stringify(postData) };
        }

        else if (platform === 'tiktok') {
          // TikTok posts go to drafts - acknowledge receipt
          results[platform] = { status: 'pending_approval', message: 'Video sent to TikTok drafts. Open TikTok app to publish.' };
        }

        else if (platform === 'google') {
          // Google Posts via Business Profile API
          results[platform] = { status: 'queued', message: 'Google Post queued' };
        }

      } catch (e) {
        results[platform] = { status: 'error', error: e.message };
      }
    }

    // Save post record
    await query(
      `INSERT INTO social_posts (customer_id, platforms, content_type, text_content, link_url, schedule_at, platform_results, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [customerId, JSON.stringify(platforms), contentType, text, link || null, scheduleAt || null, JSON.stringify(results),
       Object.values(results).every(r => r.status === 'live') ? 'live' : 'partial']
    ).catch(e => logger.warn('social_posts save error:', e.message));

    res.json({ success: true, results });
  } catch (err) {
    logger.error('Social post error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET POST HISTORY ──────────────────────────────────────────────────────────
// GET /api/social/posts
router.get('/social/posts', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const result = await query(
      'SELECT * FROM social_posts WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 50',
      [customerId]
    ).catch(() => ({ rows: [] }));
    res.json({ posts: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SEND REVIEW REQUEST ───────────────────────────────────────────────────────
// POST /api/review-requests/send
// Sends a live review request email (and optionally SMS) to a customer
router.post('/review-requests/send', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const { name, email, phone } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Get business info + template settings
    const custResult = await query('SELECT name FROM customers WHERE id=$1', [customerId]);
    const businessName = custResult.rows[0]?.name || 'Your Business';

    // Load the customer's saved template for branding + verbiage
    const tmplRes = await query(
      'SELECT config FROM review_templates WHERE customer_id=$1', [customerId]
    ).catch(() => ({ rows: [] }));
    const tmpl = { ...TEMPLATE_DEFAULTS, ...(tmplRes.rows[0]?.config || {}) };

    // Get location for review link + create the review request record
    const locResult = await query(
      'SELECT id FROM locations WHERE customer_id=$1 LIMIT 1', [customerId]
    ).catch(() => ({ rows: [] }));
    const locationId = locResult.rows[0]?.id;

    // Generate a token for the review page
    const token = require('crypto').randomBytes(16).toString('hex');

    try {
      await query(
        `INSERT INTO review_requests (customer_id, location_id, contact_name, contact_email, contact_phone, trigger_source, trigger_ref, status)
         VALUES ($1,$2,$3,$4,$5,'manual',$6,'sent')`,
        [customerId, locationId || null, name || null, email.trim(), phone || null, token]
      );
    } catch (e) {
      logger.error('review_requests insert failed:', e.message);
      return res.status(500).json({ error: 'Could not create review request: ' + e.message });
    }

    const reviewLink = 'https://app.swarmreply.com/review/' + token;
    const brandColor = tmpl.brandColor || '#f5c842';
    const brandLogo  = tmpl.brandLogo  || 'https://swarmreply.com/bee-logo.png';
    const buttonText = tmpl.buttonText || 'Share Your Feedback →';
    const firstName  = (name || '').trim().split(' ')[0] || 'there';

    const bodyText = 'Hi ' + firstName + ',\n\nThank you for choosing ' + businessName + '! We would love to hear how we did. It only takes a moment.';

    const emailHtml = [
      '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
      '<body style="margin:0;padding:0;background:#f4f4f0;font-family:Arial,sans-serif">',
      '<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 16px">',
      '<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">',
      '<tr><td style="background:' + brandColor + ';padding:20px 32px;border-radius:12px 12px 0 0">',
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
      return res.status(503).json({ error: 'Email not configured. Add RESEND_TRANSACTIONAL_KEY to Railway.' });
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
      logger.error('Review request send error:', JSON.stringify(sendError));
      return res.status(502).json({ error: sendError.message || 'Email provider rejected the send' });
    }
    if (!sendData?.id) {
      return res.status(502).json({ error: 'Email was not accepted. Verify swarmreply.com at resend.com/domains' });
    }

    logger.info('Review request sent to ' + email + ' (id ' + sendData.id + ')');
    res.json({ success: true, id: sendData.id, reviewLink });
  } catch (err) {
    logger.error('review-requests/send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});



// ── REVIEW PLATFORM URLs (for promoter links) ─────────────────────────────────
// GET /api/locations/review-urls — list locations with their review URLs
router.get('/locations/review-urls', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const result = await query(
      `SELECT id, business_name, google_review_url, facebook_review_url, yelp_review_url
       FROM locations WHERE customer_id=$1 ORDER BY created_at ASC`,
      [customerId]
    ).catch(() => ({ rows: [] }));
    res.json({ locations: result.rows });
  } catch (err) {
    logger.error('GET review-urls error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/locations/:id/review-urls — save review URLs for one location
router.put('/locations/:id/review-urls', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const { id } = req.params;
    const { googleReviewUrl, facebookReviewUrl, yelpReviewUrl } = req.body;

    const result = await query(
      `UPDATE locations
       SET google_review_url   = $1,
           facebook_review_url = $2,
           yelp_review_url     = $3,
           updated_at = NOW()
       WHERE id = $4 AND customer_id = $5
       RETURNING id`,
      [googleReviewUrl || null, facebookReviewUrl || null, yelpReviewUrl || null, id, customerId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Location not found' });
    res.json({ success: true });
  } catch (err) {
    logger.error('PUT review-urls error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── REVIEW TEMPLATE: GET + SAVE ───────────────────────────────────────────────
const TEMPLATE_DEFAULTS = {
  brandColor: '#f5c842',
  brandLogo: 'https://swarmreply.com/bee-logo.png',
  buttonText: 'Share Your Feedback \u2192',
  promoterMin: 9,
  neutralMin: 7,
  smsRequest: "Hi {name}, thanks for choosing {business}! We'd love your feedback - it only takes 30 seconds. {link}",
  emailSubject: 'How did we do, {name}?',
  emailBody: "Hi {name},\n\nThank you for choosing {business}! We would love to hear how we did. It only takes a moment.",
  npsQuestion: 'How likely are you to recommend {business} to a friend or family member?',
  promoterMessage: "We're so glad you had a great experience! Would you mind sharing it online?",
  neutralQuestion: 'Would you consider using {business} again in the future?',
  detractorOpening: "We're sorry your experience didn't meet expectations. Your feedback helps us improve.",
  detractorQ1: 'What aspect of your experience fell short?',
  detractorQ2: 'What could we do better in the future?',
  detractorClosing: 'Thank you for sharing this with us. We take every piece of feedback seriously.',
  platforms: ['google'],
};

// GET /api/templates — load the customer's saved review template
router.get('/templates', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const result = await query(
      'SELECT config FROM review_templates WHERE customer_id=$1', [customerId]
    ).catch(() => ({ rows: [] }));
    const config = result.rows[0]?.config || {};
    res.json({ template: { ...TEMPLATE_DEFAULTS, ...config } });
  } catch (err) {
    logger.error('GET /templates error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/templates — save the customer's review template
router.put('/templates', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const config = req.body.template || req.body.config || req.body;
    await query(
      `INSERT INTO review_templates (customer_id, config, updated_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (customer_id) DO UPDATE SET config=$2, updated_at=NOW()`,
      [customerId, JSON.stringify(config)]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error('PUT /templates error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUBLIC REVIEW PAGE (no auth — customer-facing) ────────────────────────────
// GET /api/review/:token — load survey config + business branding for the page
router.get('/review/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const rr = await query(
      `SELECT rr.id, rr.contact_name, rr.customer_id, rr.location_id, c.name AS business_name
       FROM review_requests rr
       JOIN customers c ON c.id = rr.customer_id
       WHERE rr.trigger_ref = $1
       LIMIT 1`,
      [token]
    ).catch(() => ({ rows: [] }));

    if (!rr.rows.length) return res.status(404).json({ error: 'Review request not found' });
    const row = rr.rows[0];

    const tmplRes = await query(
      'SELECT config FROM review_templates WHERE customer_id=$1', [row.customer_id]
    ).catch(() => ({ rows: [] }));
    const tmpl = { ...TEMPLATE_DEFAULTS, ...(tmplRes.rows[0]?.config || {}) };

    const locRes = await query(
      'SELECT google_review_url, facebook_review_url, yelp_review_url FROM locations WHERE id=$1',
      [row.location_id]
    ).catch(() => ({ rows: [] }));
    const loc = locRes.rows[0] || {};

    const PLATFORM_META = {
      google:   { id:'google',   name:'Google',   color:'#4285F4', icon:'G', url: loc.google_review_url },
      facebook: { id:'facebook', name:'Facebook', color:'#1877F2', icon:'f', url: loc.facebook_review_url },
      yelp:     { id:'yelp',     name:'Yelp',     color:'#D32323', icon:'Y', url: loc.yelp_review_url },
    };
    const platforms = (tmpl.platforms || ['google'])
      .map(pid => PLATFORM_META[pid])
      .filter(p => p && p.url);

    res.json({
      businessName:    row.business_name,
      contactName:     row.contact_name,
      brandColor:      tmpl.brandColor,
      brandLogo:       tmpl.brandLogo,
      promoterMin:     tmpl.promoterMin,
      neutralMin:      tmpl.neutralMin,
      npsQuestion:     tmpl.npsQuestion,
      promoterMessage: tmpl.promoterMessage,
      neutralQuestion: tmpl.neutralQuestion,
      detractorOpening:tmpl.detractorOpening,
      detractorQ1:     tmpl.detractorQ1,
      detractorQ2:     tmpl.detractorQ2,
      platforms:       platforms.length ? platforms : [PLATFORM_META.google],
    });
  } catch (err) {
    logger.error('GET /review/:token error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/review/:token/submit — save the customer's survey response
router.post('/review/:token/submit', async (req, res) => {
  try {
    const { token } = req.params;
    const { npsScore, path, wouldReturn, leftReview, platform, detractorQ1, detractorQ2 } = req.body;

    const rr = await query(
      'SELECT id, customer_id, location_id FROM review_requests WHERE trigger_ref=$1 LIMIT 1',
      [token]
    ).catch(() => ({ rows: [] }));

    if (!rr.rows.length) return res.status(404).json({ error: 'Review request not found' });
    const { id: reviewRequestId, customer_id, location_id } = rr.rows[0];

    await query(
      `INSERT INTO survey_responses
         (review_request_id, customer_id, location_id, nps_score, path, would_return, left_review, review_platform, detractor_q1, detractor_q2, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
      [reviewRequestId, customer_id, location_id || null, npsScore, path,
       wouldReturn ?? null, leftReview || false, platform || null, detractorQ1 || null, detractorQ2 || null]
    );

    // Mark the request completed
    await query(
      "UPDATE review_requests SET status='completed' WHERE id=$1", [reviewRequestId]
    ).catch(() => {});

    logger.info('Survey response saved for request ' + reviewRequestId + ' (score ' + npsScore + ', ' + path + ')');
    res.json({ success: true });
  } catch (err) {
    logger.error('POST /review/:token/submit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});



// ════════════════════════════════════════════════════════════════════════════
// SURVEY (NPS) DASHBOARD — live routes over the REAL tables (review_requests /
// survey_responses / review_templates). The legacy surveys.js / nps.js routers
// were unmounted dead code on a different data model (survey_sends/survey_configs).
// Config is stored in review_templates.config — the same row the public
// /review/:token page reads — with camelCase keys derived on save so dashboard
// edits actually change the live customer survey.
// ════════════════════════════════════════════════════════════════════════════

const SURVEY_CONFIG_DEFAULTS = {
  is_enabled: true,
  question_text: 'How likely are you to recommend us to a friend or family member?',
  scale_type: '0-10',
  low_label: 'Not likely', high_label: 'Very likely',
  promoter_min: 9, passive_min: 7,
  promoter_message: "We're so glad you had a great experience! Would you mind sharing it online?",
  promoter_url: '',
  passive_message: 'Thank you for your feedback!',
  detractor_message: "We're sorry your experience didn't meet expectations.",
  followup_enabled: true,
  followup_question: 'What could we do better?',
  thank_you_title: 'Thank you!',
  thank_you_message: 'We appreciate your feedback.',
  button_text: 'Share Your Feedback →',
  email_subject: 'How did we do?',
  sms_body: 'How was your experience? Tap to let us know:',
  send_channel: 'email',
  send_delay_hours: 0,
  brand_color: '#f5c842',
};

// Validate a location belongs to the authenticated customer.
async function surveyLocation(locId, customerId) {
  const r = await query(
    'SELECT id, business_name FROM locations WHERE id=$1 AND customer_id=$2',
    [locId, customerId]
  ).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

function npsLabel(score, promoterMin = 9, passiveMin = 7) {
  if (score == null) return null;
  if (score >= promoterMin) return 'Promoter';
  if (score >= passiveMin)  return 'Passive';
  return 'Detractor';
}

// GET /api/surveys/:locId/config
router.get('/surveys/:locId/config', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const loc = await surveyLocation(req.params.locId, customerId);
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    const r = await query('SELECT config FROM review_templates WHERE customer_id=$1', [customerId]).catch(() => ({ rows: [] }));
    res.json({ config: { ...SURVEY_CONFIG_DEFAULTS, ...(r.rows[0]?.config || {}) } });
  } catch (err) {
    logger.error('GET /surveys/:locId/config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/surveys/:locId/config
router.put('/surveys/:locId/config', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const loc = await surveyLocation(req.params.locId, customerId);
    if (!loc) return res.status(404).json({ error: 'Location not found' });

    const incoming = req.body || {};
    const existingRes = await query('SELECT config FROM review_templates WHERE customer_id=$1', [customerId]).catch(() => ({ rows: [] }));
    const existing = existingRes.rows[0]?.config || {};

    // Keep existing keys (platforms, detractorQ2, brandLogo…), apply the dashboard's
    // snake_case fields, then derive the camelCase keys the public /review/:token
    // reader consumes so edits take effect on the live survey.
    const merged = {
      ...existing,
      ...incoming,
      promoterMin:      incoming.promoter_min      ?? existing.promoterMin,
      neutralMin:       incoming.passive_min       ?? existing.neutralMin,
      npsQuestion:      incoming.question_text     ?? existing.npsQuestion,
      promoterMessage:  incoming.promoter_message  ?? existing.promoterMessage,
      neutralQuestion:  incoming.passive_message   ?? existing.neutralQuestion,
      detractorOpening: incoming.detractor_message ?? existing.detractorOpening,
      detractorQ1:      incoming.followup_question ?? existing.detractorQ1,
      brandColor:       incoming.brand_color       ?? existing.brandColor,
      buttonText:       incoming.button_text       ?? existing.buttonText,
    };

    await query(
      `INSERT INTO review_templates (customer_id, config, updated_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (customer_id) DO UPDATE SET config=$2, updated_at=NOW()`,
      [customerId, JSON.stringify(merged)]
    );
    res.json({ config: { ...SURVEY_CONFIG_DEFAULTS, ...merged } });
  } catch (err) {
    logger.error('PUT /surveys/:locId/config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/surveys/:locId/analytics
router.get('/surveys/:locId/analytics', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const loc = await surveyLocation(req.params.locId, customerId);
    if (!loc) return res.status(404).json({ error: 'Location not found' });

    const cfgRes = await query('SELECT config FROM review_templates WHERE customer_id=$1', [customerId]).catch(() => ({ rows: [] }));
    const cfg = { ...SURVEY_CONFIG_DEFAULTS, ...(cfgRes.rows[0]?.config || {}) };

    const rowsRes = await query(
      `SELECT sr.nps_score, sr.path, sr.left_review, sr.detractor_q1, sr.detractor_q2,
              sr.completed_at, rr.contact_name
       FROM survey_responses sr
       LEFT JOIN review_requests rr ON rr.id = sr.review_request_id
       WHERE sr.location_id = $1
       ORDER BY sr.completed_at DESC`,
      [req.params.locId]
    ).catch(() => ({ rows: [] }));

    const responses = rowsRes.rows.map(r => {
      const label = npsLabel(r.nps_score, cfg.promoter_min, cfg.passive_min);
      const followup = [r.detractor_q1, r.detractor_q2].filter(Boolean).join(' — ') || null;
      return {
        score: r.nps_score,
        score_label: label,
        contact_name: r.contact_name || 'Anonymous',
        responded_at: r.completed_at,
        followup_text: followup,
        action: r.left_review ? 'Left a public review' : (label === 'Detractor' ? 'Private feedback' : 'Completed'),
      };
    });
    const feedback = responses.filter(r => r.score_label === 'Detractor' && r.followup_text);

    const total = responses.length;
    const promoters  = responses.filter(r => r.score_label === 'Promoter').length;
    const passives   = responses.filter(r => r.score_label === 'Passive').length;
    const detractors = responses.filter(r => r.score_label === 'Detractor').length;
    const avgScore = total ? +(responses.reduce((s, r) => s + (r.score || 0), 0) / total).toFixed(1) : 0;
    const nps = total ? Math.round(((promoters - detractors) / total) * 100) : 0;

    res.json({ responses, feedback, total, promoters, passives, detractors, avgScore, nps });
  } catch (err) {
    logger.error('GET /surveys/:locId/analytics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/surveys/:locId/history
router.get('/surveys/:locId/history', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const loc = await surveyLocation(req.params.locId, customerId);
    if (!loc) return res.status(404).json({ error: 'Location not found' });

    const cfgRes = await query('SELECT config FROM review_templates WHERE customer_id=$1', [customerId]).catch(() => ({ rows: [] }));
    const cfg = { ...SURVEY_CONFIG_DEFAULTS, ...(cfgRes.rows[0]?.config || {}) };

    const r = await query(
      `SELECT rr.contact_name, rr.contact_email, rr.contact_phone, rr.status, rr.created_at,
              sr.nps_score
       FROM review_requests rr
       LEFT JOIN survey_responses sr ON sr.review_request_id = rr.id
       WHERE rr.location_id = $1
       ORDER BY rr.created_at DESC
       LIMIT 100`,
      [req.params.locId]
    ).catch(() => ({ rows: [] }));

    const history = r.rows.map(h => {
      const label = npsLabel(h.nps_score, cfg.promoter_min, cfg.passive_min);
      return {
        contact_name:  h.contact_name || '—',
        contact_email: h.contact_email || null,
        contact_phone: h.contact_phone || null,
        channel: h.contact_email ? 'email' : (h.contact_phone ? 'sms' : '—'),
        sent_at: h.created_at,
        status: h.status,
        score: h.nps_score,
        score_label: label,
        label,
      };
    });
    res.json({ history });
  } catch (err) {
    logger.error('GET /surveys/:locId/history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── IMPORT CONTACTS ───────────────────────────────────────────────────────────
// POST /api/contacts/import — bulk insert contacts from a parsed CSV
router.post('/contacts/import', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const { rows, filename, segment } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'No rows to import' });
    }

    let imported = 0, skipped = 0;
    for (const r of rows) {
      const email = (r.email || '').trim().toLowerCase();
      const name  = (r.name || '').trim();
      const phone = (r.phone || '').trim();
      // Must have at least an email or phone
      if (!email && !phone) { skipped++; continue; }
      try {
        const result = await query(
          `INSERT INTO contacts (customer_id, name, email, phone, segment)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (customer_id, lower(email)) WHERE email IS NOT NULL
           DO UPDATE SET name=COALESCE(EXCLUDED.name, contacts.name),
                         phone=COALESCE(EXCLUDED.phone, contacts.phone)
           RETURNING (xmax = 0) AS inserted`,
          [customerId, name || null, email || null, phone || null, segment || 'all']
        );
        if (result.rows[0]?.inserted) imported++; else skipped++;
      } catch (e) {
        skipped++;
      }
    }

    await query(
      `INSERT INTO contact_imports (customer_id, filename, row_count, imported, skipped)
       VALUES ($1,$2,$3,$4,$5)`,
      [customerId, filename || 'import.csv', rows.length, imported, skipped]
    ).catch(() => {});

    logger.info('Contact import: ' + imported + ' imported, ' + skipped + ' skipped for ' + customerId);
    res.json({ success: true, imported, skipped, total: rows.length });
  } catch (err) {
    logger.error('contacts/import error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/imports — recent import history
router.get('/contacts/imports', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const result = await query(
      `SELECT id, filename, row_count, imported, skipped, created_at
       FROM contact_imports WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 10`,
      [customerId]
    ).catch(() => ({ rows: [] }));
    res.json({ imports: result.rows });
  } catch (err) {
    logger.error('contacts/imports error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET CONTACTS ──────────────────────────────────────────────────────────────
router.get('/contacts', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const result = await query(
      "SELECT id, name, email, phone, segment, last_request_at AS last_request FROM contacts WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1000",
      [customerId]
    ).catch(() => ({ rows: [] }));
    const contacts = result.rows;
    const segCounts = {};
    contacts.forEach(c => { const s = c.segment || 'all'; segCounts[s] = (segCounts[s] || 0) + 1; });
    const segments = [
      { id: 'all', name: 'All contacts', count: contacts.length },
      ...Object.keys(segCounts).filter(s => s !== 'all').map(s => ({ id: s, name: s.charAt(0).toUpperCase()+s.slice(1)+' customers', count: segCounts[s] })),
    ];
    res.json({ contacts, segments });
  } catch (err) {
    logger.error('contacts GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── BULK SEND REVIEW REQUESTS ─────────────────────────────────────────────────
router.post('/review-requests/bulk-send', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const targets = req.body.contacts;
    if (!Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({ error: 'No contacts provided' });
    }
    if (!process.env.RESEND_TRANSACTIONAL_KEY && !process.env.RESEND_API_KEY) {
      return res.status(503).json({ error: 'Email not configured. Add RESEND_TRANSACTIONAL_KEY to Railway.' });
    }
    const custResult = await query('SELECT name FROM customers WHERE id=$1', [customerId]);
    const businessName = custResult.rows[0]?.name || 'Your Business';
    const locResult = await query('SELECT id FROM locations WHERE customer_id=$1 LIMIT 1', [customerId]).catch(() => ({ rows: [] }));
    const locationId = locResult.rows[0]?.id;
    const resend = new Resend(process.env.RESEND_TRANSACTIONAL_KEY || process.env.RESEND_API_KEY);
    const crypto = require('crypto');
    const brandColor = '#f5c842';
    const brandLogo = 'https://swarmreply.com/bee-logo.png';
    let sent = 0, failed = 0;

    for (const t of targets) {
      if (!t.email || !t.email.trim()) { failed++; continue; }
      const token = crypto.randomBytes(16).toString('hex');
      const firstName = (t.name || '').trim().split(' ')[0] || 'there';
      await query(
        "INSERT INTO review_requests (customer_id, location_id, contact_name, contact_email, contact_phone, trigger_source, trigger_ref, status) VALUES ($1,$2,$3,$4,$5,'bulk',$6,'sent')",
        [customerId, locationId || null, t.name || null, t.email.trim(), t.phone || null, token]
      ).catch(e => logger.warn('bulk insert error:', e.message));
      const reviewLink = 'https://app.swarmreply.com/review/' + token;
      const bodyHtml = 'Hi ' + firstName + ',<br><br>Thank you for choosing ' + businessName + '! We would love to hear how we did. It only takes a moment.';
      const emailHtml = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f4f4f0;font-family:Arial,sans-serif"><table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 16px"><table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%"><tr><td style="background:' + brandColor + ';padding:20px 32px;border-radius:12px 12px 0 0"><img src="' + brandLogo + '" alt="' + businessName + '" style="max-height:52px;max-width:180px;object-fit:contain"></td></tr><tr><td style="background:#ffffff;padding:36px 32px"><h2 style="margin:0 0 16px;font-size:1.25rem;color:#0a0a0a">How did we do, ' + firstName + '?</h2><div style="font-size:.9rem;line-height:1.75;color:#3a3a38;margin-bottom:28px">' + bodyHtml + '</div><div style="text-align:center"><a href="' + reviewLink + '" style="display:inline-block;background:' + brandColor + ';color:#0a0a0a;text-decoration:none;padding:14px 32px;border-radius:50px;font-weight:700;font-size:.95rem">Share Your Feedback &rarr;</a></div></td></tr><tr><td style="background:' + brandColor + ';padding:14px 32px;border-radius:0 0 12px 12px;text-align:center"><span style="font-size:.72rem;color:#0a0a0a;opacity:.65">Sent by ' + businessName + ' via SwarmReply</span></td></tr></table></td></tr></table></body></html>';
      try {
        const { data, error } = await resend.emails.send({
          from: process.env.SMTP_FROM || 'SwarmReply <nick@swarmreply.com>',
          to: [t.email.trim()],
          subject: 'How did we do, ' + firstName + '?',
          text: 'Hi ' + firstName + ', thank you for choosing ' + businessName + '! Share your feedback: ' + reviewLink,
          html: emailHtml,
        });
        if (error || !data?.id) { failed++; } else { sent++; }
      } catch (e) { failed++; logger.warn('bulk email error ' + t.email + ':', e.message); }
    }
    logger.info('Bulk send: ' + sent + ' sent, ' + failed + ' failed');
    res.json({ success: true, sent, failed });
  } catch (err) {
    logger.error('bulk-send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── CAMPAIGNS ─────────────────────────────────────────────────────────────────
// GET /api/campaigns — list the customer's campaigns
router.get('/campaigns', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const result = await query(
      `SELECT id, name, message, segment, status, recipient_count, sent_count, reply_count,
              scheduled_at, sent_at, created_at
       FROM campaigns WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [customerId]
    ).catch(() => ({ rows: [] }));
    res.json({ campaigns: result.rows });
  } catch (err) {
    logger.error('GET /campaigns error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/usage — SMS quota for the current period
router.get('/campaigns/usage', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    let result = await query(
      'SELECT sms_sent, sms_limit FROM campaign_usage WHERE customer_id=$1', [customerId]
    ).catch(() => ({ rows: [] }));

    if (!result.rows.length) {
      // Initialize a usage row on first read
      await query(
        'INSERT INTO campaign_usage (customer_id, sms_sent, sms_limit) VALUES ($1,0,2000) ON CONFLICT (customer_id) DO NOTHING',
        [customerId]
      ).catch(() => {});
      result = { rows: [{ sms_sent: 0, sms_limit: 2000 }] };
    }

    // Aggregate real campaign stats for the stat cards
    const stats = await query(
      `SELECT
         COALESCE(SUM(sent_count),0)  AS total_sent,
         COALESCE(SUM(reply_count),0) AS total_replies,
         COUNT(*)                     AS total_campaigns
       FROM campaigns WHERE customer_id=$1 AND status='sent'`,
      [customerId]
    ).catch(() => ({ rows: [{ total_sent: 0, total_replies: 0, total_campaigns: 0 }] }));

    const row = result.rows[0];
    const s = stats.rows[0];
    res.json({
      usage: {
        used:       parseInt(row.sms_sent) || 0,
        limit:      parseInt(row.sms_limit) || 2000,
        sms_sent:   parseInt(row.sms_sent) || 0,
        sms_limit:  parseInt(row.sms_limit) || 2000,
        total_sent:     parseInt(s.total_sent) || 0,
        total_replies:  parseInt(s.total_replies) || 0,
        total_campaigns:parseInt(s.total_campaigns) || 0,
      }
    });
  } catch (err) {
    logger.error('GET /campaigns/usage error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns — create a campaign record
// NOTE: actual SMS delivery requires Twilio (not yet wired). This creates the
// campaign as 'draft' so it's saved and listed; sending is enabled once Twilio is live.
router.post('/campaigns', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const { name, message, segment, scheduledAt } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Campaign name is required' });
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

    // Count recipients in the segment (from contacts)
    let recipientCount = 0;
    try {
      const seg = segment && segment !== 'all' ? segment : null;
      const countRes = seg
        ? await query('SELECT COUNT(*) AS c FROM contacts WHERE customer_id=$1 AND segment=$2 AND phone IS NOT NULL', [customerId, seg])
        : await query('SELECT COUNT(*) AS c FROM contacts WHERE customer_id=$1 AND phone IS NOT NULL', [customerId]);
      recipientCount = parseInt(countRes.rows[0].c) || 0;
    } catch (e) { /* contacts table may be empty */ }

    const status = scheduledAt ? 'scheduled' : 'draft';
    const result = await query(
      `INSERT INTO campaigns (customer_id, name, message, segment, status, recipient_count, scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name, message, segment, status, recipient_count, sent_count, reply_count, scheduled_at, created_at`,
      [customerId, name.trim(), message.trim(), segment || 'all', status, recipientCount, scheduledAt || null]
    );

    logger.info('Campaign created: ' + result.rows[0].id + ' (' + status + ', ' + recipientCount + ' recipients)');
    res.json({ success: true, campaign: result.rows[0] });
  } catch (err) {
    logger.error('POST /campaigns error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;


// ══════════════════════════════════════════════════════════════════════════════
// LLM / AI VISIBILITY ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/llm/queries — load auto + custom queries for the customer
router.get('/llm/queries', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;

    const result = await query(
      `SELECT custom_queries, auto_queries, scan_frequency
       FROM llm_settings
       WHERE customer_id = $1`,
      [customerId]
    ).catch(() => ({ rows: [] }));

    const row = result.rows[0];
    res.json({
      customQueries: row?.custom_queries || [],
      autoQueries:   row?.auto_queries   || [],
      scanFrequency: row?.scan_frequency || 'weekly',
    });
  } catch (err) {
    logger.error('LLM queries GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/llm/queries — save custom queries
router.put('/llm/queries', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const { customQueries = [] } = req.body;

    if (!Array.isArray(customQueries)) {
      return res.status(400).json({ error: 'customQueries must be an array' });
    }
    if (customQueries.length > 15) {
      return res.status(400).json({ error: 'Maximum 15 custom queries allowed' });
    }

    await query(
      `INSERT INTO llm_settings (customer_id, custom_queries, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (customer_id)
       DO UPDATE SET custom_queries = $2, updated_at = NOW()`,
      [customerId, JSON.stringify(customQueries)]
    );

    res.json({ success: true, saved: customQueries.length });
  } catch (err) {
    logger.error('LLM queries PUT error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/llm/report — get latest AI visibility scan report
router.get('/llm/report', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;

    const result = await query(
      `SELECT report_data, next_scan_at, last_scan_at
       FROM llm_reports
       WHERE customer_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [customerId]
    ).catch(() => ({ rows: [] }));

    const { isScanning } = require('../services/llmMonitorService');
    const row = result.rows[0];
    res.json({
      report:     row?.report_data   || null,
      nextScanAt: row?.next_scan_at  || null,
      lastScanAt: row?.last_scan_at  || null,
      scanning:   isScanning(customerId),
    });
  } catch (err) {
    logger.error('LLM report GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/llm/scan — trigger a manual scan
router.post('/llm/scan', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const { runRealScan, markScanning, clearScanning, isScanning } = require('../services/llmMonitorService');

    // If a scan is already running for this customer, don't start another.
    if (isScanning(customerId)) {
      return res.json({ success: true, status: 'scanning', message: 'A scan is already running — results will appear here shortly.' });
    }

    // Get customer info for the report
    const custResult = await query(
      'SELECT name, plan FROM customers WHERE id=$1',
      [customerId]
    );
    const custName = custResult.rows[0]?.name || 'Your Business';

    // Get queries to scan
    const queriesResult = await query(
      'SELECT custom_queries FROM llm_settings WHERE customer_id=$1',
      [customerId]
    ).catch(() => ({ rows: [] }));
    const queries = queriesResult.rows[0]?.custom_queries || [];

    // Business name: prefer the active location's name, fall back to the account name.
    let businessName = custName;
    try {
      const locRes = await query(
        `SELECT business_name FROM locations WHERE customer_id=$1 AND is_active = true ORDER BY created_at ASC LIMIT 1`,
        [customerId]
      );
      if (locRes.rows[0]?.business_name) businessName = locRes.rows[0].business_name;
    } catch (e) { /* fall back to account name */ }

    // Previous overall score, for the delta shown on the dashboard.
    let prevScore = null;
    let lastScanAt = null;
    try {
      const prevRes = await query(
        `SELECT report_data, last_scan_at FROM llm_reports WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [customerId]
      );
      const pd = prevRes.rows[0]?.report_data;
      if (pd && typeof pd.overallScore === 'number') prevScore = pd.overallScore;
      lastScanAt = prevRes.rows[0]?.last_scan_at || null;
    } catch (e) { /* no previous report */ }

    // Weekly cadence: the first scan runs on demand; after that, the next scan is
    // only available 7 days after the last one ran (rolling).
    if (lastScanAt) {
      const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
      const nextAllowed = new Date(new Date(lastScanAt).getTime() + SEVEN_DAYS);
      if (Date.now() < nextAllowed.getTime()) {
        return res.status(429).json({
          error: 'cooldown',
          message: `Scans run once a week. Your next scan is available on ${nextAllowed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.`,
          nextScanAt: nextAllowed.toISOString(),
          lastScanAt: new Date(lastScanAt).toISOString(),
        });
      }
    }

    // Respond immediately and run the scan in the background, so the request
    // can't time out and the customer can navigate away while it runs.
    markScanning(customerId);
    res.json({
      success: true,
      status: 'scanning',
      message: 'Scan started — this can take a few minutes. You can leave this page; your results will be here when they\'re ready.',
    });

    (async () => {
      try {
        const reportData = await runRealScan({ businessName, customQueries: queries, prevScore });
        if (reportData.error) {
          logger.error('LLM scan failed for customer ' + customerId + ': ' + reportData.error);
          return;
        }
        const now      = new Date(reportData.lastScanAt);
        const nextScan = new Date(reportData.nextScanAt);
        await query(
          `INSERT INTO llm_reports (customer_id, report_data, next_scan_at, last_scan_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (customer_id)
           DO UPDATE SET
             report_data  = $2,
             next_scan_at = $3,
             last_scan_at = $4`,
          [customerId, JSON.stringify(reportData), nextScan.toISOString(), now.toISOString()]
        );
        logger.info('LLM scan completed for customer ' + customerId);
      } catch (e) {
        logger.error('LLM scan background error for customer ' + customerId + ': ' + e.message);
      } finally {
        clearScanning(customerId);
      }
    })();
  } catch (err) {
    logger.error('LLM scan POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
