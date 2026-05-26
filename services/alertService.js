// ============================================
// services/alertService.js
// Instant new review alerts via email
// Sends notification the moment a new review lands
// Includes review text, star rating, and reply preview
// ============================================

const { Resend } = require('resend');
const { query } = require('../database/db');
const logger = require('../utils/logger');

const resend = new Resend(process.env.RESEND_API_KEY);

// ============================================
// NEW REVIEW ALERT
// ============================================

/**
 * sendNewReviewAlert()
 * Fire an instant email when a new review is detected
 * Called from reviewProcessor.js after storing a new review
 *
 * @param {Object} review - Review row from database
 * @param {Object} location - Location row from database
 * @param {Object} customer - Customer row from database
 */
async function sendNewReviewAlert(review, location, customer) {
  try {
    // Check customer alert preferences
    // Default: always send for 1-2 star reviews, send all if enabled
    const shouldAlert = shouldSendAlert(review, customer);
    if (!shouldAlert) return;

    const stars = '★'.repeat(review.star_rating) + '☆'.repeat(5 - review.star_rating);
    const sentiment = review.star_rating >= 4 ? 'positive' : review.star_rating === 3 ? 'neutral' : 'negative';
    const isNegative = review.star_rating <= 2;
    const isUrgent = review.star_rating === 1;

    const subjectLine = isUrgent
      ? `🚨 Urgent: 1-star review needs attention — ${location.business_name}`
      : isNegative
        ? `⚠️ New ${review.star_rating}-star review — ${location.business_name}`
        : `⭐ New ${review.star_rating}-star review — ${location.business_name}`;

    await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: customer.email,
      subject: subjectLine,
      html: buildAlertEmail(review, location, customer, stars, sentiment, isNegative, isUrgent)
    });

    // Log alert sent
    await query(
      `INSERT INTO audit_log (customer_id, location_id, action, details)
       VALUES ($1, $2, 'review_alert_sent', $3)`,
      [customer.id, location.id, JSON.stringify({ reviewId: review.id, starRating: review.star_rating })]
    );

    logger.info(`Review alert sent to ${customer.email} for review ${review.id}`);

  } catch (error) {
    logger.error(`Failed to send review alert for review ${review.id}:`, error.message);
    // Never throw — alerts failing shouldn't stop review processing
  }
}

/**
 * shouldSendAlert()
 * Determine if we should send an alert for this review
 * Logic: always alert on 1-2 stars, alert on all if customer preference set
 */
function shouldSendAlert(review, customer) {
  // Always alert on negative reviews
  if (review.star_rating <= 2) return true;

  // For positive reviews, only alert if customer has opted in to all alerts
  // Default is positive reviews don't trigger alerts (too noisy)
  // Can be changed per customer in settings
  return customer.alert_all_reviews === true;
}

/**
 * buildAlertEmail()
 * Build the HTML email for a review alert
 */
