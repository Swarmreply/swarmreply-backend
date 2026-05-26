const crypto = require('crypto');
const ALGORITHM = 'aes-256-gcm';
let _key = null;

function getKey() {
  if (_key) return _key;
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY environment variable is not set. Add it in Railway Variables.');
  if (raw.length !== 64) throw new Error('ENCRYPTION_KEY must be 64 hex characters. Generate with: openssl rand -hex 32');
  _key = Buffer.from(raw, 'hex');
  return _key;
}

function encrypt(text) {
  if (!text) return null;
  try {
    const key = getKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  } catch (error) {
    throw new Error(`Encryption failed: ${error.message}`);
  }
}

function decrypt(encryptedText) {
  if (!encryptedText) return null;
  if (!encryptedText.includes(':')) return encryptedText;
  try {
    const key = getKey();
    const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    throw new Error(`Decryption failed: ${error.message}`);
  }
}

module.exports = { encrypt, decrypt };
