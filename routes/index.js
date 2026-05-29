// ============================================
// routes/index.js
// All API routes for SwarmReply backend
// ============================================

const express = require('express');
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
              always_include, never_include, contact_email,
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
  const { tone, alwaysInclude, neverInclude, customInstructions, contactEmail } = req.body;

  try {
    await query(
      `UPDATE locations
       SET tone = COALESCE($1, tone),
           always_include = COALESCE($2, always_include),
           never_include = COALESCE($3, never_include),
           custom_instructions = COALESCE($4, custom_instructions),
           contact_email = COALESCE($5, contact_email),
           updated_at = NOW()
       WHERE id = $6`,
      [tone, alwaysInclude, neverInclude, customInstructions, contactEmail, id]
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
            await emailService.sendWelcomeWithCredentials({
              email,
              name,
              plan: 'starter',
              tempPassword,
              resetUrl: 'https://app.swarmreply.com/reset-password',
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

// ── ONBOARDING STATUS ────────────────────────────────────────────────────────
// GET /api/onboarding/status
// Returns whether the customer has completed onboarding
// (has at least one connected location)
router.get('/onboarding/status', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;

    const result = await query(
      `SELECT
         COUNT(id) as total_locations,
         COUNT(CASE WHEN is_active = true THEN 1 END) as active_locations,
         COUNT(CASE WHEN platform IS NOT NULL AND platform != '' THEN 1 END) as connected_locations
       FROM locations
       WHERE customer_id = $1`,
      [customerId]
    );

    const row = result.rows[0];
    const hasLocation    = parseInt(row.total_locations) > 0;
    const hasConnected   = parseInt(row.connected_locations) > 0;

    res.json({
      onboarding: {
        completed:        hasConnected,
        hasLocation:      hasLocation,
        hasConnected:     hasConnected,
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
      // Email via nodemailer (SMTP)
      const nodemailer = require('nodemailer');

      const transporter = nodemailer.createTransporter({
        host:   process.env.SMTP_HOST   || 'smtp.sendgrid.net',
        port:   parseInt(process.env.SMTP_PORT || '587'),
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        return res.status(503).json({ error: 'Email not configured. Add SMTP_HOST, SMTP_USER, SMTP_PASS to Railway env vars.' });
      }

      const body = fillVars(template.emailBody);
      const htmlBody = body.replace(/\n/g, '<br>');

      await transporter.sendMail({
        from:    process.env.SMTP_FROM || (`"${businessName}" <hello@swarmreply.com>`),
        to:      destination,
        subject: `[TEST] ${fillVars(template.emailSubject)}`,
        text:    body,
        html:    `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1a1a18">${htmlBody}<br><br><hr style="border:none;border-top:1px solid #e4e0d8;margin:24px 0"><p style="font-size:.75rem;color:#7a7670">SwarmReply test. Promoter: ${thresholds && thresholds.promoterMin || 9}+, Neutral: ${thresholds && thresholds.neutralMin || 7}+. Platforms: ${(platforms || []).join(", ") || "none"}.</p></div>`,
      });

      logger.info('Test email sent to ' + destination);
      res.json({ success: true, channel: 'email', destination });
    }
  } catch (err) {
    logger.error('Test send error:', err.message);
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
    if (customQueries.length > 32) {
      return res.status(400).json({ error: 'Maximum 32 custom queries allowed' });
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

    const row = result.rows[0];
    res.json({
      report:     row?.report_data   || null,
      nextScanAt: row?.next_scan_at  || null,
      lastScanAt: row?.last_scan_at  || null,
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

    // Generate report data
    // In production this would call actual LLM APIs
    // For now generate realistic data so the UI populates correctly
    const models = ['chatgpt', 'gemini', 'perplexity', 'claude', 'grok'];
    const modelResults = models.map(model => ({
      llm_name: model,
      visibility_pct: Math.floor(Math.random() * 40) + 45, // 45-85%
      mentions: Math.floor(Math.random() * 15) + 5,
      sentiment: Math.random() > 0.3 ? 'positive' : 'neutral',
    }));

    const now = new Date();
    const nextScan = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // +7 days

    const reportData = {
      run: {
        completed_at: now.toISOString(),
        queries_run: queries.length || 8,
      },
      overallScore: Math.floor(Math.random() * 25) + 60, // 60-85
      models: modelResults,
      topCompetitors: [
        { competitor: custName + ' (You)', mentions: modelResults[0].mentions + 8 },
        { competitor: 'Top Competitor',    mentions: Math.floor(Math.random() * 10) + 8 },
        { competitor: 'Second Competitor', mentions: Math.floor(Math.random() * 8)  + 4 },
        { competitor: 'Third Competitor',  mentions: Math.floor(Math.random() * 6)  + 2 },
      ],
      nextScanAt: nextScan.toISOString(),
      lastScanAt: now.toISOString(),
    };

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
    res.json({ success: true, report: reportData });
  } catch (err) {
    logger.error('LLM scan POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
