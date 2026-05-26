// ============================================
// routes/sender.js
// Merge these into backend/routes/index.js
// Review request sending endpoints
// ============================================

const reviewRequestSender = require('../services/reviewRequestSender');

// POST /api/send/single/:locationId
// Send review request to one contact
router.post('/send/single/:locationId', async (req, res) => {
  const { templateId, contact } = req.body;

  if (!templateId || !contact?.name || (!contact?.email && !contact?.phone)) {
    return res.status(400).json({ error: 'templateId, contact.name, and contact email or phone are required' });
  }

  try {
    // Get location
    const locResult = await query(
      'SELECT * FROM locations WHERE id = $1',
      [req.params.locationId]
    );
    if (!locResult.rows.length) {
      return res.status(404).json({ error: 'Location not found' });
    }

    const result = await reviewRequestSender.sendReviewRequest({
      templateId,
      contact,
      location: locResult.rows[0],
      customerId: req.body.customerId
    });

    if (result.success) {
      res.json({ success: true, messageId: result.messageId });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (error) {
    logger.error('Send single error:', error.message);
    res.status(500).json({ error: 'Send failed' });
  }
});

// POST /api/send/bulk/:locationId
// Send review requests to multiple contacts
router.post('/send/bulk/:locationId', async (req, res) => {
  const { templateId, contacts } = req.body;

  if (!templateId || !contacts || !Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: 'templateId and contacts array are required' });
  }

  if (contacts.length > 100) {
    return res.status(400).json({ error: 'Maximum 100 contacts per bulk send' });
  }

  try {
    const locResult = await query(
      'SELECT * FROM locations WHERE id = $1',
      [req.params.locationId]
    );
    if (!locResult.rows.length) {
      return res.status(404).json({ error: 'Location not found' });
    }

    const results = await reviewRequestSender.sendBulk(
      contacts, templateId, locResult.rows[0], req.body.customerId
    );

    res.json(results);
  } catch (error) {
    logger.error('Bulk send error:', error.message);
    res.status(500).json({ error: 'Bulk send failed' });
  }
});

// GET /api/send/history/:locationId
// Get send history for a location
router.get('/send/history/:locationId', async (req, res) => {
  try {
    const history = await reviewRequestSender.getSendHistory(
      req.params.locationId,
      parseInt(req.query.limit) || 50
    );
    res.json({ history });
  } catch (error) {
    logger.error('Send history error:', error.message);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// GET /api/send/stats/:locationId
// Get today's send stats and remaining limit
router.get('/send/stats/:locationId', async (req, res) => {
  try {
    const stats = await reviewRequestSender.getDailyStats(req.params.locationId);
    res.json({ stats });
  } catch (error) {
    logger.error('Send stats error:', error.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});
