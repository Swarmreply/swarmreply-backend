// ============================================
// services/googlePostsService.js
// Google Business Profile — Auto Post Publisher
//
// Flow:
//  1. Scheduler fires weekly (or on-demand)
//  2. Find best recent review for each enabled location
//  3. Claude writes a Google Post (quoted review + CTA)
//  4. POST to Google Business Profile localPosts API
//  5. Store result, update next_post_at
//
// Google Posts facts:
//  - Standard posts expire after 7 days — Google removes them
//  - Max post length: 1,500 characters
//  - CTA button is optional but improves engagement
//  - Posts appear in Business Profile on Search and Maps
//  - Posting regularly signals active business to Google's ranking algo
//  - One post per week is the recommended cadence
// ============================================

const Anthropic = require('@anthropic-ai/sdk');
const { query }           = require('../database/db');
const { getValidClient, makeGoogleAPICallWithRetry } = require('./googleService');
const logger              = require('../utils/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Google Posts expire after 7 days
const POST_TTL_DAYS = 7;

// ============================================
// SCHEDULER ENTRY POINT
// Called by the cron job — processes all
// locations that are due for a new post
// ============================================

/**
 * processScheduledPosts()
 * Find all locations where:
 *  - Google Posts is enabled
 *  - next_post_at <= NOW()
 *  - Location is active and has valid OAuth tokens
 * Then generate and publish a post for each.
 */
async function processScheduledPosts() {
  try {
    const result = await query(
      `SELECT
         gpc.*,
         l.id           AS location_id,
         l.business_name,
         l.platform_account_id,
         l.platform_location_id,
         l.tone,
         l.always_include,
         l.never_include,
         l.contact_email,
         l.is_active,
         l.refresh_token
       FROM google_post_configs gpc
       JOIN locations l ON gpc.location_id = l.id
       WHERE gpc.is_enabled = true
         AND l.is_active = true
         AND l.refresh_token IS NOT NULL
         AND (
           gpc.next_post_at IS NULL
           OR gpc.next_post_at <= NOW()
         )`,
      []
    );

    logger.info(`Google Posts: ${result.rows.length} location(s) due for a post`);

    for (const config of result.rows) {
      try {
        await generateAndPublishPost(config);
      } catch (err) {
        logger.error(
          `Google Posts: Failed for ${config.business_name}: ${err.message}`
        );
      }

      // Small delay between locations — avoid hammering Google API
      await sleep(2000);
    }

  } catch (err) {
    logger.error('processScheduledPosts error:', err.message);
  }
}

// ============================================
// CORE: GENERATE + PUBLISH
// ============================================

/**
 * generateAndPublishPost()
 * Main pipeline for one location:
 *  1. Pick the best review
 *  2. Generate post content with Claude
 *  3. Save draft to DB
 *  4. Publish to Google (or stage for approval)
 *  5. Update schedule
 */
async function generateAndPublishPost(config) {
  const locationId = config.location_id;
  logger.info(`Google Posts: Generating post for ${config.business_name}`);

  // ── 1. Find the best review to feature ──
  const review = await pickBestReview(locationId, config.min_stars);
  if (!review) {
    logger.info(`Google Posts: No suitable review found for ${config.business_name} — skipping`);
    await updateNextPostAt(config.id, config.frequency);
    return;
  }

  // ── 2. Generate post content with Claude ──
  const postContent = await generatePostContent(review, config);

  // ── 3. Save draft post to DB ──
  const scheduledFor = new Date();
  const expiresAt    = new Date(Date.now() + POST_TTL_DAYS * 24 * 60 * 60 * 1000);

  const insertResult = await query(
    `INSERT INTO google_posts
     (location_id, config_id, review_id, reviewer_name, review_stars,
      review_excerpt, post_text, post_summary, cta_type, cta_url,
      status, scheduled_for, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      locationId,
      config.id,
      review.id,
      review.reviewer_name,
      review.star_rating,
      truncate(review.review_text, 150),
      postContent.text,
      postContent.summary,
      config.cta_type,
      config.cta_url,
      config.require_approval ? 'draft' : 'pending',
      scheduledFor,
      expiresAt
    ]
  );

  const postId = insertResult.rows[0].id;

  // ── 4. Publish (or stage for approval) ──
  if (config.require_approval) {
    logger.info(`Google Posts: Post ${postId} staged for approval (require_approval=true)`);
    await updateNextPostAt(config.id, config.frequency);
    return;
  }

  await publishPost(postId, locationId, config, postContent);
}

/**
 * publishPost()
 * Hit the Google Business Profile API to create the post.
 * Handles retries via the existing makeGoogleAPICallWithRetry wrapper.
 */
async function publishPost(postId, locationId, config, postContent) {
  try {
    // Build the Google API payload
    const payload = buildGooglePostPayload(postContent, config);

    // Get authenticated client (reuses existing token refresh logic)
    const client = await getValidClient(locationId);

    // POST to Google localPosts API
    const response = await makeGoogleAPICallWithRetry(async () => {
      const res = await client.request({
        method: 'POST',
        url: buildPostsApiUrl(config.platform_account_id, config.platform_location_id),
        data: payload
      });
      return res.data;
    });

    // Extract Google's resource name from response
    const googlePostName = response.name || null;
    const googlePostUrl  = response.searchUrl || null;

    // ── 5. Update DB with success ──
    await query(
      `UPDATE google_posts SET
         status           = 'published',
         google_post_name = $1,
         google_post_url  = $2,
         published_at     = NOW(),
         updated_at       = NOW()
       WHERE id = $3`,
      [googlePostName, googlePostUrl, postId]
    );

    // Update config stats
    await query(
      `UPDATE google_post_configs SET
         total_posts  = total_posts + 1,
         last_post_at = NOW(),
         updated_at   = NOW()
       WHERE id = $4`,
      [config.id]
    );

    await updateNextPostAt(config.id, config.frequency);

    logger.info(
      `Google Posts: Published for ${config.business_name} — ${googlePostName}`
    );

  } catch (err) {
    logger.error(
      `Google Posts: Publish failed for post ${postId}: ${err.message}`
    );

    // Mark as failed with error message
    await query(
      `UPDATE google_posts SET
         status        = 'failed',
         error_message = $1,
         retry_count   = retry_count + 1,
         last_retry_at = NOW(),
         updated_at    = NOW()
       WHERE id = $2`,
      [err.message, postId]
    );

    // Still advance the schedule so we don't retry the same week
    await updateNextPostAt(config.id, config.frequency);

    throw err;
  }
}

// ============================================
// REVIEW PICKER
// Selects the best review to feature
// ── Priority rules:
//   1. Meet minimum star threshold
//   2. Has substantive text (> 30 chars)
//   3. Not already featured in a recent post
//   4. Most recent first, then highest rated
// ============================================

async function pickBestReview(locationId, minStars = 4) {
  // Find review IDs already used in recent posts (last 90 days)
  const recentResult = await query(
    `SELECT review_id FROM google_posts
     WHERE location_id = $1
       AND review_id IS NOT NULL
       AND created_at >= NOW() - INTERVAL '90 days'`,
    [locationId]
  );
  const usedIds = recentResult.rows.map(r => r.review_id);

  const result = await query(
    `SELECT
       r.id, r.reviewer_name, r.star_rating,
       r.review_text, r.review_date,
       rp.posted_reply
     FROM reviews r
     LEFT JOIN replies rp ON r.id = rp.review_id AND rp.status = 'posted'
     WHERE r.location_id   = $1
       AND r.star_rating   >= $2
       AND r.review_text   IS NOT NULL
       AND LENGTH(TRIM(r.review_text)) > 30
       AND r.status        = 'replied'
       ${usedIds.length ? `AND r.id NOT IN (${usedIds.map((_, i) => `$${i + 3}`).join(',')})` : ''}
     ORDER BY r.star_rating DESC, r.review_date DESC
     LIMIT 1`,
    usedIds.length
      ? [locationId, minStars, ...usedIds]
      : [locationId, minStars]
  );

  return result.rows[0] || null;
}

// ============================================
// CLAUDE CONTENT GENERATOR
// Writes the Google Post text
//
// Strategy: quote a snippet of the review,
// add a warm sentence from the owner, include
// a soft CTA. Max 1,500 chars (Google's limit).
// Keep it conversational — not corporate.
// ============================================

async function generatePostContent(review, config) {
  // Truncate the review quote to ~120 chars for the post
  const reviewQuote = truncate(review.review_text, 120);

  // Build reviewer first name only for warmth
  const firstName = (review.reviewer_name || 'A customer')
    .split(' ')[0];

  const toneGuide = {
    warm:         'warm, genuine, and personal — like a thank-you note',
    professional: 'professional and polished, but still human',
    casual:       'conversational, friendly, and relaxed',
    empathetic:   'caring, appreciative, and deeply human'
  };

  const alwaysInclude = config.always_include?.length
    ? `\nAlways include these words/phrases somewhere: ${config.always_include.join(', ')}`
    : '';
  const neverInclude = config.never_include?.length
    ? `\nNever include: ${config.never_include.join(', ')}`
    : '';

  const ctaInstruction = config.include_cta && config.cta_url
    ? `\nEnd with a single soft call-to-action inviting readers to visit, book, or leave their own review. Do not include the URL — just the invite.`
    : '';

  const customInstruction = config.custom_prompt
    ? `\nAdditional instructions: ${config.custom_prompt}`
    : '';

  const prompt = `You are writing a Google Business Profile post for ${config.business_name}.

A customer named ${firstName} left this ${review.star_rating}-star review:
"${reviewQuote}"

Write a Google Business Profile post that:
1. Briefly quotes or references ${firstName}'s experience (use their words naturally)
2. Adds a genuine, brief thank-you from the business (1–2 sentences max)
3. Invites the reader in a natural way — no hard sell
4. Feels ${toneGuide[config.tone] || 'warm and genuine'}
5. Is between 150 and 280 characters — short, punchy, readable at a glance
6. Does NOT start with "We" — start with a quote, an emoji, or a customer-forward opening
7. Does NOT sound like a press release or corporate announcement${alwaysInclude}${neverInclude}${ctaInstruction}${customInstruction}

Return ONLY a JSON object with exactly two keys:
{
  "text": "the full post text here",
  "summary": "a 6-8 word summary for internal tracking"
}

No markdown, no preamble, no explanation. Pure JSON only.`;

  try {
    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content[0]?.text?.trim() || '';

    // Strip any accidental markdown fences
    const cleaned = raw
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    if (!parsed.text) throw new Error('Claude returned empty post text');

    // Hard enforce Google's 1,500 char limit
    const text = parsed.text.length > 1500
      ? parsed.text.substring(0, 1490) + '…'
      : parsed.text;

    return {
      text,
      summary: parsed.summary || `Post featuring ${firstName}'s review`
    };

  } catch (err) {
    logger.error('generatePostContent error:', err.message);

    // Fallback: simple formatted post
    return {
      text: `"${truncate(review.review_text, 100)}" — ${firstName}\n\nThank you, ${firstName}! We're so glad you had a great experience at ${config.business_name}. 🙏`,
      summary: `Fallback post — ${firstName}'s review`
    };
  }
}

