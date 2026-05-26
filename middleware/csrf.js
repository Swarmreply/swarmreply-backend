// ============================================
// middleware/csrf.js
// CSRF protection via double-submit cookie
//
// How it works:
//   1. GET /api/auth/csrf returns a random token
//      as both a cookie AND in the JSON body
//   2. Frontend stores the body value and sends
//      it as X-CSRF-Token header on every
//      state-changing request (POST/PUT/PATCH/DELETE)
//   3. This middleware compares header vs cookie
//      — an attacker can't read the cookie from
//      a different origin so they can't forge it
//
// Note: This protects browser-based attacks.
// API integrations using JWT (no cookies) are
// exempt — JWT in Authorization header is
// CSRF-safe by definition.
// ============================================

const crypto = require('crypto');

const CSRF_COOKIE = 'csrf_token';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * generateCsrf — endpoint that issues the token pair
 * GET /api/auth/csrf
 */
function generateCsrf(req, res) {
  const token = crypto.randomBytes(32).toString('hex');

  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,       // Must be readable by JS to send in header
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   24 * 60 * 60 * 1000, // 24 hours
  });

  res.json({ csrfToken: token });
}

/**
 * verifyCsrf — middleware that validates the token on mutations
 * Skip for requests using only JWT (Authorization header, no cookie session)
 */
function verifyCsrf(req, res, next) {
  // Safe methods don't need CSRF protection
  if (SAFE_METHODS.has(req.method)) return next();

  // JWT-only requests (no cookie session) are CSRF-safe
  // If they have an Authorization header but no CSRF cookie, skip
  const hasCookie = req.cookies?.[CSRF_COOKIE];
  const hasAuthHeader = req.headers['authorization'];

  if (hasAuthHeader && !hasCookie) return next();

  // If there's a CSRF cookie, validate it
  if (hasCookie) {
    const cookieToken  = req.cookies[CSRF_COOKIE];
    const headerToken  = req.headers[CSRF_HEADER];

    if (!headerToken || !crypto.timingSafeEqual(
      Buffer.from(cookieToken, 'hex'),
      Buffer.from(headerToken, 'hex')
    )) {
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
  }

  next();
}

module.exports = { generateCsrf, verifyCsrf };
