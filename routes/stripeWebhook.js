// ============================================
// STRIPE WEBHOOK HANDLER
// Replace the existing webhook section in
// backend/routes/index.js with this entire block.
//
// Find this line in routes/index.js:
//   // POST /api/webhooks/stripe
// And replace everything from that line down
// to (but not including) module.exports = router;
//
// ============================================
// HOW STRIPE WEBHOOKS WORK WITH YOUR SETUP:
//
// You have direct Stripe payment links:
//   Starter $79:  https://buy.stripe.com/8x29ATa118yl32GbvebfO04
//   Growth  $139: https://buy.stripe.com/4gM3cv6OP01PcDg2YIbfO05
//   Agency  $289: https://buy.stripe.com/dRmdR9ehh8yl1YC42MbfO06
//
// When someone pays via those links, Stripe fires:
//   1. checkout.session.completed  ← THE KEY EVENT
//      This is where we create/activate the customer
//   2. customer.subscription.created
//      Fires right after — we update plan details
//   3. invoice.payment_succeeded
//      Every successful renewal
//   4. invoice.payment_failed
//      Card declined — send recovery email
//   5. customer.subscription.deleted
//      When they cancel — deactivate account
// ============================================

const emailService = require('../services/emailService');

// ============================================
// PRICE ID MAP
// YOUR ACTUAL STRIPE PRICE IDs
// Get these from: Stripe Dashboard → Products
// Each product has a Price ID like price_xxx
// ============================================
const PRICE_TO_PLAN = {
  // Replace these with your real Stripe Price IDs
  // Stripe Dashboard → Products → click each product → copy Price ID
  [process.env.STRIPE_PRICE_STARTER]: 'starter',  // $79/mo
  [process.env.STRIPE_PRICE_GROWTH]:  'growth',   // $139/mo
  [process.env.STRIPE_PRICE_AGENCY]:  'agency',   // $289/mo
};

function getPlanFromPriceId(priceId) {
  const map = {
    [process.env.STRIPE_PRICE_BASE_MONTHLY]:            'starter',
    [process.env.STRIPE_PRICE_BASE_ANNUAL]:             'starter',
    [process.env.STRIPE_PRICE_LOCATION_MONTHLY]:        'starter',
    [process.env.STRIPE_PRICE_LOCATION_ANNUAL]:         'starter',
    // Legacy price IDs
    [process.env.STRIPE_PRICE_STARTER]:                 'starter',
    [process.env.STRIPE_PRICE_GROWTH]:                  'growth',
  };
  return map[priceId] || 'starter';
}

// ============================================
// IDEMPOTENCY CHECK
// Stripe can fire the same event multiple times.
// We record every event ID we process so we
// never handle the same event twice.
// ============================================
async function isEventAlreadyProcessed(eventId) {
  const result = await query(
    'SELECT id FROM stripe_webhook_events WHERE id = $1',
    [eventId]
  );
  return result.rows.length > 0;
}