// ============================================
// GOOGLE API PAYLOAD BUILDER
// ============================================

function buildGooglePostPayload(postContent, config) {
  const payload = {
    languageCode: 'en',
    summary:      postContent.text,
    topicType:    config.post_type || 'STANDARD'
  };

  // CTA button
  if (config.include_cta && config.cta_url && config.cta_type) {
    payload.callToAction = {
      actionType: config.cta_type,
      url:        config.cta_url
    };
  }

  return payload;
}

function buildPostsApiUrl(platformAccountId, platformLocationId) {
  // Google Business Profile API v4
  // Resource: accounts/{accountId}/locations/{locationId}/localPosts
  return `https://mybusiness.googleapis.com/v4/${platformAccountId}/locations/${platformLocationId}/localPosts`;
}

// ============================================
// MANUAL CONTROLS (called from dashboard)
// ============================================

/**
 * approvePost()
 * In approval mode — publish a staged draft
 */
async function approvePost(postId) {
  const result = await query(
    `SELECT gp.*, gpc.*, l.id AS location_id,
            l.platform_account_id, l.platform_location_id,
            l.business_name, l.tone, l.always_include, l.never_include
     FROM google_posts gp
     JOIN google_post_configs gpc ON gp.config_id = gpc.id
     JOIN locations l ON gp.location_id = l.id
     WHERE gp.id = $1 AND gp.status = 'draft'`,
    [postId]
  );

  if (!result.rows.length) {
    throw new Error('Post not found or not in draft status');
  }

  const row = result.rows[0];

  await publishPost(postId, row.location_id, row, {
    text:    row.post_text,
    summary: row.post_summary
  });
}

