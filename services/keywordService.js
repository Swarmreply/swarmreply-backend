// ============================================
// services/keywordService.js
// Review keyword tracker
// Extracts meaningful keywords from reviews,
// tracks frequency, sentiment per keyword,
// and trends over time
// ============================================

const Anthropic = require('@anthropic-ai/sdk');
const { query } = require('../database/db');
const logger = require('../utils/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================
// EXTRACT KEYWORDS FROM A SINGLE REVIEW
// ============================================

/**
 * extractKeywords()
 * Use Claude to pull meaningful keywords from a review
 * Called automatically when a new review is stored
 *
 * @param {Object} review - Review row from database
 * @returns {Array} Array of keyword objects
 */
async function extractKeywords(review) {
  if (!review.review_text || review.review_text.trim().length < 10) {
    return [];
  }

  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system: `You are a keyword extraction engine for business reviews.
Extract meaningful keywords and phrases from the review.
Focus on: specific products/services mentioned, staff references (use "staff" not names),
experience descriptors, price mentions, wait time references, quality indicators.
Ignore: filler words, the business name, generic words like "place" or "went".
Return ONLY valid JSON array, no other text:
[{"keyword": "pasta", "sentiment": "positive", "category": "food"},
 {"keyword": "wait time", "sentiment": "negative", "category": "service"}]
Categories: food, drink, service, staff, atmosphere, price, quality, cleanliness, parking, location, other
Sentiment: positive, neutral, negative
Return 3-8 keywords maximum. Return [] if no meaningful keywords found.`,
        messages: [{
          role: 'user',
          content: `Review (${review.star_rating} stars): "${review.review_text}"`
        }]
      });

      const text = message.content[0]?.text?.trim();
      const clean = text.replace(/```json|```/g, '').trim();
      const keywords = JSON.parse(clean);

      if (!Array.isArray(keywords)) throw new Error('Response is not an array');
      return keywords;

    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 1500));
      }
    }
  }

  logger.error(`Keyword extraction failed for review ${review.id}:`, lastError?.message);
  return [];
}

// ============================================
// STORE KEYWORDS IN DATABASE
// ============================================

/**
 * storeKeywords()
 * Save extracted keywords for a review
 * Uses upsert to handle re-processing
 *
 * @param {string} reviewId
 * @param {string} locationId
 * @param {Array} keywords - Array from extractKeywords()
 */
async function storeKeywords(reviewId, locationId, keywords) {
  if (!keywords || keywords.length === 0) return;

  try {
    for (const kw of keywords) {
      // Validate keyword
      if (!kw.keyword || typeof kw.keyword !== 'string') continue;

      const normalized = kw.keyword.toLowerCase().trim();
      if (normalized.length < 2 || normalized.length > 50) continue;

      await query(
        `INSERT INTO review_keywords
         (review_id, location_id, keyword, sentiment, category)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (review_id, keyword) DO NOTHING`,
        [
          reviewId,
          locationId,
          normalized,
          kw.sentiment || 'neutral',
          kw.category || 'other'
        ]
      );
    }
  } catch (error) {
    logger.error(`Failed to store keywords for review ${reviewId}:`, error.message);
  }
}

// ============================================
// KEYWORD ANALYTICS
// ============================================

/**
 * getKeywordAnalytics()
 * Get full keyword analytics for a location
 * Returns frequency, sentiment breakdown, trends, top/bottom keywords
 *
 * @param {string} locationId
 * @param {number} days - Lookback period (default 30)
 * @param {string} category - Filter by category (optional)
 * @returns {Object} Full keyword analytics
 */
