// ============================================
// routes/admin.js
// Admin API routes — internal use only
// Protected by admin JWT middleware
// ============================================

const express = require('express');
const router  = express.Router();
const { query } = require('../database/db');
const logger  = require('../utils/logger');
const jwt     = require('jsonwebtoken');
const { authenticator } = require('otplib');
const bcrypt  = require('bcryptjs');
const QRCode  = require('qrcode');
const { estimateMonthly, syncLocationBilling } = require('../services/locationBilling');

// ── ADMIN AUTH MIDDLEWARE ─────────────────────
// Admin-panel tokens carry scope:'admin'. Customer tokens never do (they have
// roles like 'owner'/'manager'/'staff' but no admin scope), so they can't reach
// these endpoints. The env owner uses role:'superadmin' (also accepted).
function decodeAuth(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  try { return jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET, { algorithms: ['HS256'] }); }
  catch (e) { return null; }
}

function requireAdmin(req, res, next) {
  const d = decodeAuth(req);
  if (!d) return res.status(401).json({ error: 'Unauthorized' });
  if (d.scope !== 'admin' && d.role !== 'superadmin') return res.status(403).json({ error: 'Forbidden' });
  req.admin = d;
  next();
}

// Owner-only (env owner, or a DB admin whose role is 'owner').
function requireOwner(req, res, next) {
  const d = decodeAuth(req);
  if (!d) return res.status(401).json({ error: 'Unauthorized' });
  const isOwner = d.role === 'superadmin' || (d.scope === 'admin' && d.role === 'owner');
  if (!isOwner) return res.status(403).json({ error: 'Owner access required' });
  req.admin = d;
  next();
}

// Short-lived provisional token used only during first-login account setup.
function requireSetup(req, res, next) {
  const d = decodeAuth(req);
  if (!d || d.scope !== 'admin_setup' || !d.sub) return res.status(401).json({ error: 'Setup session expired' });
  req.setupUser = d;
  next();
}

// A valid-format bcrypt hash to compare against when no user is found, so login
// timing doesn't leak whether an email exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);
function genTempPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12) + '!7';
}
async function adminAudit(action, details) {
  try { await query('INSERT INTO audit_log (customer_id, action, details) VALUES ($1,$2,$3)', [null, action, JSON.stringify(details || {})]); }
  catch (e) { /* audit is best-effort; never block the operation */ }
}

// ── ADMIN LOGIN ───────────────────────────────
// POST /api/admin/login
// Credentials MUST come from env (ADMIN_EMAIL / ADMIN_PASSWORD). No fallbacks —
// fail closed if unset so a secret is never baked into source.
const crypto = require('crypto');
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

router.post('/login', async (req, res) => {
  const { email, password, code } = req.body || {};
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  const ADMIN_PASS  = process.env.ADMIN_PASSWORD;

  if (!ADMIN_EMAIL || !ADMIN_PASS) {
    logger.error('Admin login attempted but ADMIN_EMAIL/ADMIN_PASSWORD are not configured');
    return res.status(500).json({ error: 'Admin login is not configured' });
  }

  const emailIn = typeof email === 'string' ? email.toLowerCase().trim() : '';
  const isEnvOwner = emailIn === ADMIN_EMAIL.toLowerCase().trim();

  // ── 1. ENV OWNER (the permanent, un-lockoutable account) ──────────
  if (isEnvOwner) {
    const passOk = typeof password === 'string' && safeEqual(password, ADMIN_PASS);
    if (!passOk) return res.status(401).json({ error: 'Invalid credentials' });

    // Second factor — enforced only once ADMIN_TOTP_SECRET is set in the env.
    const totpSecret = process.env.ADMIN_TOTP_SECRET;
    if (totpSecret) {
      const t = code != null ? String(code).trim() : '';
      if (!/^\d{6}$/.test(t)) return res.status(401).json({ error: 'Authenticator code required', twofa: true });
      let valid = false;
      try { valid = authenticator.verify({ token: t, secret: totpSecret }); } catch (e) { valid = false; }
      if (!valid) return res.status(401).json({ error: 'Invalid authenticator code', twofa: true });
    }

    const token = jwt.sign(
      { email: ADMIN_EMAIL, role: 'superadmin', scope: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );
    logger.info(`Admin login (env owner): ${ADMIN_EMAIL}`);
    return res.json({ token });
  }

  // ── 2. DB ADMIN USER (employees / co-founder) ─────────────────────
  let user = null;
  try {
    const r = await query('SELECT * FROM admin_users WHERE LOWER(email) = $1', [emailIn]);
    user = r.rows[0] || null;
  } catch (e) {
    // Table may not exist yet (migration not run) — treat as no DB users.
    logger.error('admin_users lookup failed: ' + e.message);
  }

  // Compare against a dummy hash when no user, so timing doesn't leak existence.
  const passwordValid = await bcrypt.compare(String(password || ''), user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordValid) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.status !== 'active') return res.status(403).json({ error: 'This admin account has been suspended. Contact the owner.' });

  // First login: must set their own password and/or enrol their own 2FA.
  if (user.must_change_password || user.must_setup_2fa || !user.totp_secret) {
    const setupToken = jwt.sign(
      { sub: user.id, email: user.email, scope: 'admin_setup' },
      process.env.JWT_SECRET,
      { expiresIn: '20m' }
    );
    return res.json({
      setupToken,
      mustChangePassword: !!user.must_change_password,
      mustSetup2fa: !!(user.must_setup_2fa || !user.totp_secret),
      name: user.name || ''
    });
  }

  // Normal login: per-user 2FA is required.
  const t = code != null ? String(code).trim() : '';
  if (!/^\d{6}$/.test(t)) return res.status(401).json({ error: 'Authenticator code required', twofa: true });
  let valid = false;
  try { valid = authenticator.verify({ token: t, secret: user.totp_secret }); } catch (e) { valid = false; }
  if (!valid) return res.status(401).json({ error: 'Invalid authenticator code', twofa: true });

  try { await query('UPDATE admin_users SET last_login_at = NOW() WHERE id = $1', [user.id]); } catch (e) {}
  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, scope: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
  logger.info(`Admin login (db user): ${user.email} [${user.role}]`);
  res.json({ token });
});

// ── FIRST-LOGIN ACCOUNT SETUP (provisional token only) ────────────
// Set a new password.
router.post('/account/setup-password', requireSetup, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 10) {
    return res.status(400).json({ error: 'Password must be at least 10 characters.' });
  }
  const hash = await bcrypt.hash(String(newPassword), 12);
  await query('UPDATE admin_users SET password_hash = $1, must_change_password = FALSE, updated_at = NOW() WHERE id = $2', [hash, req.setupUser.sub]);
  res.json({ success: true });
});

// Generate a 2FA secret + QR for this user (not saved until confirmed).
router.post('/account/setup-2fa', requireSetup, async (req, res) => {
  try {
    const secret  = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(req.setupUser.email || 'admin', 'SwarmReply Admin', secret);
    const qr      = await QRCode.toDataURL(otpauth, { margin: 1, width: 220 });
    res.json({ secret, qr });
  } catch (err) {
    res.status(500).json({ error: 'Could not generate a 2FA secret' });
  }
});

