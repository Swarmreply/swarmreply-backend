// ============================================
// services/dataService.js
// Unified data analytics service
// Powers the consolidated Data section
//
// New metrics:
//  1. Reply Quality Score
//  2. Review Velocity
//  3. Star Rating History (by platform)
//  4. Hour-of-Day analysis
//  5. Survey Trends (from survey_sends)
// ============================================

const { query } = require('../database/db');
const logger    = require('../utils/logger');

// ============================================
// 1. REPLY QUALITY SCORE
// Measures how good the auto-replies are:
//  - Average reply length (too short = lazy)
//  - Edit rate (how often staff edit before posting)
//  - Tone consistency (variation in openings)
//  - Coverage of "always include" keywords
// Returns 0–100 score + breakdown
// ============================================
async function getReplyQuality(locationId, days = 30) {
  const result = await query(
    `SELECT
       COUNT(*)                                              AS total_replies,
       COUNT(*) FILTER (WHERE rp.was_edited = true)         AS edited_count,
       COUNT(*) FILTER (WHERE rp.status = 'posted')         AS posted_count,
       ROUND(AVG(LENGTH(rp.posted_reply)))::int             AS avg_reply_length,
       ROUND(AVG(LENGTH(rp.posted_reply)) FILTER
         (WHERE rp.posted_reply IS NOT NULL))::int          AS avg_posted_length,
       MIN(LENGTH(rp.posted_reply))                         AS min_length,
       MAX(LENGTH(rp.posted_reply))                         AS max_length,
       -- Response speed distribution
       COUNT(*) FILTER (
         WHERE EXTRACT(EPOCH FROM (rp.posted_at - r.review_date))/3600 <= 2
       ) AS replied_under_2h,
       COUNT(*) FILTER (
         WHERE EXTRACT(EPOCH FROM (rp.posted_at - r.review_date))/3600 BETWEEN 2 AND 6
       ) AS replied_2_6h,
       COUNT(*) FILTER (
         WHERE EXTRACT(EPOCH FROM (rp.posted_at - r.review_date))/3600 BETWEEN 6 AND 12
       ) AS replied_6_12h,
       COUNT(*) FILTER (
         WHERE EXTRACT(EPOCH FROM (rp.posted_at - r.review_date))/3600 BETWEEN 12 AND 24
       ) AS replied_12_24h,
       COUNT(*) FILTER (
         WHERE EXTRACT(EPOCH FROM (rp.posted_at - r.review_date))/3600 > 24
       ) AS replied_over_24h,
       ROUND(AVG(
         EXTRACT(EPOCH FROM (rp.posted_at - r.review_date))/3600
       )::numeric, 1)                                       AS avg_response_hours
     FROM reviews r
     JOIN replies rp ON r.id = rp.review_id
     WHERE r.location_id = $1
       AND rp.status = 'posted'
       AND rp.posted_at >= NOW() - ($2 || ' days')::interval`,
    [locationId, days]
  );

  const row = result.rows[0];
  const total    = parseInt(row.total_replies)  || 0;
  const edited   = parseInt(row.edited_count)   || 0;
  const posted   = parseInt(row.posted_count)   || 0;
  const avgLen   = parseInt(row.avg_reply_length) || 0;
  const editRate = total > 0 ? Math.round((edited / total) * 100) : 0;

  // Weekly trend — reply quality score per week
  const trend = await query(
    `SELECT
       DATE_TRUNC('week', rp.posted_at) AS week,
       COUNT(*)                         AS replies,
       ROUND(AVG(LENGTH(rp.posted_reply)))::int AS avg_length,
       COUNT(*) FILTER (WHERE rp.was_edited) AS edited,
       ROUND(AVG(EXTRACT(EPOCH FROM (rp.posted_at - r.review_date))/3600)::numeric, 1) AS avg_hours
     FROM reviews r
     JOIN replies rp ON r.id = rp.review_id
     WHERE r.location_id = $1
       AND rp.status = 'posted'
       AND rp.posted_at >= NOW() - ($2 || ' days')::interval
     GROUP BY DATE_TRUNC('week', rp.posted_at)
     ORDER BY week`,
    [locationId, days]
  );

  // Compute quality score (0–100)
  // Factors: avg length (ideal 150–350), low edit rate (< 10% = good), fast response
  const lengthScore   = avgLen >= 150 && avgLen <= 400 ? 40
                      : avgLen >= 100 && avgLen < 150  ? 28
                      : avgLen > 400                   ? 35
                      : 15;
  const editScore     = editRate <= 5  ? 30
                      : editRate <= 15 ? 22
                      : editRate <= 30 ? 14 : 6;
  const speedScore    = (row.avg_response_hours || 0) <= 4  ? 30
                      : (row.avg_response_hours || 0) <= 12 ? 22
                      : (row.avg_response_hours || 0) <= 24 ? 14 : 6;
  const qualityScore  = lengthScore + editScore + speedScore;

  return {
    qualityScore,
    totalReplies:      total,
    postedReplies:     posted,
    editRate,
    avgReplyLength:    avgLen,
    avgResponseHours:  parseFloat(row.avg_response_hours) || 0,
    speedBreakdown: {
      under2h:  parseInt(row.replied_under_2h)  || 0,
      h2to6:    parseInt(row.replied_2_6h)      || 0,
      h6to12:   parseInt(row.replied_6_12h)     || 0,
      h12to24:  parseInt(row.replied_12_24h)    || 0,
      over24h:  parseInt(row.replied_over_24h)  || 0,
    },
    trend: trend.rows
  };
}