function buildAlertEmail(review, location, customer, stars, sentiment, isNegative, isUrgent) {
  const headerBg = isUrgent ? '#c0392b' : isNegative ? '#e67e22' : '#1a6b45';
  const headerText = isUrgent
    ? 'Urgent: A 1-star review needs your attention'
    : isNegative
      ? 'A negative review was received'
      : 'A new review was received';

  const tipText = isUrgent
    ? 'A 1-star review has been received. SwarmReply has already drafted a professional response. You may want to also reach out to this customer directly.'
    : isNegative
      ? 'SwarmReply has drafted a professional response to this review. Consider reaching out to the customer privately to resolve any issues.'
      : 'SwarmReply is handling the reply automatically. No action needed from you.';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f8f7f4;font-family:'DM Sans',sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:40px 20px;">

    <!-- Header -->
    <div style="background:${headerBg};border-radius:12px 12px 0 0;padding:20px 28px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="color:white;font-size:1rem;font-weight:700">${headerText}</span>
      </div>
      <div style="color:rgba(255,255,255,0.75);font-size:0.8rem;margin-top:4px">
        ${location.business_name} · ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
      </div>
    </div>

    <!-- Review Card -->
    <div style="background:white;border:1px solid #e4e0d8;border-top:none;padding:24px 28px;">

      <!-- Stars and reviewer -->
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
        <div style="width:40px;height:40px;border-radius:50%;background:#f0eeea;display:flex;align-items:center;justify-content:center;font-size:0.875rem;font-weight:700;color:#7a7670;flex-shrink:0;">
          ${review.reviewer_name?.charAt(0) || '?'}
        </div>
        <div>
          <div style="font-weight:600;font-size:0.9rem">${review.reviewer_name || 'Anonymous'}</div>
          <div style="font-size:1rem;letter-spacing:2px;color:${review.star_rating >= 4 ? '#f59e0b' : '#e53e3e'}">${stars}</div>
        </div>
        <div style="margin-left:auto;font-size:0.75rem;color:#7a7670">
          via Google
        </div>
      </div>

      <!-- Review text -->
      ${review.review_text ? `
      <div style="background:#f8f7f4;border-radius:8px;padding:14px 16px;margin-bottom:16px;">
        <p style="font-size:0.9rem;line-height:1.65;color:#0d0d0d;margin:0;font-style:italic">
          "${review.review_text}"
        </p>
      </div>` : '<p style="color:#7a7670;font-size:0.875rem;margin-bottom:16px;">No text — rating only</p>'}

      <!-- Status -->
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:20px;">
        <span style="background:#e8f5ef;color:#1a6b45;padding:4px 12px;border-radius:50px;font-size:0.72rem;font-weight:700">
          🐝 SwarmReply is drafting a response
        </span>
        <span style="font-size:0.75rem;color:#7a7670">Will post within 1 business day</span>
      </div>

      <!-- Tip -->
      <div style="background:${isUrgent ? '#fff5f5' : isNegative ? '#fffbeb' : '#f0fdf4'};border-left:3px solid ${headerBg};border-radius:0 8px 8px 0;padding:12px 16px;margin-bottom:24px;">
        <p style="font-size:0.825rem;color:#0d0d0d;margin:0;line-height:1.6">${tipText}</p>
      </div>

      <!-- CTA -->
      <a href="https://swarmreply.com/dashboard" style="display:block;background:#0d0d0d;color:white;text-align:center;padding:14px 20px;border-radius:50px;text-decoration:none;font-size:0.9rem;font-weight:600;margin-bottom:12px;">
        View in Dashboard →
      </a>

    </div>

    <!-- Footer -->
    <div style="padding:20px 28px;text-align:center;">
      <p style="font-size:0.75rem;color:#7a7670;margin:0">
        SwarmReply · hello@swarmreply.com<br>
        <a href="https://swarmreply.com/dashboard/settings" style="color:#7a7670">Manage alert preferences</a> ·
        <a href="https://swarmreply.com/unsubscribe" style="color:#7a7670">Unsubscribe</a>
      </p>
    </div>

  </div>
</body>
</html>`;
}

// ============================================
// BULK ALERT SETTINGS
// ============================================

/**
 * updateAlertPreferences()
 * Update whether customer receives all alerts or just negative ones
 *
 * @param {string} customerId
 * @param {boolean} alertAll - true = all reviews, false = negative only
 */
async function updateAlertPreferences(customerId, alertAll) {
  try {
    await query(
      'UPDATE customers SET alert_all_reviews = $1, updated_at = NOW() WHERE id = $2',
      [alertAll, customerId]
    );
    logger.info(`Alert preferences updated for customer ${customerId}: alertAll=${alertAll}`);
  } catch (error) {
    logger.error('Failed to update alert preferences:', error.message);
    throw error;
  }
}

module.exports = {
  sendNewReviewAlert,
  updateAlertPreferences,
  shouldSendAlert
};
