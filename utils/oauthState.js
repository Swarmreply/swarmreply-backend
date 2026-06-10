// ============================================
// utils/oauthState.js
// HMAC-signed OAuth state for all integration connect flows.
// Prevents forged callbacks attaching a provider account to
// someone else's SwarmReply account, and replayed/stale states.
// ============================================

const crypto = require('crypto');

const SECRET = process.env.OAUTH_STATE_SECRET || process.env.JWT_SECRET;
const MAX_AGE_MS = 10 * 60 * 1000; // states older than 10 minutes are rejected

function signState(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, ts: Date.now() })).toString('base64url');
  const sig  = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state) {
  if (!state || typeof state !== 'string' || !state.includes('.')) {
    throw new Error('Invalid OAuth state');
  }
  const [body, sig] = state.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Invalid OAuth state signature');
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (!payload.ts || Date.now() - payload.ts > MAX_AGE_MS) {
    throw new Error('OAuth state expired — please try connecting again');
  }
  return payload;
}

module.exports = { signState, verifyState };
