// ============================================
// scheduler.js
// Automated job scheduler using node-cron
// Controls when reviews are checked and processed
// ============================================

const cron = require('node-cron');
const reviewProcessor = require('./services/reviewProcessor');
const logger = require('./utils/logger');

/**
 * startScheduler()
 * Initialize all scheduled jobs
 * Called once when server starts
 */
function startScheduler() {
  logger.info('Starting SwarmReply scheduler...');

  // ============================================
  // JOB 1: Process new reviews
  // Runs every 30 minutes, 24/7
  // Checks all active locations for new reviews
  // ============================================
  cron.schedule('*/30 * * * *', async () => {
    logger.info('Scheduler: Running review processing cycle');
    try {
      await reviewProcessor.processAllActiveLocations();
    } catch (error) {
      logger.error('Scheduler: Review processing failed:', error.message);
    }
  });

  // ============================================
  // JOB 2: Retry failed replies
  // Runs every hour
  // Picks up any replies that failed to post
  // ============================================
  cron.schedule('0 * * * *', async () => {
    logger.info('Scheduler: Retrying failed replies');
    try {
      await reviewProcessor.retryFailedReplies();
    } catch (error) {
      logger.error('Scheduler: Retry job failed:', error.message);
    }
  });

  // ============================================
  // JOB 3: Weekly digest emails
  // Runs every Monday at 8am
  // Sends summary to all active customers
  // ============================================
  cron.schedule('0 8 * * 1', async () => {
    logger.info('Scheduler: Sending weekly digests');
    try {
      await reviewProcessor.sendWeeklyDigests();
    } catch (error) {
      logger.error('Scheduler: Weekly digest failed:', error.message);
    }
  });

  logger.info('Scheduler started — 3 jobs active');
}

module.exports = { startScheduler };
