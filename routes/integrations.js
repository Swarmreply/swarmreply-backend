// ============================================
// routes/integrations.js
// All 6 third-party integrations:
//   1. Stripe  — payment completed
//   2. Square  — payment completed
//   3. HubSpot — deal closed/won
//   4. Shopify — order fulfilled
//   5. Mindbody — appointment completed
//   6. Calendly / Acuity — appointment scheduled
//
// Pattern per integration:
//   GET  /api/integrations/:provider/connect   — start OAuth or save API key
//   GET  /api/integrations/:provider/callback  — OAuth callback
//   POST /api/integrations/:provider/webhook   — receive events
//   DELETE /api/integrations/:provider         — disconnect
//
// Shared:
//   GET  /api/integrations                     — list all for a location
//   PUT  /api/integrations/:provider/settings  — update delay / template
// ============================================

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const { signState, verifyState } = require('../utils/oauthState');
const { encrypt, decrypt } = require('../middleware/encrypt');

// Tolerate legacy plaintext rows: return value as-is if it isn't our ciphertext format
const safeDecrypt = (v) => { if (!v) return v; try { return decrypt(v); } catch { return v; } };
const axios    = require('axios');
const { query }             = require('../database/db');
const { authenticateToken } = require('../middleware/auth');
const { auditLog }          = require('../middleware/audit');
const {
  saveIntegration, getIntegration, getIntegrationByProvider,
  disconnectIntegration, listIntegrations,
  isDuplicate, logEvent, triggerReviewRequest, delayedSendAt,
  cancelScheduledRequest, rescheduleScheduledRequest,
} = require('../services/integrationService');
const logger = require('../utils/logger');
const { captureError } = require('../utils/sentry');

const FE = process.env.FRONTEND_URL || 'https://swarmreply.com';
// B3: Jobber + index.js use APP_URL in prod. Prefer it here so Square/HubSpot/
// Shopify/Calendly redirect URIs don't silently fall back to localhost on Railway.
const BE = process.env.APP_URL || process.env.BACKEND_URL || 'http://localhost:3001';

// ── HELPER: verify HMAC signature ────────────────────────────────────────────
function verifyHmac(body, secret, header, algo = 'sha256') {
  const expected = crypto
    .createHmac(algo, secret)
    .update(typeof body === 'string' ? body : JSON.stringify(body))
    .digest('hex');
  const received = header?.replace(/^sha256=/, '');
  if (!received) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(received, 'hex')
    );
  } catch { return false; }
}

