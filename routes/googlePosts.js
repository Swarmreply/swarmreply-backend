// ============================================
// routes/googlePosts.js
// Merge into backend/routes/index.js
//
// All routes require authentication middleware
// already applied in routes/index.js
// ============================================

const googlePostsService = require('../services/googlePostsService');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

// GET /api/google-posts/:locationId/config
// Load or auto-create settings for a location
router.get('/google-posts/:locationId/config', requireAuth, async (req, res) => {
  try {
    const config = await googlePostsService.getConfig(req.params.locationId);
    res.json({ config });
  } catch (err) {
    logger.error('Get Google Posts config error:', err.message);
    res.status(500).json({ error: 'Failed to load configuration' });
  }
});

// PUT /api/google-posts/:locationId/config
// Update settings (toggle on/off, schedule, CTA, etc.)
router.put('/google-posts/:locationId/config', requireAuth, async (req, res) => {
  try {
    const updated = await googlePostsService.updateConfig(
      req.params.locationId,
      req.body
    );
    res.json({ config: updated });
  } catch (err) {
    logger.error('Update Google Posts config error:', err.message);
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

// ─── POST HISTORY ─────────────────────────────────────────────────────────────

// GET /api/google-posts/:locationId/history
// Full post history with source review info
router.get('/google-posts/:locationId/history', requireAuth, async (req, res) => {
  try {
    const posts = await googlePostsService.getPostHistory(
      req.params.locationId,
      parseInt(req.query.limit) || 20
    );
    res.json({ posts });
  } catch (err) {
    logger.error('Get Google Posts history error:', err.message);
    res.status(500).json({ error: 'Failed to load post history' });
  }
});

// ─── PREVIEW ──────────────────────────────────────────────────────────────────

// POST /api/google-posts/:locationId/preview
// Generate a preview post without publishing
// Called by "Generate preview" button in dashboard
router.post('/google-posts/:locationId/preview', requireAuth, async (req, res) => {
  try {
    const preview = await googlePostsService.generatePreview(req.params.locationId);
    res.json({ preview });
  } catch (err) {
    logger.error('Google Posts preview error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── MANUAL TRIGGER ───────────────────────────────────────────────────────────

// POST /api/google-posts/:locationId/publish-now
// Trigger an immediate post, bypassing the schedule
router.post('/google-posts/:locationId/publish-now', requireAuth, async (req, res) => {
  try {
    await googlePostsService.triggerManualPost(req.params.locationId);
    res.json({
      success: true,
      message: 'Post published to Google Business Profile'
    });
  } catch (err) {
    logger.error('Google Posts manual publish error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── APPROVAL FLOW ────────────────────────────────────────────────────────────

// POST /api/google-posts/posts/:postId/approve
// Publish a staged draft (when require_approval = true)
router.post('/google-posts/posts/:postId/approve', requireAuth, async (req, res) => {
  try {
    await googlePostsService.approvePost(req.params.postId);
    res.json({ success: true, message: 'Post approved and published to Google' });
  } catch (err) {
    logger.error('Google Posts approve error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/google-posts/posts/:postId/reject
// Reject a staged draft
router.post('/google-posts/posts/:postId/reject', requireAuth, async (req, res) => {
  try {
    await googlePostsService.rejectPost(req.params.postId, req.body.reason);
    res.json({ success: true, message: 'Post rejected' });
  } catch (err) {
    logger.error('Google Posts reject error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/google-posts/posts/:postId
// Delete a published post from Google + mark deleted in DB
router.delete('/google-posts/posts/:postId', requireAuth, async (req, res) => {
  try {
    await googlePostsService.deletePost(req.params.postId);
    res.json({ success: true, message: 'Post deleted from Google' });
  } catch (err) {
    logger.error('Google Posts delete error:', err.message);
    res.status(400).json({ error: err.message });
  }
});
