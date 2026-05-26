// ============================================
// services/calendarService.js
// Review Volume Calendar
// Tracks which days and months get the most
// reviews — helps owners staff up and prepare
// Growth & Agency plans only
// ============================================

const { query } = require('../database/db');
const logger = require('../utils/logger');

// ============================================
// CALENDAR DATA
// ============================================

/**
 * getCalendarData()
 * Get review volume heatmap data for a location
 * Returns daily counts for the last 12 months
 * Formatted for a GitHub-style calendar heatmap
 *
 * @param {string} locationId
 * @param {number} months - Months to look back (default 12)
 * @returns {Object} Calendar heatmap data + analytics
 */
async function getCalendarData(locationId, months = 12) {
  try {
    // Daily review counts
    const dailyResult = await query(
      `SELECT
         DATE(review_date) as date,
         COUNT(*) as count,
         ROUND(AVG(star_rating)::numeric, 1) as avg_rating
       FROM reviews
       WHERE location_id = $1
       AND review_date >= NOW() - INTERVAL '${months} months'
       AND review_date IS NOT NULL
       GROUP BY DATE(review_date)
       ORDER BY date ASC`,
      [locationId]
    );

    const dailyData = dailyResult.rows;

    // Build full date range map
    const dateMap = {};
    dailyData.forEach(d => {
      dateMap[d.date] = {
        count: parseInt(d.count),
        avgRating: parseFloat(d.avg_rating)
      };
    });

    // Monthly breakdown
    const monthlyResult = await query(
      `SELECT
         TO_CHAR(review_date, 'YYYY-MM') as month,
         TO_CHAR(review_date, 'Month') as month_name,
         COUNT(*) as count,
         ROUND(AVG(star_rating)::numeric, 1) as avg_rating
       FROM reviews
       WHERE location_id = $1
       AND review_date >= NOW() - INTERVAL '${months} months'
       GROUP BY TO_CHAR(review_date, 'YYYY-MM'), TO_CHAR(review_date, 'Month')
       ORDER BY month ASC`,
      [locationId]
    );

    // Day of week breakdown
    const dowResult = await query(
      `SELECT
         EXTRACT(DOW FROM review_date) as dow,
         TO_CHAR(review_date, 'Day') as day_name,
         COUNT(*) as count,
         ROUND(AVG(star_rating)::numeric, 1) as avg_rating
       FROM reviews
       WHERE location_id = $1
       AND review_date >= NOW() - INTERVAL '${months} months'
       GROUP BY EXTRACT(DOW FROM review_date), TO_CHAR(review_date, 'Day')
       ORDER BY dow ASC`,
      [locationId]
    );

    // Hour of day breakdown (when reviews are written)
    const hourResult = await query(
      `SELECT
         EXTRACT(HOUR FROM review_date) as hour,
         COUNT(*) as count
       FROM reviews
       WHERE location_id = $1
       AND review_date >= NOW() - INTERVAL '${months} months'
       GROUP BY EXTRACT(HOUR FROM review_date)
       ORDER BY hour ASC`,
      [locationId]
    );

    // Find peak patterns
    const peakDay = dowResult.rows.sort((a, b) => parseInt(b.count) - parseInt(a.count))[0];
    const slowDay = dowResult.rows.sort((a, b) => parseInt(a.count) - parseInt(b.count))[0];
    const peakMonth = monthlyResult.rows.sort((a, b) => parseInt(b.count) - parseInt(a.count))[0];

    // Build heatmap cells for last 52 weeks
    const heatmapCells = buildHeatmapCells(dateMap, months);

    // Calculate max for color scaling
    const maxDaily = Math.max(...dailyData.map(d => parseInt(d.count)), 1);

    // Streaks — longest consecutive days with reviews
    const longestStreak = calculateLongestStreak(dailyData);

    return {
      heatmapCells,
      maxDaily,
      dailyData: dailyData.map(d => ({
        date: d.date,
        count: parseInt(d.count),
        avgRating: parseFloat(d.avg_rating)
      })),
      monthlyData: monthlyResult.rows.map(m => ({
        month: m.month,
        monthName: m.month_name?.trim(),
        count: parseInt(m.count),
        avgRating: parseFloat(m.avg_rating)
      })),
      dayOfWeekData: dowResult.rows.map(d => ({
        dow: parseInt(d.dow),
        dayName: d.day_name?.trim(),
        count: parseInt(d.count),
        avgRating: parseFloat(d.avg_rating)
      })),
      hourData: hourResult.rows.map(h => ({
        hour: parseInt(h.hour),
        count: parseInt(h.count)
      })),
      insights: {
        peakDay: peakDay ? { name: peakDay.day_name?.trim(), count: parseInt(peakDay.count) } : null,
        slowDay: slowDay ? { name: slowDay.day_name?.trim(), count: parseInt(slowDay.count) } : null,
        peakMonth: peakMonth ? { name: peakMonth.month_name?.trim(), count: parseInt(peakMonth.count) } : null,
        longestStreak,
        totalReviews: dailyData.reduce((sum, d) => sum + parseInt(d.count), 0)
      }
    };

  } catch (error) {
    logger.error(`Failed to get calendar data for ${locationId}:`, error.message);
    throw error;
  }
}

/**
 * buildHeatmapCells()
 * Build array of {date, count, intensity} for GitHub-style heatmap
 * intensity: 0-4 (for color coding)
 */
function buildHeatmapCells(dateMap, months) {
  const cells = [];
  const now = new Date();
  const start = new Date(now);
  start.setMonth(start.getMonth() - months);

  const allCounts = Object.values(dateMap).map(d => d.count);
  const max = Math.max(...allCounts, 1);
  const p25 = max * 0.25;
  const p50 = max * 0.5;
  const p75 = max * 0.75;

  const current = new Date(start);
  while (current <= now) {
    const dateStr = current.toISOString().split('T')[0];
    const data = dateMap[dateStr];
    const count = data?.count || 0;

    let intensity = 0;
    if (count > 0) {
      if (count <= p25) intensity = 1;
      else if (count <= p50) intensity = 2;
      else if (count <= p75) intensity = 3;
      else intensity = 4;
    }

    cells.push({
      date: dateStr,
      count,
      avgRating: data?.avgRating || 0,
      intensity,
      dayOfWeek: current.getDay(),
      month: current.getMonth(),
      year: current.getFullYear()
    });

    current.setDate(current.getDate() + 1);
  }

  return cells;
}

/**
 * calculateLongestStreak()
 * Find longest consecutive days with at least 1 review
 */
function calculateLongestStreak(dailyData) {
  if (dailyData.length === 0) return 0;
  let longest = 1;
  let current = 1;

  for (let i = 1; i < dailyData.length; i++) {
    const prev = new Date(dailyData[i - 1].date);
    const curr = new Date(dailyData[i].date);
    const diff = (curr - prev) / (1000 * 60 * 60 * 24);
    if (diff === 1) {
      current++;
      longest = Math.max(longest, current);
    } else {
      current = 1;
    }
  }
  return longest;
}

module.exports = { getCalendarData };
