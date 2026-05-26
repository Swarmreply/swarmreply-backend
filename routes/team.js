// ============================================
// routes/team.js
// Team member management + role-based access
// ============================================

const express      = require('express');
const router       = express.Router();
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const crypto       = require('crypto');
const { query }    = require('../database/db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const logger       = require('../utils/logger');
const { auditLog } = require('../middleware/audit');

const JWT_SECRET   = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://swarmreply.com';

// ── ROLE DEFINITIONS ──────────────────────────────────────────────────────────
const ROLE_META = {
  admin: {
    label:       'Admin',
    description: 'Full access including billing and team management',
    color:       '#f5c842',
  },
  manager: {
    label:       'Manager',
    description: 'Full platform access — no billing or team management',
    color:       '#74aa9c',
  },
  staff: {
    label:       'Staff',
    description: 'Operational access — Reviews, Inbox, Grow, Campaigns, AI Visibility',
    color:       '#7c3aed',
  },
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
function generateInviteToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function getPermissions(role) {
  const res = await query(
    `SELECT permission, allowed FROM role_permissions WHERE role = $1`,
    [role]
  );
  return res.rows.reduce((acc, r) => {
    acc[r.permission] = r.allowed;
    return acc;
  }, {});
}

// ── GET /api/team ─────────────────────────────────────────────────────────────
// List all team members for this customer
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, email, role, status,
              invite_sent_at, invite_accepted_at, last_login_at, created_at
       FROM team_members
       WHERE customer_id = $1
       ORDER BY
         CASE role WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END,
         created_at ASC`,
      [req.user.customerId]
    );
    res.json({ success: true, members: result.rows, roleMeta: ROLE_META });
  } catch (err) {
    logger.error('List team error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/team/invite ─────────────────────────────────────────────────────
// Invite a new team member — admin only
router.post('/invite', authenticateToken, requireRole(['admin']), async (req, res) => {
  const { email, name, role } = req.body;

  if (!email || !name || !role) {
    return res.status(400).json({ error: 'email, name, and role are required' });
  }
  if (!['admin','manager','staff'].includes(role)) {
    return res.status(400).json({ error: 'role must be admin, manager, or staff' });
  }

  try {
    // Check plan limits — Starter: 3 members, Growth: 10, Agency: unlimited
    const customer = await query(
      `SELECT plan FROM customers WHERE id = $1`, [req.user.customerId]
    );
    const plan = customer.rows[0]?.plan || 'starter';
    const limits = { starter: 3, growth: 10, agency: null };
    const limit = limits[plan];

    if (limit !== null) {
      const count = await query(
        `SELECT COUNT(*) FROM team_members WHERE customer_id = $1 AND status != 'suspended'`,
        [req.user.customerId]
      );
      if (parseInt(count.rows[0].count) >= limit) {
        return res.status(403).json({
          error: `Your ${plan} plan supports up to ${limit} team members. Upgrade to add more.`,
          upgradeRequired: true,
        });
      }
    }

    // Check for existing member
    const existing = await query(
      `SELECT id, status FROM team_members WHERE customer_id = $1 AND email = $2`,
      [req.user.customerId, email.toLowerCase()]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A team member with that email already exists.' });
    }

    const inviteToken = generateInviteToken();

    const result = await query(
      `INSERT INTO team_members
         (customer_id, email, name, role, invite_token, invite_sent_at, status, created_by)
       VALUES ($1, $2, $3, $4, $5, NOW(), 'invited', $6)
       RETURNING id, name, email, role, status, invite_sent_at`,
      [req.user.customerId, email.toLowerCase(), name, role, inviteToken, req.user.memberId]
    );

    const member = result.rows[0];
    const inviteUrl = `${FRONTEND_URL}/accept-invite?token=${inviteToken}`;

    // Send invite email via Resend
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      const inviterName = req.user.name || 'Your team';
      await resend.emails.send({
        from:    process.env.EMAIL_FROM || 'hello@swarmreply.com',
        to:      email,
        subject: `${inviterName} invited you to SwarmReply`,
        html: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 20px">
            <div style="font-size:1.5rem;font-weight:900;margin-bottom:8px">🐝 You've been invited</div>
            <p style="color:#444;line-height:1.7;margin-bottom:24px">
              <strong>${inviterName}</strong> has invited you to join their SwarmReply team as a <strong>${ROLE_META[role].label}</strong>.
            </p>
            <a href="${inviteUrl}" style="display:inline-block;background:#0a0a0a;color:white;padding:13px 28px;border-radius:50px;text-decoration:none;font-weight:700;font-size:.95rem">
              Accept invitation →
            </a>
            <p style="margin-top:28px;font-size:.8rem;color:#999">
              This link expires in 7 days. If you didn't expect this email, you can ignore it safely.
            </p>
          </div>
        `
      });
    } catch (emailErr) {
      logger.warn('Invite email failed (member still created):', emailErr.message);
    }

    logger.info(`Team invite sent: ${email} as ${role} for customer ${req.user.customerId}`);
    await auditLog(req, 'team.invite', { invitedEmail: email, role, memberId: member.id });
    res.status(201).json({ success: true, member });
  } catch (err) {
    logger.error('Invite error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/team/accept ─────────────────────────────────────────────────────
// Accept invite + set password — public endpoint
router.post('/accept', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: 'token and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const result = await query(
      `SELECT id, customer_id, email, name, role
       FROM team_members
       WHERE invite_token = $1
         AND status = 'invited'
         AND invite_sent_at > NOW() - INTERVAL '7 days'`,
      [token]
    );

    if (!result.rows.length) {
      return res.status(400).json({ error: 'Invite link is invalid or has expired.' });
    }

    const member      = result.rows[0];
    const passwordHash = await bcrypt.hash(password, 12);

    await query(
      `UPDATE team_members
       SET password_hash = $2, invite_token = NULL,
           invite_accepted_at = NOW(), status = 'active',
           updated_at = NOW()
       WHERE id = $1`,
      [member.id, passwordHash]
    );

    // Issue JWT
    const { v4: uuidv4 } = require('uuid');
    const accessToken = jwt.sign(
      {
        jti:        uuidv4(), // unique token ID for revocation
        memberId:   member.id,
        customerId: member.customer_id,
        email:      member.email,
        name:       member.name,
        role:       member.role,
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    logger.info(`Invite accepted: ${member.email} (${member.role})`);
    res.json({
      success:     true,
      accessToken,
      member: { id: member.id, name: member.name, email: member.email, role: member.role }
    });
  } catch (err) {
    logger.error('Accept invite error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/team/:id/role ──────────────────────────────────────────────────
// Change a member's role — admin only
router.patch('/:id/role', authenticateToken, requireRole(['admin']), async (req, res) => {
  const { role } = req.body;
  if (!['admin','manager','staff'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  try {
    // Prevent admin from demoting themselves
    if (req.params.id === req.user.memberId && role !== 'admin') {
      return res.status(403).json({ error: 'You cannot change your own role.' });
    }

    const result = await query(
      `UPDATE team_members
       SET role = $2, updated_at = NOW()
       WHERE id = $1 AND customer_id = $3
       RETURNING id, name, email, role, status`,
      [req.params.id, role, req.user.customerId]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Member not found' });

    logger.info(`Role changed: ${result.rows[0].email} → ${role}`);
    await auditLog(req, 'team.role_change', { targetId: req.params.id, newRole: role, previousEmail: result.rows[0].email });
    res.json({ success: true, member: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/team/:id/suspend ───────────────────────────────────────────────
// Suspend / re-activate a member — admin only
router.patch('/:id/suspend', authenticateToken, requireRole(['admin']), async (req, res) => {
  const { suspend } = req.body; // true = suspend, false = re-activate

  try {
    if (req.params.id === req.user.memberId) {
      return res.status(403).json({ error: 'You cannot suspend yourself.' });
    }

    const result = await query(
      `UPDATE team_members
       SET status = $2, updated_at = NOW()
       WHERE id = $1 AND customer_id = $3
       RETURNING id, name, email, role, status`,
      [req.params.id, suspend ? 'suspended' : 'active', req.user.customerId]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Member not found' });
    await auditLog(req, suspend ? 'team.suspend' : 'team.reactivate', { targetId: req.params.id });
    res.json({ success: true, member: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/team/:id ──────────────────────────────────────────────────────
// Remove a member — admin only
router.delete('/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    if (req.params.id === req.user.memberId) {
      return res.status(403).json({ error: 'You cannot remove yourself.' });
    }

    await query(
      `DELETE FROM team_members WHERE id = $1 AND customer_id = $2`,
      [req.params.id, req.user.customerId]
    );
    await auditLog(req, 'team.remove', { removedId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/team/permissions ─────────────────────────────────────────────────
// Returns the permission set for the current user's role
// Frontend uses this to show/hide nav items
router.get('/permissions', authenticateToken, async (req, res) => {
  try {
    const permissions = await getPermissions(req.user.role || 'staff');
    res.json({ success: true, role: req.user.role, permissions, roleMeta: ROLE_META });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── GET /api/team/invite/preview ─────────────────────────────────────────────
// Validates a token and returns invite metadata without consuming it
// Used by the accept-invite page to show name/email/role before form submit
router.get('/invite/preview', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token required' });

  try {
    const result = await query(
      `SELECT name, email, role, invite_sent_at
       FROM team_members
       WHERE invite_token = $1
         AND status = 'invited'
         AND invite_sent_at > NOW() - INTERVAL '7 days'`,
      [token]
    );

    if (!result.rows.length) {
      return res.status(400).json({ error: 'Invite link is invalid or has expired.' });
    }

    const { name, email, role } = result.rows[0];
    res.json({ name, email, role, valid: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
