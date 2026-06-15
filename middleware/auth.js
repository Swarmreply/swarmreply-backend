// ============================================
// middleware/auth.js
// JWT authentication + role enforcement
// ============================================

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * authenticateToken
 * Verifies the Bearer token and attaches req.user.
 * Works for both legacy customer tokens and new team member tokens.
 */
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  // Also accept token from query string for browser OAuth redirects
  // (window.location.href can't set headers)
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    req.user = decoded;

    // Backwards compatibility — legacy tokens use customerId at top level
    if (!req.user.customerId && decoded.id) {
      req.user.customerId = decoded.id;
      req.user.role = 'admin';
    }

    // Check token revocation list (for logout / forced sign-out)
    if (decoded.jti) {
      const { query } = require('../database/db');
      const revoked = await query(
        'SELECT 1 FROM revoked_tokens WHERE jti = $1',
        [decoded.jti]
      );
      if (revoked.rows.length > 0) {
        return res.status(401).json({ error: 'Token has been revoked. Please log in again.' });
      }
    }

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * requireRole(roles)
 * Middleware factory — restricts route to specific roles.
 * Usage: router.post('/invite', authenticateToken, requireRole(['admin']), handler)
 */
function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userRole = req.user.role || 'staff';

    if (!roles.includes(userRole)) {
      return res.status(403).json({
        error: `This action requires ${roles.join(' or ')} access. Your role is ${userRole}.`,
        requiredRoles: roles,
        userRole,
      });
    }

    next();
  };
}

/**
 * requirePermission(permission)
 * Checks a specific permission key against the role_permissions table.
 * For complex per-route permission checks.
 */
function requirePermission(permission) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Admins always pass
    if (req.user.role === 'admin') return next();

    try {
      const { query } = require('../database/db');
      const result = await query(
        `SELECT allowed FROM role_permissions WHERE role = $1 AND permission = $2`,
        [req.user.role || 'staff', permission]
      );

      if (!result.rows.length || !result.rows[0].allowed) {
        return res.status(403).json({
          error: `Your ${req.user.role || 'staff'} role does not have access to this feature.`,
          permission,
        });
      }

      next();
    } catch (err) {
      res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

module.exports = { authenticateToken, requireRole, requirePermission };