async function getKeywordAnalytics(locationId, days = 30, category = null) {
  try {
    // Build category filter
    const categoryFilter = category ? `AND rk.category = '${category}'` : '';

    // Get keyword frequency with sentiment breakdown
    const frequencyResult = await query(
      `SELECT
         rk.keyword,
         rk.category,
         COUNT(*) as total_mentions,
         COUNT(CASE WHEN rk.sentiment = 'positive' THEN 1 END) as positive_count,
         COUNT(CASE WHEN rk.sentiment = 'neutral' THEN 1 END) as neutral_count,
         COUNT(CASE WHEN rk.sentiment = 'negative' THEN 1 END) as negative_count,
         ROUND(
           COUNT(CASE WHEN rk.sentiment = 'positive' THEN 1 END)::numeric /
           NULLIF(COUNT(*), 0) * 100
         ) as positive_pct,
         MAX(rv.review_date) as last_seen
       FROM review_keywords rk
       JOIN reviews rv ON rk.review_id = rv.id
       WHERE rk.location_id = $1
       AND rv.created_at >= NOW() - INTERVAL '${days} days'
       ${categoryFilter}
       GROUP BY rk.keyword, rk.category
       ORDER BY total_mentions DESC
       LIMIT 50`,
      [locationId]
    );

    const keywords = frequencyResult.rows;

    if (keywords.length === 0) {
      return {
        keywords: [],
        topPositive: [],
        topNegative: [],
        byCategory: {},
        trending: [],
        totalKeywords: 0,
        totalMentions: 0
      };
    }

    // Calculate total mentions
    const totalMentions = keywords.reduce((sum, k) => sum + parseInt(k.total_mentions), 0);

    // Top positive keywords (highest positive %)
    const topPositive = keywords
      .filter(k => parseInt(k.positive_count) > 0)
      .sort((a, b) => parseInt(b.positive_count) - parseInt(a.positive_count))
      .slice(0, 8);

    // Top negative keywords (highest negative count)
    const topNegative = keywords
      .filter(k => parseInt(k.negative_count) > 0)
      .sort((a, b) => parseInt(b.negative_count) - parseInt(a.negative_count))
      .slice(0, 8);

    // Group by category
    const byCategory = {};
    keywords.forEach(k => {
      if (!byCategory[k.category]) byCategory[k.category] = [];
      byCategory[k.category].push(k);
    });

    // Find trending keywords (appeared more in last 7 days vs previous 7 days)
    const trendingResult = await query(
      `SELECT
         rk.keyword,
         COUNT(CASE WHEN rv.created_at >= NOW() - INTERVAL '7 days' THEN 1 END) as recent_count,
         COUNT(CASE WHEN rv.created_at >= NOW() - INTERVAL '14 days'
           AND rv.created_at < NOW() - INTERVAL '7 days' THEN 1 END) as prev_count
       FROM review_keywords rk
       JOIN reviews rv ON rk.review_id = rv.id
       WHERE rk.location_id = $1
       AND rv.created_at >= NOW() - INTERVAL '14 days'
       GROUP BY rk.keyword
       HAVING COUNT(CASE WHEN rv.created_at >= NOW() - INTERVAL '7 days' THEN 1 END) > 0
       ORDER BY (
         COUNT(CASE WHEN rv.created_at >= NOW() - INTERVAL '7 days' THEN 1 END) -
         COUNT(CASE WHEN rv.created_at >= NOW() - INTERVAL '14 days'
           AND rv.created_at < NOW() - INTERVAL '7 days' THEN 1 END)
       ) DESC
       LIMIT 5`,
      [locationId]
    );

    const trending = trendingResult.rows
      .filter(k => parseInt(k.recent_count) > parseInt(k.prev_count))
      .map(k => ({
        keyword: k.keyword,
        recentCount: parseInt(k.recent_count),
        prevCount: parseInt(k.prev_count),
        change: parseInt(k.recent_count) - parseInt(k.prev_count)
      }));

    // Weekly keyword trend for top 5 keywords
    const top5Keywords = keywords.slice(0, 5).map(k => k.keyword);
    const weeklyTrend = await getKeywordWeeklyTrend(locationId, top5Keywords, days);

    return {
      keywords,
      topPositive,
      topNegative,
      byCategory,
      trending,
      weeklyTrend,
      totalKeywords: keywords.length,
      totalMentions
    };

  } catch (error) {
    logger.error(`Failed to get keyword analytics for ${locationId}:`, error.message);
    throw error;
  }
}

/**
 * getKeywordWeeklyTrend()
 * Get weekly mention counts for specific keywords
 * Used for the trend chart in the dashboard
 */
async function getKeywordWeeklyTrend(locationId, keywords, days) {
  if (!keywords || keywords.length === 0) return [];

  try {
    const weeks = Math.ceil(days / 7);
    const now = new Date();
    const trendData = [];

    for (let i = weeks - 1; i >= 0; i--) {
      const weekEnd = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000);
      const weekStart = new Date(weekEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
      const weekLabel = weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

      const weekPoint = { weekLabel };

      for (const keyword of keywords) {
        const result = await query(
          `SELECT COUNT(*) as count
           FROM review_keywords rk
           JOIN reviews rv ON rk.review_id = rv.id
           WHERE rk.location_id = $1
           AND rk.keyword = $2
           AND rv.created_at >= $3
           AND rv.created_at < $4`,
          [locationId, keyword, weekStart, weekEnd]
        );
        weekPoint[keyword] = parseInt(result.rows[0].count);
      }

      trendData.push(weekPoint);
    }

    return trendData;
  } catch (error) {
    logger.error('Failed to get keyword weekly trend:', error.message);
    return [];
  }
}

/**
 * searchKeyword()
 * Search for a specific keyword across all reviews for a location
 * Returns all reviews mentioning that keyword
 *
 * @param {string} locationId
 * @param {string} keyword
 * @returns {Array} Reviews mentioning the keyword
 */
async function searchKeyword(locationId, keyword) {
  try {
    const result = await query(
      `SELECT
         rv.id, rv.reviewer_name, rv.star_rating,
         rv.review_text, rv.review_date,
         rp.posted_reply,
         rk.sentiment as keyword_sentiment
       FROM review_keywords rk
       JOIN reviews rv ON rk.review_id = rv.id
       LEFT JOIN replies rp ON rv.id = rp.review_id AND rp.status = 'posted'
       WHERE rk.location_id = $1
       AND rk.keyword = $2
       ORDER BY rv.review_date DESC
       LIMIT 20`,
      [locationId, keyword.toLowerCase().trim()]
    );

    return result.rows;
  } catch (error) {
    logger.error(`Keyword search failed for "${keyword}":`, error.message);
    throw error;
  }
}

module.exports = {
  extractKeywords,
  storeKeywords,
  getKeywordAnalytics,
  searchKeyword
};
