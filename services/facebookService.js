// ============================================
// services/facebookService.js
// Facebook Business Reviews Integration
//
// Responsibilities:
//   - OAuth flow (Facebook Login for Business Pages)
//   - Fetch page ratings and recommendations
//   - Post public replies via Graph API
//   - Sync reviews into the reviews table
//   - Monitor for new reviews on schedule
//
// Facebook Graph API endpoints used:
//   GET /{page-id}/ratings          — fetch reviews
//   POST /{review-id}/comments      — post a reply
//   GET /me/accounts                — get pages the user manages
//
// Permissions required:
//   pages_show_list
//   pages_read_engagement
//   pages_read_user_content
//   pages_manage_engagement        (for posting replies)
// ============================================

const axios  = require('axios');
const { query } = require('../database/db');
const logger = require('../utils/logger');

const FB_API = 'https://graph.facebook.com/v19.0';
const APP_ID     = process.env.FACEBOOK_APP_ID;
const APP_SECRET = process.env.FACEBOOK_APP_SECRET;
const REDIRECT_URI = `${process.env.BACKEND_URL}/api/platforms/facebook/callback`;

// ── OAUTH ─────────────────────────────────────────────────────────────────────

/**
 * getAuthUrl()
 * Generate the Facebook OAuth URL for a location.
 * The business owner clicks this to connect their Facebook Page.
 */
function getAuthUrl(locationId) {
  const scopes = [
    'pages_show_list',
    'pages_read_engagement',
    'pages_read_user_content',
    'pages_manage_engagement'
  ].join(',');

  const params = new URLSearchParams({
    client_id:     APP_ID,
    redirect_uri:  REDIRECT_URI,
    scope:         scopes,
    state:         locationId,   // passed back in callback to identify location
    response_type: 'code'
  });

  return `https://www.facebook.com/dialog/oauth?${params.toString()}`;
}

/**
 * handleCallback()
 * Exchange the auth code for a long-lived page access token.
 * Stores the token and page details in connected_platforms.
 */
async function handleCallback(code, locationId) {
  // 1. Exchange code for short-lived user token
  const tokenRes = await axios.get(`${FB_API}/oauth/access_token`, {
    params: {
      client_id:     APP_ID,
      client_secret: APP_SECRET,
      redirect_uri:  REDIRECT_URI,
      code
    }
  });
  const shortToken = tokenRes.data.access_token;

  // 2. Exchange for long-lived user token (60 days)
  const longRes = await axios.get(`${FB_API}/oauth/access_token`, {
    params: {
      grant_type:        'fb_exchange_token',
      client_id:         APP_ID,
      client_secret:     APP_SECRET,
      fb_exchange_token: shortToken
    }
  });
  const longToken   = longRes.data.access_token;
  const expiresIn   = longRes.data.expires_in; // seconds

  // 3. Get the pages this user manages
  const pagesRes = await axios.get(`${FB_API}/me/accounts`, {
    params: { access_token: longToken, fields: 'id,name,access_token' }
  });

  if (!pagesRes.data.data?.length) {
    throw new Error('No Facebook Pages found. Make sure you are an admin of at least one Business Page.');
  }

  // Take the first page (UI will let them pick later)
  const page = pagesRes.data.data[0];

  // 4. Page token is permanent — no expiry. Store it.
  const expiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000)
    : null;

  await query(
    `INSERT INTO connected_platforms
       (location_id, platform, access_token, token_expires_at,
        page_id, page_name, is_active, auto_reply)
     VALUES ($1, 'facebook', $2, $3, $4, $5, true, true)
     ON CONFLICT (location_id, platform)
     DO UPDATE SET
       access_token     = EXCLUDED.access_token,
       token_expires_at = EXCLUDED.token_expires_at,
       page_id          = EXCLUDED.page_id,
       page_name        = EXCLUDED.page_name,
       is_active        = true,
       updated_at       = NOW()`,
    [locationId, page.access_token, expiresAt, page.id, page.name]
  );

  // 5. Seed a review destination for this location
  await query(
    `INSERT INTO review_destinations
       (location_id, platform, label, url, icon, sort_order)
     VALUES ($1, 'facebook',
       'Leave a Facebook review',
       $2, '📘', 2)
     ON CONFLICT (location_id, platform)
     DO UPDATE SET url = EXCLUDED.url, label = EXCLUDED.label`,
    [locationId, `https://www.facebook.com/${page.id}/reviews`]
  );

  logger.info(`Facebook connected for location ${locationId}: Page "${page.name}" (${page.id})`);
  return { pageName: page.name, pageId: page.id };
}

// ── REVIEW FETCHING ───────────────────────────────────────────────────────────

/**
 * fetchReviews()
 * Pull all ratings from the Facebook Page and store new ones.
 * Called by the scheduler every hour.
 */