async function markEventProcessed(eventId, type, status = 'processed') {
  await query(
    `INSERT INTO stripe_webhook_events (id, type, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [eventId, type, status]
  );
}

// ============================================
// CUSTOMER LOOKUP / CREATE
// When checkout.session.completed fires,
// the customer may or may not already exist
// in our DB (they filled out the onboarding
// form, or they went straight to Stripe).
// We handle both cases.
// ============================================
async function findOrCreateCustomer({ email, name, stripeCustomerId, plan }) {
  // Try to find by email first
  let result = await query(
    'SELECT * FROM customers WHERE email = $1',
    [email]
  );

  if (result.rows.length > 0) {
    // Existing customer — update their Stripe ID and plan
    const updated = await query(
      `UPDATE customers SET
         stripe_customer_id = COALESCE($1, stripe_customer_id),
         plan               = $2,
         status             = 'active',
         plan_activated_at  = COALESCE(plan_activated_at, NOW()),
         updated_at         = NOW()
       WHERE email = $3
       RETURNING *`,
      [stripeCustomerId, plan, email]
    );
    return { customer: updated.rows[0], isNew: false };
  }

  // New customer — create them
  const created = await query(
    `INSERT INTO customers
     (email, name, stripe_customer_id, plan, status, plan_activated_at)
     VALUES ($1, $2, $3, $4, 'active', NOW())
     RETURNING *`,
    [email, name || email.split('@')[0], stripeCustomerId, plan]
  );
  return { customer: created.rows[0], isNew: true };
}

// ============================================
// THE WEBHOOK ROUTE
// IMPORTANT: Must use raw body parser —
// Stripe signature verification requires the
// raw unparsed request body.
// This is already set up in server.js.
// ============================================

router.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    // ── Verify the webhook came from Stripe ──
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      logger.error('Stripe webhook signature verification failed:', err.message);
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // ── Respond to Stripe immediately ──
    // Stripe requires a 200 response within 30 seconds.
    // We respond now and process asynchronously.
    res.json({ received: true });

    // ── Idempotency check ──
    if (await isEventAlreadyProcessed(event.id)) {
      logger.info(`Stripe event ${event.id} already processed — skipping`);
      return;
    }

    logger.info(`Stripe event received: ${event.type} (${event.id})`);

    try {
      switch (event.type) {

        // ──────────────────────────────────────
        // CHECKOUT COMPLETED
        // This is the primary activation event.
        // Fires when someone pays via your
        // Stripe payment links.
        // ──────────────────────────────────────
        case 'checkout.session.completed': {
          const session = event.data.object;

          // Only handle subscription checkouts
          if (session.mode !== 'subscription') break;

          const stripeCustomerId = session.customer;
          const email            = session.customer_details?.email || session.customer_email;
          const name             = session.customer_details?.name  || '';
          const subscriptionId   = session.subscription;

          if (!email) {
            logger.error('checkout.session.completed: no email found');
            break;
          }

          // Get the price ID from the line items
          // to determine which plan they bought
          let priceId = null;
          try {
            const lineItems = await stripe.checkout.sessions.listLineItems(
              session.id, { limit: 1 }
            );
            priceId = lineItems.data[0]?.price?.id;
          } catch (err) {
            logger.warn('Could not fetch line items:', err.message);
            // Fall back to subscription lookup
            if (subscriptionId) {
              const sub = await stripe.subscriptions.retrieve(subscriptionId);
              priceId = sub.items.data[0]?.price?.id;
            }
          }

          const plan = getPlanFromPriceId(priceId);

          // Find or create the customer in our DB
          const { customer, isNew } = await findOrCreateCustomer({
            email,
            name,
            stripeCustomerId,
            plan
          });

          // Store subscription ID and price ID
          await query(
            `UPDATE customers SET
               stripe_subscription_id = $1,
               stripe_price_id        = $2,
               updated_at             = NOW()
             WHERE id = $3`,
            [subscriptionId, priceId, customer.id]
          );

          // Generate API key if they don't have one
          const existingKey = await query(
            'SELECT api_key FROM customers WHERE id = $1',
            [customer.id]
          );
          if (!existingKey.rows[0]?.api_key) {
            const zapierService = require('../services/zapierService');
            await zapierService.generateApiKey(customer.id);
          }

          // ── CREATE FIRST ADMIN TEAM MEMBER ────────────────────────────────
          // Every new customer needs an admin account to log in with.
          // We create it here with a random temporary password,
          // then email them the credentials and a forced-reset link.
          if (isNew) {
            try {
              const bcrypt    = require('bcryptjs');
              const cryptoMod = require('crypto');
              const { v4: uuidv4 } = require('uuid');
              const jwt       = require('jsonwebtoken');

              // Generate a secure temporary password
              const tempPassword = cryptoMod.randomBytes(10).toString('hex'); // 20-char hex
              const passwordHash = await bcrypt.hash(tempPassword, 12);

              // Generate a password-reset token so they set their own password on first login
              const resetToken  = cryptoMod.randomBytes(32).toString('hex');
              const resetExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h

              // Check if admin team member already exists for this customer
              const existingAdmin = await query(
                `SELECT id FROM team_members WHERE customer_id = $1 AND role = 'admin' LIMIT 1`,
                [customer.id]
              );

              if (!existingAdmin.rows.length) {
                await query(
                  `INSERT INTO team_members
                     (customer_id, email, name, role, password_hash,
                      status, invite_accepted_at,
                      invite_token, invite_sent_at)
                   VALUES ($1, $2, $3, 'admin', $4, 'active', NOW(), $5, NOW())`,
                  [customer.id, email.toLowerCase(), name || email.split('@')[0],
                   passwordHash, resetToken]
                );
                logger.info(`Admin team member created for ${email}`);
              }

              // Send welcome + credentials email
              const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;
              const dashUrl  = `${process.env.FRONTEND_URL}/dashboard`;

              await emailService.sendWelcomeWithCredentials({
                email,
                name:         name || email.split('@')[0],
                plan,
                tempPassword,
                resetUrl,
                dashUrl,
              });

              await query(
                'UPDATE customers SET welcome_email_sent = true WHERE id = $1',
                [customer.id]
              );

            } catch (adminErr) {
              logger.error('Failed to create admin team member:', adminErr.message);
              // Don't fail the webhook — customer account still exists
            }
          } else if (!customer.welcome_email_sent) {
            // Existing customer re-subscribing — just send a re-activation email
            await emailService.sendWelcomeEmail({ ...customer, plan });
            await query(
              'UPDATE customers SET welcome_email_sent = true WHERE id = $1',
              [customer.id]
            );
          }

          logger.info(
            `Account activated: ${email} → ${plan} plan ` +
            `(${isNew ? 'new customer' : 'existing customer'})`
          );
          break;
        }

        // ──────────────────────────────────────
        // SUBSCRIPTION UPDATED
        // Plan change (upgrade/downgrade)
        // ──────────────────────────────────────
        case 'customer.subscription.updated': {
          const sub     = event.data.object;
          const priceId = sub.items.data[0]?.price?.id;
          const plan    = getPlanFromPriceId(priceId);

          // Find customer by Stripe customer ID
          const result = await query(
            'SELECT * FROM customers WHERE stripe_customer_id = $1',
            [sub.customer]
          );

          if (!result.rows.length) {
            logger.warn(`subscription.updated: no customer found for ${sub.customer}`);
            break;
          }

          const customer = result.rows[0];

          await query(
            `UPDATE customers SET
               plan                   = $1,
               stripe_price_id        = $2,
               stripe_subscription_id = $3,
               status                 = CASE
                 WHEN $4 = 'active' THEN 'active'
                 WHEN $4 = 'past_due' THEN 'paused'
                 ELSE status
               END,
               updated_at = NOW()
             WHERE id = $5`,
            [plan, priceId, sub.id, sub.status, customer.id]
          );

          logger.info(`Subscription updated: ${customer.email} → ${plan} (${sub.status})`);
          break;
        }

        // ──────────────────────────────────────
        // SUBSCRIPTION CANCELLED
        // Customer cancelled or payment failed
        // after all retries exhausted
        // ──────────────────────────────────────
        case 'customer.subscription.deleted': {
          const sub = event.data.object;

          const result = await query(
            'SELECT * FROM customers WHERE stripe_customer_id = $1',
            [sub.customer]
          );

          if (!result.rows.length) break;
          const customer = result.rows[0];

          // Deactivate account
          await query(
            `UPDATE customers SET
               status     = 'cancelled',
               updated_at = NOW()
             WHERE id = $1`,
            [customer.id]
          );

          // Deactivate all their locations
          // (stops the scheduler from processing their reviews)
          await query(
            'UPDATE locations SET is_active = false WHERE customer_id = $1',
            [customer.id]
          );

          // Send cancellation email
          await emailService.sendCancellationEmail(customer);

          logger.info(`Account cancelled: ${customer.email}`);
          break;
        }

        // ──────────────────────────────────────
        // PAYMENT SUCCEEDED
        // Successful renewal — reset failure count
        // ──────────────────────────────────────
        case 'invoice.payment_succeeded': {
          const invoice = event.data.object;

          // Only care about subscription renewals, not the first charge
          if (invoice.billing_reason === 'subscription_create') break;

          await query(
            `UPDATE customers SET
               status                = 'active',
               payment_failed_at     = NULL,
               billing_grace_expires_at = NULL,
               payment_failure_count = 0,
               updated_at            = NOW()
             WHERE stripe_customer_id = $1`,
            [invoice.customer]
          );

          // Reactivate locations if they were paused for non-payment
          await query(
            `UPDATE locations SET is_active = true
             WHERE customer_id = (
               SELECT id FROM customers WHERE stripe_customer_id = $1
             )`,
            [invoice.customer]
          );

          logger.info(`Payment succeeded for Stripe customer ${invoice.customer}`);
          break;
        }

        // ──────────────────────────────────────
        // PAYMENT FAILED
        // Card declined — Stripe will retry
        // automatically (3x over 7 days by default)
        // We email the customer on first failure
        // ──────────────────────────────────────
        case 'invoice.payment_failed': {
          const invoice = event.data.object;

          const result = await query(
            'SELECT * FROM customers WHERE stripe_customer_id = $1',
            [invoice.customer]
          );

          if (!result.rows.length) break;
          const customer = result.rows[0];

          // Increment failure count
          const updated = await query(
            `UPDATE customers SET
               payment_failed_at     = NOW(),
               billing_grace_expires_at = NOW() + INTERVAL '7 days',
               payment_failure_count = payment_failure_count + 1,
               status                = 'paused',
               updated_at            = NOW()
             WHERE id = $1
             RETURNING payment_failure_count`,
            [customer.id]
          );

          const failureCount = updated.rows[0]?.payment_failure_count || 1;

          // Email on first failure and third failure
          if (failureCount === 1 || failureCount === 3) {
            await emailService.sendPaymentFailedEmail(customer);
          }

          logger.warn(
            `Payment failed for ${customer.email} ` +
            `(attempt ${failureCount})`
          );
          break;
        }

        default:
          logger.info(`Stripe event ignored: ${event.type}`);
      }

      await markEventProcessed(event.id, event.type, 'processed');

    } catch (err) {
      logger.error(`Stripe webhook error for ${event.type}:`, err.message);
      await markEventProcessed(event.id, event.type, 'failed');
    }
  }
);

// ============================================
// Keep getPlanFromPriceId accessible if needed
// elsewhere in routes/index.js
// ============================================
// (already defined above as a module-level function)
