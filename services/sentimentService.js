// ============================================
// services/sentimentService.js
// AI-powered sentiment analysis for all reviews
// Tags each review with sentiment, topics, and mood
// Tracks trends over time for dashboard display
// ============================================

const Anthropic = require('@anthropic-ai/sdk');
const { query } = require('../database/db');
const logger = require('../utils/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================
// SINGLE REVIEW SENTIMENT
// ============================================

/**
 * analyzeReviewSentiment()
 * Analyze a single review for sentiment, topics, and mood
 * Called automatically when a new review is stored
 *
 * @param {Object} review - Review row from database
 * @returns {Object} Sentiment analysis result
 */
async function analyzeReviewSentiment(review) {
  // Skip sentiment analysis for empty reviews
  if (!review.review_text || review.review_text.trim().length < 5) {
    return {
      sentiment: review.star_rating >= 4 ? 'positive' : review.star_rating === 3 ? 'neutral' : 'negative',
      score: review.star_rating * 20, // 0-100
      topics: [],
      emotions: [],
      summary: 'Rating only — no text to analyze'
    };
  }

  try {
    const response = await callClaudeForSentiment(review.review_text, review.star_rating);
    return response;
  } catch (error) {
    logger.error(`Sentiment analysis failed for review ${review.id}:`, error.message);
    // Return basic sentiment based on star rating as fallback
    return getBasicSentiment(review.star_rating);
  }
}

/**
 * callClaudeForSentiment()
 * Use Claude to deeply analyze review sentiment
 * Returns structured JSON with topics, emotions, score
 */
async function callClaudeForSentiment(reviewText, starRating) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: `You are a sentiment analysis engine for business reviews.
Analyze the review and return ONLY a valid JSON object with no other text.
JSON structure:
{
  "sentiment": "positive" | "neutral" | "negative",
  "score": 0-100,
  "topics": ["food", "service", "wait_time", "price", "cleanliness", "staff", "atmosphere", "quality"],
  "topic_sentiments": {"food": "positive", "service": "negative"},
  "emotions": ["satisfied", "frustrated", "delighted", "disappointed", "angry", "impressed"],
  "key_phrase": "one sentence capturing the core of this review",
  "actionable": true | false,
  "actionable_insight": "what the business should do based on this review"
}
Only include topics and emotions that are clearly present. Return valid JSON only.`,
        messages: [{
          role: 'user',
          content: `Review (${starRating} stars): "${reviewText}"`
        }]
      });

      const text = message.content[0]?.text?.trim();

      // Parse JSON response
      const clean = text.replace(/```json|```/g, '').trim();
      const result = JSON.parse(clean);

      // Validate required fields
      if (!result.sentiment || result.score === undefined) {
        throw new Error('Invalid sentiment response structure');
      }

      return result;

    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 1500));
      }
    }
  }

  logger.error('All sentiment analysis attempts failed:', lastError.message);
  return getBasicSentiment(starRating);
}

/**
 * getBasicSentiment()
 * Fallback sentiment based purely on star rating
 */
function getBasicSentiment(starRating) {
  const map = {
    5: { sentiment: 'positive', score: 95, topics: [], emotions: ['satisfied'], key_phrase: 'Positive rating', actionable: false, actionable_insight: '' },
    4: { sentiment: 'positive', score: 78, topics: [], emotions: ['satisfied'], key_phrase: 'Good rating with minor feedback', actionable: true, actionable_insight: 'Review for any specific improvement areas' },
    3: { sentiment: 'neutral', score: 55, topics: [], emotions: [], key_phrase: 'Mixed experience', actionable: true, actionable_insight: 'Investigate what could have made this a 5-star experience' },
    2: { sentiment: 'negative', score: 28, topics: [], emotions: ['disappointed'], key_phrase: 'Below expectations', actionable: true, actionable_insight: 'Reach out to understand specific issues' },
    1: { sentiment: 'negative', score: 10, topics: [], emotions: ['frustrated', 'angry'], key_phrase: 'Very negative experience', actionable: true, actionable_insight: 'Immediate follow-up needed' }
  };
  return map[starRating] || map[3];
}

// ============================================
// BATCH SENTIMENT FOR REPORTING
// ============================================

/**
 * getLocationSentimentTrend()
 * Get sentiment trends for a location over time
 * Used in dashboard charts and monthly report
 *
 * @param {string} locationId - Location ID
 * @param {number} days - Number of days to look back (default 30)
 * @returns {Object} Trend data including scores, topics, weekly breakdown
 */
