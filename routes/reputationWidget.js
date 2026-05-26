// ============================================
// routes/reputationWidget.js — Item 14
// Embeddable reputation badge widget
//
// PUBLIC:
//   GET  /api/rep-widget/:token/data   — JSON data for the widget JS
//   GET  /api/rep-widget/:token/badge  — standalone SVG badge
//   POST /api/rep-widget/:token/click  — track click events
//
// PRIVATE (dashboard):
//   GET  /api/rep-widget/config        — get widget config + embed code
//   PUT  /api/rep-widget/config        — update style/colors/text
//   POST /api/rep-widget/config/rotate — rotate public token
// ============================================

const express = require('express');
const router  = express.Router();
const { query }             = require('../database/db');
const { authenticateToken } = require('../middleware/auth');
const logger                = require('../utils/logger');

function esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── GET CONFIG OR CREATE IF MISSING ──────────────────────────────────────────
async function getOrCreateConfig(locationId) {
  let res = await query(
    'SELECT * FROM reputation_widgets WHERE location_id=$1', [locationId]
  );
  if (!res.rows[0]) {
    res = await query(
      `INSERT INTO reputation_widgets (location_id) VALUES ($1) RETURNING *`,
      [locationId]
    );
  }
  return res.rows[0];
}

// ── GET LIVE RATING DATA ──────────────────────────────────────────────────────
async function getLiveData(locationId) {
  const locRes = await query(
    `SELECT l.business_name, l.business_type, l.city,
            l.google_review_link, l.google_place_id,
            AVG(r.star_rating)::numeric(3,1) AS avg_rating,
            COUNT(r.id) AS review_count
     FROM locations l
     LEFT JOIN reviews r ON r.location_id = l.id AND r.platform = 'google'
     WHERE l.id = $1
     GROUP BY l.id`,
    [locationId]
  );
  return locRes.rows[0];
}

// ── PUBLIC: Widget data ───────────────────────────────────────────────────────
router.get('/:token/data', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=1800'); // 30 min cache

  try {
    const cfgRes = await query(
      `SELECT rw.*, l.id as location_id
       FROM reputation_widgets rw
       JOIN locations l ON l.id = rw.location_id
       WHERE rw.public_token = $1 AND rw.active = true`,
      [req.params.token]
    );
    const cfg = cfgRes.rows[0];
    if (!cfg) return res.status(404).json({ error: 'Widget not found' });

    const data = await getLiveData(cfg.location_id);
    if (!data) return res.status(404).json({ error: 'Location not found' });

    // Track view
    await query(
      'UPDATE reputation_widgets SET views = views + 1 WHERE public_token=$1',
      [req.params.token]
    ).catch(() => {});

    res.json({
      businessName:  data.business_name,
      avgRating:     parseFloat(data.avg_rating) || 0,
      reviewCount:   parseInt(data.review_count) || 0,
      reviewLink:    data.google_review_link || null,
      placeId:       data.google_place_id   || null,
      style:         cfg.style,
      position:      cfg.position,
      accentColor:   cfg.accent_color,
      showCount:     cfg.show_count,
      ctaText:       cfg.review_cta_text,
    });
  } catch (err) {
    logger.error('Rep widget data error:', err.message);
    res.status(500).json({ error: 'Failed to load widget' });
  }
});

