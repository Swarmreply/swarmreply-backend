// ============================================
// utils/sentry.js
// Small wrapper so background and scheduled code can report errors to Sentry
// consistently. Sentry is initialized once in server.js; requiring
// @sentry/node here returns that same singleton. Everything is guarded by
// SENTRY_DSN, so these are no-ops when Sentry isn't configured, and wrapped in
// try/catch so error reporting can never itself throw.
// ============================================

const Sentry = require('@sentry/node');

function captureError(err, context) {
  if (!process.env.SENTRY_DSN) return;
  try {
    Sentry.captureException(err, context ? { extra: context } : undefined);
  } catch (_) { /* never let error reporting throw */ }
}

function captureMessage(message, context) {
  if (!process.env.SENTRY_DSN) return;
  try {
    Sentry.captureMessage(message, context ? { level: 'error', extra: context } : 'error');
  } catch (_) { /* no-op */ }
}

module.exports = { captureError, captureMessage };
