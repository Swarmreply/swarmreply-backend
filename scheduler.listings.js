// ============================================
// Add to scheduler.updated.js
// ============================================

// ADD THIS IMPORT at top of scheduler.js:
// const listingsService = require('./services/listingsService');

// JOB 11: Daily listings sync — every day at 3am
// Fetches current state from Google, Apple, Bing
// and flags any divergences from canonical NAP
cron.schedule('0 3 * * *', async () => {
  try {
    await listingsService.runDailySync();
  } catch (error) {
    logger.error('Scheduler: Listings daily sync failed:', error.message);
  }
});
