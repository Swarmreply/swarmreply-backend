// middleware/encrypt.js
// AES-256-GCM field-level encryption — lazy key loading

const crypto    = require('crypto');
const ALGORITHM = 'aes-256-gcm';
let _key = null;

function getKey() {
  if (_key) return _key;
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  if (raw.length !== 64) {
    console.warn('[WARN] ENCRYPTION_KEY is not 64 hex characters');
    return null;
  }
  _key = Buffer.from(raw, 'hex');
  return _key;
}

function encrypt(plaintext) {
  const KEY = getKey();
  if (!KEY || plaintext == null) return plaintext;
  const iv        = crypto.randomBytes(12);
  const cipher    = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

function decrypt(ciphertext) {
  const KEY = getKey();
  if (!KEY || ciphertext == null) return ciphertext;
  if (!ciphertext.includes(':')) return ciphertext;
  try {
    const [ivHex, authTagHex, dataHex] = ciphertext.split(':');
    const iv      = Buffer.from(ivHex,      'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const data    = Buffer.from(dataHex,    'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new Error('Decryption failed');
  }
}

function encryptFields(obj, fields) {
  const copy = { ...obj };
  for (const field of fields) {
    if (copy[field] != null) copy[field] = encrypt(copy[field]);
  }
  return copy;
}

function decryptFields(obj, fields) {
  if (!obj) return obj;
  const copy = { ...obj };
  for (const field of fields) {
    if (copy[field] != null) {
      try { copy[field] = decrypt(copy[field]); }
      catch (e) { copy[field] = null; }
    }
  }
  return copy;
}

module.exports = { encrypt, decrypt, encryptFields, decryptFields };
