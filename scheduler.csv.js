// ============================================
// Add to scheduler.updated.js
// Processes scheduled CSV imports every 5 min
// ============================================

// ADD THIS IMPORT at top of scheduler:
// const csvImportService = require('./services/csvImportService');

// ADD THIS JOB inside startScheduler():

// JOB 7: Process scheduled CSV imports — every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  try {
    await csvImportService.processPendingImports();
  } catch (error) {
    logger.error('Scheduler: CSV import processing failed:', error.message);
  }
});
