// ============================================
// server.js
// SwarmReply Backend — Main Entry Point
//
// Starts Express server, connects to database,
// and launches the review processing scheduler
// ============================================

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');
const { testConnection } = require('./database/db');
const { startScheduler } = require('./scheduler');
const routes   = require('./routes/index');
const { sanitizeBody }        = require('./middleware/validate');
const { verifyCsrf, generateCsrf } = require('./middleware/csrf');
const cookieParser             = require('cookie-parser');
const hpp                      = require('hpp');
const logger   = require('./utils/logger');

const app  = express();
const PORT = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

// ============================================
// SECURITY MIDDLEWARE
// ============================================

// Helmet — strict security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],
      styleSrc:       ["'self'", "'unsafe-inline'"],
      imgSrc:         ["'self'", 'data:', 'https:'],
      connectSrc:     ["'self'", 'https://api.stripe.com'],
      frameSrc:       ["'none'"],
      objectSrc:      ["'none'"],
      upgradeInsecureRequests: isProd ? [] : null,
    },
  },
  hsts: isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Permissions policy
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Download-Options', 'noopen');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  // Expect-CT: require certificate transparency logging
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Expect-CT', 'enforce, max-age=86400');
  }
  next();
});

// CORS — locked to your frontend only
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://app.swarmreply.com',
  ...(isProd ? [] : ['http://localhost:3000']),
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow no-origin requests (server-to-server, mobile apps)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    logger.warn('CORS blocked request from:', origin);
    cb(new Error('Not allowed by CORS'));
  },
  credentials:  true,
  methods:      ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Request-ID'],
  maxAge:       86400, // preflight cache 24h
}));

// Cookie parser (needed for CSRF)
app.use(cookieParser());

// HPP — prevent HTTP Parameter Pollution attacks
// e.g. ?admin=false&admin=true — only takes last value
app.use(hpp());

// ── TIERED RATE LIMITING ──────────────────────────────────────────────────────

// General API — 120 req / 15 min
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 120,
  message:  { error: 'Too many requests. Please try again in 15 minutes.' },
  standardHeaders: true, legacyHeaders: false,
  skip: (req) => req.path === '/api/health',
});

// Auth endpoints — 10 req / 15 min (brute force protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Too many login attempts. Please wait 15 minutes.' },
  standardHeaders: true, legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// Invite endpoints — 5 req / hour
const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  message: { error: 'Too many invite attempts. Please wait an hour.' },
  standardHeaders: true, legacyHeaders: false,
});

// Webhook — no rate limit (Stripe needs unrestricted access)
// All other API routes
app.use('/api/', generalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api/team/invite', inviteLimiter);

// ============================================
// BODY PARSERS
// ============================================

// Regular JSON parser for all routes
// Note: Stripe webhook route uses raw parser (defined in routes)
app.use((req, res, next) => {
  if (req.path === '/api/webhooks/stripe') {
    next(); // Skip JSON parsing for Stripe webhook
  } else {
    express.json({ limit: '10mb' })(req, res, next);
  }
});

app.use(express.urlencoded({ extended: true }));

// ============================================
// ROUTES
// ============================================
// CSRF token endpoint — must come before verifyCsrf middleware
app.get('/api/auth/csrf', generateCsrf);

// Global input sanitization — strip control chars from all string body values
app.use(sanitizeBody);

// CSRF verification on all state-changing requests
app.use(verifyCsrf);

app.use('/api', routes);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  // Log full error internally but never expose stack traces to clients
  const reqId = req.headers['x-request-id'] || 'no-id';
  logger.error(`[${reqId}] Unhandled error: ${err.message}`, {
    stack:  err.stack,
    path:   req.path,
    method: req.method,
  });

  // CORS errors
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Stripe signature errors
  if (err.type === 'StripeSignatureVerificationError') {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  // Never expose internal error details in production
  const message = isProd ? 'An unexpected error occurred' : err.message;
  res.status(err.status || 500).json({ error: message });
});

// ============================================
// SERVER STARTUP
// ============================================

async function startServer() {
  // Test database connection before starting
  const dbConnected = await testConnection();

  if (!dbConnected) {
    logger.warn('Database connection failed — starting server anyway, will retry on requests');
  }

  // Start HTTP server
  app.listen(PORT, () => {
    logger.info(`SwarmReply backend running on port ${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV}`);
  });

  // Start the review processing scheduler
  startScheduler();
}

// Handle uncaught errors gracefully
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason);
});

// Start everything
startServer();

module.exports = app; // Export for testing
