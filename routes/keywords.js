// ============================================
// routes/keywords.js
// Add these routes to backend/routes/index.js
// ============================================

// GET /api/keywords/:locationId?days=30&category=food
// Get full keyword analytics for a location
router.get('/keywords/:locationId', async (req, res) => {
  const { locationId } = req.params;
  const days = parseInt(req.query.days) || 30;
  const category = req.query.category || null;

  try {
    const keywordService = require('../services/keywordService');
    const data = await keywordService.getKeywordAnalytics(locationId, days, category);
    res.json(data);
  } catch (error) {
    logger.error('Get keywords error:', error.message);
    res.status(500).json({ error: 'Failed to fetch keyword data' });
  }
});

// GET /api/keywords/:locationId/search?q=pasta
// Search reviews by keyword
router.get('/keywords/:locationId/search', async (req, res) => {
  const { locationId } = req.params;
  const { q } = req.query;

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters' });
  }

  try {
    const keywordService = require('../services/keywordService');
    const reviews = await keywordService.searchKeyword(locationId, q);
    res.json({ reviews, keyword: q.toLowerCase().trim() });
  } catch (error) {
    logger.error('Keyword search error:', error.message);
    res.status(500).json({ error: 'Search failed' });
  }
});
