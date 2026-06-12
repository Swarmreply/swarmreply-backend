// ============================================
// routes/approvals.js
// Item 12 — Review reply approval workflow
//
// When a location has approval_mode = 'approve':
//   - AI generates reply and saves with status='approved' (draft)
//   - Review status set to 'flagged' (needs human action)
//   - Human approves → reply posts to Google
//   - Human rejects → reply discarded, optional note saved
//   - Human edits → edited text posted
//
// GET  /api/approvals          — list pending approvals
// POST /api/approvals/:id/approve — approve + post to Google
// POST /api/approvals/:id/reject  — reject with optional note
// POST /api/approvals/:id/edit    — edit reply text then post
// GET  /api/approvals/settings    — get approval mode setting
// PUT  /api/approvals/settings    — toggle approval mode on/off
// ============================================

const express = require('express');
const router  = express.Router();
const { query }             = require('../database/db');
const { authenticateToken } = require('../middleware/auth');
const { requireRole }       = require('../middleware/auth');
const { auditLog }          = require('../middleware/audit');
const logger                = require('../utils/logger');

// Helper — get location for current user
async function getLocation(customerId) {
  const res = await query(
    'SELECT * FROM locations WHERE customer_id = $1 LIMIT 1',
    [customerId]
  );
  return res.rows[0];
}