async function fetchReviews(locationId) {
  const platform = await getPlatformRecord(locationId);
  if (!platform) return { fetched: 0, newReviews: 0 };

  try {
    // Fetch ratings from Graph API
    const res = await axios.get(`${FB_API}/${platform.page_id}/ratings`, {
      params: {
        access_token: platform.access_token,
        fields: 'reviewer{name,id},rating,review_text,created_time,recommendation_type,has_rating,has_review',
        limit: 100
      }
    });

    const ratings = res.data.data || [];
    let newCount  = 0;

    for (const rating of ratings) {
      if (!rating.has_review && !rating.has_rating) continue;

      const reviewer  = rating.reviewer?.name || 'Facebook User';
      const stars     = rating.rating || (rating.recommendation_type === 'positive' ? 5 : 1);
      const text      = rating.review_text || (rating.recommendation_type === 'positive' ? 'Recommends this business.' : 'Does not recommend this business.');
      const createdAt = new Date(rating.created_time);
      const fbId      = rating.reviewer?.id;

      // Upsert into reviews table
      const result = await query(
        `INSERT INTO reviews
           (location_id, platform, platform_review_id, facebook_review_id,
            facebook_page_id, reviewer_name, star_rating, review_text,
            review_date, status, recommends)
         VALUES ($1, 'facebook', $2, $2, $3, $4, $5, $6, $7, 'pending', $8)
         ON CONFLICT (platform_review_id)
         DO NOTHING
         RETURNING id`,
        [
          locationId,
          `fb_${fbId}_${platform.page_id}`,
          platform.page_id,
          reviewer,
          stars,
          text,
          createdAt,
          rating.recommendation_type === 'positive'
        ]
      );

      if (result.rows[0]) newCount++;
    }

    // Update last synced
    await query(
      `UPDATE connected_platforms
       SET last_synced_at = NOW(), total_reviews = $2
       WHERE location_id = $1 AND platform = 'facebook'`,
      [locationId, ratings.length]
    );

    logger.info(`Facebook sync for ${locationId}: ${ratings.length} total, ${newCount} new`);
    return { fetched: ratings.length, newReviews: newCount };

  } catch (err) {
    logger.error(`Facebook fetch failed for ${locationId}:`, err.message);
    // Handle token expiry gracefully
    if (err.response?.data?.error?.code === 190) {
      await query(
        `UPDATE connected_platforms SET is_active = false WHERE location_id = $1 AND platform = 'facebook'`,
        [locationId]
      );
      logger.warn(`Facebook token expired for location ${locationId} — disconnected`);
    }
    return { fetched: 0, newReviews: 0, error: err.message };
  }
}

// ── REPLY ─────────────────────────────────────────────────────────────────────

/**
 * postReply()
 * Post a public reply to a Facebook rating.
 * Uses the Page access token to comment on the rating.
 */
async function postReply(locationId, facebookReviewId, replyText) {
  const platform = await getPlatformRecord(locationId);
  if (!platform) throw new Error('Facebook not connected for this location');

  // Facebook replies go on the rating object as comments
  const res = await axios.post(
    `${FB_API}/${facebookReviewId}/comments`,
    { message: replyText },
    { params: { access_token: platform.access_token } }
  );

  logger.info(`Facebook reply posted for review ${facebookReviewId}`);
  return { commentId: res.data.id };
}

// ── PAGE SELECTION ────────────────────────────────────────────────────────────

/**
 * getAvailablePages()
 * List all pages the connected user manages.
 * Used in the dashboard to let them pick which page to monitor.
 */
async function getAvailablePages(locationId) {
  const platform = await getPlatformRecord(locationId);
  if (!platform) return [];

  const res = await axios.get(`${FB_API}/me/accounts`, {
    params: {
      access_token: platform.access_token,
      fields: 'id,name,fan_count,picture{url}'
    }
  });

  return (res.data.data || []).map(p => ({
    id:       p.id,
    name:     p.name,
    fans:     p.fan_count,
    imageUrl: p.picture?.data?.url
  }));
}

/**
 * selectPage()
 * Change which Facebook Page is being monitored for this location.
 */
async function selectPage(locationId, pageId, pageAccessToken, pageName) {
  await query(
    `UPDATE connected_platforms
     SET page_id = $2, page_name = $3, access_token = $4, updated_at = NOW()
     WHERE location_id = $1 AND platform = 'facebook'`,
    [locationId, pageId, pageName, pageAccessToken]
  );

  // Update review destination URL
  await query(
    `UPDATE review_destinations
     SET url = $2
     WHERE location_id = $1 AND platform = 'facebook'`,
    [locationId, `https://www.facebook.com/${pageId}/reviews`]
  );

  logger.info(`Facebook page updated for location ${locationId}: ${pageName}`);
}

// ── DISCONNECT ────────────────────────────────────────────────────────────────

async function disconnect(locationId) {
  await query(
    `UPDATE connected_platforms
     SET is_active = false, access_token = NULL, updated_at = NOW()
     WHERE location_id = $1 AND platform = 'facebook'`,
    [locationId]
  );
  logger.info(`Facebook disconnected for location ${locationId}`);
}

// ── STATUS ────────────────────────────────────────────────────────────────────

async function getStatus(locationId) {
  const result = await query(
    `SELECT page_id, page_name, is_active, last_synced_at,
            total_reviews, avg_rating, created_at
     FROM connected_platforms
     WHERE location_id = $1 AND platform = 'facebook'`,
    [locationId]
  );
  return result.rows[0] || null;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

async function getPlatformRecord(locationId) {
  const result = await query(
    `SELECT * FROM connected_platforms
     WHERE location_id = $1 AND platform = 'facebook' AND is_active = true`,
    [locationId]
  );
  return result.rows[0] || null;
}

module.exports = {
  getAuthUrl,
  handleCallback,
  fetchReviews,
  postReply,
  getAvailablePages,
  selectPage,
  disconnect,
  getStatus
};
