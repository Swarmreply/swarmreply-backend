// ============================================
// routes/onboarding.js
// Onboarding wizard state API
//
// GET  /api/onboarding/status         Current step + completion flags
// POST /api/onboarding/step/:step     Mark a step complete
// POST /api/onboarding/complete       Mark entire onboarding done
// POST /api/onboarding/skip           Skip onboarding (not recommended)
// ============================================

const express = require('express');
const router  = express.Router();
const { query } = require('../database/db');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

// Map step numbers to DB column names
const STEP_COLUMNS = {
  1: 'ob_business_created',
  2: 'ob_google_connected',
  3: 'ob_tone_configured',
  4: 'ob_review_request_sent',
  5: 'ob_survey_configured'
};

const STEP_LABELS = {
  1: 'Add your business',
  2: 'Connect Google Business Profile',
  3: 'Set your AI tone',
  4: 'Send your first review request',
  5: 'Set up your NPS survey'
};

// ── GET /api/onboarding/status ────────────────────────────────────────────────
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT
         onboarding_step, onboarding_completed,
         onboarding_started_at, onboarding_completed_at,
         ob_business_created, ob_google_connected,
         ob_tone_configured, ob_review_request_sent,
         ob_survey_configured
       FROM customers WHERE id = $1`,
      [req.user.customerId]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Customer not found' });
    const c = result.rows[0];

    // Build steps array with completion state
    const steps = Object.entries(STEP_COLUMNS).map(([num, col]) => ({
      step:      parseInt(num),
      label:     STEP_LABELS[num],
      completed: !!c[col],
      column:    col
    }));

    // Find the first incomplete step
    const currentStep = steps.find(s => !s.completed)?.step || 6; // 6 = all done

    const completedCount = steps.filter(s => s.completed).length;
    const progressPct    = Math.round((completedCount / steps.length) * 100);

    res.json({
      success: true,
      onboarding: {
        completed:     c.onboarding_completed,
        currentStep,
        progressPct,
        completedCount,
        totalSteps:    steps.length,
        startedAt:     c.onboarding_started_at,
        completedAt:   c.onboarding_completed_at,
        steps
      }
    });
  } catch (err) {
    logger.error('Onboarding status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/onboarding/step/:step ──────────────────────────────────────────
// Mark a specific step as complete
router.post('/step/:step', authenticateToken, async (req, res) => {
  try {
    const stepNum = parseInt(req.params.step);
    const col     = STEP_COLUMNS[stepNum];

    if (!col) return res.status(400).json({ error: `Invalid step: ${stepNum}` });

    // Mark step complete + update current step pointer
    await query(
      `UPDATE customers
       SET ${col}           = true,
           onboarding_step  = GREATEST(onboarding_step, $2),
           onboarding_started_at = COALESCE(onboarding_started_at, NOW()),
           updated_at       = NOW()
       WHERE id = $1`,
      [req.user.customerId, stepNum]
    );

    // Check if all steps are now complete
    const check = await query(
      `SELECT ob_business_created, ob_google_connected, ob_tone_configured,
              ob_review_request_sent, ob_survey_configured
       FROM customers WHERE id = $1`,
      [req.user.customerId]
    );

    const all = check.rows[0];
    const allDone = all.ob_business_created && all.ob_google_connected &&
                    all.ob_tone_configured   && all.ob_review_request_sent &&
                    all.ob_survey_configured;

    if (allDone) {
      await query(
        `UPDATE customers
         SET onboarding_completed    = true,
             onboarding_completed_at = NOW()
         WHERE id = $1`,
        [req.user.customerId]
      );
    }

    logger.info(`Onboarding step ${stepNum} completed for customer ${req.user.customerId}`);
    res.json({ success: true, step: stepNum, allDone });
  } catch (err) {
    logger.error('Onboarding step error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/onboarding/complete ────────────────────────────────────────────
// Force-complete onboarding (e.g. customer skips remaining steps)
router.post('/complete', authenticateToken, async (req, res) => {
  try {
    await query(
      `UPDATE customers
       SET onboarding_completed    = true,
           onboarding_completed_at = NOW(),
           ob_business_created     = true,
           ob_google_connected     = true,
           ob_tone_configured      = true,
           ob_review_request_sent  = true,
           ob_survey_configured    = true,
           updated_at              = NOW()
       WHERE id = $1`,
      [req.user.customerId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/onboarding/skip ────────────────────────────────────────────────
// Mark onboarding as skipped — hides the wizard
router.post('/skip', authenticateToken, async (req, res) => {
  try {
    await query(
      `UPDATE customers
       SET onboarding_completed = true, updated_at = NOW()
       WHERE id = $1`,
      [req.user.customerId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
