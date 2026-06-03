// ============================================
// scheduler.js
// Automated job scheduler using node-cron
// Controls when reviews are checked and processed
// ============================================

const cron = require('node-cron');
const reviewProcessor = require('./services/reviewProcessor');
const { runDueScans } = require('./scheduler.llm');
const logger = require('./utils/logger');
const { captureError } = require('./utils/sentry');

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
      captureError(error, { job: 'review-processing' });
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
      captureError(error, { job: 'retry-replies' });
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
      captureError(error, { job: 'weekly-digest' });
    }
  });

  // ============================================
  // JOB 4: AI Visibility weekly re-scans
  // Runs every day at 3am; only re-scans customers
  // who are DUE (last scan 7+ days ago). This naturally
  // staggers cost across the week and keeps reports fresh
  // without the customer having to click "Run scan".
  // ============================================
  cron.schedule('0 3 * * *', async () => {
    logger.info('Scheduler: Running AI Visibility due re-scans');
    try {
      await runDueScans();
    } catch (error) {
      logger.error('Scheduler: AI Visibility re-scan job failed:', error.message);
      captureError(error, { job: 'ai-visibility-rescan' });
    }
  });

  logger.info('Scheduler started — 4 jobs active');
}

module.exports = { startScheduler };
