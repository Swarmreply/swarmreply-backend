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
  try { return jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET); }
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
// POST /api/admin/demo
router.post('/demo', requireAdmin, async (req, res) => {
  try {
    const { name, industry, location_count } = req.body;
    const crypto = require('crypto');
    const bcrypt = require('bcryptjs');

    const email    = `demo_${Date.now()}@demo.swarmreply.internal`;
    const tempPass = crypto.randomBytes(8).toString('hex');
    const hash     = await bcrypt.hash(tempPass, 12);

    const result = await query(
      `INSERT INTO customers
        (email, name, password_hash, plan, status)
       VALUES ($1,$2,$3,'starter','active') RETURNING id`,
      [email, name || ' (Demo)', hash]
    );

    const custId = result.rows[0].id;

    // Create placeholder location(s)
    const locs = parseInt(location_count) || 1;
    for (let i = 0; i < locs; i++) {
      await query(
        `INSERT INTO locations (customer_id, business_name, platform, platform_location_id, is_active) VALUES ($1,$2,'google','demo_' || gen_random_uuid()::text,true)`,
        [custId, `${name} ${locs > 1 ? `Location ${i+1}` : ''}`]
      ).catch(()=>{});
    }

    await query(
      'INSERT INTO audit_log (customer_id, action, details) VALUES ($1,$2,$3)',
      [custId, 'admin_created_demo', JSON.stringify({ admin: req.admin.email, industry })]
    ).catch(()=>{});

    logger.info(`Admin created demo: ${name}`);
    res.json({ success: true, id: custId, email, tempPassword: tempPass });
  } catch (err) {
    logger.error('Create demo error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
