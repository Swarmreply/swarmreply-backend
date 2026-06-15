// ============================================
// scheduler.competitors.js
// Reports › Competitors — automatic weekly re-scans.
//
// Mirrors the manual "Try scanning now" path (POST /api/reports/competitors/
// refresh): for every location that has OPTED IN (has at least one competitor
// snapshot) and whose most recent snapshot is 7+ days old, on an active
// account, re-run findCompetitors and write a fresh daily snapshot.
//
// First scans stay on-demand — a location that has never scanned is never
// auto-scanned, so we never spend Places API budget on customers who haven't
// pressed the button.
//
// Wired in from scheduler.js:
//   const { runDueCompetitorScans } = require('./scheduler.competitors');
//   cron.schedule('0 4 * * 1', () => runDueCompetitorScans());
// ============================================

const { query } = require('./database/db');
const { findCompetitors } = require('./services/competitorService');
const logger = require('./utils/logger');
const { captureError } = require('./utils/sentry');

const GAP_MS = 8000; // pause between locations to respect Places rate limits
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runDueCompetitorScans() {
  let due = 0, scanned = 0, failed = 0;

  if (!process.env.GOOGLE_PLACES_API_KEY) {
    logger.info('Competitor scheduler: GOOGLE_PLACES_API_KEY not set — skipping');
    return { due, scanned, failed, skipped: true };
  }

  try {
    // Locations that have scanned before and are now 7+ days stale.
    const dueRes = await query(
      `SELECT cs.location_id
         FROM competitor_snapshots cs
         JOIN locations l ON l.id = cs.location_id
         JOIN customers c ON c.id = l.customer_id
        WHERE l.is_active = true
          AND c.status IN ('active', 'cancelling')
          AND c.ai_scans_enabled IS NOT FALSE
        GROUP BY cs.location_id
       HAVING MAX(cs.snapshot_date) <= CURRENT_DATE - 7`
    );
    due = dueRes.rows.length;

    for (const row of dueRes.rows) {
      try {
        await findCompetitors(row.location_id);
        scanned++;
      } catch (e) {
        failed++;
        logger.warn('Competitor re-scan failed for ' + row.location_id + ': ' + e.message);
      }
      await sleep(GAP_MS);
    }

    logger.info(`Competitor scheduler: ${due} due, ${scanned} scanned, ${failed} failed`);
  } catch (e) {
    logger.error('Competitor scheduler error: ' + e.message);
    captureError(e, { job: 'competitor-weekly-scan' });
  }

  return { due, scanned, failed };
}

module.exports = { runDueCompetitorScans };
