// ============================================
// services/reviewProcessor.js
// Orchestrates the full review → reply pipeline
// This is the core engine of SwarmReply
//
// Flow:
// 1. Fetch new reviews from Google
// 2. Generate AI reply for each
// 3. Post reply back to Google
// 4. Update database with results
// 5. Send weekly digest emails
// ============================================

const { query } = require('../database/db');
const googleService = require('./googleService');
const aiService = require('./aiService');
const emailService = require('./emailService');
const logger = require('../utils/logger');
const features = require('../config/features');

// ============================================
// MAIN PROCESSOR
// ============================================

/**
 * processAllActiveLocations()
 * Called by the scheduler every 30 minutes
 * Processes all active customer locations
 */
async function processAllActiveLocations() {
  if (!features.AUTO_REPLY_ENABLED) {
    logger.info('Auto-reply is OFF (config/features.js) — skipping review processing cycle');
    return;
  }
  logger.info('Starting review processing cycle...');
  const startTime = Date.now();

  try {
    // Get all active Google locations
    const result = await query(
      `SELECT l.*, c.email as customer_email, c.name as customer_name, c.status as customer_status
       FROM locations l
       JOIN customers c ON l.customer_id = c.id
       WHERE l.is_active = true
       AND l.platform = 'google'
       AND l.refresh_token IS NOT NULL
       AND c.status IN ('active', 'cancelling')
       AND COALESCE(l.auto_reply, true) = true`,
      []
    );

    const locations = result.rows;
    logger.info(`Processing ${locations.length} active locations`);

    // Process each location
    // Use Promise.allSettled so one failure doesn't stop others
    const results = await Promise.allSettled(
      locations.map(location => processLocation(location))
    );

    // Log summary
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    const duration = Date.now() - startTime;

    logger.info(`Processing cycle complete: ${succeeded} succeeded, ${failed} failed, ${duration}ms`);

    // Log any failures for investigation
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.error(`Location ${locations[index].id} failed:`, result.reason?.message);
      }
    });

  } catch (error) {
    logger.error('Fatal error in processAllActiveLocations:', error.message);
  }
}

/**
 * processLocation()
 * Process a single business location
 * Fetch new reviews and reply to each one
 *
 * @param {Object} location - Location row from database
 */