// ============================================
// 2. REVIEW VELOCITY
// How fast are reviews arriving vs last period?
// Returns weekly counts + acceleration metric
// ============================================
async function getReviewVelocity(locationId, weeks = 12) {
  const result = await query(
    `SELECT
       DATE_TRUNC('week', review_date) AS week,
       COUNT(*)                         AS count,
       platform,
       ROUND(AVG(star_rating)::numeric, 1) AS avg_rating
     FROM reviews
     WHERE location_id = $1
       AND review_date >= NOW() - ($2 || ' weeks')::interval
     GROUP BY DATE_TRUNC('week', review_date), platform
     ORDER BY week, platform`,
    [locationId, weeks]
  );

  // Roll up into weeks with platform breakdown
  const weekMap = {};
  for (const row of result.rows) {
    const wk = row.week;
    if (!weekMap[wk]) {
      weekMap[wk] = { week: wk, total: 0, byPlatform: {} };
    }
    const c = parseInt(row.count) || 0;
    weekMap[wk].total += c;
    weekMap[wk].byPlatform[row.platform] = c;
  }

  const weeks_arr = Object.values(weekMap).sort((a, b) => new Date(a.week) - new Date(b.week));

  // Acceleration: compare last 4 weeks to prior 4 weeks
  const last4  = weeks_arr.slice(-4).reduce((s, w) => s + w.total, 0);
  const prior4 = weeks_arr.slice(-8, -4).reduce((s, w) => s + w.total, 0);
  const acceleration = prior4 > 0 ? Math.round(((last4 - prior4) / prior4) * 100) : null;

  // Current week vs same week last year (if we have the data)
  const thisWeek = weeks_arr[weeks_arr.length - 1]?.total || 0;
  const avgPerWeek = weeks_arr.length > 0
    ? Math.round(weeks_arr.reduce((s, w) => s + w.total, 0) / weeks_arr.length)
    : 0;

  return { weeks: weeks_arr, acceleration, thisWeek, avgPerWeek, last4, prior4 };
}