/**
 * rejectPost()
 * In approval mode — reject a staged draft
 */
async function rejectPost(postId, reason) {
  await query(
    `UPDATE google_posts SET
       status        = 'rejected',
       error_message = $1,
       updated_at    = NOW()
     WHERE id = $2 AND status = 'draft'`,
    [reason || 'Rejected by user', postId]
  );
}

/**
 * deletePost()
 * Remove a live post from Google and mark deleted in DB
 */
async function deletePost(postId) {
  const result = await query(
    `SELECT gp.*, l.id AS location_id,
            l.platform_account_id, l.platform_location_id
     FROM google_posts gp
     JOIN locations l ON gp.location_id = l.id
     WHERE gp.id = $1 AND gp.status = 'published'`,
    [postId]
  );

  if (!result.rows.length) {
    throw new Error('Published post not found');
  }

  const row = result.rows[0];

  try {
    const client = await getValidClient(row.location_id);
    await makeGoogleAPICallWithRetry(async () => {
      await client.request({
        method: 'DELETE',
        url: `https://mybusiness.googleapis.com/v4/${row.google_post_name}`
      });
    });
  } catch (err) {
    logger.warn(`Could not delete post from Google: ${err.message}`);
    // Continue to mark as deleted in our DB even if Google delete fails
  }

  await query(
    "UPDATE google_posts SET status = 'deleted', updated_at = NOW() WHERE id = $1",
    [postId]
  );
}