// ── PUBLIC: SVG badge ─────────────────────────────────────────────────────────
router.get('/:token/badge', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Type', 'image/svg+xml');

  try {
    const cfgRes = await query(
      `SELECT rw.*, l.id as location_id FROM reputation_widgets rw
       JOIN locations l ON l.id = rw.location_id
       WHERE rw.public_token=$1 AND rw.active=true`,
      [req.params.token]
    );
    const cfg  = cfgRes.rows[0];
    if (!cfg)   return res.status(404).send('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');

    const data = await getLiveData(cfg.location_id);
    if (!data)  return res.status(404).send('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');

    const rating  = parseFloat(data.avg_rating || 0).toFixed(1);
    const count   = parseInt(data.review_count || 0);
    const accent  = esc(cfg.accent_color || '#f5c842');
    const name    = esc(data.business_name || 'SwarmReply');
    const stars   = Math.round(parseFloat(rating));
    const starStr = '★'.repeat(stars) + '☆'.repeat(5 - stars);

    res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="64" viewBox="0 0 240 64">
  <rect width="240" height="64" rx="12" fill="white" stroke="#e4e0d8" stroke-width="1.5"/>
  <rect x="0" y="0" width="6" height="64" rx="3" fill="${accent}"/>
  <text x="18" y="22" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#0a0a0a">${name}</text>
  <text x="18" y="44" font-family="system-ui,sans-serif" font-size="20" fill="${accent}">${starStr}</text>
  <text x="130" y="36" font-family="system-ui,sans-serif" font-size="20" font-weight="900" fill="#0a0a0a">${rating}</text>
  <text x="130" y="50" font-family="system-ui,sans-serif" font-size="9" fill="#7a7670">${count.toLocaleString()} Google reviews</text>
  <text x="200" y="58" font-family="system-ui,sans-serif" font-size="7" fill="#c8c4bc">SwarmReply</text>
</svg>`);
  } catch (err) {
    res.status(500).send('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  }
});

// ── PUBLIC: Track click ───────────────────────────────────────────────────────
router.post('/:token/click', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  await query(
    'UPDATE reputation_widgets SET clicks = clicks + 1 WHERE public_token=$1',
    [req.params.token]
  ).catch(() => {});
  res.json({ success: true });
});

// ── PRIVATE: Get config + embed code ─────────────────────────────────────────
router.get('/config', authenticateToken, async (req, res) => {
  try {
    const locRes = await query(
      'SELECT id FROM locations WHERE customer_id=$1 LIMIT 1', [req.user.customerId]
    );
    const locationId = locRes.rows[0]?.id;
    if (!locationId) return res.status(404).json({ error: 'No location found' });

    const cfg      = await getOrCreateConfig(locationId);
    const baseUrl  = process.env.FRONTEND_URL || 'https://swarmreply.com';
    const widgetUrl = `${baseUrl}/rep-widget.js`;

    const embedCode = `<!-- SwarmReply Reputation Widget -->
<script src="${widgetUrl}" data-token="${cfg.public_token}" async></script>`;

    const badgeUrl  = `${process.env.BACKEND_URL || ''}/api/rep-widget/${cfg.public_token}/badge`;
    const badgeCode = `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(cfg.public_token)}" target="_blank">
  <img src="${badgeUrl}" alt="Google Reviews" style="height:64px;border:none"/>
</a>`;

    res.json({
      success: true, config: cfg,
      embedCode, badgeCode,
      stats: { views: cfg.views, clicks: cfg.clicks },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PRIVATE: Update config ────────────────────────────────────────────────────
router.put('/config', authenticateToken, async (req, res) => {
  const { style, position, accentColor, showCount, reviewCtaText } = req.body;
  const allowed = { style: ['floating','bar','badge','card'],
                    position: ['bottom-right','bottom-left','top-right','top-left'] };

  if (style    && !allowed.style.includes(style))    return res.status(400).json({ error: 'Invalid style' });
  if (position && !allowed.position.includes(position)) return res.status(400).json({ error: 'Invalid position' });

  try {
    const locRes = await query(
      'SELECT id FROM locations WHERE customer_id=$1 LIMIT 1', [req.user.customerId]
    );
    const locationId = locRes.rows[0]?.id;
    if (!locationId) return res.status(404).json({ error: 'No location found' });

    await getOrCreateConfig(locationId);
    await query(
      `UPDATE reputation_widgets SET
         style          = COALESCE($2, style),
         position       = COALESCE($3, position),
         accent_color   = COALESCE($4, accent_color),
         show_count     = COALESCE($5, show_count),
         review_cta_text = COALESCE($6, review_cta_text),
         updated_at     = NOW()
       WHERE location_id = $1`,
      [locationId, style||null, position||null,
       accentColor||null, showCount??null, reviewCtaText||null]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PRIVATE: Rotate token ─────────────────────────────────────────────────────
router.post('/config/rotate', authenticateToken, async (req, res) => {
  try {
    const locRes = await query(
      'SELECT id FROM locations WHERE customer_id=$1 LIMIT 1', [req.user.customerId]
    );
    const locationId = locRes.rows[0]?.id;
    if (!locationId) return res.status(404).json({ error: 'No location found' });

    const result = await query(
      `UPDATE reputation_widgets
       SET public_token = encode(gen_random_bytes(24),'hex'), updated_at=NOW()
       WHERE location_id=$1
       RETURNING public_token`,
      [locationId]
    );
    res.json({ success: true, newToken: result.rows[0]?.public_token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
