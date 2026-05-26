// ============================================
// Add to scheduler.updated.js
// Refresh widget cache hourly
// ============================================

// ADD THIS IMPORT at top of scheduler.js:
// const widgetService = require('./services/widgetService');

// ADD THIS JOB inside startScheduler():

// JOB 8: Refresh widget review cache — every hour
cron.schedule('0 * * * *', async () => {
  try {
    await widgetService.refreshWidgetCache();
  } catch (error) {
    logger.error('Scheduler: Widget cache refresh failed:', error.message);
  }
});