/**
 * generatePreview()
 * Generate a draft post for preview in the dashboard
 * without publishing it. Used by the "Preview" button.
 */
async function generatePreview(locationId) {
  const configResult = await query(
    `SELECT gpc.*, l.business_name, l.tone,
            l.always_include, l.never_include,
            l.platform_account_id, l.platform_location_id
     FROM google_post_configs gpc
     JOIN locations l ON gpc.location_id = l.id
     WHERE gpc.location_id = $1`,
    [locationId]
  );

  if (!configResult.rows.length) {
    throw new Error('Google Posts not configured for this location');
  }

  const config = configResult.rows[0];
  const review = await pickBestReview(locationId, config.min_stars);

  if (!review) {
    throw new Error('No suitable reviews found to build a post from');
  }

  const content = await generatePostContent(review, config);

  return {
    postText:     content.text,
    postSummary:  content.summary,
    sourceReview: {
      name:   review.reviewer_name,
      stars:  review.star_rating,
      text:   truncate(review.review_text, 150),
      date:   review.review_date
    },
    charCount:    content.text.length,
    ctaType:      config.cta_type,
    ctaUrl:       config.cta_url
  };
}

/**
 * triggerManualPost()
 * Publish a post immediately, bypassing the schedule.
 * Called by the "Post now" button in the dashboard.
 */
async function triggerManualPost(locationId) {
  const configResult = await query(
    `SELECT gpc.*, l.id AS location_id, l.business_name, l.tone,
            l.always_include, l.never_include,
            l.platform_account_id, l.platform_location_id,
            l.refresh_token
     FROM google_post_configs gpc
     JOIN locations l ON gpc.location_id = l.id
     WHERE gpc.location_id = $1`,
    [locationId]
  );

  if (!configResult.rows.length) {
    throw new Error('Google Posts not configured for this location');
  }

  const config = configResult.rows[0];

  if (!config.refresh_token) {
    throw new Error('Location not connected to Google — OAuth required');
  }

  await generateAndPublishPost(config);
}

