// ============================================
// services/widgetService.js
// Review Widget — backend logic
//
// Responsibilities:
//  - Fetch filtered reviews for a widget token
//  - Build the JSON-LD schema.org markup
//  - Cache widget data (refreshed hourly)
//  - Track view counts
//  - Generate and rotate widget tokens
// ============================================

const { query } = require('../database/db');
const logger = require('../utils/logger');

// ============================================
// PUBLIC API — called by the widget endpoint
// This is the hot path: every page load on every
// customer website that has the widget installed
// ============================================

/**
 * getWidgetData()
 * Given a public widget token, return everything
 * the frontend JS needs to render the widget.
 * Results are cached in widget_configs and
 * refreshed hourly by the scheduler.
 *
 * @param {string} token  - widget_configs.widget_token
 * @returns {Object}      - widget data or null
 */
async function getWidgetData(token) {
  if (!token || token.length < 16) return null;

  try {
    // 1. Load widget config + location info
    const configResult = await query(
      `SELECT
         wc.*,
         l.business_name,
         l.owner_name,
         l.google_review_link,
         l.place_id,
         l.is_active as location_active
       FROM widget_configs wc
       JOIN locations l ON wc.location_id = l.id
       WHERE wc.widget_token = $1
         AND wc.is_active = true
         AND l.is_active = true`,
      [token]
    );

    if (!configResult.rows.length) return null;
    const config = configResult.rows[0];

    // 2. Fetch filtered reviews
    const reviews = await getFilteredReviews(
      config.location_id,
      config.min_stars,
      config.max_reviews
    );

    // 3. Track view (async, fire and forget)
    trackView(config.id).catch(() => {});

    // 4. Calculate aggregate stats
    const stats = await getAggregateStats(config.location_id);

    // 5. Build response
    return {
      businessName:   config.business_name,
      ownerName:      config.owner_name,
      layout:         config.layout,
      theme:          config.theme,
      accentColor:    config.accent_color,
      fontFamily:     config.font_family,
      borderRadius:   config.border_radius,
      showDate:       config.show_date,
      showReviewer:   config.show_reviewer,
      showPlatform:   config.show_platform,
      showReply:      config.show_reply,
      showCta:        config.show_cta,
      ctaText:        config.cta_text,
      ctaUrl:         config.cta_url || config.google_review_link,
      schemaEnabled:  config.schema_enabled,
      stats: {
        avgRating:   stats.avgRating,
        totalReviews: stats.totalReviews
      },
      reviews: reviews.map(formatReview),
      jsonLd: config.schema_enabled
        ? buildJsonLd(config, reviews, stats)
        : null
    };

  } catch (err) {
    logger.error('getWidgetData error:', err.message);
    return null;
  }
}

/**
 * getFilteredReviews()
 * Pull reviews that are safe to display publicly:
 * - Met the minimum star threshold
 * - Have actual review text (not just a star rating)
 * - Have been successfully replied to (quality filter)
 * - Ordered by star rating desc, then recency
 */
async function getFilteredReviews(locationId, minStars, maxReviews) {
  const result = await query(
    `SELECT
       r.id,
       r.reviewer_name,
       r.star_rating,
       r.review_text,
       r.review_date,
       r.language,
       r.platform,
       rp.posted_reply,
       rp.replied_at
     FROM reviews r
     LEFT JOIN review_replies rp ON r.id = rp.review_id
     WHERE r.location_id = $1
       AND r.star_rating >= $2
       AND r.review_text IS NOT NULL
       AND LENGTH(TRIM(r.review_text)) > 20
       AND r.status = 'replied'
     ORDER BY r.star_rating DESC, r.review_date DESC
     LIMIT $3`,
    [locationId, minStars, maxReviews]
  );
  return result.rows;
}

/**
 * getAggregateStats()
 * Overall rating stats for a location.
 * Used in JSON-LD and badge layout.
 */
async function getAggregateStats(locationId) {
  const result = await query(
    `SELECT
       ROUND(AVG(star_rating)::numeric, 1) as avg_rating,
       COUNT(*) as total_reviews
     FROM reviews
     WHERE location_id = $1
       AND star_rating IS NOT NULL`,
    [locationId]
  );
  const row = result.rows[0];
  return {
    avgRating:    parseFloat(row.avg_rating) || 0,
    totalReviews: parseInt(row.total_reviews) || 0
  };
}

/**
 * formatReview()
 * Clean and truncate review data for public output.
 * Never expose internal IDs or sensitive fields.
 */
function formatReview(row) {
  return {
    id:           row.id,
    name:         anonymizeName(row.reviewer_name),
    rating:       row.star_rating,
    text:         truncateText(row.review_text, 280),
    date:         row.review_date
                    ? new Date(row.review_date).toLocaleDateString('en-US', {
                        month: 'long', year: 'numeric'
                      })
                    : null,
    platform:     row.platform || 'google',
    reply:        row.posted_reply
                    ? truncateText(row.posted_reply, 200)
                    : null
  };
}

/**
 * anonymizeName()
 * Show first name + last initial only: "Sarah M."
 * Protects reviewer privacy on public embeds.
 */
