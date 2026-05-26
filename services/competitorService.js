// ============================================
// services/competitorService.js
// Competitor Review Benchmarking
// Pulls nearby competitor ratings from Google
// Places API and compares vs customer's business
// Growth & Agency plans only
// ============================================

const { query } = require('../database/db');
const logger = require('../utils/logger');

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

// ============================================
// FIND & STORE COMPETITORS
// ============================================

/**
 * findCompetitors()
 * Search Google Places for nearby businesses
 * of the same type as the customer's location
 *
 * @param {string} locationId - Our internal location ID
 * @param {number} radiusMeters - Search radius (default 1500m ~1 mile)
 * @returns {Array} Array of competitor objects
 */
async function findCompetitors(locationId, radiusMeters = 1500) {
  try {
    // Get location details including business coordinates
    const locResult = await query(
      'SELECT * FROM locations WHERE id = $1',
      [locationId]
    );
    if (!locResult.rows.length) throw new Error('Location not found');
    const location = locResult.rows[0];

    if (!location.latitude || !location.longitude) {
      throw new Error('Location missing coordinates — update location with lat/lng first');
    }

    // Map business type to Google Places type
    const placeType = mapBusinessTypeToPlaceType(location.business_type);

    // Search Google Places for nearby competitors
    const searchUrl = `${PLACES_BASE}/nearbysearch/json?` +
      `location=${location.latitude},${location.longitude}` +
      `&radius=${radiusMeters}` +
      `&type=${placeType}` +
      `&key=${GOOGLE_PLACES_API_KEY}`;

    const response = await fetchWithRetry(searchUrl);
    const data = await response.json();

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new Error(`Google Places API error: ${data.status} — ${data.error_message || ''}`);
    }

    const places = (data.results || [])
      // Exclude the customer's own business
      .filter(p => p.place_id !== location.google_place_id)
      // Only include businesses with reviews
      .filter(p => p.user_ratings_total > 0)
      // Take top 5 competitors
      .slice(0, 5);

    const competitors = places.map(p => ({
      placeId: p.place_id,
      name: p.name,
      rating: p.rating,
      reviewCount: p.user_ratings_total,
      address: p.vicinity,
      businessType: location.business_type
    }));

    // Store competitors in DB
    for (const comp of competitors) {
      await query(
        `INSERT INTO competitor_snapshots
         (location_id, competitor_place_id, competitor_name, rating, review_count, address, snapshot_date)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE)
         ON CONFLICT (location_id, competitor_place_id, snapshot_date)
         DO UPDATE SET rating = EXCLUDED.rating, review_count = EXCLUDED.review_count`,
        [locationId, comp.placeId, comp.name, comp.rating, comp.reviewCount, comp.address]
      );
    }

    logger.info(`Found ${competitors.length} competitors for location ${locationId}`);
    return competitors;

  } catch (error) {
    logger.error(`findCompetitors failed for ${locationId}:`, error.message);
    throw error;
  }
}

/**
 * getCompetitorBenchmark()
 * Get full benchmark comparison for dashboard
 * Returns customer vs competitors side by side
 *
 * @param {string} locationId
 * @returns {Object} Benchmark data
 */
async function getCompetitorBenchmark(locationId) {
  try {
    // Get our location's stats
    const locResult = await query(
      `SELECT l.*,
         ROUND(AVG(rv.star_rating)::numeric, 1) as avg_rating,
         COUNT(rv.id) as total_reviews,
         COUNT(rv.id) FILTER (WHERE rv.created_at >= NOW() - INTERVAL '30 days') as reviews_this_month
       FROM locations l
       LEFT JOIN reviews rv ON l.id = rv.location_id
       WHERE l.id = $1
       GROUP BY l.id`,
      [locationId]
    );
    if (!locResult.rows.length) throw new Error('Location not found');
    const ours = locResult.rows[0];

    // Get latest competitor snapshots
    const compResult = await query(
      `SELECT DISTINCT ON (competitor_place_id)
         competitor_name, rating, review_count, address, snapshot_date
       FROM competitor_snapshots
       WHERE location_id = $1
       ORDER BY competitor_place_id, snapshot_date DESC`,
      [locationId]
    );
    const competitors = compResult.rows;

    if (competitors.length === 0) {
      return { hasData: false, message: 'No competitor data yet — click Refresh to fetch nearby businesses' };
    }

    // Calculate rankings
    const allRatings = [
      { name: ours.business_name, rating: parseFloat(ours.avg_rating || 0), isUs: true },
      ...competitors.map(c => ({ name: c.competitor_name, rating: parseFloat(c.rating), isUs: false }))
    ].sort((a, b) => b.rating - a.rating);

    const ourRank = allRatings.findIndex(r => r.isUs) + 1;
    const avgCompetitorRating = competitors.reduce((sum, c) => sum + parseFloat(c.rating), 0) / competitors.length;
    const ratingDiff = parseFloat(ours.avg_rating || 0) - avgCompetitorRating;

    // Trend — compare our rating this month vs last month
    const lastMonthResult = await query(
      `SELECT ROUND(AVG(star_rating)::numeric, 1) as avg_rating
       FROM reviews
       WHERE location_id = $1
       AND created_at >= NOW() - INTERVAL '60 days'
       AND created_at < NOW() - INTERVAL '30 days'`,
      [locationId]
    );
    const lastMonthRating = parseFloat(lastMonthResult.rows[0]?.avg_rating || 0);
    const ratingTrend = parseFloat(ours.avg_rating || 0) - lastMonthRating;

    return {
      hasData: true,
      ours: {
        name: ours.business_name,
        rating: parseFloat(ours.avg_rating || 0),
        totalReviews: parseInt(ours.total_reviews || 0),
        reviewsThisMonth: parseInt(ours.reviews_this_month || 0),
        rank: ourRank,
        total: allRatings.length
      },
      competitors: competitors.map(c => ({
        name: c.competitor_name,
        rating: parseFloat(c.rating),
        reviewCount: parseInt(c.review_count),
        address: c.address
      })),
      rankings: allRatings,
      avgCompetitorRating: parseFloat(avgCompetitorRating.toFixed(1)),
      ratingDiff: parseFloat(ratingDiff.toFixed(1)),
      ratingTrend: parseFloat(ratingTrend.toFixed(1)),
      lastUpdated: compResult.rows[0]?.snapshot_date
    };

  } catch (error) {
    logger.error(`getCompetitorBenchmark failed for ${locationId}:`, error.message);
    throw error;
  }
}

// ============================================
// HELPERS
// ============================================

function mapBusinessTypeToPlaceType(businessType) {
  const map = {
    restaurant: 'restaurant',
    dental: 'dentist',
    medical: 'doctor',
    gym: 'gym',
    medspa: 'beauty_salon',
    salon: 'hair_care',
    auto: 'car_repair',
    hotel: 'lodging',
    bar: 'bar',
    cafe: 'cafe'
  };
  return map[businessType] || 'establishment';
}

async function fetchWithRetry(url, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (error) {
      if (attempt === maxRetries) throw error;
      await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }
}

module.exports = { findCompetitors, getCompetitorBenchmark };