async function getLocationSentimentTrend(locationId, days = 30) {
  try {
    // Get all reviews with sentiment data for this period
    const result = await query(
      `SELECT
         rv.id, rv.star_rating, rv.review_text,
         rv.review_date, rv.created_at,
         rs.sentiment, rs.score, rs.topics,
         rs.emotions, rs.key_phrase, rs.actionable_insight
       FROM reviews rv
       LEFT JOIN review_sentiment rs ON rv.id = rs.review_id
       WHERE rv.location_id = $1
       AND rv.created_at >= NOW() - INTERVAL '${days} days'
       ORDER BY rv.created_at ASC`,
      [locationId]
    );

    const reviews = result.rows;

    if (reviews.length === 0) {
      return {
        averageScore: 0,
        trend: 'neutral',
        weeklyScores: [],
        topTopics: [],
        topEmotions: [],
        actionableInsights: [],
        reviewCount: 0
      };
    }

    // Calculate average sentiment score
    const scoredReviews = reviews.filter(r => r.score !== null);
    const averageScore = scoredReviews.length > 0
      ? Math.round(scoredReviews.reduce((sum, r) => sum + r.score, 0) / scoredReviews.length)
      : Math.round(reviews.reduce((sum, r) => sum + (r.star_rating * 20), 0) / reviews.length);

    // Calculate weekly breakdown
    const weeklyScores = calculateWeeklyBreakdown(reviews, days);

    // Determine trend (comparing first half vs second half)
    const midpoint = Math.floor(reviews.length / 2);
    const firstHalf = reviews.slice(0, midpoint);
    const secondHalf = reviews.slice(midpoint);
    const firstAvg = firstHalf.reduce((sum, r) => sum + (r.score || r.star_rating * 20), 0) / (firstHalf.length || 1);
    const secondAvg = secondHalf.reduce((sum, r) => sum + (r.score || r.star_rating * 20), 0) / (secondHalf.length || 1);
    const trend = secondAvg > firstAvg + 5 ? 'improving' : secondAvg < firstAvg - 5 ? 'declining' : 'stable';

    // Aggregate most mentioned topics
    const topicCounts = {};
    reviews.forEach(r => {
      if (r.topics && Array.isArray(r.topics)) {
        r.topics.forEach(t => {
          topicCounts[t] = (topicCounts[t] || 0) + 1;
        });
      }
    });
    const topTopics = Object.entries(topicCounts)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([topic, count]) => ({ topic, count }));

    // Aggregate emotions
    const emotionCounts = {};
    reviews.forEach(r => {
      if (r.emotions && Array.isArray(r.emotions)) {
        r.emotions.forEach(e => {
          emotionCounts[e] = (emotionCounts[e] || 0) + 1;
        });
      }
    });
    const topEmotions = Object.entries(emotionCounts)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 4)
      .map(([emotion, count]) => ({ emotion, count }));

    // Collect actionable insights from negative/neutral reviews
    const actionableInsights = reviews
      .filter(r => r.actionable && r.actionable_insight && r.star_rating <= 3)
      .slice(0, 3)
      .map(r => r.actionable_insight);

    return {
      averageScore,
      trend,
      weeklyScores,
      topTopics,
      topEmotions,
      actionableInsights,
      reviewCount: reviews.length,
      positiveCount: reviews.filter(r => (r.sentiment || '') === 'positive' || r.star_rating >= 4).length,
      neutralCount: reviews.filter(r => (r.sentiment || '') === 'neutral' || r.star_rating === 3).length,
      negativeCount: reviews.filter(r => (r.sentiment || '') === 'negative' || r.star_rating <= 2).length
    };

  } catch (error) {
    logger.error(`Failed to get sentiment trend for location ${locationId}:`, error.message);
    throw error;
  }
}

/**
 * calculateWeeklyBreakdown()
 * Group reviews by week and calculate average score per week
 */
function calculateWeeklyBreakdown(reviews, days) {
  const weeks = Math.ceil(days / 7);
  const now = new Date();
  const weeklyData = [];

  for (let i = weeks - 1; i >= 0; i--) {
    const weekEnd = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    const weekStart = new Date(weekEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

    const weekReviews = reviews.filter(r => {
      const date = new Date(r.created_at);
      return date >= weekStart && date < weekEnd;
    });

    const avgScore = weekReviews.length > 0
      ? Math.round(weekReviews.reduce((sum, r) => sum + (r.score || r.star_rating * 20), 0) / weekReviews.length)
      : null;

    weeklyData.push({
      weekLabel: weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      averageScore: avgScore,
      reviewCount: weekReviews.length,
      averageRating: weekReviews.length > 0
        ? parseFloat((weekReviews.reduce((sum, r) => sum + r.star_rating, 0) / weekReviews.length).toFixed(1))
        : null
    });
  }

  return weeklyData;
}

// ============================================
// STORE SENTIMENT IN DATABASE
// ============================================

/**
 * storeSentiment()
 * Save sentiment analysis result to DB
 * Called after analyzeReviewSentiment()
 */
async function storeSentiment(reviewId, sentimentData) {
  try {
    await query(
      `INSERT INTO review_sentiment
       (review_id, sentiment, score, topics, topic_sentiments, emotions, key_phrase, actionable, actionable_insight)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (review_id) DO UPDATE SET
         sentiment = EXCLUDED.sentiment,
         score = EXCLUDED.score,
         topics = EXCLUDED.topics,
         updated_at = NOW()`,
      [
        reviewId,
        sentimentData.sentiment,
        sentimentData.score,
        JSON.stringify(sentimentData.topics || []),
        JSON.stringify(sentimentData.topic_sentiments || {}),
        JSON.stringify(sentimentData.emotions || []),
        sentimentData.key_phrase || '',
        sentimentData.actionable || false,
        sentimentData.actionable_insight || ''
      ]
    );
  } catch (error) {
    logger.error(`Failed to store sentiment for review ${reviewId}:`, error.message);
  }
}

module.exports = {
  analyzeReviewSentiment,
  storeSentiment,
  getLocationSentimentTrend
};
