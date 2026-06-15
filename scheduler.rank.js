// ============================================
// scheduler.rank.js
// Rank Tracking — automatic weekly re-checks.
//
// Mirrors the manual "Run scan" path (POST /api/rank/check): for every active
// location that has OPTED IN (has run at least one rank check) and has active
// keywords, and whose most recent check is 7+ days old, re-run runRankCheck.
//
// First checks stay on-demand — a location that has never checked is never
// auto-checked, so we never spend DataForSEO budget on customers who haven't
// pressed the button.
//
// Wired in from scheduler.js:
//   const { runDueRankChecks } = require('./scheduler.rank');
//   cron.schedule('0 9 * * 1', () => runDueRankChecks());
// ============================================

const { query } = require('./database/db');
const { runRankCheck } = require('./services/rankTrackingService');
const logger = require('./utils/logger');
const { captureError } = require('./utils/sentry');

const GAP_MS = 5000; // pause between locations (runRankCheck already paces per keyword)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runDueRankChecks() {
  let due = 0, checked = 0, failed = 0;

  if (!process.env.DATAFORSEO_LOGIN || !process.env.DATAFORSEO_PASSWORD) {
    logger.info('Rank scheduler: DataForSEO credentials not set — skipping');
    return { due, checked, failed, skipped: true };
  }

  try {
    // Locations that have checked before, still have active keywords, on an
    // active account, and whose last check is now 7+ days old.
    const dueRes = await query(
      `SELECT rr.location_id
         FROM rank_results rr
         JOIN locations l ON l.id = rr.location_id
         JOIN customers c ON c.id = l.customer_id
        WHERE l.is_active = true
          AND c.status IN ('active', 'cancelling')
          AND c.rank_scans_enabled IS NOT FALSE
          AND EXISTS (
            SELECT 1 FROM rank_keywords k
             WHERE k.location_id = rr.location_id AND k.active = true
          )
        GROUP BY rr.location_id
       HAVING MAX(rr.checked_at) <= NOW() - INTERVAL '7 days'`
    );
    due = dueRes.rows.length;

    for (const row of dueRes.rows) {
      try {
        await runRankCheck(row.location_id);
        checked++;
      } catch (e) {
        failed++;
        logger.warn('Rank re-check failed for ' + row.location_id + ': ' + e.message);
      }
      await sleep(GAP_MS);
    }

    logger.info(`Rank scheduler: ${due} due, ${checked} checked, ${failed} failed`);
  } catch (e) {
    logger.error('Rank scheduler error: ' + e.message);
    captureError(e, { job: 'rank-weekly-check' });
  }

  return { due, checked, failed };
}

module.exports = { runDueRankChecks };
