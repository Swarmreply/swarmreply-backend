// ============================================
// middleware/audit.js
// Audit log — records every state-changing
// action with who, what, when, from where.
// Stored in audit_logs table.
// ============================================

const { query } = require('../database/db');
const logger    = require('../utils/logger');

/**
 * auditLog(action, details)
 * Call inside route handlers after successful operations.
 *
 * Usage:
 *   await auditLog(req, 'team.invite', { invitedEmail: email, role });
 */
async function auditLog(req, action, details = {}) {
  try {
    await query(
      `INSERT INTO audit_logs
         (customer_id, member_id, action, details, ip_address, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        req.user?.customerId || null,
        req.user?.memberId   || null,
        action,
        JSON.stringify(details),
        req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown',
        req.headers['user-agent']?.slice(0, 500) || 'unknown',
      ]
    );
  } catch (err) {
    // Audit failures should never block the main operation
    logger.error('Audit log failed:', err.message);
  }
}

/**
 * auditMiddleware(action)
 * Express middleware version — logs automatically after next().
 * For simple GET logs (less common).
 */
function auditMiddleware(action) {
  return async (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode < 400) {
        auditLog(req, action, { path: req.path, method: req.method });
      }
    });
    next();
  };
}

module.exports = { auditLog, auditMiddleware };
