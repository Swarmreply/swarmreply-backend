// ============================================
// middleware/encrypt.js
// AES-256-GCM field-level encryption for PII
// and sensitive credentials stored in the DB.
//
// What gets encrypted:
//   - Google/Facebook OAuth tokens
//   - Twilio credentials per location
//   - Customer phone numbers
//
// Key: ENCRYPTION_KEY env var (32-byte hex)
// Generate: openssl rand -hex 32
// ============================================

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_HEX   = process.env.ENCRYPTION_KEY;

// Warn loudly if key missing — don't silently skip encryption
if (!KEY_HEX || KEY_HEX.length !== 64) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes). Generate with: openssl rand -hex 32');
  } else {
    console.warn('[WARN] ENCRYPTION_KEY not set — field encryption disabled in development');
  }
}

const KEY = KEY_HEX ? Buffer.from(KEY_HEX, 'hex') : null;

/**
 * encrypt(plaintext)
 * Returns: "iv:authTag:ciphertext" as a single base64-encoded string
 */
function encrypt(plaintext) {
  if (!KEY || plaintext == null) return plaintext;
  const iv       = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher   = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag  = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

/**
 * decrypt(ciphertext)
 * Accepts the "iv:authTag:ciphertext" format from encrypt()
 */
function decrypt(ciphertext) {
  if (!KEY || ciphertext == null) return ciphertext;
  // If it doesn't look encrypted, return as-is (backwards compat)
  if (!ciphertext.includes(':')) return ciphertext;
  try {
    const [ivHex, authTagHex, dataHex] = ciphertext.split(':');
    const iv       = Buffer.from(ivHex,      'hex');
    const authTag  = Buffer.from(authTagHex, 'hex');
    const data     = Buffer.from(dataHex,    'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (err) {
    // Decryption failure = tampered data or wrong key
    throw new Error('Decryption failed — data may be corrupted or key mismatch');
  }
}

/**
 * encryptFields(obj, fields)
 * Encrypts specific fields of an object in place.
 * Usage: encryptFields(location, ['google_access_token', 'google_refresh_token'])
 */
function encryptFields(obj, fields) {
  const copy = { ...obj };
  for (const field of fields) {
    if (copy[field] != null) copy[field] = encrypt(copy[field]);
  }
  return copy;
}

/**
 * decryptFields(obj, fields)
 * Decrypts specific fields. Use before returning data to clients.
 */
function decryptFields(obj, fields) {
  if (!obj) return obj;
  const copy = { ...obj };
  for (const field of fields) {
    if (copy[field] != null) {
      try { copy[field] = decrypt(copy[field]); }
      catch (e) { copy[field] = null; } // don't leak decrypt errors to client
    }
  }
  return copy;
}

module.exports = { encrypt, decrypt, encryptFields, decryptFields };