function anonymizeName(name) {
  if (!name) return 'Anonymous';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

function truncateText(text, maxLen) {
  if (!text) return '';
  const t = text.trim();
  if (t.length <= maxLen) return t;
  return t.substring(0, maxLen).replace(/\s+\S*$/, '') + '…';
}

// ============================================
// JSON-LD SCHEMA BUILDER
// Outputs schema.org/LocalBusiness markup with
// embedded Review items — shows star ratings
// in Google search results (rich snippets)
// ============================================

function buildJsonLd(config, reviews, stats) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    'name': config.business_name,
    'aggregateRating': {
      '@type': 'AggregateRating',
      'ratingValue': stats.avgRating.toFixed(1),
      'reviewCount': stats.totalReviews,
      'bestRating': '5',
      'worstRating': '1'
    },
    'review': reviews.slice(0, 5).map(r => ({
      '@type': 'Review',
      'author': {
        '@type': 'Person',
        'name': anonymizeName(r.reviewer_name)
      },
      'reviewRating': {
        '@type': 'Rating',
        'ratingValue': r.star_rating,
        'bestRating': '5',
        'worstRating': '1'
      },
      'reviewBody': truncateText(r.review_text, 200),
      'datePublished': r.review_date
        ? new Date(r.review_date).toISOString().split('T')[0]
        : undefined
    }))
  };

  return JSON.stringify(schema);
}

// ============================================
// DASHBOARD API — called by authenticated routes
// ============================================

/**
 * getOrCreateWidgetConfig()
 * Get existing config or create default one.
 * Called when a customer opens the widget builder.
 */
async function getOrCreateWidgetConfig(locationId) {
  // Try to get existing
  const existing = await query(
    `SELECT wc.*, l.business_name, l.google_review_link
     FROM widget_configs wc
     JOIN locations l ON wc.location_id = l.id
     WHERE wc.location_id = $1`,
    [locationId]
  );

  if (existing.rows.length) return existing.rows[0];

  // Create default config
  const created = await query(
    `INSERT INTO widget_configs (location_id)
     VALUES ($1)
     RETURNING *`,
    [locationId]
  );
  return created.rows[0];
}

/**
 * updateWidgetConfig()
 * Update settings from the dashboard builder.
 */
async function updateWidgetConfig(locationId, settings) {
  const {
    layout, minStars, maxReviews, showDate,
    showReviewer, showPlatform, showReply,
    theme, accentColor, fontFamily, borderRadius,
    showCta, ctaText, ctaUrl, schemaEnabled
  } = settings;

  const result = await query(
    `UPDATE widget_configs SET
       layout        = COALESCE($2, layout),
       min_stars     = COALESCE($3, min_stars),
       max_reviews   = COALESCE($4, max_reviews),
       show_date     = COALESCE($5, show_date),
       show_reviewer = COALESCE($6, show_reviewer),
       show_platform = COALESCE($7, show_platform),
       show_reply    = COALESCE($8, show_reply),
       theme         = COALESCE($9, theme),
       accent_color  = COALESCE($10, accent_color),
       font_family   = COALESCE($11, font_family),
       border_radius = COALESCE($12, border_radius),
       show_cta      = COALESCE($13, show_cta),
       cta_text      = COALESCE($14, cta_text),
       cta_url       = COALESCE($15, cta_url),
       schema_enabled = COALESCE($16, schema_enabled),
       updated_at    = NOW()
     WHERE location_id = $1
     RETURNING *`,
    [
      locationId, layout, minStars, maxReviews,
      showDate, showReviewer, showPlatform, showReply,
      theme, accentColor, fontFamily, borderRadius,
      showCta, ctaText, ctaUrl, schemaEnabled
    ]
  );

  return result.rows[0];
}

/**
 * rotateWidgetToken()
 * Generate a new token — invalidates old embed code.
 * Only offered as an option if the customer suspects
 * their token was scraped.
 */
async function rotateWidgetToken(locationId) {
  const result = await query(
    `UPDATE widget_configs
     SET widget_token = encode(gen_random_bytes(16), 'hex'),
         updated_at = NOW()
     WHERE location_id = $1
     RETURNING widget_token`,
    [locationId]
  );
  return result.rows[0]?.widget_token;
}

/**
 * getWidgetAnalytics()
 * Basic view stats for the dashboard.
 */
async function getWidgetAnalytics(locationId) {
  const result = await query(
    `SELECT
       total_views,
       last_served_at,
       embed_count,
       cached_avg_rating,
       cached_review_count,
       cache_updated_at
     FROM widget_configs
     WHERE location_id = $1`,
    [locationId]
  );
  return result.rows[0] || null;
}

/**
 * refreshWidgetCache()
 * Called hourly by scheduler — pre-computes stats
 * so widget responses are instant.
 */
async function refreshWidgetCache() {
  try {
    const widgets = await query(
      'SELECT id, location_id FROM widget_configs WHERE is_active = true',
      []
    );

    for (const w of widgets.rows) {
      const stats = await getAggregateStats(w.location_id);
      await query(
        `UPDATE widget_configs SET
           cached_avg_rating   = $1,
           cached_review_count = $2,
           cache_updated_at    = NOW()
         WHERE id = $3`,
        [stats.avgRating, stats.totalReviews, w.id]
      );
    }

    logger.info(`Widget cache refreshed for ${widgets.rows.length} widgets`);
  } catch (err) {
    logger.error('refreshWidgetCache error:', err.message);
  }
}

// ============================================
// HELPERS
// ============================================

async function trackView(widgetConfigId) {
  await query(
    `UPDATE widget_configs SET
       total_views   = total_views + 1,
       last_served_at = NOW()
     WHERE id = $1`,
    [widgetConfigId]
  );
}

module.exports = {
  getWidgetData,
  getOrCreateWidgetConfig,
  updateWidgetConfig,
  rotateWidgetToken,
  getWidgetAnalytics,
  refreshWidgetCache
};
