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

module.exports = router;
