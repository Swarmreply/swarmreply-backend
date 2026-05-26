// ============================================
// scheduler.growth.js
// Add this job to scheduler.updated.js
// Daily competitor snapshot for Growth+ plans
// ============================================

// ADD THIS IMPORT at top of scheduler.js:
// const competitorService = require('./services/competitorService');

// ADD THIS JOB inside startScheduler():

// JOB 6: Daily competitor snapshot — 6am every day
// Only runs for Growth & Agency plan customers
cron.schedule('0 6 * * *', async () => {
  logger.info('Scheduler: Taking daily competitor snapshots');
  try {
    await snapshotAllCompetitors();
  } catch (error) {
    logger.error('Scheduler: Competitor snapshot failed:', error.message);
  }
});

/**
 * snapshotAllCompetitors()
 * Take fresh competitor data for all Growth+ locations
 */
async function snapshotAllCompetitors() {
  const { query } = require('./database/db');
  const competitorService = require('./services/competitorService');
  const logger = require('./utils/logger');

  try {
    const result = await query(
      `SELECT l.id, l.business_name
       FROM locations l
       JOIN customers c ON l.customer_id = c.id
       WHERE l.is_active = true
       AND c.plan IN ('growth', 'agency')
       AND l.latitude IS NOT NULL
       AND l.longitude IS NOT NULL`,
      []
    );

    logger.info(`Snapshotting competitors for ${result.rows.length} Growth+ locations`);

    for (const location of result.rows) {
      try {
        await competitorService.findCompetitors(location.id);
        await new Promise(r => setTimeout(r, 1000)); // Rate limit Google Places API
      } catch (error) {
        logger.error(`Competitor snapshot failed for ${location.business_name}:`, error.message);
      }
    }
  } catch (error) {
    logger.error('snapshotAllCompetitors failed:', error.message);
  }
}