// ============================================
// 3. STAR RATING HISTORY BY PLATFORM
// Monthly average rating per platform
// Shows how your rating has moved over time
// ============================================
async function getRatingHistory(locationId, months = 12) {
  const result = await query(
    `SELECT
       DATE_TRUNC('month', review_date) AS month,
       platform,
       ROUND(AVG(star_rating)::numeric, 2) AS avg_rating,
       COUNT(*)                             AS review_count,
       COUNT(*) FILTER (WHERE star_rating = 5) AS five_star,
       COUNT(*) FILTER (WHERE star_rating >= 4) AS four_plus,
       COUNT(*) FILTER (WHERE star_rating <= 2) AS negative
     FROM reviews
     WHERE location_id = $1
       AND review_date >= NOW() - ($2 || ' months')::interval
       AND star_rating IS NOT NULL
     GROUP BY DATE_TRUNC('month', review_date), platform
     ORDER BY month, platform`,
    [locationId, months]
  );

  // Also get overall (all platforms combined) per month
  const overall = await query(
    `SELECT
       DATE_TRUNC('month', review_date) AS month,
       ROUND(AVG(star_rating)::numeric, 2) AS avg_rating,
       COUNT(*) AS review_count
     FROM reviews
     WHERE location_id = $1
       AND review_date >= NOW() - ($2 || ' months')::interval
       AND star_rating IS NOT NULL
     GROUP BY DATE_TRUNC('month', review_date)
     ORDER BY month`,
    [locationId, months]
  );

  // Current vs first month delta
  const overallRows = overall.rows;
  const firstRating = parseFloat(overallRows[0]?.avg_rating) || null;
  const lastRating  = parseFloat(overallRows[overallRows.length - 1]?.avg_rating) || null;
  const ratingDelta = firstRating && lastRating
    ? Math.round((lastRating - firstRating) * 10) / 10
    : null;

  return {
    byPlatform: result.rows,
    overall:    overallRows,
    firstRating,
    lastRating,
    ratingDelta
  };
}

// ============================================
// 4. HOUR-OF-DAY ANALYSIS
// When do reviews arrive?
// When are replies sent?
// Best time to send review requests?
// ============================================
async function getHourOfDayAnalysis(locationId, days = 90) {
  // Review arrival by hour
  const arrivals = await query(
    `SELECT
       EXTRACT(HOUR FROM review_date)::int AS hour,
       COUNT(*)                             AS count,
       platform
     FROM reviews
     WHERE location_id = $1
       AND review_date >= NOW() - ($2 || ' days')::interval
     GROUP BY EXTRACT(HOUR FROM review_date), platform
     ORDER BY hour, platform`,
    [locationId, days]
  );

  // Day of week breakdown
  const byDow = await query(
    `SELECT
       EXTRACT(DOW FROM review_date)::int AS dow,
       COUNT(*)                           AS count,
       ROUND(AVG(star_rating)::numeric, 1) AS avg_rating
     FROM reviews
     WHERE location_id = $1
       AND review_date >= NOW() - ($2 || ' days')::interval
     GROUP BY EXTRACT(DOW FROM review_date)
     ORDER BY dow`,
    [locationId, days]
  );

  // Find peak hour
  const hourTotals = {};
  for (const row of arrivals.rows) {
    hourTotals[row.hour] = (hourTotals[row.hour] || 0) + parseInt(row.count);
  }
  const peakHour = Object.entries(hourTotals)
    .sort(([,a],[,b]) => b - a)[0]?.[0];

  // Find best day for review requests (highest avg rating = happiest customers)
  const bestDay = byDow.rows.sort((a, b) =>
    parseFloat(b.avg_rating) - parseFloat(a.avg_rating)
  )[0]?.dow;

  const DOW_LABELS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  return {
    byHour:    arrivals.rows,
    byDow:     byDow.rows,
    peakHour:  peakHour !== undefined ? parseInt(peakHour) : null,
    peakHourLabel: peakHour !== undefined
      ? (parseInt(peakHour) === 0 ? '12am'
        : parseInt(peakHour) < 12 ? `${peakHour}am`
        : parseInt(peakHour) === 12 ? '12pm'
        : `${parseInt(peakHour) - 12}pm`)
      : null,
    bestDayForRequests: bestDay !== undefined ? DOW_LABELS[parseInt(bestDay)] : null
  };
}

