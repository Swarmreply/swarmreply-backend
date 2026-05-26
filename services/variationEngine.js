// ============================================
// services/variationEngine.js
// Reply Variation Engine
// Tracks all reply openings and structures
// to ensure no two replies ever sound identical
// Prevents Google flagging templated responses
// Growth & Agency plans only
// ============================================

const Anthropic = require('@anthropic-ai/sdk');
const { query } = require('../database/db');
const logger = require('../utils/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================
// VARIATION TRACKING
// ============================================

/**
 * getRecentOpenings()
 * Get the last N reply openings for a location
 * Used to ensure new replies don't start the same way
 *
 * @param {string} locationId
 * @param {number} limit - How many recent replies to check (default 10)
 * @returns {Array} Array of opening phrases
 */
async function getRecentOpenings(locationId, limit = 10) {
  try {
    const result = await query(
      `SELECT rp.posted_reply
       FROM replies rp
       JOIN reviews rv ON rp.review_id = rv.id
       WHERE rv.location_id = $1
       AND rp.status = 'posted'
       AND rp.posted_reply IS NOT NULL
       ORDER BY rp.posted_at DESC
       LIMIT $2`,
      [locationId, limit]
    );

    // Extract first 8 words of each reply as the "opening"
    return result.rows.map(r => {
      const words = r.posted_reply.split(' ').slice(0, 8).join(' ').toLowerCase();
      return words;
    });
  } catch (error) {
    logger.error('Failed to get recent openings:', error.message);
    return [];
  }
}

/**
 * getVariationInstructions()
 * Build variation instructions for the AI prompt
 * based on recently used openings
 *
 * @param {string} locationId
 * @param {number} starRating - To get tone-appropriate variations
 * @returns {string} Instructions string for the AI
 */
async function getVariationInstructions(locationId, starRating) {
  const recentOpenings = await getRecentOpenings(locationId);

  // Tone-appropriate opener bank — AI will choose differently from recent ones
  const openerBanks = {
    5: [
      'Start with the customer\'s name if available',
      'Start by referencing something specific from their review',
      'Start with an expression of genuine delight',
      'Start by acknowledging the specific item they praised',
      'Start with "What wonderful feedback" or similar',
      'Start by thanking them for taking time to share'
    ],
    4: [
      'Start by acknowledging their positive experience first',
      'Start with their name and a warm thank you',
      'Start by referencing the specific positive they mentioned',
      'Start with appreciation for their detailed feedback',
      'Start by noting how much the team appreciates hearing this'
    ],
    3: [
      'Start by thanking them for their honest feedback',
      'Start by acknowledging both the positives and areas to improve',
      'Start with the customer\'s name and genuine appreciation',
      'Start by noting that feedback like theirs helps the business grow',
      'Start with a warm acknowledgment of their visit'
    ],
    2: [
      'Start by sincerely apologizing for not meeting expectations',
      'Start with the customer\'s name and an empathetic acknowledgment',
      'Start by taking the feedback seriously and personally',
      'Start with genuine regret that their experience fell short',
      'Start by acknowledging specifically what went wrong'
    ],
    1: [
      'Start with a direct, sincere apology using their name',
      'Start by acknowledging the severity of their disappointment',
      'Start with genuine empathy for their frustrating experience',
      'Start by taking full ownership without excuses',
      'Start with the customer\'s name and a heartfelt apology'
    ]
  };

  const bank = openerBanks[starRating] || openerBanks[3];

  // Build the instruction
  let instruction = 'REPLY VARIATION RULES:\n';
  instruction += '- Write a UNIQUE response that sounds different from previous replies\n';

  if (recentOpenings.length > 0) {
    instruction += `- Do NOT start your reply with any of these recent openings or similar phrases:\n`;
    recentOpenings.slice(0, 5).forEach(o => {
      instruction += `  × "${o}..."\n`;
    });
  }

  // Pick a random opener instruction from the bank
  const randomOpener = bank[Math.floor(Math.random() * bank.length)];
  instruction += `- ${randomOpener}\n`;
  instruction += '- Vary your sentence structure, vocabulary, and emotional register\n';

  return instruction;
}

// ============================================
// VARIATION ANALYTICS
// ============================================

/**
 * getVariationScore()
 * Calculate how varied recent replies are
 * Returns a score 0-100 (100 = perfectly varied)
 *
 * @param {string} locationId
 * @returns {Object} { score, totalReplies, uniqueOpenings, insight }
 */
async function getVariationScore(locationId) {
  try {
    const result = await query(
      `SELECT rp.posted_reply
       FROM replies rp
       JOIN reviews rv ON rp.review_id = rv.id
       WHERE rv.location_id = $1
       AND rp.status = 'posted'
       AND rp.posted_reply IS NOT NULL
       ORDER BY rp.posted_at DESC
       LIMIT 20`,
      [locationId]
    );

    const replies = result.rows;
    if (replies.length < 2) {
      return { score: 100, totalReplies: replies.length, uniqueOpenings: replies.length, insight: 'Not enough replies yet to measure variation' };
    }

    // Extract first 5 words of each reply
    const openings = replies.map(r =>
      r.posted_reply.split(' ').slice(0, 5).join(' ').toLowerCase()
    );

    // Count unique openings
    const uniqueOpenings = new Set(openings).size;
    const score = Math.round((uniqueOpenings / replies.length) * 100);

    // Common words analysis
    const allWords = replies.flatMap(r => r.posted_reply.toLowerCase().split(' '));
    const wordCounts = {};
    allWords.forEach(w => {
      const clean = w.replace(/[^a-z]/g, '');
      if (clean.length > 4) wordCounts[clean] = (wordCounts[clean] || 0) + 1;
    });
    const overusedWords = Object.entries(wordCounts)
      .filter(([w, c]) => c > replies.length * 0.6) // Used in >60% of replies
      .sort(([,a], [,b]) => b - a)
      .slice(0, 3)
      .map(([w]) => w);

    const insight = score >= 85
      ? 'Excellent variation — replies sound consistently unique'
      : score >= 65
      ? `Good variation with room to improve${overusedWords.length ? ` — "${overusedWords[0]}" appears frequently` : ''}`
      : `Low variation detected${overusedWords.length ? ` — words like "${overusedWords.join('", "')}" are overused` : ''}`;

    return { score, totalReplies: replies.length, uniqueOpenings, overusedWords, insight };

  } catch (error) {
    logger.error('Failed to calculate variation score:', error.message);
    return { score: 0, totalReplies: 0, uniqueOpenings: 0, insight: 'Unable to calculate' };
  }
}

module.exports = {
  getVariationInstructions,
  getRecentOpenings,
  getVariationScore
};
