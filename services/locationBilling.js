// ============================================
// services/locationBilling.js
// DB-driven per-location billing.
//
// Pricing model (matches the marketing site):
//   • Locations 1–2 .... $99/mo each
//   • Locations 3–25 ... $89/mo each
//   • Locations 26–99 .. $79/mo each
//   • 100+ ............. Agency (contact sales, handled off-platform)
//
// Stripe shape: ONE subscription with two recurring items —
//   1. Base price            (qty 1)
//   2. Location add-on price (qty = activeLocations - 1)
// The add-on price is configured in Stripe as GRADUATED tiers
// (unit 1 = $99, units 2–24 = $89, units 25–98 = $79), so we only ever set the
// quantity here — Stripe applies the per-unit math. We never compute charges ourselves.
// ============================================

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { query } = require('../database/db');
const logger = require('../utils/logger');

const BASE_MONTHLY     = process.env.STRIPE_PRICE_BASE_MONTHLY;
const BASE_ANNUAL      = process.env.STRIPE_PRICE_BASE_ANNUAL;
const LOCATION_MONTHLY = process.env.STRIPE_PRICE_LOCATION_MONTHLY;
const LOCATION_ANNUAL  = process.env.STRIPE_PRICE_LOCATION_ANNUAL;

// Display-only rates (for estimates/breakdowns shown in the dashboard).
// Stripe remains the source of truth for what is actually charged.
const PRICING = {
  base:           99,   // locations 1–2 (each)
  tier2:          89,   // locations 3–25 (each)
  tier3:          79,   // locations 26–99 (each)
  annualDiscount: 0.90, // 10% off
  maxSelfServe:   99,   // 100+ → agency
};

// Mirror of the website's calculator — for display/estimates only.
function estimateMonthly(locationCount) {
  const n = parseInt(locationCount, 10) || 0;
  if (n < 1) return PRICING.base;
  let total = Math.min(n, 2) * PRICING.base;                  // locations 1–2 @ $99
  if (n > 2)  total += Math.min(n - 2, 23) * PRICING.tier2;   // locations 3–25 @ $89
  if (n > 25) total += Math.min(n - 25, 74) * PRICING.tier3;  // locations 26–99 @ $79
  return total;
}

function priceBreakdown(locationCount, annual = false) {
  const n = parseInt(locationCount, 10) || 1;
  const f = annual ? PRICING.annualDiscount : 1;
  const rows = [{ label: 'Locations 1–2', qty: Math.min(n, 2), rate: Math.round(PRICING.base * f) }];
  if (n > 2)  rows.push({ label: 'Locations 3–25', qty: Math.min(n - 2, 23), rate: Math.round(PRICING.tier2 * f) });
  if (n > 25) rows.push({ label: 'Locations 26–99', qty: Math.min(n - 25, 74), rate: Math.round(PRICING.tier3 * f) });
  const monthly = Math.round(estimateMonthly(n) * f);
  return { rows, monthly, annual: annual ? monthly * 12 : null };
}

async function countActiveLocations(customerId) {
  const r = await query(
    `SELECT COUNT(*)::int AS n FROM locations WHERE customer_id = $1 AND is_active = true`,
    [customerId]
  );
  return r.rows[0]?.n || 0;
}

// Sync the Stripe add-on quantity to the customer's actual active-location count.
// Defensive by design: never throws — callers (location create, etc.) must not
// fail just because a billing sync hiccuped. Returns a result object instead.
// Mark a customer's locations as reconciled with Stripe (or as needing no
// reconciliation, e.g. accounts with no subscription).
async function markBillingSynced(customerId) {
  await query(
    `UPDATE locations SET billing_synced = true WHERE customer_id = $1 AND billing_synced = false`,
    [customerId]
  ).catch(e => logger.warn('markBillingSynced failed:', e.message));
}

async function syncLocationBilling(customerId) {
  try {
    const cr = await query(
      `SELECT stripe_subscription_id, stripe_price_id, status
       FROM customers WHERE id = $1`,
      [customerId]
    );
    const customer = cr.rows[0];
    if (!customer) return { success: false, skipped: true, reason: 'no_customer' };
    if (!customer.stripe_subscription_id) {
      // Nothing to reconcile — don't leave these in the retry queue forever.
      await markBillingSynced(customerId);
      return { success: false, skipped: true, reason: 'no_subscription' };
    }

    const locationCount = await countActiveLocations(customerId);
    const addonQty = Math.max(0, locationCount - 1);

    const sub = await stripe.subscriptions.retrieve(customer.stripe_subscription_id);

    // Determine billing cycle from the base item on the subscription.
    const isAnnual =
      sub.items.data.some(i => i.price?.id === BASE_ANNUAL) ||
      customer.stripe_price_id === BASE_ANNUAL;
    const locationPrice = isAnnual ? LOCATION_ANNUAL : LOCATION_MONTHLY;

    if (!locationPrice) {
      logger.warn('syncLocationBilling: location price env var not set — skipping');
      return { success: false, skipped: true, reason: 'no_location_price' };
    }

    // Find an existing location add-on item (either cycle).
    const existingAddon = sub.items.data.find(
      i => i.price?.id === LOCATION_MONTHLY || i.price?.id === LOCATION_ANNUAL
    );

    let items;
    if (existingAddon) {
      items = addonQty > 0
        ? [{ id: existingAddon.id, price: locationPrice, quantity: addonQty }]
        : [{ id: existingAddon.id, deleted: true }];
    } else if (addonQty > 0) {
      items = [{ price: locationPrice, quantity: addonQty }];
    } else {
      await markBillingSynced(customerId);
      return { success: true, locationCount, addonQty, changed: false };
    }

    await stripe.subscriptions.update(customer.stripe_subscription_id, {
      items,
      proration_behavior: 'create_prorations',
    });

    await markBillingSynced(customerId);
    logger.info(`Location billing synced: customer ${customerId} → ${locationCount} active locations (add-on qty ${addonQty})`);
    return { success: true, locationCount, addonQty, changed: true };
  } catch (err) {
    logger.error('syncLocationBilling error:', err.message);
    return { success: false, error: err.message };
  }
}

// Retry any customers whose location changes never reached Stripe
// (created/toggled while Stripe was down, env misconfig, etc.).
// Called hourly from the scheduler (JOB 5).
async function resyncPendingBilling() {
  const r = await query(
    `SELECT DISTINCT customer_id FROM locations WHERE billing_synced = false`
  );
  for (const row of r.rows) {
    const result = await syncLocationBilling(row.customer_id);
    if (!result.success && !result.skipped) {
      logger.warn(`Billing resync still failing for customer ${row.customer_id}: ${result.error || 'unknown'}`);
    }
  }
  return r.rows.length;
}

module.exports = {
  syncLocationBilling,
  resyncPendingBilling,
  countActiveLocations,
  estimateMonthly,
  priceBreakdown,
  PRICING,
};