// ============================================
// 5. SURVEY TRENDS
// NPS over time, promoter/detractor ratio,
// private feedback themes
// ============================================
async function getSurveyTrends(locationId, weeks = 12) {
  // Check if survey table exists first
  try {
    const weekly = await query(
      `SELECT
         DATE_TRUNC('week', responded_at) AS week,
         COUNT(*)                          AS responses,
         ROUND(AVG(score)::numeric, 1)     AS avg_score,
         COUNT(*) FILTER (WHERE score_label = 'promoter')  AS promoters,
         COUNT(*) FILTER (WHERE score_label = 'passive')   AS passives,
         COUNT(*) FILTER (WHERE score_label = 'detractor') AS detractors
       FROM survey_sends
       WHERE location_id = $1
         AND score IS NOT NULL
         AND responded_at >= NOW() - ($2 || ' weeks')::interval
       GROUP BY DATE_TRUNC('week', responded_at)
       ORDER BY week`,
      [locationId, weeks]
    );

    // Response rate trend
    const sendRate = await query(
      `SELECT
         DATE_TRUNC('week', sent_at)              AS week,
         COUNT(*)                                  AS sent,
         COUNT(*) FILTER (WHERE score IS NOT NULL) AS responded
       FROM survey_sends
       WHERE location_id = $1
         AND sent_at >= NOW() - ($2 || ' weeks')::interval
       GROUP BY DATE_TRUNC('week', sent_at)
       ORDER BY week`,
      [locationId, weeks]
    );

    // Common words in detractor feedback (simple frequency)
    const feedback = await query(
      `SELECT followup_text FROM survey_sends
       WHERE location_id = $1
         AND score_label = 'detractor'
         AND followup_text IS NOT NULL
         AND followup_text != ''
         AND responded_at >= NOW() - ($2 || ' weeks')::interval`,
      [locationId, weeks]
    );

    const wordFreq = {};
    const stopWords = new Set(['the','a','an','and','or','but','in','on','at','to','for','of',
      'with','was','is','it','we','i','my','our','this','that','had','have','were','are',
      'very','so','be','not','no','me','you','they','their','he','she','us','got','get',
      'did','do','will','would','could','should','been','has','its']);

    for (const row of feedback.rows) {
      const words = row.followup_text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
      for (const w of words) {
        if (!stopWords.has(w)) {
          wordFreq[w] = (wordFreq[w] || 0) + 1;
        }
      }
    }
    const topWords = Object.entries(wordFreq)
      .sort(([,a],[,b]) => b - a)
      .slice(0, 15)
      .map(([word, count]) => ({ word, count }));

    return {
      weekly:    weekly.rows,
      sendRate:  sendRate.rows,
      topWords,
      hasData:   weekly.rows.length > 0
    };
  } catch (err) {
    // Survey table may not exist yet
    return { weekly: [], sendRate: [], topWords: [], hasData: false };
  }
}

// ============================================
// COMBINED — returns all 5 new metrics at once
// so the Data page only needs one API call
// ============================================
async function getAllDataMetrics(locationId, options = {}) {
  const { days = 30, weeks = 12, months = 12 } = options;

  const [quality, velocity, ratingHistory, hourAnalysis, surveyTrends] =
    await Promise.allSettled([
      getReplyQuality(locationId, days),
      getReviewVelocity(locationId, weeks),
      getRatingHistory(locationId, months),
      getHourOfDayAnalysis(locationId, days * 3),
      getSurveyTrends(locationId, weeks)
    ]);

  return {
    replyQuality:  quality.status   === 'fulfilled' ? quality.value   : null,
    velocity:      velocity.status  === 'fulfilled' ? velocity.value  : null,
    ratingHistory: ratingHistory.status === 'fulfilled' ? ratingHistory.value : null,
    hourAnalysis:  hourAnalysis.status  === 'fulfilled' ? hourAnalysis.value  : null,
    surveyTrends:  surveyTrends.status  === 'fulfilled' ? surveyTrends.value  : null,
  };
}

module.exports = {
  getReplyQuality,
  getReviewVelocity,
  getRatingHistory,
  getHourOfDayAnalysis,
  getSurveyTrends,
  getAllDataMetrics
};
