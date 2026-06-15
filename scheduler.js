// ============================================
// scheduler.js
// Automated job scheduler using node-cron
// Controls when reviews are checked and processed
// ============================================

const cron = require('node-cron');
const reviewProcessor = require('./services/reviewProcessor');
const { runDueScans } = require('./scheduler.llm');
const { resyncPendingBilling } = require('./services/locationBilling');
const { processDueScheduledRequests } = require('./services/integrationService');
const { runDailySync } = require('./services/listingsService');
const { runWeeklyDirectoryScan } = require('./services/directoryCheckService');
const { runDueCompetitorScans } = require('./scheduler.competitors');
const { runDueRankChecks } = require('./scheduler.rank');
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
  // JOB -1: Daily listings sync — fetch each platform,
  // detect NAP divergences, refresh consistency scores
  // ============================================
  cron.schedule('0 6 * * *', async () => {
    try {
      await runDailySync();
    } catch (error) {
      logger.error('Scheduler: listings daily sync failed:', error.message);
      captureError(error, { job: 'listings-daily-sync' });
    }
  });

  // ============================================
  // JOB -0.5: Weekly guided-directory scan — read Yelp,
  // Foursquare, and the Facebook page for NAP drift
  // ============================================
  cron.schedule('0 7 * * 1', async () => {
    try {
      await runWeeklyDirectoryScan();
    } catch (error) {
      logger.error('Scheduler: directory scan failed:', error.message);
      captureError(error, { job: 'listings-directory-scan' });
    }
  });

  // ============================================
  // JOB -0.25: Weekly competitor re-scan — refresh nearby
  // rating/review benchmarks for locations that opted in
  // (Mondays 08:00, after the directory scan)
  // ============================================
  cron.schedule('0 8 * * 1', async () => {
    try {
      await runDueCompetitorScans();
    } catch (error) {
      logger.error('Scheduler: competitor scan failed:', error.message);
      captureError(error, { job: 'competitor-weekly-scan' });
    }
  });

  // ============================================
  // JOB 0: Send due scheduled review requests
  // Runs every minute — integrations queue sends
  // with a customer-configured delay (send timing)
  // ============================================
  cron.schedule('* * * * *', async () => {
    try {
      await processDueScheduledRequests();
    } catch (error) {
      logger.error('Scheduler: send-timing sweep failed:', error.message);
      captureError(error, { job: 'send-timing-sweep' });
    }
  });

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

  // ============================================
  // JOB 4b: Rank Tracking weekly re-checks
  // Runs every Monday at 9am; re-checks locations that have
  // opted in (run at least one check) and are now 7+ days
  // stale. First checks stay on-demand via the button.
  // ============================================
  cron.schedule('0 9 * * 1', async () => {
    logger.info('Scheduler: Running due rank checks');
    try {
      await runDueRankChecks();
    } catch (error) {
      logger.error('Scheduler: Rank check job failed:', error.message);
      captureError(error, { job: 'rank-weekly-check' });
    }
  });

  // ============================================
  // JOB 5: Retry pending location-billing syncs
  // Runs hourly at :15. Any location created or
  // toggled while Stripe was unreachable stays
  // billing_synced=false until this reconciles it,
  // so a billing hiccup can never become free usage.
  // ============================================
  cron.schedule('15 * * * *', async () => {
    try {
      const n = await resyncPendingBilling();
      if (n > 0) logger.info(`Scheduler: retried location billing sync for ${n} customer(s)`);
    } catch (error) {
      logger.error('Scheduler: billing resync job failed:', error.message);
      captureError(error, { job: 'billing-resync' });
    }
  });

  logger.info('Scheduler started — 5 jobs active');
}

module.exports = { startScheduler };
