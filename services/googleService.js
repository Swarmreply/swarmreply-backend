// ============================================
// services/googleService.js
// All Google Business Profile API interactions
// Handles OAuth, fetching reviews, posting replies
// ============================================

const { google } = require('googleapis');
const { query } = require('../database/db');
const { encrypt, decrypt } = require('../utils/encryption');
const logger = require('../utils/logger');

// Initialize Google OAuth client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Google Business Profile API scopes needed
const SCOPES = [
  'https://www.googleapis.com/auth/business.manage'
];

// ============================================
// OAUTH FUNCTIONS
// ============================================

/**
 * getAuthUrl()
 * Generate Google OAuth URL for customer to authorize
 * Customer clicks this link to connect their Google Business Profile
 *
 * @param {string} locationId - Our internal location ID (passed as state)
 * @returns {string} Google authorization URL
 */
function getAuthUrl(locationId) {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',    // get refresh token for permanent access
    scope: SCOPES,
    prompt: 'consent',          // force consent screen to get refresh token
    state: locationId           // passed back after auth to identify which location
  });
}

/**
 * exchangeCodeForTokens()
 * Exchange authorization code for access + refresh tokens
 * Called after customer authorizes on Google
 *
 * @param {string} code - Authorization code from Google callback
 * @param {string} locationId - Our internal location ID
 */
async function exchangeCodeForTokens(code, locationId) {
  try {
    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      throw new Error('No refresh token received — user may have already authorized. Ask them to revoke and re-authorize.');
    }

    // Encrypt tokens before storing
    const encryptedAccess = encrypt(tokens.access_token);
    const encryptedRefresh = encrypt(tokens.refresh_token);
    const expiresAt = new Date(tokens.expiry_date);

    // Store in database
    await query(
      `UPDATE locations
       SET access_token = $1,
           refresh_token = $2,
           token_expires_at = $3,
           updated_at = NOW()
       WHERE id = $4`,
      [encryptedAccess, encryptedRefresh, expiresAt, locationId]
    );

    logger.info(`Google tokens stored for location: ${locationId}`);
    return true;

  } catch (error) {
    logger.error('Failed to exchange Google OAuth code:', error.message);
    throw error;
  }
}

/**
 * getValidClient()
 * Get an authenticated Google API client for a location
 * Automatically refreshes expired tokens
 *
 * @param {string} locationId - Our internal location ID
 * @returns {Object} Authenticated OAuth2 client
 */
async function getValidClient(locationId) {
  try {
    // Fetch location's tokens from database
    const result = await query(
      'SELECT access_token, refresh_token, token_expires_at FROM locations WHERE id = $1',
      [locationId]
    );

    if (!result.rows.length) {
      throw new Error(`Location not found: ${locationId}`);
    }

    const location = result.rows[0];

    if (!location.refresh_token) {
      throw new Error(`No refresh token for location: ${locationId} — needs re-authorization`);
    }

    // Decrypt tokens
    const accessToken = decrypt(location.access_token);
    const refreshToken = decrypt(location.refresh_token);

    // Set credentials on client
    const client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
      expiry_date: new Date(location.token_expires_at).getTime()
    });

    // Auto-refresh token if expired or expiring in next 5 minutes
    const expiresAt = new Date(location.token_expires_at).getTime();
    const fiveMinutes = 5 * 60 * 1000;

    if (Date.now() + fiveMinutes >= expiresAt) {
      logger.info(`Refreshing Google token for location: ${locationId}`);

      const { credentials } = await client.refreshAccessToken();

      // Store new tokens
      const newEncryptedAccess = encrypt(credentials.access_token);
      const newExpiresAt = new Date(credentials.expiry_date);

      await query(
        `UPDATE locations
         SET access_token = $1,
             token_expires_at = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [newEncryptedAccess, newExpiresAt, locationId]
      );
    }

    return client;

  } catch (error) {
    logger.error(`Failed to get valid Google client for ${locationId}:`, error.message);
    throw error;
  }
}

// ============================================
// REVIEW FETCHING
// ============================================

/**
 * fetchNewReviews()
 * Fetch all reviews from Google Business Profile for a location
 * Stores new reviews in database, skips already processed ones
 *
 * @param {string} locationId - Our internal location ID
 * @returns {Array} Array of new reviews found
 */
async function fetchNewReviews(locationId) {
  const newReviews = [];

  try {
    // Get location details from DB
    const locResult = await query(
      'SELECT * FROM locations WHERE id = $1 AND is_active = true',
      [locationId]
    );

    if (!locResult.rows.length) {
      throw new Error(`Active location not found: ${locationId}`);
    }

    const location = locResult.rows[0];

    // Get authenticated Google client
    const client = await getValidClient(locationId);

    // Call Google Business Profile Reviews API
    const response = await makeGoogleAPICallWithRetry(async () => {
      const res = await client.request({
        url: `https://mybusiness.googleapis.com/v4/${location.platform_account_id}/locations/${location.platform_location_id}/reviews`,
        params: {
          pageSize: 50,     // fetch up to 50 reviews at once
          orderBy: 'updateTime desc'
        }
      });
      return res.data;
    });

    const reviews = response.reviews || [];
    logger.info(`Fetched ${reviews.length} reviews for location: ${location.business_name}`);

    // Process each review
    for (const review of reviews) {
      try {
        // Check if we already have this review
        const existing = await query(
          'SELECT id FROM reviews WHERE platform_review_id = $1',
          [review.reviewId]
        );

        // Skip if already processed
        if (existing.rows.length > 0) continue;

        // Skip if review already has a reply on Google
        if (review.reviewReply) {
          // Store it but mark as already replied
          await query(
            `INSERT INTO reviews
             (location_id, platform_review_id, reviewer_name, star_rating, review_text, review_date, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'replied')
             ON CONFLICT (platform_review_id) DO NOTHING`,
            [
              locationId,
              review.reviewId,
              review.reviewer?.displayName || 'Anonymous',
              starRatingToNumber(review.starRating),
              review.comment || '',
              new Date(review.updateTime)
            ]
          );
          continue;
        }

        // Insert new review that needs a reply
        const insertResult = await query(
          `INSERT INTO reviews
           (location_id, platform_review_id, reviewer_name, star_rating, review_text, review_date, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending')
           RETURNING *`,
          [
            locationId,
            review.reviewId,
            review.reviewer?.displayName || 'Anonymous',
            starRatingToNumber(review.starRating),
            review.comment || '',
            new Date(review.updateTime)
          ]
        );

        newReviews.push(insertResult.rows[0]);
        logger.info(`New review stored: ${review.reviewId} for ${location.business_name}`);

      } catch (reviewError) {
        // Don't let one bad review stop all others
        logger.error(`Error processing review ${review.reviewId}:`, reviewError.message);
      }
    }

    // Update last synced timestamp
    await query(
      'UPDATE locations SET last_synced_at = NOW() WHERE id = $1',
      [locationId]
    );

    return newReviews;

  } catch (error) {
    logger.error(`Failed to fetch reviews for location ${locationId}:`, error.message);
    throw error;
  }
}

