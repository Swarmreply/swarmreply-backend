// ============================================
// routes/billing.js
// Customer subscription self-management
//
// GET  /api/billing/status          Current plan, status, next billing date
// GET  /api/billing/invoices         Invoice history (last 12)
// GET  /api/billing/portal           Stripe Customer Portal URL
// POST /api/billing/upgrade          Upgrade/downgrade plan
// POST /api/billing/cancel           Cancel at period end
// POST /api/billing/reactivate       Undo cancellation
// POST /api/billing/update-payment   Redirect to update card (via portal)
// ============================================

const express = require('express');
const router  = express.Router();
const Stripe  = require('stripe');
const { query } = require('../database/db');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const { auditLog } = require('../middleware/audit');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { syncLocationBilling, countActiveLocations, priceBreakdown, PRICING } = require('../services/locationBilling');

// Plan metadata — single source of truth
const PLANS = {
  starter: {
    name:       'Starter',
    price:      99,
    priceId:    process.env.STRIPE_PRICE_BASE_MONTHLY,
    locations:  1,
    features:   ['1 location', 'AI review replies', 'NPS surveys', 'Listings sync', 'Zapier integration']
  },
  growth: {
    name:       'Growth',
    price:      199,
    priceId:    process.env.STRIPE_PRICE_BASE_MONTHLY,
    locations:  5,
    features:   ['Up to 5 locations', 'Everything in Starter', 'Competitor benchmarking', '15-language replies', 'Priority support']
  },
  agency: {
    name:       'Agency',
    price:      null, // custom pricing
    priceId:    process.env.STRIPE_PRICE_AGENCY,
    locations:  null,
    features:   ['Unlimited locations', 'Everything in Growth', 'White-label dashboard', 'Branded reports', 'Dedicated account manager']
  }
};

// ── HELPERS ───────────────────────────────────────────────────────────────────

async function getCustomerRecord(customerId) {
  const result = await query(
    `SELECT id, email, name, plan, status,
            stripe_customer_id, stripe_subscription_id, stripe_price_id,
            plan_activated_at, payment_failed_at, payment_failure_count
     FROM customers WHERE id = $1`,
    [customerId]
  );
  return result.rows[0] || null;
}

async function getStripeSubscription(subscriptionId) {
  if (!subscriptionId) return null;
  try {
    return await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['latest_invoice', 'default_payment_method']
    });
  } catch (err) {
    logger.warn('Could not fetch Stripe subscription:', err.message);
    return null;
  }
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

// GET /api/billing/status
// Full subscription status for the billing dashboard
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const customer = await getCustomerRecord(req.user.customerId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const plan = PLANS[customer.plan] || PLANS.starter;

    // Per-location pricing context (DB-driven). Additive — existing consumers
    // keep reading plan/account/stripe/availablePlans unchanged.
    const isAnnual = customer.stripe_price_id === process.env.STRIPE_PRICE_BASE_ANNUAL;
    const locationCount = await countActiveLocations(req.user.customerId);
    const pricing = priceBreakdown(locationCount, isAnnual);

    // Fetch live data from Stripe
    let stripeData = null;
    if (customer.stripe_subscription_id) {
      const sub = await getStripeSubscription(customer.stripe_subscription_id);
      if (sub) {
        stripeData = {
          status:              sub.status,                          // active, past_due, canceled
          currentPeriodStart:  new Date(sub.current_period_start * 1000),
          currentPeriodEnd:    new Date(sub.current_period_end   * 1000),
          cancelAtPeriodEnd:   sub.cancel_at_period_end,
          cancelAt:            sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
          trialEnd:            sub.trial_end ? new Date(sub.trial_end * 1000) : null,
          defaultPaymentMethod: sub.default_payment_method
            ? {
                brand:    sub.default_payment_method.card?.brand,
                last4:    sub.default_payment_method.card?.last4,
                expMonth: sub.default_payment_method.card?.exp_month,
                expYear:  sub.default_payment_method.card?.exp_year,
              }
            : null,
          latestInvoice: sub.latest_invoice
            ? {
                amountDue:  sub.latest_invoice.amount_due  / 100,
                amountPaid: sub.latest_invoice.amount_paid / 100,
                status:     sub.latest_invoice.status,
                invoiceUrl: sub.latest_invoice.hosted_invoice_url
              }
            : null
        };
      }
    }

    res.json({
      success: true,
      billing: {
        plan: {
          id:        customer.plan,
          name:      plan.name,
          price:     plan.price,
          locations: plan.locations,
          features:  plan.features
        },
        account: {
          status:           customer.status,
          activatedAt:      customer.plan_activated_at,
          paymentFailed:    !!customer.payment_failed_at,
          failureCount:     customer.payment_failure_count || 0
        },
        stripe: stripeData,
        locationCount,
        billingCycle: isAnnual ? 'annual' : 'monthly',
        pricing,
        availablePlans: Object.entries(PLANS).map(([id, p]) => ({
          id,
          name:      p.name,
          price:     p.price,
          locations: p.locations,
          features:  p.features,
          current:   id === customer.plan
        }))
      }
    });
  } catch (err) {
    logger.error('Billing status error:', err.message);
    res.status(500).json({ error: 'Failed to load billing status' });
  }
});

