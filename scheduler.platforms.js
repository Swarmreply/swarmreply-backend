// ============================================
// scheduler.platforms.js
// Multi-platform review sync scheduler
//
// Runs alongside the main scheduler.
// Fetches new reviews from all connected
// non-Google platforms on a schedule.
//
// Merge into scheduler.js:
//   const { startPlatformScheduler } = require('./scheduler.platforms');
//   startPlatformScheduler();
// ============================================

const cron            = require('node-cron');
const { query }       = require('./database/db');
const facebookService = require('./services/facebookService');
const logger          = require('./utils/logger');

/**
 * syncAllFacebookLocations()
 * Fetch new reviews from Facebook for every connected location.
 */
async function syncAllFacebookLocations() {
  try {
    const result = await query(
      `SELECT location_id FROM connected_platforms
       WHERE platform = 'facebook' AND is_active = true`
    );

    if (!result.rows.length) return;

    logger.info(`[Platform Scheduler] Syncing Facebook for ${result.rows.length} location(s)`);

    for (const row of result.rows) {
      try {
        const stats = await facebookService.fetchReviews(row.location_id);
        if (stats.newReviews > 0) {
          logger.info(`[Facebook] ${row.location_id}: ${stats.newReviews} new review(s)`);
          // New Facebook reviews will be picked up by the main review processor
          // on its next run — it processes all reviews with status = 'pending'
        }
      } catch (err) {
        logger.error(`[Facebook] Sync failed for ${row.location_id}:`, err.message);
      }
    }
  } catch (err) {
    logger.error('[Platform Scheduler] Fatal error:', err.message);
  }
}

function startPlatformScheduler() {
  // Sync Facebook reviews every hour
  cron.schedule('0 * * * *', () => {
    logger.info('[Platform Scheduler] Starting hourly platform sync');
    syncAllFacebookLocations();
  });

  // Initial sync on startup
  setTimeout(syncAllFacebookLocations, 15000); // 15s after boot

  logger.info('[Platform Scheduler] Started — Facebook sync every hour');
}

module.exports = { startPlatformScheduler, syncAllFacebookLocations };
