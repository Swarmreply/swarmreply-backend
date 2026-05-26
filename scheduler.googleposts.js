// ============================================
// Add to scheduler.updated.js
// Google Posts — two jobs
// ============================================

// ADD THIS IMPORT at top of scheduler.js:
// const googlePostsService = require('./services/googlePostsService');

// ─────────────────────────────────────────────────────────────
// JOB 9: Check for scheduled Google Posts — every 30 minutes
// The service itself checks next_post_at <= NOW() so running
// every 30 minutes gives ~30-minute accuracy on post timing.
// ─────────────────────────────────────────────────────────────
cron.schedule('*/30 * * * *', async () => {
  try {
    await googlePostsService.processScheduledPosts();
  } catch (error) {
    logger.error('Scheduler: Google Posts processing failed:', error.message);
  }
});

// ─────────────────────────────────────────────────────────────
// JOB 10: Mark expired Google Posts — daily at 1am
// Google Standard posts auto-expire after 7 days.
// This job marks them as 'expired' in our DB.
// ─────────────────────────────────────────────────────────────
cron.schedule('0 1 * * *', async () => {
  try {
    await googlePostsService.markExpiredPosts();
  } catch (error) {
    logger.error('Scheduler: Google Posts expiry check failed:', error.message);
  }
});