async function processLocation(location) {
  logger.info(`Processing location: ${location.business_name}`);

  try {
    // Step 1: Fetch new reviews from Google
    const newReviews = await googleService.fetchNewReviews(location.id);

    if (newReviews.length === 0) {
      logger.info(`No new reviews for: ${location.business_name}`);
      return;
    }

    logger.info(`Found ${newReviews.length} new reviews for: ${location.business_name}`);

    // Build business profile for AI
    const businessProfile = {
      businessName: location.business_name,
      businessType: location.business_type,
      tone: location.tone,
      alwaysInclude: location.always_include || [],
      neverInclude: location.never_include || [],
      contactEmail: location.contact_email,
      customInstructions: location.custom_instructions,
      isHealthcare: location.is_healthcare
    };

    // Step 2: Process each new review
    for (const review of newReviews) {
      await processReview(review, location, businessProfile);

      // Small delay between reviews to be respectful of API limits
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Step 3: Log to audit trail
    await query(
      `INSERT INTO audit_log (customer_id, location_id, action, details)
       VALUES ($1, $2, 'reviews_processed', $3)`,
      [
        location.customer_id,
        location.id,
        JSON.stringify({ reviewCount: newReviews.length, businessName: location.business_name })
      ]
    );

  } catch (error) {
    logger.error(`Error processing location ${location.id}:`, error.message);
    throw error;
  }
}

/**
 * processReview()
 * Process a single review — generate and post reply
 *
 * @param {Object} review - Review from database
 * @param {Object} location - Location from database
 * @param {Object} businessProfile - Formatted business settings
 */
async function processReview(review, location, businessProfile) {
  logger.info(`Processing review ${review.id} (${review.star_rating}★)`);

  try {
    // Mark review as processing
    await query(
      "UPDATE reviews SET status = 'processing', updated_at = NOW() WHERE id = $1",
      [review.id]
    );

    // Step 1: Generate AI reply
    let generatedReply;
    try {
      generatedReply = await aiService.generateReviewReply(review, businessProfile);
    } catch (aiError) {
      logger.error(`AI generation failed for review ${review.id}:`, aiError.message);

      // Mark review as error and move on
      await query(
        "UPDATE reviews SET status = 'error', updated_at = NOW() WHERE id = $1",
        [review.id]
      );

      // Store failed reply attempt
      await query(
        `INSERT INTO replies (review_id, generated_reply, status, error_message)
         VALUES ($1, $2, 'failed', $3)`,
        [review.id, 'AI generation failed', aiError.message]
      );
      return;
    }

    // Step 2: Store generated reply
    const replyResult = await query(
      `INSERT INTO replies (review_id, generated_reply, status)
       VALUES ($1, $2, 'pending')
       RETURNING id`,
      [review.id, generatedReply]
    );
    const replyId = replyResult.rows[0].id;

    // Step 2b: Approval mode — park the draft for human sign-off instead of posting.
    // The Approvals page posts it via POST /approvals/:replyId/approve.
    if (location.approval_mode === 'approve') {
      await query(
        `UPDATE replies SET status = 'pending_approval', updated_at = NOW() WHERE id = $1`,
        [replyId]
      );
      await query(
        `UPDATE reviews SET status = 'pending_approval', updated_at = NOW() WHERE id = $1`,
        [review.id]
      );
      logger.info(`Reply ${replyId} queued for approval (review ${review.id}, ${location.business_name})`);
      return;
    }

    // Step 3: Post reply to Google
    try {
      await googleService.postReplyToGoogle(
        location.id,
        review.platform_review_id,
        generatedReply
      );

      // Update reply as posted
      await query(
        `UPDATE replies
         SET status = 'posted',
             posted_reply = $1,
             posted_at = NOW(),
             updated_at = NOW()
         WHERE id = $2`,
        [generatedReply, replyId]
      );

      // Update review as replied
      await query(
        "UPDATE reviews SET status = 'replied', updated_at = NOW() WHERE id = $1",
        [review.id]
      );

      logger.info(`Successfully replied to review ${review.id} for ${location.business_name}`);

    } catch (postError) {
      logger.error(`Failed to post reply to Google for review ${review.id}:`, postError.message);

      // Mark reply as failed with error details
      await query(
        `UPDATE replies
         SET status = 'failed',
             error_message = $1,
             retry_count = retry_count + 1,
             updated_at = NOW()
         WHERE id = $2`,
        [postError.message, replyId]
      );

      // Mark review as error
      await query(
        "UPDATE reviews SET status = 'error', updated_at = NOW() WHERE id = $1",
        [review.id]
      );
    }

  } catch (error) {
    logger.error(`Unexpected error processing review ${review.id}:`, error.message);

    // Ensure review is marked as error
    await query(
      "UPDATE reviews SET status = 'error', updated_at = NOW() WHERE id = $1",
      [review.id]
    ).catch(e => logger.error('Failed to update review status:', e.message));
  }
}

// ============================================
// RETRY FAILED REPLIES
// ============================================

/**
 * retryFailedReplies()
 * Retry replies that failed in previous cycles
 * Called hourly — gives failed replies multiple chances
 */
async function retryFailedReplies() {
  if (!features.AUTO_REPLY_ENABLED) {
    logger.info('Auto-reply is OFF (config/features.js) — skipping failed-reply retry');
    return;
  }
  logger.info('Checking for failed replies to retry...');

  try {
    // Find failed replies that haven't been retried too many times
    const result = await query(
      `SELECT r.*, rv.platform_review_id, rv.location_id
       FROM replies r
       JOIN reviews rv ON r.review_id = rv.id
       WHERE r.status = 'failed'
       AND r.retry_count < 3
       AND r.updated_at < NOW() - INTERVAL '1 hour'`,
      []
    );

    if (result.rows.length === 0) {
      logger.info('No failed replies to retry');
      return;
    }

    logger.info(`Retrying ${result.rows.length} failed replies`);

    for (const reply of result.rows) {
      try {
        await googleService.postReplyToGoogle(
          reply.location_id,
          reply.platform_review_id,
          reply.generated_reply
        );

        // Success — update status
        await query(
          `UPDATE replies
           SET status = 'posted', posted_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [reply.id]
        );

        await query(
          "UPDATE reviews SET status = 'replied', updated_at = NOW() WHERE id = $1",
          [reply.review_id]
        );

        logger.info(`Retry successful for reply ${reply.id}`);

      } catch (error) {
        // Increment retry count
        await query(
          `UPDATE replies
           SET retry_count = retry_count + 1,
               error_message = $1,
               updated_at = NOW()
           WHERE id = $2`,
          [error.message, reply.id]
        );
        logger.warn(`Retry failed for reply ${reply.id}:`, error.message);
      }

      // Delay between retries
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

  } catch (error) {
    logger.error('Error in retryFailedReplies:', error.message);
  }
}

// ============================================
// WEEKLY DIGEST
// ============================================

/**
 * sendWeeklyDigests()
 * Send weekly summary emails to all active customers
 * Called every Monday at 8am
 */
async function sendWeeklyDigests() {
  logger.info('Sending weekly digest emails...');

  try {
    // Get all active customers with at least one reply this week
    const result = await query(
      `SELECT DISTINCT
         c.id, c.email, c.name,
         COUNT(rv.id) as review_count,
         COUNT(rp.id) as reply_count,
         AVG(rv.star_rating) as avg_rating
       FROM customers c
       JOIN locations l ON c.id = l.customer_id
       JOIN reviews rv ON l.id = rv.location_id
       LEFT JOIN replies rp ON rv.id = rp.review_id AND rp.status = 'posted'
       WHERE c.status IN ('active', 'cancelling')
       AND rv.created_at >= NOW() - INTERVAL '7 days'
       GROUP BY c.id, c.email, c.name
       HAVING COUNT(rp.id) > 0`,
      []
    );

    logger.info(`Sending digests to ${result.rows.length} customers`);

    for (const customer of result.rows) {
      await emailService.sendWeeklyDigest(customer);
      await new Promise(resolve => setTimeout(resolve, 200)); // Rate limit emails
    }

  } catch (error) {
    logger.error('Error sending weekly digests:', error.message);
  }
}

module.exports = {
  processAllActiveLocations,
  processLocation,
  processReview,
  retryFailedReplies,
  sendWeeklyDigests
};