// ============================================
// REPLY POSTING
// ============================================

/**
 * postReplyToGoogle()
 * Post an AI-generated reply to a Google review
 *
 * @param {string} locationId - Our internal location ID
 * @param {string} platformReviewId - Google's review ID
 * @param {string} replyText - The reply text to post
 * @returns {boolean} Success status
 */
async function postReplyToGoogle(locationId, platformReviewId, replyText) {
  try {
    // Validate reply text
    if (!replyText || replyText.trim().length < 5) {
      throw new Error('Reply text is too short or empty');
    }

    if (replyText.length > 4096) {
      // Truncate if too long (Google's limit)
      replyText = replyText.substring(0, 4090) + '...';
      logger.warn(`Reply truncated for review: ${platformReviewId}`);
    }

    // Get location details
    const locResult = await query(
      'SELECT * FROM locations WHERE id = $1',
      [locationId]
    );
    const location = locResult.rows[0];

    // Get authenticated client
    const client = await getValidClient(locationId);

    // Post reply to Google
    await makeGoogleAPICallWithRetry(async () => {
      await client.request({
        method: 'PUT',
        url: `https://mybusiness.googleapis.com/v4/${location.platform_account_id}/locations/${location.platform_location_id}/reviews/${platformReviewId}/reply`,
        data: { comment: replyText }
      });
    });

    logger.info(`Reply posted to Google for review: ${platformReviewId}`);
    return true;

  } catch (error) {
    logger.error(`Failed to post Google reply for review ${platformReviewId}:`, error.message);
    throw error;
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * makeGoogleAPICallWithRetry()
 * Wrapper for all Google API calls with retry logic
 * Handles rate limits and transient errors
 *
 * @param {Function} apiCall - Async function that makes the API call
 * @param {number} maxRetries - Maximum retry attempts (default 3)
 */
async function makeGoogleAPICallWithRetry(apiCall, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await apiCall();
    } catch (error) {
      const isRateLimit = error.code === 429 || error.message?.includes('quota');
      const isTransient = error.code >= 500 || error.message?.includes('UNAVAILABLE');

      // Only retry on rate limits and transient errors
      if ((isRateLimit || isTransient) && attempt < maxRetries) {
        // Exponential backoff: 2s, 4s, 8s
        const waitTime = Math.pow(2, attempt) * 1000;
        logger.warn(`Google API attempt ${attempt} failed, retrying in ${waitTime}ms:`, error.message);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      // Not retryable or out of retries
      throw error;
    }
  }
}

/**
 * starRatingToNumber()
 * Convert Google's star rating string to integer
 * Google returns: "FIVE", "FOUR", "THREE", "TWO", "ONE"
 */
function starRatingToNumber(starRating) {
  const map = {
    'FIVE': 5, 'FOUR': 4, 'THREE': 3, 'TWO': 2, 'ONE': 1
  };
  return map[starRating] || 0;
}

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  getValidClient,
  fetchNewReviews,
  postReplyToGoogle
};