// GET /api/billing/invoices
// Last 12 invoices from Stripe
router.get('/invoices', authenticateToken, async (req, res) => {
  try {
    const customer = await getCustomerRecord(req.user.customerId);
    if (!customer?.stripe_customer_id) {
      return res.json({ success: true, invoices: [] });
    }

    const invoices = await stripe.invoices.list({
      customer: customer.stripe_customer_id,
      limit:    12
    });

    const formatted = invoices.data.map(inv => ({
      id:          inv.id,
      number:      inv.number,
      date:        new Date(inv.created * 1000),
      periodStart: new Date(inv.period_start * 1000),
      periodEnd:   new Date(inv.period_end   * 1000),
      amount:      inv.amount_paid / 100,
      currency:    inv.currency.toUpperCase(),
      status:      inv.status,
      plan:        inv.lines?.data[0]?.description || 'SwarmReply',
      pdfUrl:      inv.invoice_pdf,
      hostedUrl:   inv.hosted_invoice_url
    }));

    res.json({ success: true, invoices: formatted });
  } catch (err) {
    logger.error('Invoices error:', err.message);
    res.status(500).json({ error: 'Failed to load invoices' });
  }
});

// GET /api/billing/portal
// Generate a Stripe Customer Portal URL — handles card updates, invoice history, cancellation
router.get('/portal', authenticateToken, async (req, res) => {
  try {
    const customer = await getCustomerRecord(req.user.customerId);
    if (!customer?.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found. Please contact hello@swarmreply.com' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer:   customer.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/dashboard/billing`
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    logger.error('Portal error:', err.message);
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

// POST /api/billing/upgrade
// Switch to a different plan immediately
// Stripe prorates the charge automatically
router.post('/upgrade', authenticateToken, async (req, res) => {
  try {
    const { planId } = req.body;
    const newPlan = PLANS[planId];
    if (!newPlan?.priceId) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const customer = await getCustomerRecord(req.user.customerId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    if (customer.plan === planId) {
      return res.status(400).json({ error: 'Already on this plan' });
    }

    if (!customer.stripe_subscription_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    // Agency upgrades go to sales — not self-serve
    if (planId === 'agency') {
      return res.status(400).json({
        error: 'Agency plan requires a sales conversation. Contact hello@swarmreply.com'
      });
    }

    // Fetch current subscription to get the subscription item ID
    const sub = await stripe.subscriptions.retrieve(customer.stripe_subscription_id);
    const itemId = sub.items.data[0]?.id;

    if (!itemId) {
      return res.status(400).json({ error: 'Could not find subscription item' });
    }

    // Update subscription — Stripe prorates automatically
    const updated = await stripe.subscriptions.update(customer.stripe_subscription_id, {
      items: [{ id: itemId, price: newPlan.priceId }],
      proration_behavior: 'create_prorations',  // immediate proration
      billing_cycle_anchor: 'unchanged'          // keep same billing date
    });

    // Update our DB immediately — webhook will also fire
    await query(
      `UPDATE customers
       SET plan = $1, stripe_price_id = $2, updated_at = NOW()
       WHERE id = $3`,
      [planId, newPlan.priceId, customer.id]
    );

    logger.info(`Plan changed: ${customer.email} ${customer.plan} → ${planId}`);

    res.json({
      success: true,
      message: `Plan updated to ${newPlan.name}`,
      plan:    planId,
      newPricePerMonth: newPlan.price
    });
  } catch (err) {
    logger.error('Plan upgrade error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to update plan' });
  }
});

// POST /api/billing/cancel
// Cancel subscription at end of current billing period
// Customer keeps access until period ends
router.post('/cancel', authenticateToken, async (req, res) => {
  try {
    const customer = await getCustomerRecord(req.user.customerId);
    if (!customer?.stripe_subscription_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    const { reason } = req.body; // optional cancellation reason

    // Cancel at period end — not immediately
    const sub = await stripe.subscriptions.update(customer.stripe_subscription_id, {
      cancel_at_period_end: true,
      metadata: { cancel_reason: reason || 'no reason provided' }
    });

    const accessUntil = new Date(sub.current_period_end * 1000);

    // Log cancellation intent in our DB
    await query(
      `UPDATE customers
       SET status = 'cancelling', updated_at = NOW()
       WHERE id = $1`,
      [customer.id]
    );

    logger.info(`Cancellation scheduled: ${customer.email} — access until ${accessUntil.toISOString()}`);

    res.json({
      success:     true,
      message:     `Your subscription will end on ${accessUntil.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}. You have full access until then.`,
      accessUntil
    });
  } catch (err) {
    logger.error('Cancel error:', err.message);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// POST /api/billing/reactivate
// Undo a cancellation (while still within the billing period)
router.post('/reactivate', authenticateToken, async (req, res) => {
  try {
    const customer = await getCustomerRecord(req.user.customerId);
    if (!customer?.stripe_subscription_id) {
      return res.status(400).json({ error: 'No subscription found' });
    }

    // Remove the cancel_at_period_end flag
    await stripe.subscriptions.update(customer.stripe_subscription_id, {
      cancel_at_period_end: false
    });

    await query(
      `UPDATE customers SET status = 'active', updated_at = NOW() WHERE id = $1`,
      [customer.id]
    );

    logger.info(`Reactivated: ${customer.email}`);
    res.json({ success: true, message: 'Subscription reactivated. Welcome back! 🐝' });
  } catch (err) {
    logger.error('Reactivate error:', err.message);
    res.status(500).json({ error: 'Failed to reactivate subscription' });
  }
});


// ── POST /api/billing/sync-locations ──────────────────────────────────────────
// Reconcile the Stripe per-location add-on quantity with the customer's actual
// active-location count. Safe to call anytime; used by the billing dashboard and
// as a manual lever for location-creation paths that don't auto-sync.
router.post('/sync-locations', authenticateToken, async (req, res) => {
  try {
    const result = await syncLocationBilling(req.user.customerId);
    if (result.error) return res.status(502).json({ error: result.error });
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('Sync-locations error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/billing/health ───────────────────────────────────────────────────
// Returns billing health, days until next charge, lockout state.
// Called by DashboardLayout on every page load.
// F7-1: was a SECOND router.get('/status'), which Express never reached because
// the rich /status above shadowed it — so locked/bannerLevel were always
// undefined and the payment-failure lockout never triggered. Now its own path.
router.get('/health', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT
         status,
         plan,
         payment_failed_at,
         payment_failure_count,
         billing_grace_expires_at,
         next_billing_at,
         plan_activated_at,
         stripe_customer_id
       FROM customers
       WHERE id = $1`,
      [req.user.customerId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const c   = result.rows[0];
    const now = new Date();

    // ── Days until next charge ────────────────────────────────────────────────
    let daysUntilNextCharge = null;
    if (c.next_billing_at) {
      const diff = new Date(c.next_billing_at) - now;
      daysUntilNextCharge = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    } else if (c.plan_activated_at) {
      // Fallback: calculate from activation date (monthly cycle)
      const activated = new Date(c.plan_activated_at);
      const next = new Date(activated);
      while (next <= now) next.setMonth(next.getMonth() + 1);
      const diff = next - now;
      daysUntilNextCharge = Math.ceil(diff / (1000 * 60 * 60 * 24));
    }

    // ── Billing state ─────────────────────────────────────────────────────────
    const isPaused    = c.status === 'paused';
    const hasFailed   = !!c.payment_failed_at;
    const graceExpiry = c.billing_grace_expires_at ? new Date(c.billing_grace_expires_at) : null;
    const inGrace     = graceExpiry && now < graceExpiry;
    const graceExpired = graceExpiry && now >= graceExpiry;

    // Days remaining in grace period
    let graceDaysLeft = null;
    if (inGrace) {
      graceDaysLeft = Math.max(0, Math.ceil((graceExpiry - now) / (1000 * 60 * 60 * 24)));
    }

    // ── Lockout: paused + grace period expired ────────────────────────────────
    const locked = isPaused && graceExpired;

    // ── Banner level ──────────────────────────────────────────────────────────
    // null     = no banner (all good)
    // 'warn'   = payment failed, still in grace — show warning banner
    // 'locked' = grace expired — show lockout screen
    let bannerLevel = null;
    if (locked)         bannerLevel = 'locked';
    else if (isPaused)  bannerLevel = 'warn';

    res.json({
      success: true,
      billing: {
        status:              c.status,
        plan:                c.plan,
        bannerLevel,
        locked,
        isPaused,
        hasFailed,
        inGrace,
        graceDaysLeft,
        graceExpiresAt:      c.billing_grace_expires_at,
        paymentFailedAt:     c.payment_failed_at,
        paymentFailureCount: c.payment_failure_count || 0,
        daysUntilNextCharge,
        nextBillingAt:       c.next_billing_at,
        stripePortalAvailable: !!c.stripe_customer_id,
      }
    });
  } catch (err) {
    logger.error('Billing status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/billing/portal ──────────────────────────────────────────────────
// Creates a Stripe billing portal session for card updates
router.post('/portal', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      'SELECT stripe_customer_id FROM customers WHERE id = $1',
      [req.user.customerId]
    );

    const stripeCustomerId = result.rows[0]?.stripe_customer_id;
    if (!stripeCustomerId) {
      return res.status(400).json({ error: 'No billing account found.' });
    }

    const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.billingPortal.sessions.create({
      customer:   stripeCustomerId,
      return_url: `${process.env.FRONTEND_URL}/dashboard/settings?tab=billing`,
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    logger.error('Billing portal error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
