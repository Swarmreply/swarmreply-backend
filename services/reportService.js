// ============================================
// services/reportService.js
// Monthly reputation report generator
// Builds a comprehensive HTML report per location
// Emailed to customer on the 1st of each month
// ============================================

const Anthropic = require('@anthropic-ai/sdk');
const { Resend } = require('resend');
const { query } = require('../database/db');
const { getLocationSentimentTrend } = require('./sentimentService');
const logger = require('../utils/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

// ============================================
// GENERATE AND SEND MONTHLY REPORT
// ============================================

/**
 * generateMonthlyReports()
 * Called on the 1st of each month by scheduler
 * Generates and emails a report for every active location
 */
async function generateMonthlyReports() {
  logger.info('Generating monthly reputation reports...');

  try {
    const result = await query(
      `SELECT l.*, c.email as customer_email, c.name as customer_name, c.id as customer_id
       FROM locations l
       JOIN customers c ON l.customer_id = c.id
       WHERE l.is_active = true AND c.status = 'active'`,
      []
    );

    logger.info(`Generating reports for ${result.rows.length} locations`);

    for (const location of result.rows) {
      try {
        await generateAndSendReport(location);
        await new Promise(r => setTimeout(r, 500)); // Rate limit emails
      } catch (error) {
        logger.error(`Report failed for location ${location.id}:`, error.message);
      }
    }

  } catch (error) {
    logger.error('Monthly report generation failed:', error.message);
  }
}

/**
 * generateAndSendReport()
 * Generate and email the report for one location
 */
async function generateAndSendReport(location) {
  // Get last 30 days of data
  const [reviewData, sentimentData, replyStats] = await Promise.all([
    getReviewData(location.id),
    getLocationSentimentTrend(location.id, 30),
    getReplyStats(location.id)
  ]);

  // Generate AI narrative summary
  const narrative = await generateNarrative(location, reviewData, sentimentData);

  // Build report HTML
  const reportHtml = buildReportHTML(location, reviewData, sentimentData, replyStats, narrative);

  // Send via email
  const monthName = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  await resend.emails.send({
    from: process.env.EMAIL_FROM,
    to: location.customer_email,
    subject: `Your SwarmReply Reputation Report — ${monthName} 🐝`,
    html: reportHtml
  });

  // Log report sent
  await query(
    `INSERT INTO audit_log (customer_id, location_id, action, details)
     VALUES ($1, $2, 'monthly_report_sent', $3)`,
    [location.customer_id, location.id, JSON.stringify({ month: monthName })]
  );

  logger.info(`Monthly report sent to ${location.customer_email} for ${location.business_name}`);
}

// ============================================
// DATA GATHERING
// ============================================

async function getReviewData(locationId) {
  const result = await query(
    `SELECT
       COUNT(*) as total_reviews,
       COUNT(CASE WHEN star_rating = 5 THEN 1 END) as five_star,
       COUNT(CASE WHEN star_rating = 4 THEN 1 END) as four_star,
       COUNT(CASE WHEN star_rating = 3 THEN 1 END) as three_star,
       COUNT(CASE WHEN star_rating = 2 THEN 1 END) as two_star,
       COUNT(CASE WHEN star_rating = 1 THEN 1 END) as one_star,
       ROUND(AVG(star_rating)::numeric, 1) as avg_rating,
       COUNT(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 END) as this_month,
       COUNT(CASE WHEN created_at >= NOW() - INTERVAL '60 days'
         AND created_at < NOW() - INTERVAL '30 days' THEN 1 END) as last_month
     FROM reviews
     WHERE location_id = $1`,
    [locationId]
  );

  // Also get top positive and negative reviews
  const topPositive = await query(
    `SELECT reviewer_name, review_text, star_rating
     FROM reviews
     WHERE location_id = $1 AND star_rating = 5 AND review_text IS NOT NULL
     AND LENGTH(review_text) > 30
     AND created_at >= NOW() - INTERVAL '30 days'
     ORDER BY LENGTH(review_text) DESC LIMIT 1`,
    [locationId]
  );

  const topNegative = await query(
    `SELECT reviewer_name, review_text, star_rating
     FROM reviews
     WHERE location_id = $1 AND star_rating <= 2 AND review_text IS NOT NULL
     AND created_at >= NOW() - INTERVAL '30 days'
     ORDER BY created_at DESC LIMIT 1`,
    [locationId]
  );

  return {
    ...result.rows[0],
    topPositive: topPositive.rows[0] || null,
    topNegative: topNegative.rows[0] || null
  };
}

async function getReplyStats(locationId) {
  const result = await query(
    `SELECT
       COUNT(rv.id) as total_reviews,
       COUNT(rp.id) as total_replied,
       COUNT(CASE WHEN rp.status = 'posted' THEN 1 END) as successfully_posted,
       ROUND(AVG(EXTRACT(EPOCH FROM (rp.posted_at - rv.created_at))/3600)::numeric, 1) as avg_response_hours
     FROM reviews rv
     LEFT JOIN replies rp ON rv.id = rp.review_id
     WHERE rv.location_id = $1
     AND rv.created_at >= NOW() - INTERVAL '30 days'`,
    [locationId]
  );

  const stats = result.rows[0];
  const responseRate = stats.total_reviews > 0
    ? Math.round((stats.total_replied / stats.total_reviews) * 100)
    : 0;

  return { ...stats, responseRate };
}

// ============================================
// AI NARRATIVE GENERATOR
// ============================================

/**
 * generateNarrative()
 * Use Claude to write a human-sounding report summary
 * Personalised to the business and their actual data
 */
async function generateNarrative(location, reviewData, sentimentData) {
  try {
    const prompt = `Write a short, encouraging monthly reputation summary for a local business owner.
Keep it to 3-4 sentences. Sound like a knowledgeable business advisor, not a robot.
Be specific to their numbers. End with one concrete suggestion.

Business: ${location.business_name} (${location.business_type || 'local business'})
This month's reviews: ${reviewData.this_month}
Average rating: ${reviewData.avg_rating} stars
Sentiment trend: ${sentimentData.trend}
Response rate: 100% (SwarmReply replied to all reviews)
Top topics mentioned: ${sentimentData.topTopics.map(t => t.topic).join(', ') || 'general feedback'}
Most common emotions: ${sentimentData.topEmotions.map(e => e.emotion).join(', ') || 'mixed'}

Write the summary paragraph now. No preamble.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    });

    return message.content[0]?.text?.trim() || getDefaultNarrative(location, reviewData);

  } catch (error) {
    logger.error('Narrative generation failed:', error.message);
    return getDefaultNarrative(location, reviewData);
  }
}

function getDefaultNarrative(location, reviewData) {
  const rating = parseFloat(reviewData.avg_rating || 0);
  const count = parseInt(reviewData.this_month || 0);
  return `${location.business_name} had a ${rating >= 4 ? 'strong' : 'mixed'} month with ${count} new review${count !== 1 ? 's' : ''} and an average rating of ${rating} stars. SwarmReply responded to 100% of reviews on your behalf, keeping your Google profile fully engaged. ${sentimentData?.trend === 'improving' ? 'Sentiment is trending upward — great momentum.' : 'Keep engaging with customers to maintain your reputation.'} Consider reaching out to customers who left 3-star reviews to understand how you can turn them into 5-star fans.`;
}

// ============================================
// REPORT HTML BUILDER
// ============================================

/**
 * buildReportHTML()
 * Build the full styled monthly report email
 */
function buildReportHTML(location, reviewData, sentimentData, replyStats, narrative) {
  const monthName = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const prevMonthName = new Date(new Date().setMonth(new Date().getMonth() - 1))
    .toLocaleDateString('en-US', { month: 'long' });

  const reviewChange = parseInt(reviewData.this_month) - parseInt(reviewData.last_month);
  const reviewChangeText = reviewChange > 0
    ? `+${reviewChange} vs ${prevMonthName}`
    : reviewChange < 0
      ? `${reviewChange} vs ${prevMonthName}`
      : `Same as ${prevMonthName}`;

  const trendColor = sentimentData.trend === 'improving' ? '#1a6b45'
    : sentimentData.trend === 'declining' ? '#c0392b' : '#7a7670';
  const trendIcon = sentimentData.trend === 'improving' ? '↑'
    : sentimentData.trend === 'declining' ? '↓' : '→';

  // Build star distribution bars
  const maxStars = Math.max(
    parseInt(reviewData.five_star), parseInt(reviewData.four_star),
    parseInt(reviewData.three_star), parseInt(reviewData.two_star),
    parseInt(reviewData.one_star), 1
  );

  const starBars = [5, 4, 3, 2, 1].map(n => {
    const count = parseInt(reviewData[`${['', 'one', 'two', 'three', 'four', 'five'][n]}_star`] || 0);
    const pct = Math.round((count / maxStars) * 100);
    const color = n >= 4 ? '#1a6b45' : n === 3 ? '#f59e0b' : '#c0392b';
    return `
      <tr>
        <td style="width:30px;font-size:12px;color:#7a7670;padding:3px 8px 3px 0;white-space:nowrap">${n} ★</td>
        <td style="padding:3px 8px 3px 0;">
          <div style="background:#f0eeea;border-radius:4px;height:10px;overflow:hidden;">
            <div style="background:${color};height:100%;width:${pct}%;border-radius:4px;transition:width 0.3s"></div>
          </div>
        </td>
        <td style="width:30px;font-size:12px;color:#7a7670;text-align:right">${count}</td>
      </tr>`;
  }).join('');

  // Build topic pills
  const topicPills = sentimentData.topTopics.slice(0, 5).map(t =>
    `<span style="display:inline-block;background:#f0eeea;border:1px solid #e4e0d8;padding:4px 12px;border-radius:50px;font-size:11px;color:#0d0d0d;margin:3px;">${t.topic} (${t.count})</span>`
  ).join('');

  // Build actionable insights
  const insightsList = sentimentData.actionableInsights.length > 0
    ? sentimentData.actionableInsights.map(i =>
        `<li style="font-size:13px;color:#0d0d0d;padding:6px 0;border-bottom:1px solid #f0eeea;line-height:1.5">${i}</li>`
      ).join('')
    : '<li style="font-size:13px;color:#7a7670;padding:6px 0">No specific action items this month — keep up the great work!</li>';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f8f7f4;font-family:Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:40px 20px;">

  <!-- Header -->
  <div style="background:#0d0d0d;border-radius:16px 16px 0 0;padding:32px 36px;">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
      <span style="font-size:24px">🐝</span>
      <span style="font-size:1.1rem;font-weight:700;color:white;letter-spacing:-0.01em">SwarmReply</span>
    </div>
    <h1 style="font-size:1.6rem;font-weight:700;color:white;margin:0 0 6px;letter-spacing:-0.02em">
      Monthly Reputation Report
    </h1>
    <div style="font-size:0.875rem;color:rgba(255,255,255,0.5)">
      ${location.business_name} · ${monthName}
    </div>
  </div>

  <!-- Narrative -->
  <div style="background:white;border:1px solid #e4e0d8;border-top:none;padding:28px 36px;">
    <p style="font-size:0.95rem;line-height:1.75;color:#0d0d0d;margin:0;border-left:3px solid #f5c842;padding-left:16px;">
      ${narrative}
    </p>
  </div>

  <!-- Stats Row -->
  <div style="display:flex;gap:0;margin-top:2px;">
    ${[
      { label: 'Total reviews', value: reviewData.this_month, sub: reviewChangeText },
      { label: 'Avg rating', value: `${reviewData.avg_rating}★`, sub: 'This month' },
      { label: 'Replies sent', value: replyStats.total_replied, sub: `${replyStats.responseRate}% rate` },
      { label: 'Sentiment', value: sentimentData.averageScore, sub: `${trendIcon} ${sentimentData.trend}` }
    ].map((s, i) => `
    <div style="flex:1;background:white;border:1px solid #e4e0d8;border-top:none;${i > 0 ? 'border-left:none;' : ''}padding:20px;text-align:center;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#7a7670;margin-bottom:8px">${s.label}</div>
      <div style="font-size:1.6rem;font-weight:700;color:#0d0d0d;font-family:Georgia,serif">${s.value}</div>
      <div style="font-size:11px;color:${s.label === 'Sentiment' ? trendColor : '#1a6b45'};margin-top:4px">${s.sub}</div>
    </div>`).join('')}
  </div>

  <!-- Review Distribution -->
  <div style="background:white;border:1px solid #e4e0d8;border-top:none;padding:24px 36px;">
    <h2 style="font-size:0.875rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#7a7670;margin:0 0 16px">
      Rating distribution
    </h2>
    <table style="width:100%;border-collapse:collapse;">
      ${starBars}
    </table>
  </div>

  <!-- Topics Mentioned -->
  ${sentimentData.topTopics.length > 0 ? `
  <div style="background:white;border:1px solid #e4e0d8;border-top:none;padding:24px 36px;">
    <h2 style="font-size:0.875rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#7a7670;margin:0 0 12px">
      What customers talked about most
    </h2>
    <div>${topicPills}</div>
  </div>` : ''}

  <!-- Top Reviews -->
  ${reviewData.topPositive ? `
  <div style="background:white;border:1px solid #e4e0d8;border-top:none;padding:24px 36px;">
    <h2 style="font-size:0.875rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#7a7670;margin:0 0 12px">
      Top review this month
    </h2>
    <div style="background:#f0fdf4;border-left:3px solid #1a6b45;padding:12px 16px;border-radius:0 8px 8px 0;">
      <div style="font-size:0.875rem;font-style:italic;color:#0d0d0d;line-height:1.6">
        "${reviewData.topPositive.review_text.substring(0, 200)}${reviewData.topPositive.review_text.length > 200 ? '...' : ''}"
      </div>
      <div style="font-size:11px;color:#1a6b45;font-weight:700;margin-top:8px">
        — ${reviewData.topPositive.reviewer_name} · ★★★★★
      </div>
    </div>
  </div>` : ''}

  <!-- Action Items -->
  <div style="background:white;border:1px solid #e4e0d8;border-top:none;padding:24px 36px;">
    <h2 style="font-size:0.875rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#7a7670;margin:0 0 12px">
      Suggested actions for next month
    </h2>
    <ul style="margin:0;padding:0;list-style:none;">
      ${insightsList}
    </ul>
  </div>

  <!-- CTA -->
  <div style="background:#0d0d0d;border-radius:0 0 16px 16px;padding:28px 36px;text-align:center;">
    <p style="color:rgba(255,255,255,0.6);font-size:0.875rem;margin:0 0 16px">
      SwarmReply handled 100% of your reviews this month — automatically.
    </p>
    <a href="https://swarmreply.com/dashboard" style="display:inline-block;background:#f5c842;color:#0d0d0d;padding:14px 32px;border-radius:50px;text-decoration:none;font-size:0.875rem;font-weight:700;">
      View Full Dashboard →
    </a>
    <p style="color:rgba(255,255,255,0.3);font-size:11px;margin:20px 0 0">
      SwarmReply · hello@swarmreply.com ·
      <a href="https://swarmreply.com/unsubscribe" style="color:rgba(255,255,255,0.3)">Unsubscribe</a>
    </p>
  </div>

</div>
</body>
</html>`;
}

module.exports = {
  generateMonthlyReports,
  generateAndSendReport
};