// Confirm the code, save the secret to this user, finish setup, return a real token.
router.post('/account/setup-2fa/confirm', requireSetup, async (req, res) => {
  const { secret, code } = req.body || {};
  const t = code != null ? String(code).trim() : '';
  if (!secret || !/^\d{6}$/.test(t)) return res.status(400).json({ error: 'A secret and 6-digit code are required.' });
  let valid = false;
  try { valid = authenticator.verify({ token: t, secret: String(secret).trim() }); } catch (e) { valid = false; }
  if (!valid) return res.json({ valid: false });

  const r = await query('SELECT email, role, must_change_password FROM admin_users WHERE id = $1', [req.setupUser.sub]);
  const u = r.rows[0];
  if (!u) return res.status(404).json({ error: 'Account not found.' });
  if (u.must_change_password) return res.status(400).json({ valid: false, error: 'Set your password first.' });

  await query('UPDATE admin_users SET totp_secret = $1, must_setup_2fa = FALSE, last_login_at = NOW(), updated_at = NOW() WHERE id = $2', [String(secret).trim(), req.setupUser.sub]);
  const token = jwt.sign(
    { sub: req.setupUser.sub, email: u.email, role: u.role, scope: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
  await adminAudit('admin_user_self_setup_complete', { id: req.setupUser.sub, email: u.email });
  res.json({ valid: true, token });
});

// Who am I? Lets the UI gate owner-only features.
router.get('/me', requireAdmin, (req, res) => {
  const role = req.admin.role || 'superadmin';
  res.json({
    email: req.admin.email,
    role,
    isOwner: role === 'superadmin' || role === 'owner',
    isEnvOwner: role === 'superadmin'
  });
});

// ── ADMIN 2FA (TOTP) ──────────────────────────
// Whether a second factor is currently enforced.
router.get('/2fa/status', requireAdmin, (req, res) => {
  res.json({ enabled: !!process.env.ADMIN_TOTP_SECRET });
});

// Generate a fresh secret + QR for enrollment. The secret is NOT active until the
// admin saves it as ADMIN_TOTP_SECRET in Railway, so this endpoint can't lock anyone
// out. The secret is generated server-side and never sent to any third party.
router.post('/2fa/setup', requireAdmin, async (req, res) => {
  try {
    const secret  = authenticator.generateSecret();
    const label   = process.env.ADMIN_EMAIL || 'admin';
    const otpauth = authenticator.keyuri(label, 'SwarmReply Admin', secret);
    const qr      = await QRCode.toDataURL(otpauth, { margin: 1, width: 220 });
    res.json({ secret, otpauth, qr });
  } catch (err) {
    logger.error('2fa setup error: ' + err.message);
    res.status(500).json({ error: 'Could not generate a 2FA secret' });
  }
});

// Confirm a code against a just-generated secret — lets the admin verify their
// authenticator works BEFORE they rely on it (does not persist anything).
router.post('/2fa/verify', requireAdmin, (req, res) => {
  const { secret, code } = req.body || {};
  if (!secret || !code) return res.status(400).json({ error: 'secret and code are required' });
  let valid = false;
  try { valid = authenticator.verify({ token: String(code).trim(), secret: String(secret).trim() }); } catch (e) { valid = false; }
  res.json({ valid });
});

// ── GET ALL CUSTOMERS ─────────────────────────
// GET /api/admin/customers
router.get('/customers', requireAdmin, async (req, res) => {
  try {
    // Customers with location counts and integration info
    const customers = await query(`
      SELECT
        c.id, c.email, c.name, c.plan, c.status,
        c.stripe_customer_id,
        COALESCE(c.stripe_subscription_id, '') as stripe_subscription_id,
        COALESCE(c.welcome_email_sent, false) as welcome_email_sent,
        c.created_at, c.updated_at,
        COALESCE(c.notes, '') as notes,
        COALESCE(c.flagged, false) as flagged,
        COALESCE(c.account_type, 'direct') as type,
        COALESCE(c.is_demo, false) as is_demo,
        COUNT(DISTINCT l.id) as location_count,
        MAX(l.last_synced_at) as last_synced,
        ARRAY_AGG(DISTINCT l.business_name) FILTER (WHERE l.business_name IS NOT NULL) as business_names,
        ARRAY_AGG(DISTINCT l.platform) FILTER (WHERE l.platform IS NOT NULL) as platforms
      FROM customers c
      LEFT JOIN locations l ON l.customer_id = c.id AND l.is_active = true
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);

    // Get integration data
    const integrations = await query(`
      SELECT l.customer_id, i.provider FROM integrations i JOIN locations l ON l.id = i.location_id WHERE i.status = 'connected'
    `).catch(() => ({ rows: [] }));

    // Get team member counts
    const teamCounts = await query(`
      SELECT customer_id, COUNT(*) as count FROM team_members GROUP BY customer_id
    `).catch(() => ({ rows: [] }));

    // Get last login per customer (from team_members)
    const lastLogins = await query(`
      SELECT customer_id, MAX(last_login_at) as last_login
      FROM team_members GROUP BY customer_id
    `).catch(() => ({ rows: [] }));

    // Get reply counts this month
    const replyCounts = await query(`
      SELECT l.customer_id, COUNT(r.id) as reply_count
      FROM replies r
      JOIN reviews rv ON rv.id = r.review_id
      JOIN locations l ON l.id = rv.location_id
      WHERE r.created_at >= date_trunc('month', NOW())
      AND r.status = 'posted'
      GROUP BY l.customer_id
    `).catch(() => ({ rows: [] }));

    // Merge all data
    const intMap    = {};
    const teamMap   = {};
    const loginMap  = {};
    const replyMap  = {};

    integrations.rows.forEach(i => {
      if (!intMap[i.customer_id]) intMap[i.customer_id] = [];
      intMap[i.customer_id].push(i.provider);
    });
    teamCounts.rows.forEach(t => teamMap[t.customer_id] = parseInt(t.count));
    lastLogins.rows.forEach(l => loginMap[l.customer_id] = l.last_login);
    replyCounts.rows.forEach(r => replyMap[r.customer_id] = parseInt(r.reply_count));

    const enriched = customers.rows.map(c => {
      const locs = parseInt(c.location_count) || 0;
      // MRR from the shared graduated pricing model (single source of truth).
      let mrr = 0;
      if (c.status === 'active' && !c.is_demo && locs >= 1) {
        mrr = estimateMonthly(locs);
      }

      return {
        ...c,
        location_count: locs,
        mrr,
        integrations: intMap[c.id] || [],
        team_member_count: teamMap[c.id] || 0,
        last_login: loginMap[c.id] || null,
        replies_this_month: replyMap[c.id] || 0,
        google_connected: (c.platforms || []).includes('google'),
      };
    });

    // Aggregate stats
    const active   = enriched.filter(c => c.status === 'active' && !c.is_demo);
    const totalMrr = active.reduce((s, c) => s + c.mrr, 0);
    const thisMonth = new Date();
    thisMonth.setDate(1); thisMonth.setHours(0,0,0,0);
    const newThisMonth = enriched.filter(c => new Date(c.created_at) >= thisMonth).length;

    // Audit log
    const auditLog = await query(`
      SELECT
        to_char(al.created_at, 'Mon DD HH24:MI') as time,
        al.action as action,
        c.name as customer,
        al.details as detail,
        al.created_at
      FROM audit_log al
      LEFT JOIN customers c ON c.id = al.customer_id
      ORDER BY al.created_at DESC
      LIMIT 50
    `).catch(() => ({ rows: [] }));

    res.json({
      customers: enriched,
      totalMrr,
      totalLocations: active.reduce((s, c) => s + c.location_count, 0),
      newThisMonth,
      churnedCount: enriched.filter(c => c.status === 'cancelled').length,
      auditLog: auditLog.rows,
    });

  } catch (err) {
    logger.error('Admin customers error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET SINGLE CUSTOMER ───────────────────────
// GET /api/admin/customers/:id
router.get('/customers/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const customer = await query('SELECT * FROM customers WHERE id = $1', [id]);
    if (!customer.rows.length) return res.status(404).json({ error: 'Not found' });

    const locations = await query(
      'SELECT * FROM locations WHERE customer_id = $1 ORDER BY created_at',
      [id]
    ).catch(() => ({ rows: [] }));

    const team = await query(
      'SELECT id, name, email, role, status, last_login_at FROM team_members WHERE customer_id = $1',
      [id]
    ).catch(() => ({ rows: [] }));

    const integrations = await query(
      `SELECT i.provider, i.status, i.created_at
         FROM integrations i JOIN locations l ON l.id = i.location_id
        WHERE l.customer_id = $1`,
      [id]
    ).catch(() => ({ rows: [] }));

    const recentEvents = await query(`
      SELECT action as text, created_at as time, details as detail
      FROM audit_log WHERE customer_id = $1
      ORDER BY created_at DESC LIMIT 10
    `, [id]).catch(() => ({ rows: [] }));

    res.json({
      ...customer.rows[0],
      locations: locations.rows,
      team_members: team.rows,
      integrations: integrations.rows.map(i => i.provider),
      recent_events: recentEvents.rows,
    });

  } catch (err) {
    logger.error('Admin customer detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── UPDATE CUSTOMER STATUS ────────────────────
// PATCH /api/admin/customers/:id/status
router.patch('/customers/:id/status', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const valid = ['active', 'paused', 'cancelled', 'trial'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    await query(
      'UPDATE customers SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, id]
    );

    // Log action
    await query(
      'INSERT INTO audit_log (customer_id, action, details) VALUES ($1, $2, $3)',
      [id, 'admin_status_change', JSON.stringify({ status, admin: req.admin.email })]
    ).catch(() => {});

    logger.info(`Admin status change: customer ${id} → ${status}`);
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get Found scan controls ──────────────────────────────────────────────
// Pause or resume the weekly auto-scans (AI Visibility and/or Rank Tracking).
router.patch('/customers/:id/get-found', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const sets = [];
    const vals = [];
    let i = 1;
    if (typeof req.body.aiScansEnabled === 'boolean')   { sets.push(`ai_scans_enabled = $${i++}`);   vals.push(req.body.aiScansEnabled); }
    if (typeof req.body.rankScansEnabled === 'boolean') { sets.push(`rank_scans_enabled = $${i++}`); vals.push(req.body.rankScansEnabled); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(id);
    const r = await query(
      `UPDATE customers SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${i}
        RETURNING ai_scans_enabled, rank_scans_enabled`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Customer not found' });
    await query(
      'INSERT INTO audit_log (customer_id, action, details) VALUES ($1, $2, $3)',
      [id, 'admin_get_found_toggle', JSON.stringify({ ...req.body, admin: req.admin.email })]
    ).catch(() => {});
    logger.info(`Admin Get Found toggle: customer ${id} → ${JSON.stringify(r.rows[0])}`);
    res.json({ success: true, ...r.rows[0] });
  } catch (err) {
    logger.error('Admin get-found toggle error: ' + err.message);
    res.status(500).json({ error: 'Failed to update scan settings' });
  }
});

// Reset the searches behind Get Found. target: 'ai' | 'rank' | 'both'.
// 'ai'  → clears the AI Visibility queries and nulls the scan clock (so the
//          weekly scheduler skips this account until a fresh scan is run).
// 'rank'→ deactivates every rank keyword across the account's locations.
// Either way, the corresponding auto-scans stop.
router.post('/customers/:id/get-found/reset', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const target = req.body.target || 'both';
    const done = [];
    if (target === 'ai' || target === 'both') {
      await query(`UPDATE llm_settings SET custom_queries = '[]' WHERE customer_id = $1`, [id]).catch(() => {});
      await query(`UPDATE llm_reports SET last_scan_at = NULL WHERE customer_id = $1`, [id]).catch(() => {});
      done.push('ai');
    }
    if (target === 'rank' || target === 'both') {
      await query(
        `UPDATE rank_keywords SET active = false
          WHERE location_id IN (SELECT id FROM locations WHERE customer_id = $1)`,
        [id]
      ).catch(() => {});
      done.push('rank');
    }
    await query(
      'INSERT INTO audit_log (customer_id, action, details) VALUES ($1, $2, $3)',
      [id, 'admin_get_found_reset', JSON.stringify({ target, admin: req.admin.email })]
    ).catch(() => {});
    logger.info(`Admin Get Found reset: customer ${id} → ${done.join(', ')}`);
    res.json({ success: true, reset: done });
  } catch (err) {
    logger.error('Admin get-found reset error: ' + err.message);
    res.status(500).json({ error: 'Failed to reset searches' });
  }
});

// ── UPDATE NOTES ──────────────────────────────
// PATCH /api/admin/customers/:id/notes
router.patch('/customers/:id/notes', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    await query(
      'UPDATE customers SET notes = $1, updated_at = NOW() WHERE id = $2',
      [notes, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── UPDATE FLAG ───────────────────────────────
// PATCH /api/admin/customers/:id/flag
router.patch('/customers/:id/flag', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { flagged } = req.body;
    await query(
      'UPDATE customers SET flagged = $1, updated_at = NOW() WHERE id = $2',
      [flagged, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CREATE CUSTOMER ───────────────────────────
// POST /api/admin/customers
router.post('/customers', requireAdmin, async (req, res) => {
  try {
    const name  = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const { plan, type, is_demo } = req.body;

    // Reject malformed emails (commas, spaces, missing TLD, etc.) so a typo can't
    // create an unreachable account that can never log in or reset its password.
    if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (!name) return res.status(400).json({ error: 'Name is required.' });

    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const tempPass = crypto.randomBytes(8).toString('hex');
    const hash = await bcrypt.hash(tempPass, 12);

    const result = await query(
      `INSERT INTO customers
        (email, name, password_hash, plan, status)
       VALUES ($1,$2,$3,$4,'active') RETURNING id`,
      [email, name, hash, plan||'starter']
    );

    await query(
      'INSERT INTO audit_log (customer_id, action, details) VALUES ($1,$2,$3)',
      [result.rows[0].id, 'admin_created', JSON.stringify({ admin: req.admin.email })]
    ).catch(() => {});

    res.json({ success: true, id: result.rows[0].id, tempPassword: tempPass });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A customer with that email already exists.' });
    res.status(500).json({ error: err.message });
  }
});

// ── ADD LOCATION TO A CUSTOMER ────────────────
// POST /api/admin/customers/:id/locations
router.post('/customers/:id/locations', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const businessName = (req.body.business_name || req.body.name || '').trim();
    const platform     = (req.body.platform || 'google').trim();
    if (!businessName) return res.status(400).json({ error: 'Business name is required.' });

    const cust = await query('SELECT id FROM customers WHERE id=$1', [id]);
    if (!cust.rows.length) return res.status(404).json({ error: 'Customer not found' });

    const result = await query(
      `INSERT INTO locations (customer_id, business_name, platform, platform_location_id, is_active)
       VALUES ($1,$2,$3,'manual_' || gen_random_uuid()::text,true) RETURNING id, business_name, platform`,
      [id, businessName, platform]
    );
    await query('INSERT INTO audit_log (customer_id, action, details) VALUES ($1,$2,$3)',
      [id, 'admin_add_location', JSON.stringify({ admin: req.admin.email, business_name: businessName })]).catch(() => {});
    res.json({ success: true, location: result.rows[0] });
  } catch (err) {
    logger.error('admin add-location failed: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ADD USER (TEAM MEMBER) TO A CUSTOMER ──────
// POST /api/admin/customers/:id/users
router.post('/customers/:id/users', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const name  = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const role  = ['admin', 'manager', 'staff'].includes(req.body.role) ? req.body.role : 'staff';

    if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (!name) return res.status(400).json({ error: 'Name is required.' });

    const cust = await query('SELECT id FROM customers WHERE id=$1', [id]);
    if (!cust.rows.length) return res.status(404).json({ error: 'Customer not found' });

    // Reject duplicates with a clear message (mirrors the team-invite flow).
    const dupe = await query(
      'SELECT id FROM team_members WHERE customer_id=$1 AND LOWER(email)=$2',
      [id, email]
    ).catch(() => ({ rows: [] }));
    if (dupe.rows.length) return res.status(409).json({ error: 'A user with that email already exists for this customer.' });

    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const tempPass    = crypto.randomBytes(8).toString('hex');
    const hash        = await bcrypt.hash(tempPass, 12);
    const inviteToken = crypto.randomBytes(16).toString('hex');

    // Insert using the live team-invite column set, MINUS created_by: that column
    // is a UUID (references a user id) and the admin only has an email, not a UUID.
    // The admin's identity is recorded in audit_log below instead.
    const result = await query(
      `INSERT INTO team_members
         (customer_id, email, name, role, invite_token, invite_sent_at, status)
       VALUES ($1,$2,$3,$4,$5,NOW(),'invited') RETURNING id`,
      [id, email, name, role, inviteToken]
    );
    const newId = result.rows[0].id;
    await query('UPDATE team_members SET password_hash=$1 WHERE id=$2', [hash, newId])
      .catch(e => logger.error('add-user set password failed: ' + e.message));
    await query("UPDATE team_members SET status='active' WHERE id=$1", [newId])
      .catch(e => logger.error('add-user activate failed (left as invited): ' + e.message));

    await query('INSERT INTO audit_log (customer_id, action, details) VALUES ($1,$2,$3)',
      [id, 'admin_add_user', JSON.stringify({ admin: req.admin.email, email, role })]).catch(() => {});
    res.json({ success: true, id: newId, tempPassword: tempPass });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with that email already exists for this customer.' });
    logger.error('admin add-user failed: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// ADMIN EDITS — Tier 1 & 2 (support / account management)
// All gated by requireAdmin. These mirror the customer-facing endpoints but
// are NOT scoped to a token's own customer, so an admin can edit any account.
// ─────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}$/;

// PATCH /api/admin/customers/:id/account — name / email / alert preferences
router.patch('/customers/:id/account', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, email, notificationPrefs } = req.body || {};
  if (email !== undefined && !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  try {
    const sets = [], params = [];
    let i = 1;
    if (name !== undefined)              { sets.push(`name=$${i++}`);               params.push(name); }
    if (email !== undefined)             { sets.push(`email=$${i++}`);              params.push(email.toLowerCase().trim()); }
    if (notificationPrefs !== undefined) { sets.push(`notification_prefs=$${i++}`); params.push(JSON.stringify(notificationPrefs)); }
    if (!sets.length) return res.json({ success: true });
    params.push(id);
    await query(`UPDATE customers SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${i}`, params);
    await query('INSERT INTO audit_log (customer_id, action, details) VALUES ($1,$2,$3)',
      [id, 'admin_edit_account', JSON.stringify({ admin: req.admin.email, fields: Object.keys(req.body || {}) })]).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That email is already in use.' });
    logger.error('admin edit account error: ' + err.message);
    res.status(500).json({ error: 'Could not update account' });
  }
});

// PUT /api/admin/locations/:locId — edit a single location's fields
// (business name/type, contact email, tone, custom instructions, auto-reply, active)
router.put('/locations/:locId', requireAdmin, async (req, res) => {
  const { locId } = req.params;
  const { businessName, businessType, contactEmail, tone, customInstructions, autoReply, isActive, city, state } = req.body || {};
  if (contactEmail !== undefined && contactEmail && !EMAIL_RE.test(contactEmail)) {
    return res.status(400).json({ error: 'Please enter a valid contact email.' });
  }
  try {
    const owner = await query('SELECT customer_id, refresh_token FROM locations WHERE id=$1', [locId]);
    if (!owner.rows.length) return res.status(404).json({ error: 'Location not found' });
    const customerId = owner.rows[0].customer_id;
    const hasGoogle = !!owner.rows[0].refresh_token;

    const sets = [], params = [];
    let i = 1;
    if (businessName       !== undefined) { sets.push(`business_name=$${i++}`);       params.push(businessName); }
    if (businessType       !== undefined) { sets.push(`business_type=$${i++}`);       params.push(businessType); }
    if (contactEmail       !== undefined) { sets.push(`contact_email=$${i++}`);       params.push(contactEmail || null); }
    if (tone               !== undefined) { sets.push(`tone=$${i++}`);                params.push(tone); }
    if (customInstructions !== undefined) { sets.push(`custom_instructions=$${i++}`); params.push(customInstructions || null); }
    if (autoReply          !== undefined) { sets.push(`auto_reply=$${i++}`);          params.push(!!autoReply); }
    if (isActive           !== undefined) { sets.push(`is_active=$${i++}`);           params.push(!!isActive); }
    if (city               !== undefined) { sets.push(`city=$${i++}`);                params.push(city || null); }
    if (state              !== undefined) { sets.push(`state=$${i++}`);               params.push(state || null); }

    // When an admin sets the location manually (no Google connection), clear any
    // cached coordinates so the next competitor scan re-resolves them from the new
    // city/state. For Google-connected locations we keep Google's exact coordinates.
    if ((city !== undefined || state !== undefined) && !hasGoogle) {
      sets.push('latitude=NULL', 'longitude=NULL', 'google_place_id=NULL');
    }

    if (!sets.length) return res.json({ success: true });

    params.push(locId);
    await query(`UPDATE locations SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${i}`, params);

    // Toggling a location active/inactive changes what the customer is billed for.
    if (isActive !== undefined) {
      try { await syncLocationBilling(customerId); } catch (e) { logger.error('billing resync after admin toggle: ' + e.message); }
    }
    await query('INSERT INTO audit_log (customer_id, action, details) VALUES ($1,$2,$3)',
      [customerId, 'admin_edit_location', JSON.stringify({ admin: req.admin.email, locId, fields: Object.keys(req.body || {}) })]).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    logger.error('admin edit location error: ' + err.message);
    res.status(500).json({ error: 'Could not update location' });
  }
});

// PUT /api/admin/locations/:locId/review-urls — edit a location's review links
router.put('/locations/:locId/review-urls', requireAdmin, async (req, res) => {
  const { locId } = req.params;
  const { googleReviewUrl, facebookReviewUrl, yelpReviewUrl } = req.body || {};
  try {
    const result = await query(
      `UPDATE locations
         SET google_review_url=$1, facebook_review_url=$2, yelp_review_url=$3, updated_at=NOW()
       WHERE id=$4 RETURNING customer_id`,
      [googleReviewUrl || null, facebookReviewUrl || null, yelpReviewUrl || null, locId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Location not found' });
    await query('INSERT INTO audit_log (customer_id, action, details) VALUES ($1,$2,$3)',
      [result.rows[0].customer_id, 'admin_edit_review_urls', JSON.stringify({ admin: req.admin.email, locId })]).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    logger.error('admin review-urls error: ' + err.message);
    res.status(500).json({ error: 'Could not update review links' });
  }
});

// PATCH /api/admin/team/:memberId/role — change a team member's role
router.patch('/team/:memberId/role', requireAdmin, async (req, res) => {
  const { memberId } = req.params;
  const { role } = req.body || {};
  if (!['admin', 'manager', 'staff'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const result = await query(
      `UPDATE team_members SET role=$2, updated_at=NOW() WHERE id=$1 RETURNING customer_id, name, role`,
      [memberId, role]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Team member not found' });
    await query('INSERT INTO audit_log (customer_id, action, details) VALUES ($1,$2,$3)',
      [result.rows[0].customer_id, 'admin_team_role', JSON.stringify({ admin: req.admin.email, memberId, role })]).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    logger.error('admin team role error: ' + err.message);
    res.status(500).json({ error: 'Could not change role' });
  }
});

// PATCH /api/admin/team/:memberId/suspend — suspend / reactivate a team member
router.patch('/team/:memberId/suspend', requireAdmin, async (req, res) => {
  const { memberId } = req.params;
  const { suspend } = req.body || {};
  try {
    const result = await query(
      `UPDATE team_members SET status=$2, updated_at=NOW() WHERE id=$1 RETURNING customer_id, name`,
      [memberId, suspend ? 'suspended' : 'active']
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Team member not found' });
    await query('INSERT INTO audit_log (customer_id, action, details) VALUES ($1,$2,$3)',
      [result.rows[0].customer_id, 'admin_team_suspend', JSON.stringify({ admin: req.admin.email, memberId, suspend: !!suspend })]).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    logger.error('admin team suspend error: ' + err.message);
    res.status(500).json({ error: 'Could not update member' });
  }
});

// DELETE /api/admin/team/:memberId — remove a team member
router.delete('/team/:memberId', requireAdmin, async (req, res) => {
  const { memberId } = req.params;
  try {
    const result = await query('DELETE FROM team_members WHERE id=$1 RETURNING customer_id, name', [memberId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Team member not found' });
    await query('INSERT INTO audit_log (customer_id, action, details) VALUES ($1,$2,$3)',
      [result.rows[0].customer_id, 'admin_team_remove', JSON.stringify({ admin: req.admin.email, memberId })]).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    logger.error('admin team remove error: ' + err.message);
    res.status(500).json({ error: 'Could not remove member' });
  }
});


// ── ADMIN USER MANAGEMENT (owner only) ────────────────────────────
const ADMIN_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// List all DB admin users.
router.get('/admin-users', requireOwner, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, email, name, role, status,
              (totp_secret IS NOT NULL) AS twofa_enabled,
              must_change_password, must_setup_2fa, last_login_at, created_at
         FROM admin_users ORDER BY created_at ASC`);
    res.json({ users: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Could not load admin users. Has the admin_users migration been run?' });
  }
});

// Create a new admin user with a temporary password (returned once).
router.post('/admin-users', requireOwner, async (req, res) => {
  const { email, name, role } = req.body || {};
  const e = String(email || '').toLowerCase().trim();
  if (!ADMIN_EMAIL_RE.test(e)) return res.status(400).json({ error: 'A valid email is required.' });
  const r = role === 'owner' ? 'owner' : 'member';
  const tempPassword = genTempPassword();
  const hash = await bcrypt.hash(tempPassword, 12);
  try {
    const ins = await query(
      `INSERT INTO admin_users (email, name, password_hash, role, status, must_change_password, must_setup_2fa)
       VALUES ($1,$2,$3,$4,'active',TRUE,TRUE) RETURNING id`,
      [e, (name || '').trim() || null, hash, r]);
    await adminAudit('admin_user_created', { id: ins.rows[0].id, email: e, role: r, by: req.admin.email });
    res.json({ success: true, id: ins.rows[0].id, email: e, role: r, tempPassword });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An admin user with that email already exists.' });
    res.status(500).json({ error: 'Could not create the admin user.' });
  }
});

// Change a user's role.
router.patch('/admin-users/:id/role', requireOwner, async (req, res) => {
  const role = req.body && req.body.role === 'owner' ? 'owner' : 'member';
  try {
    const r = await query('UPDATE admin_users SET role=$1, updated_at=NOW() WHERE id=$2 RETURNING email', [role, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Admin user not found.' });
    await adminAudit('admin_user_role_changed', { id: req.params.id, role, by: req.admin.email });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Could not update role.' }); }
});

// Suspend / reactivate. Owners can't suspend themselves.
router.patch('/admin-users/:id/suspend', requireOwner, async (req, res) => {
  if (req.admin.sub && req.admin.sub === req.params.id) return res.status(400).json({ error: 'You cannot suspend your own account.' });
  const status = req.body && req.body.status === 'active' ? 'active' : 'suspended';
  try {
    const r = await query('UPDATE admin_users SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING email', [status, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Admin user not found.' });
    await adminAudit('admin_user_' + status, { id: req.params.id, by: req.admin.email });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Could not update status.' }); }
});

// Issue a new temporary password (forces a password change at next login).
router.post('/admin-users/:id/reset-password', requireOwner, async (req, res) => {
  const tempPassword = genTempPassword();
  const hash = await bcrypt.hash(tempPassword, 12);
  try {
    const r = await query('UPDATE admin_users SET password_hash=$1, must_change_password=TRUE, updated_at=NOW() WHERE id=$2 RETURNING email', [hash, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Admin user not found.' });
    await adminAudit('admin_user_password_reset', { id: req.params.id, by: req.admin.email });
    res.json({ success: true, tempPassword });
  } catch (e) { res.status(500).json({ error: 'Could not reset password.' }); }
});

// Clear 2FA (forces re-enrolment at next login).
router.post('/admin-users/:id/reset-2fa', requireOwner, async (req, res) => {
  try {
    const r = await query('UPDATE admin_users SET totp_secret=NULL, must_setup_2fa=TRUE, updated_at=NOW() WHERE id=$1 RETURNING email', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Admin user not found.' });
    await adminAudit('admin_user_2fa_reset', { id: req.params.id, by: req.admin.email });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Could not reset 2FA.' }); }
});

// Remove an admin user. Owners can't remove themselves.
router.delete('/admin-users/:id', requireOwner, async (req, res) => {
  if (req.admin.sub && req.admin.sub === req.params.id) return res.status(400).json({ error: 'You cannot remove your own account.' });
  try {
    const r = await query('DELETE FROM admin_users WHERE id=$1 RETURNING email', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Admin user not found.' });
    await adminAudit('admin_user_deleted', { id: req.params.id, email: r.rows[0].email, by: req.admin.email });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Could not remove the admin user.' }); }
});


module.exports = router;

// ── DELETE CUSTOMER ───────────────────────────
// DELETE /api/admin/customers/:id
router.delete('/customers/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Get customer info for audit log before deleting
    const cust = await query('SELECT name, email, is_demo FROM customers WHERE id = $1', [id]);
    if (!cust.rows.length) return res.status(404).json({ error: 'Customer not found' });
    const { name, email, is_demo } = cust.rows[0];

    // Delete in dependency order
    await query('DELETE FROM replies WHERE review_id IN (SELECT id FROM reviews WHERE location_id IN (SELECT id FROM locations WHERE customer_id=$1))', [id]).catch(()=>{});
    await query('DELETE FROM reviews WHERE location_id IN (SELECT id FROM locations WHERE customer_id=$1)', [id]).catch(()=>{});
    await query('DELETE FROM locations WHERE customer_id=$1', [id]).catch(()=>{});
    await query('DELETE FROM integrations WHERE location_id IN (SELECT id FROM locations WHERE customer_id=$1)', [id]).catch(()=>{});
    await query('DELETE FROM team_members WHERE customer_id=$1', [id]).catch(()=>{});
    await query('DELETE FROM audit_log WHERE customer_id=$1', [id]).catch(()=>{});
    await query('DELETE FROM customers WHERE id=$1', [id]);

    logger.info(`Admin deleted customer: ${email} (demo: ${is_demo})`);
    res.json({ success: true, deleted: { name, email } });
  } catch (err) {
    logger.error('Delete customer error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── IMPERSONATE CUSTOMER ──────────────────────
// POST /api/admin/customers/:id/impersonate
// Returns a short-lived JWT the admin can use to log in as that customer
router.post('/customers/:id/impersonate', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const cust = await query(
      'SELECT id, email, name, plan, status, is_demo FROM customers WHERE id=$1',
      [id]
    );
    if (!cust.rows.length) return res.status(404).json({ error: 'Customer not found' });
    const c = cust.rows[0];

    // Generate a 2-hour impersonation token (same shape as normal customer JWT)
    const impToken = jwt.sign(
      { id: c.id, email: c.email, name: c.name, plan: c.plan, role: 'customer', impersonated_by: req.admin.email },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    // Audit log
    await query(
      'INSERT INTO audit_log (customer_id, action, details) VALUES ($1,$2,$3)',
      [id, 'admin_impersonate', JSON.stringify({ admin: req.admin.email, demo: c.is_demo })]
    ).catch(()=>{});

    logger.info(`Admin impersonated: ${c.email} by ${req.admin.email}`);
    res.json({ token: impToken, customer: { id: c.id, email: c.email, name: c.name, plan: c.plan, is_demo: c.is_demo } });
  } catch (err) {
    logger.error('Impersonate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── CREATE DEMO ACCOUNT ───────────────────────
// Demo seeding helpers + industry-specific mock content. A demo account is
// populated with realistic reviews, replies, contacts, requests, and NPS
// responses so the platform looks "live" during a sales demo for that
// customer type. All data is backdated so dashboard windows read naturally.
const DEMO_FIRST = ['James','Maria','David','Jennifer','Michael','Linda','Robert','Patricia','John','Sarah','William','Jessica','Carlos','Ashley','Daniel','Emily','Matthew','Amanda','Anthony','Stephanie','Mark','Nicole','Steven','Rachel','Andrew','Lauren','Joshua','Megan','Kevin','Hannah','Brian','Olivia','Eric','Grace','Jason','Sofia','Ryan','Victoria','Justin','Chloe'];
const DEMO_LAST  = ['Smith','Garcia','Johnson','Lee','Brown','Martinez','Davis','Rodriguez','Wilson','Nguyen','Anderson','Taylor','Thomas','Moore','Jackson','White','Harris','Martin','Thompson','Lopez','Hill','Scott','Green','Adams','Baker','Gonzalez','Nelson','Carter','Mitchell','Perez','Roberts','Turner','Phillips','Campbell','Parker','Evans','Collins','Stewart','Morris'];

function demoRand(min, max){ return Math.floor(Math.random() * (max - min + 1)) + min; }
function demoPick(arr){ return arr[Math.floor(Math.random() * arr.length)]; }
function demoWeighted(pairs){
  const total = pairs.reduce((s, p) => s + p[1], 0);
  let r = Math.random() * total;
  for (const [v, w] of pairs){ if ((r -= w) < 0) return v; }
  return pairs[pairs.length - 1][0];
}
function demoDaysAgo(days, jitterHours){
  return new Date(Date.now() - days * 86400000 - (jitterHours || 0) * 3600000);
}
function demoPeople(n){
  const out = [];
  for (let i = 0; i < n; i++){
    const f = demoPick(DEMO_FIRST), l = demoPick(DEMO_LAST);
    out.push({
      full:  f + ' ' + l,
      email: (f + '.' + l + demoRand(1, 99) + '@example.com').toLowerCase(),
      phone: '(555) ' + demoRand(200, 999) + '-' + demoRand(1000, 9999)
    });
  }
  return out;
}
function demoBulk(table, cols, rows){
  const params = [];
  const tuples = rows.map(row => {
    const ph = cols.map(c => { params.push(row[c] === undefined ? null : row[c]); return '$' + params.length; });
    return '(' + ph.join(',') + ')';
  });
  return { text: 'INSERT INTO ' + table + ' (' + cols.join(',') + ') VALUES ' + tuples.join(','), params };
}

const DEMO_INDUSTRY = {
  'Restaurant':    { code: 'restaurant', healthcare: false },
  'Dental':        { code: 'dental',     healthcare: true  },
  'Gym / Fitness': { code: 'fitness',    healthcare: false },
  'Salon / Spa':   { code: 'salon',      healthcare: false },
  'Auto Shop':     { code: 'automotive', healthcare: false },
  'Medical':       { code: 'medical',    healthcare: true  },
  'Other':         { code: 'other',      healthcare: false }
};

const DEMO_REVIEWS = {
  'Restaurant': {
    pos: [
      "Absolutely incredible meal. The pasta was cooked perfectly and our server was so attentive all night.",
      "Best brunch in town! The avocado toast and fresh juice were amazing, and the patio is gorgeous.",
      "We come here every Friday. Consistently great food, friendly staff, and a welcoming atmosphere.",
      "They sent out a complimentary appetizer for our anniversary, such a thoughtful touch. Food was outstanding.",
      "Hands down the best burger I have had. Juicy, flavorful, and the fries are addictive.",
      "Great date-night spot. Cozy lighting, excellent wine list, and the dessert was the perfect ending.",
      "Service was quick even though they were packed. Everything came out hot and delicious.",
      "The seasonal menu never disappoints. Fresh ingredients and creative dishes every single time.",
      "Took my parents here and they loved it. Generous portions and the staff made us feel at home."
    ],
    neu: [
      "Food was good but the wait was longer than expected on a weeknight. Might come back when it is quieter.",
      "Decent meal overall. Some dishes were better than others, the entrees shined more than the starters.",
      "Nice spot but a little pricey for the portion sizes. The flavor was definitely there though."
    ],
    neg: [
      "Disappointed this visit. Our order came out wrong twice and the table next to us was served first.",
      "The food was cold by the time it reached us and the server seemed overwhelmed. Hope they staff up.",
      "Waited 40 minutes for a table we reserved ahead of time. The food did not make up for it."
    ]
  },
  'Dental': {
    pos: [
      "The dentist made my root canal completely painless. The whole team is gentle and reassuring.",
      "Best dental experience I have had. They explained every step and never made me feel rushed.",
      "The hygienist was thorough and friendly, and the office is spotless. My teeth have never felt cleaner.",
      "They got me in same-day for a chipped tooth and fixed it perfectly. So grateful for the quick care.",
      "My kids actually look forward to their cleanings here. The staff is wonderful with nervous patients.",
      "Transparent about pricing and insurance up front. No surprises, just great care.",
      "Switched to this practice last year and could not be happier. Modern equipment and a caring team.",
      "Painless cleaning, and they caught an issue early that saved me a much bigger problem later.",
      "Gentle, professional, and genuinely kind. They put my anxiety at ease immediately."
    ],
    neu: [
      "Good care but the wait past my appointment time was a bit long. The cleaning itself was great.",
      "Solid dental office. Staff is friendly, though scheduling took a couple tries for a convenient slot.",
      "Competent and clean, just wish the billing explanation had been clearer up front."
    ],
    neg: [
      "Waited almost an hour past my appointment and felt rushed once I was seen. Expected better.",
      "Billing was confusing and I was charged more than the estimate. The dental work itself was fine.",
      "Hard to get someone on the phone to reschedule, and I had to call back several times."
    ]
  },
  'Gym / Fitness': {
    pos: [
      "Love this gym! Equipment is always clean and the trainers genuinely care about your progress.",
      "The group classes are fantastic, high-energy instructors and a welcoming community.",
      "Signed up three months ago and I am already seeing results. The personal training is worth every penny.",
      "Open 24/7, never too crowded, and the staff is friendly every single time I come in.",
      "Best fitness investment I have made. Great variety of machines and free weights.",
      "The trainers built me a plan that actually fits my schedule. So motivating.",
      "Clean locker rooms, modern equipment, and a positive vibe. Highly recommend.",
      "My favorite part is the community, everyone encourages each other. Made working out fun again.",
      "The staff helped me feel comfortable as a beginner. No judgment, just support."
    ],
    neu: [
      "Good gym overall but it gets crowded right after work. Early mornings are much better.",
      "Solid equipment selection, though a couple machines have been out of order for a while.",
      "Nice facility and friendly staff, just wish they offered more evening classes."
    ],
    neg: [
      "Cancelled my membership because half the treadmills were broken for weeks. Disappointing.",
      "Way too crowded at peak hours and hard to get on equipment. Front desk was not very helpful.",
      "Signed up and then struggled to get the onboarding session I was promised."
    ]
  },
  'Salon / Spa': {
    pos: [
      "Best haircut I have had in years! My stylist really listened to exactly what I wanted.",
      "The massage was incredibly relaxing and the spa atmosphere is so peaceful. Already booked my next visit.",
      "My colorist is a genius, exactly the shade I asked for and it looks so natural.",
      "Pampered from the moment I walked in. The staff is warm and the facial left my skin glowing.",
      "Such a relaxing experience. Clean, beautiful space and the most talented team.",
      "I always leave feeling refreshed and looking my best. Worth every minute.",
      "They fixed a color disaster from another salon and I could not be happier. True professionals.",
      "The manicure lasted three weeks without chipping. Best in town, hands down.",
      "My stylist remembered exactly how I like my cut from last time. That personal touch means a lot."
    ],
    neu: [
      "Nice salon and good results, but my appointment ran behind by about 20 minutes.",
      "Lovely atmosphere, though it is on the pricier side. The service itself was good.",
      "Happy with my cut, just wish parking nearby was a little easier."
    ],
    neg: [
      "My color came out nothing like the photo I showed and I had to come back to fix it.",
      "Waited well past my appointment time and felt rushed. Not the relaxing experience I hoped for.",
      "Booking online was glitchy and my appointment did not get saved the first time."
    ]
  },
  'Auto Shop': {
    pos: [
      "Honest, fast, and fair. They fixed my brakes the same day and did not upsell me on anything.",
      "Finally a mechanic I trust. They explained the repair clearly and the price was exactly as quoted.",
      "Got my oil change and tire rotation done quickly. Friendly staff and a clean waiting area.",
      "They diagnosed a problem two other shops missed. Saved me hundreds. Customer for life.",
      "Quick turnaround on my transmission work and they kept me updated the whole time.",
      "Fair pricing and they never make you feel pressured. Highly recommend for any repair.",
      "My car runs like new. Professional, honest, and reasonably priced.",
      "They squeezed me in for an emergency repair before a road trip. Lifesavers!",
      "The only shop I trust with my family cars. Reliable every single time."
    ],
    neu: [
      "Good work but it took a day longer than estimated. The repair itself was solid.",
      "Fair mechanics, though the waiting room could use an update. Service was fine.",
      "Decent experience overall, just wish they had called sooner with the estimate."
    ],
    neg: [
      "Charged me more than the original estimate without calling first. Not happy about that.",
      "Had to bring my car back twice for the same issue. Expected it fixed the first time.",
      "Took a while to get a callback about my appointment. The work was okay once done."
    ]
  },
  'Medical': {
    pos: [
      "The staff was compassionate and the wait time was short. The doctor really listened to my concerns.",
      "Best medical office I have been to. Caring providers and a smooth check-in process.",
      "They got me an appointment quickly and followed up afterward to check on me. Truly patient-focused.",
      "The whole team is kind and professional. I never feel rushed during my visits.",
      "Clean facility, friendly staff, and a doctor who takes time to explain everything.",
      "Made a stressful health situation so much easier with their patience and care.",
      "Online scheduling is easy and the nurses are wonderful. Highly recommend this practice.",
      "Short wait, attentive staff, and clear communication about my treatment plan.",
      "The front desk and nurses go above and beyond. A truly caring practice."
    ],
    neu: [
      "Good care but the wait was longer than I would like. The provider was attentive once I was seen.",
      "Competent and friendly staff, though getting through on the phone can take a while.",
      "Solid experience overall, just wish the follow-up instructions had been a bit clearer."
    ],
    neg: [
      "Waited over an hour past my appointment and felt rushed once I was finally seen.",
      "Hard to reach anyone by phone and my results took longer than promised to come through.",
      "Scheduling was frustrating and I had to call several times to confirm my visit."
    ]
  },
  'Other': {
    pos: [
      "Fantastic service from start to finish. The team was professional and exceeded my expectations.",
      "Could not be happier with the experience. Friendly, knowledgeable, and reliable.",
      "They went above and beyond to make sure I was taken care of. Highly recommend.",
      "Great communication and quality work. Will definitely be back.",
      "Professional, prompt, and a pleasure to work with. Five stars.",
      "Exceeded my expectations in every way. The staff is courteous and skilled.",
      "Reliable and trustworthy. They made the whole process easy and stress-free.",
      "Top-notch service and fair pricing. I recommend them to everyone I know.",
      "Excellent experience overall. Friendly staff and outstanding results."
    ],
    neu: [
      "Good service overall, though it took a little longer than I expected.",
      "Solid experience. A few small hiccups but the team handled them well.",
      "Happy with the outcome, just wish communication had been a bit quicker."
    ],
    neg: [
      "The service did not quite meet my expectations and communication was slow.",
      "Had a couple issues that took longer than I would like to resolve.",
      "Getting a response took several attempts. The end result was acceptable."
    ]
  }
};

const DEMO_REPLIES_POS = [
  "Thank you so much for the kind words, {first}! It means the world to our team. We hope to see you again soon.",
  "We are thrilled you had such a great experience, {first}! Thanks for taking the time to share it.",
  "This made our day, {first}! Thank you for the wonderful review and for choosing {biz}.",
  "So grateful for your support, {first}! Reviews like yours keep our whole team motivated. Thank you!",
  "Thank you, {first}! We are so happy we could deliver a great experience. Come back and see us soon.",
  "Wonderful to hear, {first}! We appreciate you and look forward to your next visit."
];
const DEMO_REPLIES_REC = [
  "Thank you for the honest feedback, {first}. We are sorry your experience fell short, and we would love the chance to make it right. Please reach out to us directly.",
  "We appreciate you letting us know, {first}. This is not the standard we hold ourselves to, and we are taking your comments seriously.",
  "Thank you for sharing, {first}. We are looking into what happened and would welcome the opportunity to do better next time."
];
const DEMO_DETRACTOR_Q1 = ["Long wait time","Service did not meet expectations","Communication could be better","Pricing was unclear","The issue was not fully resolved"];
const DEMO_DETRACTOR_Q2 = ["Faster service","Clearer communication","More appointment availability","Better follow-up after the visit","More upfront pricing"];

// POST /api/admin/demo
// Industry-specific social copy for the Campaigns demo (keyed by industry code).
const DEMO_SOCIAL = {
  restaurant: [
    "Tonight's special: house-made pappardelle with slow-braised short rib. Limited portions \u2014 come early! \ud83c\udf5d",
    "Now taking reservations for the long weekend. Book your table before they're gone \ud83c\udf77",
    "Behind every great plate is a great team. Thank you to our kitchen crew for another packed Saturday! \ud83d\udc4f",
    "New on the menu: a citrus burrata salad that tastes like spring. Come try it this week \ud83e\udd57",
    "Brunch is back every Sunday, 9am\u20132pm. Bottomless mimosas and the fluffiest pancakes in town \ud83e\udd5e",
    "Thank you for making us your neighborhood spot \u2014 500+ five-star reviews and counting \ud83d\ude4f",
  ],
  dental: [
    "Friendly reminder: most dental benefits reset at year-end. Book your cleaning before you lose them! \ud83e\uddb7",
    "New patients welcome! Your first visit includes a full exam and digital X-rays. Reserve your spot today.",
    "Coffee lover? 3 easy ways to keep your smile bright between visits \u2615\u2728",
    "We know dental visits can feel stressful \u2014 every room has noise-cancelling headphones and a cozy blanket.",
    "Meet our team: gentle, judgment-free care at every appointment \ud83d\ude0a",
    "Thank you to our amazing patients for trusting us with your smiles. We don't take it for granted!",
  ],
  fitness: [
    "New class alert: Sunrise HIIT, Tuesdays & Thursdays at 6am. Start your day strong \ud83d\udcaa",
    "Member spotlight: 6 months of consistency and it shows. So proud of you! \ud83d\udd25",
    "Bring a friend free all week \u2014 workouts are better together \ud83e\udd1d",
    "3 stretches to do after every workout to recover faster and feel better tomorrow \ud83e\uddd8",
    "New equipment just landed \u2014 come check out the upgraded racks and turf zone!",
    "Your only competition is who you were yesterday. See you on the floor \ud83d\udc5f",
  ],
  salon: [
    "Spring color we're loving: warm honey balayage \ud83c\udf6f Book your transformation this week!",
    "Swipe-worthy before & after \ud83d\udc87\u200d\u2640\ufe0f Tag a friend who needs a fresh look!",
    "Now carrying the full Olaplex lineup \u2014 ask your stylist which one's right for you.",
    "Gift cards available \u2014 the perfect last-minute gift for the people you love \ud83d\udc9d",
    "Booking up fast for the holidays. Reserve your color or blowout before the calendar fills \ud83d\udcc5",
    "Thank you for filling our chairs and our hearts this year \ud83d\udc95",
  ],
  automotive: [
    "Heading into winter? Now's the time for a battery and tire check. Stay safe out there \u2744\ufe0f",
    "Synthetic oil change special this month \u2014 quick, honest, done right. Book online!",
    "Check engine light on? Don't panic. Free diagnostic scan and a plain-English explanation.",
    "3 dashboard lights you should never ignore (and what they actually mean) \ud83d\udee0",
    "Same-day appointments open this week \u2014 give us a call and we'll get you back on the road.",
    "Thank you to our loyal customers. 5-star service isn't a slogan, it's the only way we work \ud83d\udd27",
  ],
  medical: [
    "Flu season is here \u2014 walk-in vaccines available. Protect yourself and those around you \ud83d\udc89",
    "Now accepting new patients! Same-week appointments and most major insurance accepted.",
    "5 simple habits that make the biggest difference for your heart health \u2764\ufe0f",
    "Telehealth visits now available for follow-ups and quick questions \ud83d\udcf1",
    "Meet our care team \u2014 here to listen, not rush. Your health is a partnership.",
    "Thank you for trusting us with your care. We're honored to serve this community \ud83d\ude4f",
  ],
  other: [
    "We're grateful for every customer who walks through our doors. Thank you for your support! \ud83d\ude4c",
    "Booking up fast this week \u2014 reach out to reserve your spot before we're full \ud83d\udcc5",
    "New this season: a few upgrades we think you'll love. Come see what's changed!",
    "A quick tip from our team to help you get the most out of your visit \ud83d\udca1",
    "Open this weekend! Stop by and say hello \u2014 we'd love to see you.",
    "500+ happy customers and counting. We don't take a single one for granted \u2b50",
  ],
};

router.post('/demo', requireAdmin, async (req, res) => {
  const crypto = require('crypto');
  const bcrypt = require('bcryptjs');
  const { randomUUID } = crypto;
  try {
    const { name, industry, location_count } = req.body;
    const ind     = DEMO_INDUSTRY[industry] || DEMO_INDUSTRY['Other'];
    const content = DEMO_REVIEWS[industry]  || DEMO_REVIEWS['Other'];
    const bizName = (name || '').trim() || 'Demo Account';
    const locs    = Math.min(Math.max(parseInt(location_count) || 1, 1), 25);

    const email    = `demo_${Date.now()}@demo.swarmreply.internal`;
    const tempPass = crypto.randomBytes(8).toString('hex');
    const hash     = await bcrypt.hash(tempPass, 12);

    // 1) Customer — flagged as a demo so it is excluded from live counts
    const cust = await query(
      `INSERT INTO customers (email, name, password_hash, plan, status, is_demo)
       VALUES ($1,$2,$3,'starter','active',true) RETURNING id`,
      [email, bizName, hash]
    );
    const custId = cust.rows[0].id;

    // 2) Location(s)
    const locIds = [];
    for (let i = 0; i < locs; i++){
      try {
        const r = await query(
          `INSERT INTO locations
            (customer_id, business_name, business_type, platform, platform_location_id,
             contact_email, tone, is_healthcare, is_active, billing_synced)
           VALUES ($1,$2,$3,'google',$4,$5,'warm',$6,true,true) RETURNING id`,
          [custId, locs > 1 ? `${bizName} — Location ${i+1}` : bizName, ind.code,
           'demo_loc_' + randomUUID(), email, ind.healthcare]
        );
        locIds.push(r.rows[0].id);
      } catch (e){ logger.error('demo location: ' + e.message); }
    }

    // Nothing more to seed without a location
    if (locIds.length){
      const NUM_CONTACTS = Math.min(20 + locs * 6, 60);
      const NUM_REVIEWS  = Math.min(28 + locs * 8, 70);
      const NUM_REQUESTS = Math.min(22 + locs * 6, 60);
      const NUM_SURVEYS  = Math.min(14 + locs * 3, 36);
      const people = demoPeople(Math.max(NUM_CONTACTS, NUM_REVIEWS, NUM_REQUESTS));

      // 3) Contacts
      try {
        const rows = people.slice(0, NUM_CONTACTS).map(p => ({
          customer_id: custId, name: p.full, email: p.email, phone: p.phone, segment: 'all'
        }));
        const q = demoBulk('contacts', ['customer_id','name','email','phone','segment'], rows);
        await query(q.text + ' ON CONFLICT DO NOTHING', q.params);
      } catch (e){ logger.error('demo contacts: ' + e.message); }

      // 4) Reviews (backdated, mostly replied) + 5) replies for replied ones
      let reviews = [];
      try {
        const rows = [];
        for (let i = 0; i < NUM_REVIEWS; i++){
          const rating = demoWeighted([[5,66],[4,23],[3,7],[2,2],[1,2]]);
          const bucket = rating >= 4 ? content.pos : rating === 3 ? content.neu : content.neg;
          // ~45% land in the last 30 days; the rest spread back across ~12
          // months with a recency bias, so the 12-month trend/velocity charts
          // show a full, naturally front-loaded curve.
          const created = demoDaysAgo(
            Math.random() < 0.45 ? demoRand(0,29) : 30 + Math.floor(Math.pow(Math.random(), 1.8) * 330),
            demoRand(0,23)
          );
          let status;
          if (rating <= 2)       status = demoWeighted([['flagged',35],['pending',40],['replied',25]]);
          else if (rating === 3) status = demoWeighted([['replied',75],['pending',25]]);
          else                   status = demoWeighted([['replied',82],['pending',18]]);
          rows.push({
            location_id: demoPick(locIds),
            platform: demoWeighted([['google',70],['facebook',22],['yelp',8]]),
            platform_review_id: 'demo_rev_' + randomUUID(),
            reviewer_name: demoPick(people).full,
            star_rating: rating,
            review_text: demoPick(bucket),
            review_date: created,
            created_at: created,
            status
          });
        }
        const q = demoBulk('reviews',
          ['location_id','platform','platform_review_id','reviewer_name','star_rating','review_text','review_date','created_at','status'],
          rows);
        reviews = (await query(q.text + ' RETURNING id, status, star_rating, reviewer_name, created_at', q.params)).rows;
      } catch (e){ logger.error('demo reviews: ' + e.message); }

      try {
        const replyRows = reviews.filter(r => r.status === 'replied').map(r => {
          const first = (r.reviewer_name || '').split(' ')[0] || 'there';
          const tpl = (r.star_rating >= 4 ? demoPick(DEMO_REPLIES_POS) : demoPick(DEMO_REPLIES_REC))
                        .replace(/\{first\}/g, first).replace(/\{biz\}/g, bizName);
          const posted = new Date(new Date(r.created_at).getTime() + demoRand(2,36) * 3600000);
          return { review_id: r.id, generated_reply: tpl, posted_reply: tpl, status: 'posted',
                   posted_at: posted, approved_at: posted, updated_at: posted };
        });
        if (replyRows.length){
          const q = demoBulk('replies',
            ['review_id','generated_reply','posted_reply','status','posted_at','approved_at','updated_at'],
            replyRows);
          await query(q.text, q.params);
        }
      } catch (e){ logger.error('demo replies: ' + e.message); }

      // 5b) A few reviews with a drafted reply awaiting approval — so the
      // "Pending Approval" state is visible on the Reviews page in demos.
      try {
        const NUM_DRAFTS = Math.min(3 + locs, 6);
        const rows = [];
        for (let i = 0; i < NUM_DRAFTS; i++){
          const rating = demoWeighted([[5,60],[4,30],[3,10]]);
          const created = demoDaysAgo(demoRand(0, 6), demoRand(0, 23));
          rows.push({
            location_id: demoPick(locIds),
            platform: 'google',
            platform_review_id: 'demo_rev_' + randomUUID(),
            reviewer_name: demoPick(people).full,
            star_rating: rating,
            review_text: demoPick(rating >= 4 ? content.pos : content.neu),
            review_date: created,
            created_at: created,
            status: 'pending'
          });
        }
        const rq = demoBulk('reviews',
          ['location_id','platform','platform_review_id','reviewer_name','star_rating','review_text','review_date','created_at','status'],
          rows);
        const drafts = (await query(rq.text + ' RETURNING id, reviewer_name', rq.params)).rows;

        const draftReplies = drafts.map(d => {
          const first = (d.reviewer_name || '').split(' ')[0] || 'there';
          const tpl = demoPick(DEMO_REPLIES_POS).replace(/\{first\}/g, first).replace(/\{biz\}/g, bizName);
          return { review_id: d.id, generated_reply: tpl, status: 'pending_approval' };
        });
        if (draftReplies.length){
          const q = demoBulk('replies', ['review_id','generated_reply','status'], draftReplies);
          await query(q.text, q.params);
        }
      } catch (e){ logger.error('demo draft replies: ' + e.message); }

      // 6) Review requests
      let requests = [];
      try {
        const rows = [];
        for (let i = 0; i < NUM_REQUESTS; i++){
          const p = demoPick(people);
          rows.push({
            customer_id: custId, location_id: demoPick(locIds),
            contact_name: p.full, contact_email: p.email, contact_phone: p.phone,
            trigger_source: demoWeighted([['email',38],['sms',22],['manual',25],['zapier',15]]),
            trigger_ref: 'demo_' + randomUUID(),
            status: demoWeighted([['sent',45],['clicked',30],['completed',25]])
          });
        }
        const q = demoBulk('review_requests',
          ['customer_id','location_id','contact_name','contact_email','contact_phone','trigger_source','trigger_ref','status'],
          rows);
        requests = (await query(q.text + ' RETURNING id', q.params)).rows;
      } catch (e){ logger.error('demo requests: ' + e.message); }

      // 7) NPS survey responses
      try {
        const rows = [];
        for (let i = 0; i < NUM_SURVEYS; i++){
          const score = demoWeighted([[10,42],[9,26],[8,14],[7,8],[6,4],[5,2],[4,2],[3,1],[2,1],[1,0],[0,0]]);
          const path  = score >= 9 ? 'Promoter' : score >= 7 ? 'Passive' : 'Detractor';
          rows.push({
            review_request_id: requests.length ? demoPick(requests).id : null,
            customer_id: custId, location_id: demoPick(locIds),
            nps_score: score, path,
            would_return: score >= 7 ? true : Math.random() < 0.3,
            left_review: path === 'Promoter' ? Math.random() < 0.6 : false,
            review_platform: 'google',
            detractor_q1: path === 'Detractor' ? demoPick(DEMO_DETRACTOR_Q1) : null,
            detractor_q2: path === 'Detractor' ? demoPick(DEMO_DETRACTOR_Q2) : null,
            completed_at: demoDaysAgo(demoRand(0,89), demoRand(0,23))
          });
        }
        const q = demoBulk('survey_responses',
          ['review_request_id','customer_id','location_id','nps_score','path','would_return','left_review','review_platform','detractor_q1','detractor_q2','completed_at'],
          rows);
        await query(q.text, q.params);
      } catch (e){ logger.error('demo surveys: ' + e.message); }
    }

    // 6) Competitor snapshots — so Get Found shows a live nearby benchmark.
    try {
      const COMP = ['Summit & Co.','Maple Street Collective','Riverside Group','Oakwood Partners','Premier Local','Hometown Provider','Cornerstone Co.','Evergreen Services','First Choice Co.','The Local Standard'];
      for (const lid of locIds) {
        const picks = [...COMP].sort(() => Math.random() - 0.5).slice(0, demoRand(3, 5));
        for (const name of picks) {
          await query(
            `INSERT INTO competitor_snapshots
               (location_id, competitor_place_id, competitor_name, rating, review_count, address, snapshot_date)
             VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE)
             ON CONFLICT (location_id, competitor_place_id, snapshot_date) DO NOTHING`,
            [lid, 'demo_comp_' + randomUUID(), name, demoRand(36, 49) / 10, demoRand(45, 620), 'Nearby']
          );
        }
      }
    } catch (e){ logger.error('demo competitors: ' + e.message); }

    // 7) Webchat sessions + messages — so the Inbox isn't empty.
    try {
      const CHAT = [
        { v: "Hi, are you open this weekend?", a: "We sure are — Saturday 9–5 and Sunday 10–4. Anything we can help with?" },
        { v: "Do you take walk-ins or do I need an appointment?", a: "Walk-ins are welcome! Booking ahead just guarantees your spot. Want me to set one up?" },
        { v: "What does a first visit cost?", a: "Great question — first visits start at our standard rate and we'll walk through options when you're in. Want details by text?" },
        { v: "Where exactly are you located?", a: "We're right downtown with parking out front. Happy to text you the exact address if that's easier." },
        { v: "Any specials for new customers?", a: "We do have a new-customer welcome offer on your first visit. Want me to send it over?" },
        { v: "How long is the wait right now?", a: "About 15 minutes at the moment — I can add you to the list so you're set when you arrive." },
      ];
      for (const lid of locIds) {
        let cfgId;
        const cfg = await query(`INSERT INTO webchat_configs (location_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id`, [lid]);
        cfgId = cfg.rows[0] && cfg.rows[0].id;
        if (!cfgId) { const ex = await query(`SELECT id FROM webchat_configs WHERE location_id=$1 LIMIT 1`, [lid]); cfgId = ex.rows[0] && ex.rows[0].id; }
        if (!cfgId) continue;
        const sessCount = demoRand(3, 6);
        for (let s = 0; s < sessCount; s++) {
          const person = demoPick(people);
          const convo = demoPick(CHAT);
          const status = s < 2 ? 'open' : demoWeighted([['open', 40], ['resolved', 60]]);
          const sess = await query(
            `INSERT INTO webchat_sessions
               (config_id, location_id, visitor_name, visitor_phone, visitor_email, page_url, referrer, user_agent, ip_address, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [cfgId, lid, person.full, person.phone, person.email, 'https://swarmreply.com/contact', 'https://www.google.com/', 'Mozilla/5.0', '203.0.113.' + demoRand(2, 250), status]
          );
          const sid = sess.rows[0] && sess.rows[0].id;
          if (!sid) continue;
          const thread = [
            ['bot', 'SwarmReply', "Hi there! 👋 How can we help you today?"],
            ['visitor', person.full, convo.v],
            ['agent', 'Front desk', convo.a],
          ];
          if (status === 'resolved') thread.push(['visitor', person.full, "Perfect — thank you so much!"]);
          for (const [sender, sname, body] of thread) {
            await query(
              `INSERT INTO webchat_messages (session_id, sender, sender_name, body, msg_type, channel)
               VALUES ($1,$2,$3,$4,'text','webchat')`,
              [sid, sender, sname, body]
            );
          }
        }
      }
    } catch (e){ logger.error('demo webchat: ' + e.message); }

    // 8) Social posts — so the Campaigns tab shows a real posting history across
    //    the connected platforms (mostly published, a couple scheduled upcoming).
    try {
      const SOCIAL_PLATS = ['facebook','instagram','google','linkedin'];
      const pool = [...(DEMO_SOCIAL[ind.code] || DEMO_SOCIAL.other)].sort(() => Math.random() - 0.5);
      const NUM_POSTS = demoRand(8, 12);
      const rows = [];
      for (let i = 0; i < NUM_POSTS; i++){
        const text  = pool[i % pool.length];
        const plats = SOCIAL_PLATS.filter(() => Math.random() < 0.55);
        if (!plats.length) plats.push('facebook');
        const ct = Math.random() < 0.5 ? 'text_image' : 'text';
        if (i < 2){
          // upcoming / scheduled
          rows.push({
            customer_id: custId, platforms: JSON.stringify(plats), content_type: ct,
            text_content: text, link_url: null,
            schedule_at: demoDaysAgo(-demoRand(2, 10), demoRand(0, 23)),
            platform_results: JSON.stringify({}), status: 'scheduled',
            created_at: demoDaysAgo(demoRand(0, 2), demoRand(0, 23))
          });
        } else {
          const results = {};
          plats.forEach(p => { results[p] = 'live'; });
          rows.push({
            customer_id: custId, platforms: JSON.stringify(plats), content_type: ct,
            text_content: text, link_url: null, schedule_at: null,
            platform_results: JSON.stringify(results), status: 'live',
            created_at: demoDaysAgo(demoRand(3, 75), demoRand(0, 23))
          });
        }
      }
      const q = demoBulk('social_posts',
        ['customer_id','platforms','content_type','text_content','link_url','schedule_at','platform_results','status','created_at'],
        rows);
      await query(q.text, q.params);
    } catch (e){ logger.error('demo social posts: ' + e.message); }

    await query(
      'INSERT INTO audit_log (customer_id, action, details) VALUES ($1,$2,$3)',
      [custId, 'admin_created_demo', JSON.stringify({ admin: req.admin.email, industry, locations: locs })]
    ).catch(()=>{});

    logger.info(`Admin created demo: ${bizName} (${industry}, ${locs} loc)`);
    res.json({ success: true, id: custId, email, tempPassword: tempPass });
  } catch (err) {
    logger.error('Create demo error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
