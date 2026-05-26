// ============================================
// scheduler.llm.js
// LLM Reputation Monitor — scheduled scans
//
// Runs nightly. Finds all locations where
// next_scan_at <= NOW() and triggers a scan.
//
// Merge into scheduler.js:
//   const { startLLMScheduler } = require('./scheduler.llm');
//   startLLMScheduler();
// ============================================

const cron = require('node-cron');
const llm  = require('./services/llmMonitorService');
const logger = require('./utils/logger');

async function runScheduledScans() {
  try {
    const locationIds = await llm.getLocationsForScan();
    if (!locationIds.length) return;

    logger.info(`[LLM Scheduler] Running scans for ${locationIds.length} location(s)`);

    // Run sequentially to avoid hammering external APIs
    for (const locationId of locationIds) {
      try {
        const result = await llm.runScan(locationId);
        logger.info(`[LLM Scheduler] ${locationId}: score=${result.visibilityScore}`);
        // Wait 30s between locations to respect rate limits
        await new Promise(r => setTimeout(r, 30000));
      } catch (err) {
        logger.error(`[LLM Scheduler] Scan failed for ${locationId}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error('[LLM Scheduler] Fatal error:', err.message);
  }
}

function startLLMScheduler() {
  // Run at 3am daily — quiet time, minimal API cost impact
  cron.schedule('0 3 * * *', () => {
    logger.info('[LLM Scheduler] Starting nightly LLM scan');
    runScheduledScans();
  });

  logger.info('[LLM Scheduler] Started — nightly scans at 3am');
}

module.exports = { startLLMScheduler, runScheduledScans };
