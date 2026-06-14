// ============================================
// services/storageService.js
// Thin wrapper over Supabase Storage's REST API (no SDK).
// Uploads a base64 image, returns a public URL.
// Auto-creates the public "branding" bucket on first use,
// so the only setup is two Railway env vars:
//   SUPABASE_URL                (e.g. https://abcd.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY   (Supabase dashboard > Settings > API)
// ============================================

const axios = require('axios');
const logger = require('../utils/logger');

const BUCKET = 'branding';

function cfg() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    const e = new Error('Logo upload isn\u2019t configured yet. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to Railway.');
    e.code = 'STORAGE_UNCONFIGURED';
    throw e;
  }
  return { url: url.replace(/\/$/, ''), key };
}

let bucketEnsured = false;
async function ensureBucket({ url, key }) {
  if (bucketEnsured) return;
  try {
    await axios.post(
      `${url}/storage/v1/bucket`,
      { id: BUCKET, name: BUCKET, public: true, file_size_limit: 5242880 },
      { headers: { Authorization: `Bearer ${key}`, apikey: key }, timeout: 10000 }
    );
    logger.info('Storage: created public bucket "branding"');
  } catch (err) {
    // 400/409 = already exists, which is fine
    const status = err.response?.status;
    if (status && status !== 400 && status !== 409) {
      logger.warn(`Storage: bucket ensure returned ${status} — continuing`);
    }
  }
  bucketEnsured = true;
}

// dataUri: "data:image/png;base64,...."  → { publicUrl }
async function uploadLogo(locationId, dataUri) {
  const { url, key } = cfg();

  const m = /^data:(image\/(png|jpeg|jpg|webp|svg\+xml));base64,(.+)$/i.exec(dataUri || '');
  if (!m) {
    const e = new Error('Unsupported image. Use PNG, JPG, WEBP, or SVG.');
    e.code = 'BAD_IMAGE';
    throw e;
  }
  const contentType = m[1];
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' }[contentType.toLowerCase()] || 'png';
  const bytes = Buffer.from(m[3], 'base64');
  if (bytes.length > 5 * 1024 * 1024) {
    const e = new Error('Image is too large (max 5 MB). Try a smaller file.');
    e.code = 'TOO_LARGE';
    throw e;
  }

  await ensureBucket({ url, key });

  // Stable path per location so re-uploads overwrite (no orphan files);
  // cache-bust with a version query param on read.
  const path = `logos/${locationId}.${ext}`;
  await axios.post(
    `${url}/storage/v1/object/${BUCKET}/${path}`,
    bytes,
    {
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
        'Content-Type': contentType,
        'x-upsert': 'true',
      },
      timeout: 20000,
      maxBodyLength: Infinity,
    }
  );

  const publicUrl = `${url}/storage/v1/object/public/${BUCKET}/${path}?v=${Date.now()}`;
  logger.info(`Storage: uploaded logo for location ${locationId} (${bytes.length} bytes)`);
  return { publicUrl };
}

module.exports = { uploadLogo, BUCKET };
