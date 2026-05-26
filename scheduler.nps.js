// ============================================
// Add to scheduler.updated.js
// ============================================

// ADD THIS IMPORT at top of scheduler.js:
// const npsService = require('./services/npsService');

// JOB 12: Refresh NPS caches daily at 2am
cron.schedule('0 2 * * *', async () => {
  try {
    const locations = await query(
      `SELECT location_id FROM survey_configs WHERE is_enabled = true`
    );
    for (const loc of locations.rows) {
      await npsService.refreshNpsCache(loc.location_id);
    }
    logger.info(`NPS cache refreshed for ${locations.rows.length} location(s)`);
  } catch (error) {
    logger.error('Scheduler: NPS cache refresh failed:', error.message);
  }
});