// ══════════════════════════════════════════════════════════════════════════════
// SHARED ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/integrations — list all integrations for a location
router.get('/', authenticateToken, async (req, res) => {
  try {
    const locs = await query(
      'SELECT id FROM locations WHERE customer_id = $1 LIMIT 1',
      [req.user.customerId]
    );
    if (!locs.rows[0]) return res.json({ integrations: [] });
    const integrations = await listIntegrations(locs.rows[0].id);
    res.json({ success: true, integrations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/integrations/:provider/settings
router.put('/:provider/settings', authenticateToken, async (req, res) => {
  const { delayMinutes, templateId } = req.body;
  try {
    const locs = await query(
      'SELECT id FROM locations WHERE customer_id = $1 LIMIT 1',
      [req.user.customerId]
    );
    await query(
      `UPDATE integrations
       SET delay_minutes = COALESCE($3, delay_minutes),
           template_id   = COALESCE($4, template_id),
           updated_at    = NOW()
       WHERE location_id = $1 AND provider = $2`,
      [locs.rows[0]?.id, req.params.provider,
       delayMinutes ?? null, templateId ?? null]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/integrations/:provider
router.delete('/:provider', authenticateToken, async (req, res) => {
  try {
    const locs = await query(
      'SELECT id FROM locations WHERE customer_id = $1 LIMIT 1',
      [req.user.customerId]
    );
    const locationId = locs.rows[0]?.id;

    // Jobber: notify Jobber via appDisconnect BEFORE we drop the tokens, so it
    // shows as disconnected on their side too (required disconnect flow).
    if (req.params.provider === 'jobber' && locationId) {
      const tok = await query(
        `SELECT access_token FROM integrations WHERE location_id=$1 AND provider='jobber'`,
        [locationId]
      ).catch(() => ({ rows: [] }));
      await jobberAppDisconnect(safeDecrypt(tok.rows[0]?.access_token));
    }

    await disconnectIntegration(locationId, req.params.provider);
    await auditLog(req, 'integration.disconnect', { provider: req.params.provider });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 1. STRIPE TRIGGER
// Already authenticated via existing Stripe webhook.
// This just enables "send review request after successful payment" toggle.
// ══════════════════════════════════════════════════════════════════════════════

router.post('/stripe_trigger/enable', authenticateToken, async (req, res) => {
  try {
    const locs = await query(
      'SELECT id FROM locations WHERE customer_id = $1 LIMIT 1',
      [req.user.customerId]
    );
    const locationId = locs.rows[0]?.id;
    if (!locationId) return res.status(404).json({ error: 'No location found' });

    await saveIntegration(locationId, 'stripe_trigger', {
      triggerEvent:  'payment.succeeded',
      delayMinutes:  req.body.delayMinutes ?? 60,
      templateId:    req.body.templateId || null,
    });

    await auditLog(req, 'integration.connect', { provider: 'stripe_trigger' });
    res.json({ success: true, message: 'Stripe payment trigger enabled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Called by stripeWebhook.js when charge.succeeded fires
async function handleStripePaymentForReview(stripeCustomerId, amount, currency, customerEmail, customerName) {
  try {
    // Find location linked to this Stripe customer
    const custRes = await query(
      'SELECT id FROM customers WHERE stripe_customer_id = $1',
      [stripeCustomerId]
    );
    if (!custRes.rows[0]) return;

    const locRes = await query(
      'SELECT id FROM locations WHERE customer_id = $1 LIMIT 1',
      [custRes.rows[0].id]
    );
    if (!locRes.rows[0]) return;

    const integration = await getIntegration(locRes.rows[0].id, 'stripe_trigger');
    if (!integration || integration.status !== 'connected') return;
    if (!customerEmail && !customerName) return;

    const contact = {
      name:  customerName || customerEmail?.split('@')[0] || 'Customer',
      email: customerEmail || null,
      phone: null,
    };

    await triggerReviewRequest(integration, contact, null, { sendAt: delayedSendAt(integration) });
    logger.info(`Stripe review trigger fired for ${customerEmail}`);
  } catch (err) {
    logger.error('Stripe review trigger error:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. SQUARE
// OAuth 2.0 — after payment completed → send review request
// Docs: https://developer.squareup.com/reference/square
// ══════════════════════════════════════════════════════════════════════════════

router.get('/square/connect', authenticateToken, async (req, res) => {
  const state = signState({
    customerId: req.user.customerId,
    ts:         Date.now(),
  });

  const url = new URL('https://connect.squareup.com/oauth2/authorize');
  url.searchParams.set('client_id',    process.env.SQUARE_APP_ID);
  url.searchParams.set('scope',        'PAYMENTS_READ CUSTOMERS_READ ORDERS_READ');
  url.searchParams.set('redirect_uri', `${BE}/api/integrations/square/callback`);
  url.searchParams.set('state',        state);

  res.redirect(url.toString());
});

router.get('/square/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`${FE}/dashboard/settings?integration=square&error=denied`);
  }

  try {
    const { customerId } = verifyState(state);

    // Exchange code for token
    const tokenRes = await axios.post('https://connect.squareup.com/oauth2/token', {
      client_id:     process.env.SQUARE_APP_ID,
      client_secret: process.env.SQUARE_APP_SECRET,
      code,
      grant_type:    'authorization_code',
      redirect_uri:  `${BE}/api/integrations/square/callback`,
    });

    const { access_token, refresh_token, expires_at, merchant_id } = tokenRes.data;

    // Get location
    const locRes = await query(
      'SELECT id FROM locations WHERE customer_id = $1 LIMIT 1',
      [customerId]
    );
    if (!locRes.rows[0]) return res.redirect(`${FE}/dashboard/settings?integration=square&error=no_location`);

    await saveIntegration(locRes.rows[0].id, 'square', {
      accessToken:     access_token,
      refreshToken:    refresh_token,
      tokenExpiresAt:  expires_at,
      extraData:       { merchant_id },
      triggerEvent:    'payment.completed',
      delayMinutes:    60,
    });

    // Register webhook with Square
    try {
      await axios.post(
        'https://connect.squareup.com/v2/webhooks/subscriptions',
        {
          subscription: {
            name:         `SwarmReply-${locRes.rows[0].id}`,
            enabled:      true,
            event_types:  ['payment.completed'],
            notification_url: `${BE}/api/integrations/square/webhook`,
          }
        },
        { headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' } }
      );
    } catch (whErr) {
      logger.warn('Square webhook registration failed (will retry):', whErr.message);
    }

    logger.info(`Square connected for customer ${customerId}`);
    res.redirect(`${FE}/dashboard/settings?integration=square&status=connected`);
  } catch (err) {
    logger.error('Square callback error:', err.message);
    res.redirect(`${FE}/dashboard/settings?integration=square&error=failed`);
  }
});

router.post('/square/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately

  try {
    const sig  = req.headers['x-square-hmacsha256-signature'];
    const body = req.body;

    // Verify signature using Square's HMAC-SHA256
    if (process.env.SQUARE_WEBHOOK_SIGNATURE_KEY) {
      const valid = verifyHmac(body, process.env.SQUARE_WEBHOOK_SIGNATURE_KEY, sig);
      if (!valid) { logger.warn('Square webhook signature invalid'); return; }
    }

    const event   = JSON.parse(body.toString());
    const payment = event?.data?.object?.payment;
    if (!payment) return;

    // Find integration by merchant_id
    const merchantId = event.merchant_id;
    const integration = await getIntegrationByProvider('square', { merchant_id: merchantId });
    if (!integration) return;

    // Dedup
    const extId = `square_${payment.id}`;
    if (await isDuplicate('square', extId)) return;
    const eventId = await logEvent(integration.id, 'square', 'payment.completed', extId, event);

    // Extract customer info from payment
    const buyer = payment.buyer_email_address || payment.buyer_phone_number;
    if (!buyer) { logger.info('Square payment: no customer contact info'); return; }

    // Try to fetch customer details if customer_id present
    let name = 'Customer';
    let email = payment.buyer_email_address || null;
    let phone = null;

    if (payment.customer_id) {
      try {
        const custRes = await axios.get(
          `https://connect.squareup.com/v2/customers/${payment.customer_id}`,
          { headers: { Authorization: `Bearer ${integration.access_token}` } }
        );
        const c = custRes.data?.customer;
        if (c) {
          name  = [c.given_name, c.family_name].filter(Boolean).join(' ') || name;
          email = c.email_address || email;
          phone = c.phone_number  || null;
        }
      } catch (e) { /* Use what we have */ }
    }

    await triggerReviewRequest(integration, { name, email, phone }, eventId, { sendAt: delayedSendAt(integration) });
  } catch (err) {
    logger.error('Square webhook error:', err.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. HUBSPOT
// OAuth 2.0 — deal stage = closedwon → send review request
// Docs: https://developers.hubspot.com/docs/api/crm/deals
// ══════════════════════════════════════════════════════════════════════════════

router.get('/hubspot/connect', authenticateToken, async (req, res) => {
  const state = signState({
    customerId: req.user.customerId, ts: Date.now()
  });

  const url = new URL('https://app.hubspot.com/oauth/authorize');
  url.searchParams.set('client_id',    process.env.HUBSPOT_CLIENT_ID);
  url.searchParams.set('redirect_uri', `${BE}/api/integrations/hubspot/callback`);
  url.searchParams.set('scope',        'crm.objects.contacts.read crm.objects.deals.read');
  url.searchParams.set('state',        state);

  res.redirect(url.toString());
});

router.get('/hubspot/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`${FE}/dashboard/settings?integration=hubspot&error=denied`);

  try {
    const { customerId } = verifyState(state);

    const tokenRes = await axios.post('https://api.hubapi.com/oauth/v1/token',
      new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.HUBSPOT_CLIENT_ID,
        client_secret: process.env.HUBSPOT_CLIENT_SECRET,
        redirect_uri:  `${BE}/api/integrations/hubspot/callback`,
        code,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000);

    // Get HubSpot portal ID
    const meRes = await axios.get('https://api.hubapi.com/oauth/v1/access-tokens/' + access_token);
    const portalId = meRes.data.hub_id;

    const locRes = await query(
      'SELECT id FROM locations WHERE customer_id = $1 LIMIT 1',
      [customerId]
    );
    if (!locRes.rows[0]) return res.redirect(`${FE}/dashboard/settings?integration=hubspot&error=no_location`);

    await saveIntegration(locRes.rows[0].id, 'hubspot', {
      accessToken:     access_token,
      refreshToken:    refresh_token,
      tokenExpiresAt:  expiresAt,
      extraData:       { portal_id: portalId },
      triggerEvent:    'deal.closedwon',
      delayMinutes:    30,
    });

    // Create HubSpot workflow webhook subscription
    try {
      await axios.post(
        `https://api.hubapi.com/webhooks/v3/${portalId}/subscriptions`,
        { eventType: 'deal.propertyChange', propertyName: 'dealstage', active: true },
        { headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' } }
      );
    } catch (whErr) { logger.warn('HubSpot subscription failed:', whErr.message); }

    logger.info(`HubSpot connected for customer ${customerId}`);
    res.redirect(`${FE}/dashboard/settings?integration=hubspot&status=connected`);
  } catch (err) {
    logger.error('HubSpot callback error:', err.message);
    res.redirect(`${FE}/dashboard/settings?integration=hubspot&error=failed`);
  }
});

router.post('/hubspot/webhook', async (req, res) => {
  // Raw body (registered in server.js) is required for v3 signature verification
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body || {});

  // ── Verify HubSpot v3 signature: base64( HMAC-SHA256(secret, method+uri+body+timestamp) ) ──
  const hsSecret = process.env.HUBSPOT_CLIENT_SECRET;
  if (hsSecret) {
    const ts  = req.headers['x-hubspot-request-timestamp'];
    const sig = req.headers['x-hubspot-signature-v3'];
    const fresh = ts && Math.abs(Date.now() - Number(ts)) < 5 * 60 * 1000;
    const base  = 'POST' + 'https://' + req.get('host') + req.originalUrl + rawBody + ts;
    const expected = crypto.createHmac('sha256', hsSecret).update(base).digest('base64');
    const ok = fresh && sig && sig.length === expected.length &&
               crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!ok) {
      logger.warn('HubSpot webhook: invalid or stale signature — rejected');
      return res.sendStatus(401);
    }
  } else {
    logger.warn('HubSpot webhook: HUBSPOT_CLIENT_SECRET not set — signature NOT verified');
  }

  res.sendStatus(200);

  try {
    // HubSpot sends an array of events
    let parsed; try { parsed = JSON.parse(rawBody); } catch { parsed = []; }
    const events = Array.isArray(parsed) ? parsed : [parsed];

    for (const event of events) {
      if (event.subscriptionType !== 'deal.propertyChange') continue;
      if (event.propertyName !== 'dealstage') continue;

      // Only trigger on closedwon deals
      const isWon = event.propertyValue?.toLowerCase().includes('closedwon') ||
                    event.propertyValue === 'closedwon';
      if (!isWon) continue;

      // Find integration by portal ID
      const portalId = event.portalId?.toString();
      if (!portalId) continue;

      const integration = await getIntegrationByProvider('hubspot', { portal_id: portalId });
      if (!integration) continue;

      const extId = `hs_deal_${event.objectId}`;
      if (await isDuplicate('hubspot', extId)) continue;
      const eventId = await logEvent(integration.id, 'hubspot', 'deal.closedwon', extId, event);

      // Fetch associated contact from HubSpot
      try {
        const dealRes = await axios.get(
          `https://api.hubapi.com/crm/v3/objects/deals/${event.objectId}/associations/contacts`,
          { headers: { Authorization: `Bearer ${integration.access_token}` } }
        );

        const contactId = dealRes.data?.results?.[0]?.id;
        if (!contactId) continue;

        const contRes = await axios.get(
          `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,email,phone`,
          { headers: { Authorization: `Bearer ${integration.access_token}` } }
        );

        const props = contRes.data?.properties || {};
        const contact = {
          name:  [props.firstname, props.lastname].filter(Boolean).join(' ') || 'Customer',
          email: props.email || null,
          phone: props.phone || null,
        };

        if (!contact.email && !contact.phone) continue;
        await triggerReviewRequest(integration, contact, eventId, { sendAt: delayedSendAt(integration) });
      } catch (fetchErr) {
        logger.error('HubSpot contact fetch error:', fetchErr.message);
      }
    }
  } catch (err) {
    logger.error('HubSpot webhook error:', err.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. SHOPIFY
// OAuth 2.0 — order fulfilled → send review request
// Docs: https://shopify.dev/docs/api/admin-rest/2024-01/resources/webhook
// ══════════════════════════════════════════════════════════════════════════════

router.get('/shopify/connect', authenticateToken, async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop parameter required (e.g. mystore.myshopify.com)' });

  const state = signState({
    customerId: req.user.customerId, shop, ts: Date.now()
  });

  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id',    process.env.SHOPIFY_API_KEY);
  url.searchParams.set('scope',        'read_orders,read_customers');
  url.searchParams.set('redirect_uri', `${BE}/api/integrations/shopify/callback`);
  url.searchParams.set('state',        state);

  res.redirect(url.toString());
});

router.get('/shopify/callback', async (req, res) => {
  const { code, state, shop, hmac } = req.query;
  if (!code || !shop) return res.redirect(`${FE}/dashboard/settings?integration=shopify&error=denied`);

  try {
    // Verify Shopify HMAC
    const params = { ...req.query };
    delete params.hmac;
    const message  = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    const expected = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET).update(message).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hmac))) {
      return res.redirect(`${FE}/dashboard/settings?integration=shopify&error=invalid_hmac`);
    }

    const { customerId } = verifyState(state);

    const tokenRes = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id:     process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      code,
    });

    const { access_token } = tokenRes.data;
    const locRes = await query(
      'SELECT id FROM locations WHERE customer_id = $1 LIMIT 1', [customerId]
    );
    if (!locRes.rows[0]) return res.redirect(`${FE}/dashboard/settings?integration=shopify&error=no_location`);

    await saveIntegration(locRes.rows[0].id, 'shopify', {
      accessToken:  access_token,
      extraData:    { shop },
      triggerEvent: 'order.fulfilled',
      delayMinutes: 120,
    });

    // Register webhook
    await axios.post(
      `https://${shop}/admin/api/2024-01/webhooks.json`,
      { webhook: {
        topic:   'orders/fulfilled',
        address: `${BE}/api/integrations/shopify/webhook`,
        format:  'json',
      }},
      { headers: { 'X-Shopify-Access-Token': access_token } }
    ).catch(e => logger.warn('Shopify webhook reg failed:', e.message));

    logger.info(`Shopify connected: ${shop} for customer ${customerId}`);
    res.redirect(`${FE}/dashboard/settings?integration=shopify&status=connected`);
  } catch (err) {
    logger.error('Shopify callback error:', err.message);
    res.redirect(`${FE}/dashboard/settings?integration=shopify&error=failed`);
  }
});

router.post('/shopify/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  res.sendStatus(200);

  try {
    const hmac = req.headers['x-shopify-hmac-sha256'];
    if (process.env.SHOPIFY_API_SECRET) {
      const digest = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET)
        .update(req.body).digest('base64');
      if (digest !== hmac) { logger.warn('Shopify webhook HMAC invalid'); return; }
    }

    const order = JSON.parse(req.body.toString());
    const shop  = req.headers['x-shopify-shop-domain'];
    if (!shop || !order) return;

    const integration = await getIntegrationByProvider('shopify', { shop });
    if (!integration) return;

    const extId = `shopify_order_${order.id}`;
    if (await isDuplicate('shopify', extId)) return;
    const eventId = await logEvent(integration.id, 'shopify', 'order.fulfilled', extId, {
      order_id: order.id, email: order.email
    });

    const customer = order.customer || {};
    const contact = {
      name:  [customer.first_name, customer.last_name].filter(Boolean).join(' ')
             || order.billing_address?.name
             || order.email?.split('@')[0]
             || 'Customer',
      email: order.email || customer.email || null,
      phone: customer.phone || order.billing_address?.phone || null,
    };

    if (!contact.email && !contact.phone) return;
    await triggerReviewRequest(integration, contact, eventId, { sendAt: delayedSendAt(integration) });
  } catch (err) {
    logger.error('Shopify webhook error:', err.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. MINDBODY
// API Key (no OAuth — Mindbody uses partner API keys + site credentials)
// Docs: https://developers.mindbodyonline.com/PublicDocumentation/V6
// Trigger: appointment completed (class/appointment check-out)
// ══════════════════════════════════════════════════════════════════════════════

router.post('/mindbody/connect', authenticateToken, async (req, res) => {
  const { siteId, staffUsername, staffPassword } = req.body;

  if (!siteId || !staffUsername || !staffPassword) {
    return res.status(400).json({ error: 'siteId, staffUsername, and staffPassword are required' });
  }

  try {
    // Authenticate with Mindbody to validate credentials
    const authRes = await axios.post(
      'https://api.mindbodyonline.com/public/v6/usertoken/issue',
      {
        Username: staffUsername,
        Password: staffPassword,
        SiteIds:  [parseInt(siteId)],
      },
      {
        headers: {
          'Content-Type':  'application/json',
          'Api-Key':        process.env.MINDBODY_API_KEY,
          'SiteId':         siteId,
        }
      }
    );

    const token = authRes.data?.UserToken?.AccessToken;
    if (!token) return res.status(401).json({ error: 'Invalid Mindbody credentials' });

    const locRes = await query(
      'SELECT id FROM locations WHERE customer_id = $1 LIMIT 1',
      [req.user.customerId]
    );
    if (!locRes.rows[0]) return res.status(404).json({ error: 'No location found' });

    await saveIntegration(locRes.rows[0].id, 'mindbody', {
      accessToken:  token,
      extraData:    { site_id: siteId },
      triggerEvent: 'appointment.completed',
      delayMinutes: 60,
    });

    await auditLog(req, 'integration.connect', { provider: 'mindbody', siteId });
    logger.info(`Mindbody connected: site ${siteId}`);
    res.json({ success: true, message: 'Mindbody connected. Appointment completion webhooks now active.' });
  } catch (err) {
    logger.error('Mindbody connect error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to connect to Mindbody. Check your credentials.' });
  }
});

// Mindbody sends webhooks via their Message Broker (subscription-based)
// Register endpoint at: https://developers.mindbodyonline.com/WebhookDocumentation
router.post('/mindbody/webhook', express.json(), async (req, res) => {
  res.sendStatus(200);

  try {
    const { EventData, EventType } = req.body;
    if (!EventType?.includes('client') && !EventType?.includes('visit') &&
        !EventType?.includes('appointment')) return;

    const siteId = req.headers['mindbody-siteid']?.toString() || EventData?.SiteId?.toString();
    if (!siteId) return;

    const integration = await getIntegrationByProvider('mindbody', { site_id: siteId });
    if (!integration) return;

    const extId = `mb_${EventType}_${EventData?.Id || EventData?.VisitId || EventData?.ClientId}`;
    if (await isDuplicate('mindbody', extId)) return;
    const eventId = await logEvent(integration.id, 'mindbody', EventType, extId, EventData);

    const client = EventData?.Client || EventData;
    const contact = {
      name:  [client?.FirstName, client?.LastName].filter(Boolean).join(' ') || 'Client',
      email: client?.Email || null,
      phone: client?.MobilePhone || client?.HomePhone || null,
    };

    if (!contact.email && !contact.phone) return;
    await triggerReviewRequest(integration, contact, eventId, { sendAt: delayedSendAt(integration) });
  } catch (err) {
    logger.error('Mindbody webhook error:', err.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 6a. CALENDLY
// OAuth 2.0 — invitee created (appointment booked/completed)
// Docs: https://developer.calendly.com/api-docs
// ══════════════════════════════════════════════════════════════════════════════

router.get('/calendly/connect', authenticateToken, async (req, res) => {
  const state = signState({
    customerId: req.user.customerId, ts: Date.now()
  });

  const url = new URL('https://auth.calendly.com/oauth/authorize');
  url.searchParams.set('client_id',    process.env.CALENDLY_CLIENT_ID);
  url.searchParams.set('response_type','code');
  url.searchParams.set('redirect_uri', `${BE}/api/integrations/calendly/callback`);
  url.searchParams.set('state',        state);

  res.redirect(url.toString());
});

router.get('/calendly/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`${FE}/dashboard/settings?integration=calendly&error=denied`);

  try {
    const { customerId } = verifyState(state);

    const tokenRes = await axios.post('https://auth.calendly.com/oauth/token',
      new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.CALENDLY_CLIENT_ID,
        client_secret: process.env.CALENDLY_CLIENT_SECRET,
        redirect_uri:  `${BE}/api/integrations/calendly/callback`,
        code,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;

    // Get current user URI (needed for webhook scope)
    const userRes = await axios.get('https://api.calendly.com/users/me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const userUri = userRes.data?.resource?.uri;

    const locRes = await query(
      'SELECT id FROM locations WHERE customer_id = $1 LIMIT 1', [customerId]
    );
    if (!locRes.rows[0]) return res.redirect(`${FE}/dashboard/settings?integration=calendly&error=no_location`);

    await saveIntegration(locRes.rows[0].id, 'calendly', {
      accessToken:    access_token,
      refreshToken:   refresh_token,
      tokenExpiresAt: new Date(Date.now() + (expires_in || 3600) * 1000),
      extraData:      { user_uri: userUri },
      triggerEvent:   'invitee.created',
      delayMinutes:   0, // send immediately when appointment is booked
    });

    // Register webhook
    await axios.post(
      'https://api.calendly.com/webhook_subscriptions',
      {
        url:    `${BE}/api/integrations/calendly/webhook`,
        events: ['invitee.created', 'invitee.canceled'],
        organization: userRes.data?.resource?.current_organization,
        user:   userUri,
        scope:  'user',
      },
      { headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' } }
    ).catch(e => logger.warn('Calendly webhook reg failed:', e.message));

    logger.info(`Calendly connected for customer ${customerId}`);
    res.redirect(`${FE}/dashboard/settings?integration=calendly&status=connected`);
  } catch (err) {
    logger.error('Calendly callback error:', err.message);
    res.redirect(`${FE}/dashboard/settings?integration=calendly&error=failed`);
  }
});

router.post('/calendly/webhook', express.json(), async (req, res) => {
  res.sendStatus(200);

  try {
    // Verify Calendly webhook signature
    const sig = req.headers['calendly-webhook-signature'];
    if (sig && process.env.CALENDLY_WEBHOOK_SIGNING_KEY) {
      const [tPart, sPart] = sig.split(',');
      const t = tPart?.split('=')[1];
      const s = sPart?.split('=')[1];
      const expected = crypto.createHmac('sha256', process.env.CALENDLY_WEBHOOK_SIGNING_KEY)
        .update(`${t}.${JSON.stringify(req.body)}`).digest('hex');
      if (!s || !crypto.timingSafeEqual(Buffer.from(expected,'hex'), Buffer.from(s,'hex'))) {
        logger.warn('Calendly webhook signature invalid'); return;
      }
    }

    const { event, payload } = req.body;
    const invitee = payload?.invitee;
    if (!invitee) return;

    // Appointment canceled → withdraw any pending scheduled request
    if (event === 'invitee.canceled') {
      const ref = `calendly_${invitee.uri?.split('/').pop()}`;
      const n = await cancelScheduledRequest('calendly', ref);
      if (n) logger.info(`Calendly: canceled ${n} pending review request (${ref})`);
      return;
    }
    if (event !== 'invitee.created') return;

    // Find integration by user URI
    const hostUri = payload?.event_type?.owner;
    const integration = await getIntegrationByProvider('calendly', { user_uri: hostUri });
    if (!integration) return;

    const extId = `calendly_${invitee.uri?.split('/').pop()}`;
    if (await isDuplicate('calendly', extId)) return;
    const eventId = await logEvent(integration.id, 'calendly', 'invitee.created', extId, {
      name: invitee.name, email: invitee.email
    });

    const contact = {
      name:  invitee.name  || 'Customer',
      email: invitee.email || null,
      phone: invitee.text_reminder_number || null,
    };

    if (!contact.email && !contact.phone) return;

    // Anchor to when the appointment ENDS (booking time would ask for a
    // review before the visit even happens). The delay counts from there.
    const apptEnd = payload?.scheduled_event?.end_time
                 || payload?.event?.end_time || null;
    await triggerReviewRequest(integration, contact, eventId, {
      sendAt: delayedSendAt(integration, apptEnd),
      externalRef: extId,
    });
  } catch (err) {
    logger.error('Calendly webhook error:', err.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 6b. ACUITY SCHEDULING
// Basic auth (API Key + User ID) — appointment completed
// Docs: https://developers.acuityscheduling.com
// ══════════════════════════════════════════════════════════════════════════════

router.post('/acuity/connect', authenticateToken, async (req, res) => {
  const { userId, apiKey } = req.body;
  if (!userId || !apiKey) {
    return res.status(400).json({ error: 'userId and apiKey are required' });
  }

  try {
    // Validate credentials
    const testRes = await axios.get('https://acuityscheduling.com/api/v1/me', {
      auth: { username: userId, password: apiKey }
    });

    const acuityUserId = testRes.data?.id;

    const locRes = await query(
      'SELECT id FROM locations WHERE customer_id = $1 LIMIT 1',
      [req.user.customerId]
    );
    if (!locRes.rows[0]) return res.status(404).json({ error: 'No location found' });

    await saveIntegration(locRes.rows[0].id, 'acuity', {
      accessToken:  apiKey,
      extraData:    { user_id: userId, acuity_user_id: acuityUserId },
      triggerEvent: 'appointment.scheduled',
      delayMinutes: 1440, // 24h after appointment
    });

    // B2: Acuity webhooks carry no account/user id, so a shared target URL
    // can't be attributed to a tenant. Register a per-integration target with
    // the integration id in the query string instead.
    const acuityInteg = await query(
      `SELECT id FROM integrations WHERE location_id=$1 AND provider='acuity'`,
      [locRes.rows[0].id]
    ).catch(() => ({ rows: [] }));
    const acuityIntegId = acuityInteg.rows[0]?.id;

    // Register webhook (target scoped to this integration)
    await axios.post(
      'https://acuityscheduling.com/api/v1/webhooks',
      { event: 'appointment.scheduled',
        target: `${BE}/api/integrations/acuity/webhook?integration=${acuityIntegId || ''}` },
      { auth: { username: userId, password: apiKey } }
    ).catch(e => logger.warn('Acuity webhook reg failed:', e.message));

    await auditLog(req, 'integration.connect', { provider: 'acuity', acuityUserId });
    res.json({ success: true, message: 'Acuity Scheduling connected.' });
  } catch (err) {
    logger.error('Acuity connect error:', err.message);
    res.status(401).json({ error: 'Invalid Acuity credentials. Check your User ID and API key.' });
  }
});

router.post('/acuity/webhook', express.json(), async (req, res) => {
  res.sendStatus(200);

  try {
    const { action, id } = req.body;
    if (!['scheduled', 'rescheduled', 'canceled'].includes(action)) return;

    // Appointment canceled → withdraw any pending scheduled request
    if (action === 'canceled') {
      const n = await cancelScheduledRequest('acuity', `acuity_appt_${id}`);
      if (n) logger.info(`Acuity: canceled ${n} pending review request (appt ${id})`);
      return;
    }

    // B2: identify the integration from the per-integration target URL.
    // Removed the old `getIntegrationByProvider('acuity', {})` fallback, which
    // grabbed the FIRST acuity integration and misattributed events across
    // tenants. If we can't identify the integration, skip rather than guess.
    let integration = null;
    const integrationId = req.query.integration;

    if (integrationId) {
      const r = await query(
        `SELECT * FROM integrations WHERE id=$1 AND provider='acuity' AND status='connected'`,
        [integrationId]
      ).catch(() => ({ rows: [] }));
      integration = r.rows[0] || null;
    }

    // Fallback: match by calendar owner if the provider stored it.
    if (!integration && req.body.calendarID) {
      integration = await getIntegrationByProvider('acuity', {
        acuity_user_id: req.body.calendarID.toString()
      });
    }

    if (!integration) {
      logger.warn('Acuity webhook: could not identify integration — skipping');
      return;
    }

    const extId = `acuity_appt_${id}`;
    if (action === 'scheduled' && await isDuplicate('acuity', extId)) return;
    const eventId = await logEvent(integration.id, 'acuity', `appointment.${action}`, extId, req.body);

    // Fetch the appointment from Acuity for its end time (webhook payload is
    // minimal). Anchor = appointment end; the customer's delay counts from there.
    let apptEnd = null;
    try {
      const userId = integration.extra_data?.user_id
                  || integration.extra_data?.acuity_user_id;
      const apiKey = integration.access_token ? decrypt(integration.access_token) : null;
      if (userId && apiKey) {
        const ar = await axios.get(`https://acuityscheduling.com/api/v1/appointments/${id}`, {
          auth: { username: String(userId), password: apiKey }, timeout: 8000,
        });
        const appt = ar.data;
        if (appt?.datetime) {
          const durationMin = Number(appt.duration) || 0;
          apptEnd = new Date(new Date(appt.datetime).getTime() + durationMin * 60 * 1000);
        }
      }
    } catch (e) {
      logger.warn(`Acuity: could not fetch appointment ${id} for timing (${e.message}) — delaying from now`);
    }

    // Rescheduled → move the existing pending send instead of creating another
    if (action === 'rescheduled') {
      const moved = await rescheduleScheduledRequest('acuity', extId, delayedSendAt(integration, apptEnd));
      if (moved) {
        logger.info(`Acuity: rescheduled pending review request (appt ${id})`);
        return;
      }
      // No pending row (already sent, or predates this feature) — fall through
      // and let dedup-by-extId in logEvent guard double inserts naturally.
    }

    const contact = {
      name:  [req.body.firstName, req.body.lastName].filter(Boolean).join(' ') || 'Client',
      email: req.body.email || null,
      phone: req.body.phone || null,
    };

    if (!contact.email && !contact.phone) return;
    await triggerReviewRequest(integration, contact, eventId, {
      sendAt: delayedSendAt(integration, apptEnd),
      externalRef: extId,
    });
  } catch (err) {
    logger.error('Acuity webhook error:', err.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// JOBBER INTEGRATION
// OAuth 2.0 + Webhooks — triggers review request on job completed
// Requires env vars: JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET
// ══════════════════════════════════════════════════════════════════════════════

const JOBBER_AUTH_URL     = 'https://api.getjobber.com/api/oauth/authorize';
const JOBBER_TOKEN_URL    = 'https://api.getjobber.com/api/oauth/token';
const JOBBER_API_URL      = 'https://api.getjobber.com/api/graphql';
// Jobber GraphQL is date-versioned. Set JOBBER_API_VERSION in Railway to match
// your app's API version from the Developer Center (sent as X-JOBBER-GRAPHQL-VERSION).
const JOBBER_API_VERSION  = process.env.JOBBER_API_VERSION || null;

// GET /api/integrations/jobber/connect
// Redirect user to Jobber OAuth consent screen
router.get('/jobber/connect', authenticateToken, async (req, res) => {
  try {
    const { locationId } = req.query;
    if (!locationId) return res.status(400).json({ error: 'locationId is required' });

    const state = signState({
      customerId: req.user.customerId,
      locationId,
      ts: Date.now(),
    });

    const params = new URLSearchParams({
      client_id:     process.env.JOBBER_CLIENT_ID,
      redirect_uri:  `${process.env.APP_URL}/api/integrations/jobber/callback`,
      response_type: 'code',
      state,
    });

    res.redirect(`${JOBBER_AUTH_URL}?${params}`);
  } catch (err) {
    logger.error('Jobber connect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/integrations/jobber/callback
// Handle OAuth callback — exchange code for tokens, register webhook
router.get('/jobber/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).json({ error: 'Missing code or state' });

    const { customerId, locationId } = verifyState(state);

    // Exchange code for tokens
    const tokenRes = await fetch(JOBBER_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.JOBBER_CLIENT_ID,
        client_secret: process.env.JOBBER_CLIENT_SECRET,
        redirect_uri:  `${process.env.APP_URL}/api/integrations/jobber/callback`,
        code,
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      logger.error('Jobber token exchange failed:', tokens);
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard/integrations?error=jobber_auth_failed`);
    }

    // B1: fetch the Jobber account id so inbound webhooks (which carry
    // data.accountId) can be matched to THIS integration row, instead of
    // blindly grabbing the first connected Jobber integration.
    let jobberAccountId = null;
    try {
      const acctRes = await fetch(JOBBER_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ query: `query { account { id } }` }),
      });
      const acctJson = await acctRes.json();
      jobberAccountId = acctJson?.data?.account?.id || null;
    } catch (e) {
      logger.warn('Jobber account id fetch failed:', e.message);
    }

    // NOTE: Webhook topics (incl. APP_DISCONNECT) are configured in the Jobber
    // Developer Center app settings, NOT registered per-connection via the API.
    // Jobber delivers every subscribed topic to one URL:
    //   ${APP_URL}/api/integrations/jobber/webhook
    // which is handled (with HMAC verification) by the /jobber/webhook route below.

    // Save integration to DB
    const existing = await query(
      `SELECT id FROM integrations WHERE location_id=$1 AND provider='jobber'`,
      [locationId]
    );

    if (existing.rows.length) {
      await query(
        `UPDATE integrations SET access_token=$1, refresh_token=$2, external_account_id=$3, status='connected', updated_at=NOW()
         WHERE location_id=$4 AND provider='jobber'`,
        [encrypt(tokens.access_token), tokens.refresh_token ? encrypt(tokens.refresh_token) : null, jobberAccountId, locationId]
      );
    } else {
      await query(
        `INSERT INTO integrations (location_id, provider, access_token, refresh_token, external_account_id, status)
         VALUES ($1,'jobber',$2,$3,$4,'connected')`,
        [locationId, encrypt(tokens.access_token), tokens.refresh_token ? encrypt(tokens.refresh_token) : null, jobberAccountId]
      );
    }

    await query(
      `INSERT INTO audit_log (customer_id, action, details)
       SELECT customer_id, 'integration_connected', '{"provider":"jobber"}'::jsonb
       FROM locations WHERE id=$1`,
      [locationId]
    ).catch(() => {});

    logger.info(`Jobber connected for location ${locationId}`);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard/integrations?connected=jobber`);
  } catch (err) {
    logger.error('Jobber callback error:', err.message);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard/integrations?error=jobber_callback_failed`);
  }
});

// POST /api/integrations/jobber/webhook
// Single endpoint for ALL Jobber webhook topics (Jobber puts the topic in the
// payload). Verifies the HMAC-SHA256 signature, then routes by topic.
// server.js delivers this route's body as a raw Buffer (needed for the HMAC).
router.post('/jobber/webhook', async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));

  // ── Verify signature: base64( HMAC-SHA256(rawBody, OAuth client secret) ) ──
  if (process.env.JOBBER_CLIENT_SECRET) {
    try {
      const expected = crypto.createHmac('sha256', process.env.JOBBER_CLIENT_SECRET).update(raw).digest('base64');
      const got = String(req.headers['x-jobber-hmac-sha256'] || '');
      const a = Buffer.from(expected);
      const b = Buffer.from(got);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        logger.warn('Jobber webhook: invalid signature');
        return res.status(401).json({ error: 'invalid signature' });
      }
    } catch (e) {
      logger.warn('Jobber webhook signature error:', e.message);
      return res.status(401).json({ error: 'invalid signature' });
    }
  }

  // Acknowledge fast (Jobber requires a quick 200), then process.
  res.status(200).json({ received: true });

  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return; }

  const evt       = body?.data?.webHookEvent || {};
  const topic     = evt.topic;
  const accountId = evt.accountId;
  const itemId    = evt.itemId;
  if (!topic) return;

  try {
    // ── APP_DISCONNECT — user removed the app from Jobber's side ─────────────
    // Jobber has already invalidated the tokens; we just mark ourselves
    // disconnected so the UI reflects it. (Required to pass Jobber app review.)
    if (topic === 'APP_DISCONNECT') {
      const rows = await query(
        `SELECT i.id, i.location_id, l.customer_id
           FROM integrations i JOIN locations l ON l.id = i.location_id
          WHERE i.provider='jobber' AND i.external_account_id = $1`,
        [String(accountId)]
      );
      if (!rows.rows.length) {
        logger.warn(`Jobber APP_DISCONNECT: no integration for account ${accountId}`);
        return;
      }
      for (const row of rows.rows) {
        await query(
          `UPDATE integrations SET status='disconnected', access_token=NULL, refresh_token=NULL, updated_at=NOW() WHERE id=$1`,
          [row.id]
        ).catch(e => logger.warn('Jobber disconnect DB update error:', e.message));
        await query(
          `INSERT INTO audit_log (customer_id, action, details)
           VALUES ($1, 'integration_disconnected', '{"provider":"jobber","source":"jobber"}'::jsonb)`,
          [row.customer_id]
        ).catch(() => {});
        logger.info(`Jobber APP_DISCONNECT: marked disconnected for location ${row.location_id}`);
      }
      return;
    }

    // ── Job completion → review request ──────────────────────────────────────
    // The webhook only carries itemId + accountId, so we fetch the job's client
    // from Jobber's GraphQL API. NOTE: confirm the exact job-completion topic
    // name and the job→client field path against your app's Jobber schema.
    if (topic === 'JOB_CLOSED' || topic === 'JOB_COMPLETE' || topic === 'JOB_CLOSE' || topic === 'JOB_COMPLETED') {
      const integ = await query(
        `SELECT i.*, l.customer_id FROM integrations i JOIN locations l ON l.id=i.location_id
          WHERE i.provider='jobber' AND i.status='connected' AND i.external_account_id=$1 LIMIT 1`,
        [String(accountId)]
      );
      if (!integ.rows.length) { logger.warn(`Jobber webhook: no integration for account ${accountId}`); return; }
      const integration = integ.rows[0];

      const extId = `jobber_job_${itemId}`;
      if (await isDuplicate('jobber', extId)) return;

      const jobRes = await fetch(JOBBER_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${integration.access_token}`,
          'Content-Type':  'application/json',
          ...(JOBBER_API_VERSION ? { 'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION } : {}),
        },
        body: JSON.stringify({
          query: `query($id: EncodedId!) { job(id: $id) { client { name emails { address } phones { number } } } }`,
          variables: { id: itemId },
        }),
      });
      const jobJson = await jobRes.json();
      const client  = jobJson?.data?.job?.client;
      const email   = client?.emails?.[0]?.address;
      if (!client || !email) { logger.warn('Jobber webhook: no client email for job ' + itemId); return; }

      const eventId = await logEvent(integration.id, 'jobber', topic, extId, body);
      await triggerReviewRequest(integration, {
        name:  client.name || email.split('@')[0] || 'Customer',
        email,
        phone: client?.phones?.[0]?.number || null,
      }, eventId, { sendAt: delayedSendAt(integration) });
      logger.info(`Jobber ${topic}: review request triggered for ${email}`);
      return;
    }

    // Other topics (e.g. APP_CONNECT) — no action needed.
  } catch (err) {
    logger.error('Jobber webhook processing error:', err.message);
    captureError(err, { where: 'jobber-webhook', topic });
  }
});

// POST /api/integrations/jobber/refresh
// Refresh access token using refresh token
router.post('/jobber/refresh', authenticateToken, async (req, res) => {
  try {
    const { locationId } = req.body;

    const result = await query(
      `SELECT refresh_token FROM integrations WHERE location_id=$1 AND provider='jobber'`,
      [locationId]
    );

    if (!result.rows.length || !result.rows[0].refresh_token) {
      return res.status(404).json({ error: 'No refresh token found' });
    }

    const tokenRes = await fetch(JOBBER_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     process.env.JOBBER_CLIENT_ID,
        client_secret: process.env.JOBBER_CLIENT_SECRET,
        refresh_token: safeDecrypt(result.rows[0].refresh_token),
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokens.access_token) return res.status(400).json({ error: 'Refresh failed' });

    await query(
      `UPDATE integrations SET access_token=$1, refresh_token=$2, updated_at=NOW()
       WHERE location_id=$3 AND provider='jobber'`,
      [encrypt(tokens.access_token), tokens.refresh_token ? encrypt(tokens.refresh_token) : result.rows[0].refresh_token, locationId]
    );

    res.json({ success: true });
  } catch (err) {
    logger.error('Jobber refresh error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── JOBBER OUR-SIDE DISCONNECT HELPER ─────────────────────────────────────────
// When a user disconnects Jobber from WITHIN SwarmReply (our UI), we must notify
// Jobber via the appDisconnect mutation so it shows as disconnected on their
// side too. Jobber-INITIATED disconnects instead arrive via the APP_DISCONNECT
// webhook above and need no mutation — Jobber has already invalidated the tokens.
async function jobberAppDisconnect(accessToken) {
  if (!accessToken) return;
  try {
    await fetch(JOBBER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':  'application/json',
        ...(JOBBER_API_VERSION ? { 'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION } : {}),
      },
      body: JSON.stringify({
        query: `mutation { appDisconnect { app { id name } userErrors { message } } }`,
      }),
    });
  } catch (e) {
    logger.warn('Jobber appDisconnect mutation error:', e.message);
  }
}

// ── JOBBER RECONNECT AFTER DISCONNECT ─────────────────────────────────────────
// If a user disconnects and reconnects, the /jobber/callback route handles it
// via the ON CONFLICT upsert — no extra code needed. The disconnect above
// sets status='disconnected' so the callback will UPDATE the existing row
// back to 'connected' with fresh tokens.

// ── EXPORTS ───────────────────────────────────────────────────────────────────
// B8: moved to end of file so every route above (including the entire Jobber
// section) is attached to `router` before it is exported.
module.exports = { router, handleStripePaymentForReview };
