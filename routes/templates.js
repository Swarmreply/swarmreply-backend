// ============================================
// routes/templates.js
// Merge these routes into backend/routes/index.js
// ============================================

const reviewRequestService = require('../services/reviewRequestService');

// GET /api/templates/:locationId
// Get all templates for a location
router.get('/templates/:locationId', async (req, res) => {
  try {
    const templates = await reviewRequestService.getTemplates(req.params.locationId);
    res.json({ templates });
  } catch (error) {
    logger.error('Get templates error:', error.message);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

// POST /api/templates/:locationId
// Create a new custom template
router.post('/templates/:locationId', async (req, res) => {
  const { name, channel, subject, body } = req.body;

  if (!name || !channel || !body) {
    return res.status(400).json({ error: 'name, channel, and body are required' });
  }

  try {
    const template = await reviewRequestService.createTemplate({
      locationId: req.params.locationId,
      name, channel, subject, body,
      isDefault: false
    });
    res.status(201).json({ template });
  } catch (error) {
    logger.error('Create template error:', error.message);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// PUT /api/templates/:templateId
// Update a template
router.put('/templates/:templateId', async (req, res) => {
  try {
    const template = await reviewRequestService.updateTemplate(
      req.params.templateId, req.body
    );
    res.json({ template });
  } catch (error) {
    logger.error('Update template error:', error.message);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

// DELETE /api/templates/:templateId
// Delete a custom template
router.delete('/templates/:templateId', async (req, res) => {
  try {
    await reviewRequestService.deleteTemplate(req.params.templateId);
    res.json({ success: true });
  } catch (error) {
    logger.error('Delete template error:', error.message);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// POST /api/templates/:locationId/generate
// AI-generate a custom template
router.post('/templates/:locationId/generate', async (req, res) => {
  const { channel, tone, instructions, businessType } = req.body;

  if (!channel) {
    return res.status(400).json({ error: 'channel is required' });
  }

  try {
    // Get location details
    const locResult = await query(
      'SELECT * FROM locations WHERE id = $1',
      [req.params.locationId]
    );
    if (!locResult.rows.length) {
      return res.status(404).json({ error: 'Location not found' });
    }
    const location = locResult.rows[0];

    const generated = await reviewRequestService.generateCustomTemplate({
      businessName: location.business_name,
      businessType: businessType || location.business_type,
      ownerName: location.owner_name,
      tone: tone || location.tone || 'warm',
      channel,
      instructions
    });

    res.json({ generated });
  } catch (error) {
    logger.error('Generate template error:', error.message);
    res.status(500).json({ error: 'Failed to generate template' });
  }
});

// POST /api/templates/:templateId/preview
// Preview a template with sample data
router.post('/templates/:templateId/preview', async (req, res) => {
  try {
    // Get template
    const tResult = await query(
      'SELECT * FROM review_request_templates WHERE id = $1',
      [req.params.templateId]
    );
    if (!tResult.rows.length) {
      return res.status(404).json({ error: 'Template not found' });
    }
    const template = tResult.rows[0];

    // Get location
    const lResult = await query(
      'SELECT * FROM locations WHERE id = $1',
      [template.location_id]
    );
    const location = lResult.rows[0] || {};

    const preview = reviewRequestService.previewTemplate(
      template.body, template.subject, location
    );

    res.json({ preview });
  } catch (error) {
    logger.error('Preview template error:', error.message);
    res.status(500).json({ error: 'Failed to preview template' });
  }
});

// POST /api/templates/:templateId/track
// Track that a template was sent
router.post('/templates/:templateId/track', async (req, res) => {
  try {
    await reviewRequestService.trackSend(req.params.templateId);
    res.json({ success: true });
  } catch (error) {
    logger.error('Track template send error:', error.message);
    res.status(500).json({ error: 'Failed to track send' });
  }
});

// POST /api/templates/:locationId/seed
// Seed default templates for a new location
router.post('/templates/:locationId/seed', async (req, res) => {
  try {
    const locResult = await query(
      'SELECT * FROM locations WHERE id = $1',
      [req.params.locationId]
    );
    if (!locResult.rows.length) {
      return res.status(404).json({ error: 'Location not found' });
    }
    await reviewRequestService.seedDefaultTemplates(
      req.params.locationId, locResult.rows[0]
    );
    res.json({ success: true });
  } catch (error) {
    logger.error('Seed templates error:', error.message);
    res.status(500).json({ error: 'Failed to seed templates' });
  }
});
