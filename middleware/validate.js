// ============================================
// middleware/validate.js
// Input validation and sanitization
// Prevents injection, oversized payloads,
// and malformed data reaching business logic
// ============================================

const MAX_STRING   = 500;
const MAX_TEXT     = 5000;
const MAX_EMAIL    = 254;

// ── SANITIZERS ────────────────────────────────────────────────────────────────

function sanitizeString(val, maxLen = MAX_STRING) {
  if (val == null) return null;
  return String(val)
    .trim()
    .slice(0, maxLen)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // strip control chars
}

function sanitizeEmail(val) {
  if (!val) return null;
  const s = String(val).trim().toLowerCase().slice(0, MAX_EMAIL);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

function sanitizeInt(val, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = parseInt(val, 10);
  if (isNaN(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function sanitizeBool(val) {
  if (typeof val === 'boolean') return val;
  if (val === 'true' || val === '1') return true;
  if (val === 'false' || val === '0') return false;
  return null;
}

function sanitizeUUID(val) {
  if (!val) return null;
  const s = String(val).trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : null;
}

// ── VALIDATION MIDDLEWARE FACTORY ─────────────────────────────────────────────

/**
 * validate(schema)
 * schema: { fieldName: { type, required, min, max, enum } }
 *
 * Usage:
 *   router.post('/invite', authenticateToken, validate({
 *     email: { type: 'email', required: true },
 *     name:  { type: 'string', required: true, max: 100 },
 *     role:  { type: 'string', required: true, enum: ['admin','manager','staff'] },
 *   }), handler)
 */
function validate(schema) {
  return (req, res, next) => {
    const errors = [];
    const cleaned = {};

    for (const [field, rules] of Object.entries(schema)) {
      const raw = req.body[field] ?? req.query[field] ?? req.params[field];

      // Required check
      if (rules.required && (raw == null || raw === '')) {
        errors.push(`${field} is required`);
        continue;
      }
      if (raw == null || raw === '') {
        cleaned[field] = null;
        continue;
      }

      // Type coercion + sanitization
      let val;
      switch (rules.type) {
        case 'email':
          val = sanitizeEmail(raw);
          if (val === null) errors.push(`${field} must be a valid email address`);
          break;
        case 'uuid':
          val = sanitizeUUID(raw);
          if (val === null) errors.push(`${field} must be a valid ID`);
          break;
        case 'int':
          val = sanitizeInt(raw, rules.min, rules.max);
          if (val === null) errors.push(`${field} must be a number`);
          break;
        case 'bool':
          val = sanitizeBool(raw);
          if (val === null) errors.push(`${field} must be true or false`);
          break;
        case 'text':
          val = sanitizeString(raw, rules.max || MAX_TEXT);
          break;
        default: // string
          val = sanitizeString(raw, rules.max || MAX_STRING);
      }

      // Enum check
      if (rules.enum && val !== null && !rules.enum.includes(val)) {
        errors.push(`${field} must be one of: ${rules.enum.join(', ')}`);
      }

      // Min length check
      if (rules.minLen && val && val.length < rules.minLen) {
        errors.push(`${field} must be at least ${rules.minLen} characters`);
      }

      cleaned[field] = val;
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors });
    }

    // Attach cleaned values to req.validated
    req.validated = cleaned;
    next();
  };
}

// ── SANITIZE ALL BODY STRINGS ─────────────────────────────────────────────────
// Apply as global middleware to strip control chars from all string values
function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    for (const [key, val] of Object.entries(req.body)) {
      if (typeof val === 'string') {
        req.body[key] = val.trim().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
      }
    }
  }
  next();
}

module.exports = {
  validate,
  sanitizeBody,
  sanitizeString,
  sanitizeEmail,
  sanitizeInt,
  sanitizeUUID,
  sanitizeBool,
};
