// ============================================
// scheduler.llm.js
// AI Visibility — automatic weekly re-scans
//
// Mirrors the manual POST /api/llm/scan path: for every customer who is DUE
// (has scanned before, last scan was 7+ days ago, account still active) it
// re-runs the real scan via llmMonitorService.runRealScan and upserts the
// result into llm_reports — the same table/shape the dashboard reads.
//
// First scans stay on-demand (a customer who has never scanned is never
// auto-scanned, so we never spend on customers who haven't opted in).
//
// Wired in from scheduler.js:
//   const { runDueScans } = require('./scheduler.llm');
//   cron.schedule('0 3 * * *', () => runDueScans());
// ============================================

const { query } = require('./database/db');
const { runRealScan } = require('./services/llmMonitorService');
const logger = require('./utils/logger');

const SCAN_GAP_MS = 15000; // pause between customers to respect provider rate limits

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Find customers whose AI Visibility report is due for a refresh and re-scan them.
 * Returns a small summary { due, scanned, failed }.
 */
async function runDueScans() {
  let due = 0, scanned = 0, failed = 0;
  try {
    // Customers with an existing report older than 7 days, on an active account.
    const dueRes = await query(
      `SELECT r.customer_id, r.report_data, c.name AS customer_name
         FROM llm_reports r
         JOIN customers c ON c.id = r.customer_id
        WHERE r.last_scan_at IS NOT NULL
          AND r.last_scan_at <= NOW() - INTERVAL '7 days'
          AND c.status = 'active'`
    );
    due = dueRes.rows.length;
    if (!due) {
      logger.info('[LLM Scheduler] No customers due for an AI Visibility re-scan');
      return { due, scanned, failed };
    }

    logger.info(`[LLM Scheduler] ${due} customer(s) due for an AI Visibility re-scan`);

    for (const row of dueRes.rows) {
      const customerId = row.customer_id;
      try {
        // Business name: prefer the active location, fall back to the account name.
        let businessName = row.customer_name || 'Your Business';
        try {
          const locRes = await query(
            `SELECT business_name FROM locations
              WHERE customer_id=$1 AND is_active = true
              ORDER BY created_at ASC LIMIT 1`,
            [customerId]
          );
          if (locRes.rows[0]?.business_name) businessName = locRes.rows[0].business_name;
        } catch (e) { /* fall back to account name */ }

        // Their saved custom queries (same as the manual scan).
        let customQueries = [];
        try {
          const qRes = await query(
            'SELECT custom_queries FROM llm_settings WHERE customer_id=$1',
            [customerId]
          );
          customQueries = qRes.rows[0]?.custom_queries || [];
        } catch (e) { /* none saved — runRealScan builds defaults */ }

        const prevScore = (row.report_data && typeof row.report_data.overallScore === 'number')
          ? row.report_data.overallScore
          : null;

        const reportData = await runRealScan({ businessName, customQueries, prevScore });

        if (reportData.error) {
          // Leave the previous report intact rather than overwriting with nothing.
          logger.error(`[LLM Scheduler] ${customerId}: scan skipped (${reportData.error})`);
          failed++;
        } else {
          const now      = new Date(reportData.lastScanAt);
          const nextScan = new Date(reportData.nextScanAt);
          await query(
            `INSERT INTO llm_reports (customer_id, report_data, next_scan_at, last_scan_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (customer_id)
             DO UPDATE SET report_data = $2, next_scan_at = $3, last_scan_at = $4`,
            [customerId, JSON.stringify(reportData), nextScan.toISOString(), now.toISOString()]
          );
          logger.info(`[LLM Scheduler] ${customerId}: re-scan complete (score=${reportData.overallScore})`);
          scanned++;
        }
      } catch (err) {
        logger.error(`[LLM Scheduler] ${customerId}: re-scan failed — ${err.message}`);
        failed++;
      }

      await sleep(SCAN_GAP_MS); // pace the external API calls
    }

    logger.info(`[LLM Scheduler] Done — ${scanned} scanned, ${failed} failed, of ${due} due`);
  } catch (err) {
    logger.error('[LLM Scheduler] Fatal error:', err.message);
  }
  return { due, scanned, failed };
}

module.exports = { runDueScans };
