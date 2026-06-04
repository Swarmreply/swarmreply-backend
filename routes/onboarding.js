// ============================================
// routes/onboarding.js
// Onboarding wizard state API (data-driven — see services/onboardingService.js)
//
// GET  /api/onboarding/status          Steps + completion + score + milestones
// POST /api/onboarding/step/:id/complete   Mark a flag-based step complete
// POST /api/onboarding/dismiss         Hide the dashboard setup card ("finish later")
// POST /api/onboarding/start           Record that the wizard was opened
// ============================================

const express = require('express');
const router  = express.Router();
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const onboarding = require('../services/onboardingService');

// ── GET /api/onboarding/status ──────────────────────────────────────────────
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    const status = await onboarding.computeStatus(customerId);
    res.json(status);
  } catch (err) {
    logger.error('Onboarding status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/onboarding/step/:id/complete ──────────────────────────────────
// For flag-based steps (no derivable signal). Derived steps recompute from real
// data on the next status call regardless, so this is a no-harm record.
router.post('/step/:id/complete', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    await onboarding.markStep(customerId, req.params.id, req.body?.value !== false);
    const status = await onboarding.computeStatus(customerId);
    res.json(status);
  } catch (err) {
    logger.error('Onboarding step error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/onboarding/dismiss ────────────────────────────────────────────
// Non-blocking model: the customer can hide the setup card and finish later.
router.post('/dismiss', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    await onboarding.setStateField(customerId, 'dismissed', req.body?.dismissed !== false);
    res.json({ success: true });
  } catch (err) {
    logger.error('Onboarding dismiss error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/onboarding/start ──────────────────────────────────────────────
router.post('/start', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.customerId || req.user.id;
    await onboarding.setStateField(customerId, 'started_at', new Date().toISOString());
    res.json({ success: true });
  } catch (err) {
    logger.error('Onboarding start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
