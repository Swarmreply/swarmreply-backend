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

// ── ADMIN AUTH MIDDLEWARE ─────────────────────
function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'superadmin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
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
  const { email, password } = req.body || {};
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  const ADMIN_PASS  = process.env.ADMIN_PASSWORD;

  if (!ADMIN_EMAIL || !ADMIN_PASS) {
    logger.error('Admin login attempted but ADMIN_EMAIL/ADMIN_PASSWORD are not configured');
    return res.status(500).json({ error: 'Admin login is not configured' });
  }

  const emailOk = typeof email === 'string' && email.toLowerCase().trim() === ADMIN_EMAIL.toLowerCase().trim();
  const passOk  = typeof password === 'string' && safeEqual(password, ADMIN_PASS);
  if (!emailOk || !passOk) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { email: ADMIN_EMAIL, role: 'superadmin' },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );

  logger.info(`Admin login: ${ADMIN_EMAIL}`);
  res.json({ token });
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
      // Calculate MRR from location count
      let mrr = 0;
      if (c.status === 'active' && !c.is_demo) {
        if (locs >= 1) mrr = 99;
        if (locs > 1)  mrr += Math.min(locs - 1, 4) * 79;
        if (locs > 5)  mrr += Math.min(locs - 5, 20) * 69;
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
      'SELECT id, name, email, role, last_login_at FROM team_members WHERE customer_id = $1',
      [id]
    ).catch(() => ({ rows: [] }));

    const integrations = await query(
      'SELECT provider, status, created_at FROM integrations WHERE customer_id = $1',
      [id]
    ).catch(() => ({ rows: [] }));

    const recentEvents = await query(`
      SELECT event_type as text, created_at as time, metadata as detail
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
      `INSERT INTO locations (customer_id, business_name, platform, is_active)
       VALUES ($1,$2,$3,true) RETURNING id, business_name, platform`,
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

    // Insert using the EXACT column set the live team-invite flow uses (proven to
    // match the table), then set the password + activate as best-effort follow-ups
    // so a status CHECK constraint can never block account creation.
    const result = await query(
      `INSERT INTO team_members
         (customer_id, email, name, role, invite_token, invite_sent_at, status, created_by)
       VALUES ($1,$2,$3,$4,$5,NOW(),'invited',$6) RETURNING id`,
      [id, email, name, role, inviteToken, req.admin.email]
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
    await query('DELETE FROM integrations WHERE customer_id=$1', [id]).catch(()=>{});
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