// ============================================
// CONFIG MANAGEMENT
// ============================================

async function getConfig(locationId) {
  const result = await query(
    `SELECT gpc.*, l.business_name
     FROM google_post_configs gpc
     JOIN locations l ON gpc.location_id = l.id
     WHERE gpc.location_id = $1`,
    [locationId]
  );

  if (result.rows.length) return result.rows[0];

  // Auto-create default config
  const created = await query(
    `INSERT INTO google_post_configs (location_id) VALUES ($1) RETURNING *`,
    [locationId]
  );
  return created.rows[0];
}

async function updateConfig(locationId, settings) {
  const {
    isEnabled, postDay, postHour, frequency,
    minStars, postType, includeCta, ctaType, ctaUrl,
    customPrompt, requireApproval
  } = settings;

  const result = await query(
    `UPDATE google_post_configs SET
       is_enabled       = COALESCE($2,  is_enabled),
       post_day         = COALESCE($3,  post_day),
       post_hour        = COALESCE($4,  post_hour),
       frequency        = COALESCE($5,  frequency),
       min_stars        = COALESCE($6,  min_stars),
       post_type        = COALESCE($7,  post_type),
       include_cta      = COALESCE($8,  include_cta),
       cta_type         = COALESCE($9,  cta_type),
       cta_url          = COALESCE($10, cta_url),
       custom_prompt    = COALESCE($11, custom_prompt),
       require_approval = COALESCE($12, require_approval),
       next_post_at     = CASE
                            WHEN $2 = true AND next_post_at IS NULL
                            THEN NOW() + INTERVAL '1 minute'
                            ELSE next_post_at
                          END,
       updated_at       = NOW()
     WHERE location_id = $1
     RETURNING *`,
    [
      locationId, isEnabled, postDay, postHour, frequency,
      minStars, postType, includeCta, ctaType, ctaUrl,
      customPrompt, requireApproval
    ]
  );

  return result.rows[0];
}

async function getPostHistory(locationId, limit = 20) {
  const result = await query(
    `SELECT
       gp.*,
       r.reviewer_name, r.star_rating, r.review_text
     FROM google_posts gp
     LEFT JOIN reviews r ON gp.review_id = r.id
     WHERE gp.location_id = $1
     ORDER BY gp.created_at DESC
     LIMIT $2`,
    [locationId, limit]
  );
  return result.rows;
}

// ============================================
// EXPIRY HANDLER
// Called daily — marks posts that Google has
// auto-removed after 7 days as 'expired'
// ============================================

async function markExpiredPosts() {
  const result = await query(
    `UPDATE google_posts SET
       status     = 'expired',
       updated_at = NOW()
     WHERE status = 'published'
       AND expires_at <= NOW()
     RETURNING id, location_id`,
    []
  );

  if (result.rows.length > 0) {
    logger.info(`Google Posts: Marked ${result.rows.length} post(s) as expired`);
  }
}

// ============================================
// HELPERS
// ============================================

function truncate(str, maxLen) {
  if (!str) return '';
  const s = str.trim();
  if (s.length <= maxLen) return s;
  return s.substring(0, maxLen).replace(/\s+\S*$/, '') + '…';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function updateNextPostAt(configId, frequency) {
  const intervals = {
    weekly:    7,
    biweekly: 14,
    monthly:  30
  };
  const days = intervals[frequency] || 7;
  const next = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  await query(
    'UPDATE google_post_configs SET next_post_at = $1, updated_at = NOW() WHERE id = $2',
    [next, configId]
  );
}

module.exports = {
  processScheduledPosts,
  generateAndPublishPost,
  generatePreview,
  triggerManualPost,
  approvePost,
  rejectPost,
  deletePost,
  getConfig,
  updateConfig,
  getPostHistory,
  markExpiredPosts
};