// ── GET /api/approvals ────────────────────────────────────────────────────────
// Returns all replies pending approval — reviews with status='flagged'
// and a corresponding reply with status='approved' (draft)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const loc = await getLocation(req.user.customerId);
    if (!loc) return res.json({ approvals: [], pendingCount: 0 });

    const result = await query(
      `SELECT
         r.id          AS review_id,
         r.reviewer_name,
         r.star_rating,
         r.review_text,
         r.review_date,
         r.platform,
         r.platform_review_id AS google_review_id,
         rp.id         AS reply_id,
         rp.generated_reply AS reply_text,
         rp.created_at AS drafted_at
       FROM reviews r
       JOIN replies rp ON rp.review_id = r.id
       WHERE r.location_id = $1
         AND rp.status     = 'pending_approval'
       ORDER BY r.review_date DESC`,
      [loc.id]
    );

    res.json({
      success:      true,
      approvals:    result.rows,
      pendingCount: result.rows.length,
    });
  } catch (err) {
    logger.error('List approvals error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/approvals/:replyId/approve ──────────────────────────────────────
// Post the drafted reply to Google as-is
router.post('/:replyId/approve', authenticateToken, requireRole(['admin','manager']), async (req, res) => {
  try {
    const loc = await getLocation(req.user.customerId);
    if (!loc) return res.status(404).json({ error: 'Location not found' });

    // Get the reply + review
    const replyRes = await query(
      `SELECT rp.*, r.platform_review_id, r.id as rev_id
       FROM replies rp
       JOIN reviews r ON r.id = rp.review_id
       WHERE rp.id = $1 AND r.location_id = $2 AND rp.status = 'pending_approval'`,
      [req.params.replyId, loc.id]
    );

    if (!replyRes.rows[0]) {
      return res.status(404).json({ error: 'Reply not found or already processed' });
    }

    const reply = replyRes.rows[0];

    // Post to Google
    const googleService = require('../services/googleService');
    await googleService.postReplyToGoogle(loc.id, reply.platform_review_id, reply.generated_reply);

    // Update statuses
    await query(
      `UPDATE replies SET status = 'posted', posted_reply = generated_reply,
         posted_at = NOW(), approved_by = $2,
         approved_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [reply.id, req.user.memberId || null]
    );
    await query(
      `UPDATE reviews SET status = 'replied', updated_at = NOW() WHERE id = $1`,
      [reply.rev_id]
    );

    await auditLog(req, 'reply.approved', { replyId: reply.id, reviewId: reply.rev_id });
    logger.info(`Reply approved + posted: ${reply.id}`);
    res.json({ success: true, message: 'Reply posted to Google' });
  } catch (err) {
    logger.error('Approve reply error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/approvals/:replyId/edit ─────────────────────────────────────────
// Edit the reply text then post to Google
router.post('/:replyId/edit', authenticateToken, requireRole(['admin','manager']), async (req, res) => {
  const { replyText } = req.body;
  if (!replyText?.trim()) return res.status(400).json({ error: 'replyText is required' });
  if (replyText.length > 4096) return res.status(400).json({ error: 'Reply too long (max 4096 chars)' });

  try {
    const loc = await getLocation(req.user.customerId);
    if (!loc) return res.status(404).json({ error: 'Location not found' });

    const replyRes = await query(
      `SELECT rp.*, r.platform_review_id, r.id as rev_id
       FROM replies rp
       JOIN reviews r ON r.id = rp.review_id
       WHERE rp.id = $1 AND r.location_id = $2 AND rp.status = 'pending_approval'`,
      [req.params.replyId, loc.id]
    );

    if (!replyRes.rows[0]) {
      return res.status(404).json({ error: 'Reply not found or already processed' });
    }

    const reply = replyRes.rows[0];

    // Post edited text to Google
    const googleService = require('../services/googleService');
    await googleService.postReplyToGoogle(loc.id, reply.platform_review_id, replyText.trim());

    // Save edited text + mark posted (generated_reply keeps the AI draft for history)
    await query(
      `UPDATE replies SET posted_reply = $2, status = 'posted',
         posted_at = NOW(), approved_by = $3, approved_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [reply.id, replyText.trim(), req.user.memberId || null]
    );
    await query(
      `UPDATE reviews SET status = 'replied', updated_at = NOW() WHERE id = $1`,
      [reply.rev_id]
    );

    await auditLog(req, 'reply.edited_and_approved', { replyId: reply.id });
    res.json({ success: true, message: 'Edited reply posted to Google' });
  } catch (err) {
    logger.error('Edit reply error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/approvals/:replyId/reject ───────────────────────────────────────
// Discard the reply — review goes back to pending or skipped
router.post('/:replyId/reject', authenticateToken, requireRole(['admin','manager']), async (req, res) => {
  const { note } = req.body; // optional rejection note

  try {
    const loc = await getLocation(req.user.customerId);
    if (!loc) return res.status(404).json({ error: 'Location not found' });

    const replyRes = await query(
      `SELECT rp.*, r.id as rev_id
       FROM replies rp
       JOIN reviews r ON r.id = rp.review_id
       WHERE rp.id = $1 AND r.location_id = $2 AND rp.status = 'pending_approval'`,
      [req.params.replyId, loc.id]
    );

    if (!replyRes.rows[0]) {
      return res.status(404).json({ error: 'Reply not found or already processed' });
    }

    const reply = replyRes.rows[0];

    await query(
      `UPDATE replies SET status = 'rejected', rejected_at = NOW(),
         rejection_note = $2, updated_at = NOW() WHERE id = $1`,
      [reply.id, note || null]
    );
    // Put review back to pending so AI can retry or it can be skipped manually
    await query(
      `UPDATE reviews SET status = 'pending', updated_at = NOW() WHERE id = $1`,
      [reply.rev_id]
    );

    await auditLog(req, 'reply.rejected', { replyId: reply.id, note });
    res.json({ success: true, message: 'Reply rejected' });
  } catch (err) {
    logger.error('Reject reply error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/approvals/settings ───────────────────────────────────────────────
router.get('/settings', authenticateToken, async (req, res) => {
  try {
    const loc = await getLocation(req.user.customerId);
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    res.json({
      success:      true,
      approvalMode: loc.approval_mode || 'auto',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/approvals/settings ───────────────────────────────────────────────
router.put('/settings', authenticateToken, requireRole(['admin','manager']), async (req, res) => {
  const { approvalMode } = req.body;
  if (!['auto','approve'].includes(approvalMode)) {
    return res.status(400).json({ error: 'approvalMode must be auto or approve' });
  }

  try {
    const loc = await getLocation(req.user.customerId);
    if (!loc) return res.status(404).json({ error: 'Location not found' });

    await query(
      `UPDATE locations SET approval_mode = $2, updated_at = NOW() WHERE id = $1`,
      [loc.id, approvalMode]
    );

    await auditLog(req, 'settings.approval_mode', { mode: approvalMode });
    res.json({ success: true, approvalMode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
