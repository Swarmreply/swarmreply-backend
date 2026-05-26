// ============================================
// Add these routes to backend/routes/index.js
// Customer creation and login endpoints
// ============================================

// POST /api/customers
// Create new customer record (called from checkout page)
router.post('/customers', async (req, res) => {
  const { name, email, phone, plan, status } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }

  try {
    // Check if customer already exists
    const existing = await query(
      'SELECT * FROM customers WHERE email = $1',
      [email.toLowerCase()]
    );

    if (existing.rows.length > 0) {
      return res.json({ customer: existing.rows[0] });
    }

    // Create new customer
    const result = await query(
      `INSERT INTO customers (name, email, phone, plan, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, plan, status, created_at`,
      [name, email.toLowerCase(), phone, plan || 'starter', status || 'trial']
    );

    logger.info(`New customer created: ${email}`);
    res.status(201).json({ customer: result.rows[0] });
  } catch (error) {
    logger.error('Create customer error:', error.message);
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

// GET /api/customers/:id
// Get customer by ID
router.get('/customers/:id', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, name, email, plan, status, created_at FROM customers WHERE id = $1',
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({ customer: result.rows[0] });
  } catch (error) {
    logger.error('Get customer error:', error.message);
    res.status(500).json({ error: 'Failed to fetch customer' });
  }
});

// POST /api/customers/login
// Team member login — email + password
// Returns JWT token with role, customerId, memberId
router.post('/customers/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const normalizedEmail = email.toLowerCase().trim().slice(0, 254);
  const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';

  try {
    const bcrypt = require('bcryptjs');
    const jwt    = require('jsonwebtoken');
    const { v4: uuidv4 } = require('uuid');

    // ── Check for too many recent failed attempts (brute force) ──────────────
    const recentFails = await query(
      `SELECT COUNT(*) FROM login_attempts
       WHERE email = $1 AND succeeded = false
         AND attempted_at > NOW() - INTERVAL '15 minutes'`,
      [normalizedEmail]
    );
    if (parseInt(recentFails.rows[0].count) >= 10) {
      return res.status(429).json({
        error: 'Too many failed login attempts. Please wait 15 minutes before trying again.'
      });
    }

    // ── Look up team member ───────────────────────────────────────────────────
    const result = await query(
      `SELECT tm.id, tm.name, tm.email, tm.role, tm.password_hash,
              tm.status, tm.customer_id,
              c.plan, c.status as customer_status
       FROM team_members tm
       JOIN customers c ON c.id = tm.customer_id
       WHERE tm.email = $1`,
      [normalizedEmail]
    );

    const member = result.rows[0];

    // Use constant-time comparison even for "not found" to prevent
    // email enumeration via timing differences
    const dummyHash = '$2a$12$dummy.hash.to.prevent.timing.attacks.xxxxxxxxxx';
    const hashToCheck = member?.password_hash || dummyHash;
    const passwordValid = await bcrypt.compare(password, hashToCheck);

    // Record attempt (after timing-safe check)
    await query(
      `INSERT INTO login_attempts (email, ip_address, succeeded)
       VALUES ($1, $2, $3)`,
      [normalizedEmail, ip, !!(member && passwordValid)]
    ).catch(() => {}); // don't fail login if logging fails

    if (!member || !passwordValid) {
      // Same error message regardless of whether email exists (prevent enumeration)
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (member.status === 'suspended') {
      return res.status(403).json({ error: 'Your account has been suspended. Contact your admin.' });
    }

    if (member.status === 'invited') {
      return res.status(403).json({ error: 'Please accept your invitation before logging in.' });
    }

    if (member.customer_status === 'cancelled') {
      return res.status(403).json({ error: 'This account is no longer active.' });
    }

    // Update last login
    await query(
      'UPDATE team_members SET last_login_at = NOW() WHERE id = $1',
      [member.id]
    );

    // Issue JWT with jti for revocation support
    const accessToken = jwt.sign(
      {
        jti:        uuidv4(),
        memberId:   member.id,
        customerId: member.customer_id,
        email:      member.email,
        name:       member.name,
        role:       member.role,
        plan:       member.plan,
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    logger.info(`Login successful: ${normalizedEmail} (${member.role})`);

    res.json({
      success:     true,
      accessToken,
      member: {
        id:         member.id,
        name:       member.name,
        email:      member.email,
        role:       member.role,
        customerId: member.customer_id,
        plan:       member.plan,
      }
    });

  } catch (error) {
    logger.error('Login error:', error.message);
    // Never leak internal error details on auth endpoints
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// POST /api/customers/logout
// Revoke the current JWT immediately
router.post('/customers/logout', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.split(' ')[1];

  if (!token) return res.json({ success: true });

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.decode(token);

    if (decoded?.jti) {
      // Add to revoked tokens table
      await query(
        `INSERT INTO revoked_tokens (jti, reason, expires_at)
         VALUES ($1, 'logout', TO_TIMESTAMP($2))
         ON CONFLICT (jti) DO NOTHING`,
        [decoded.jti, decoded.exp]
      );
    }

    res.json({ success: true });
  } catch (err) {
    // Always succeed on logout — don't block the user
    res.json({ success: true });
  }
});
