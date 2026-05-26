// ============================================
// services/rankTrackingService.js
// Item 13 — Google Business Profile rank tracking
//
// Tracks where a business appears in Google search
// results for up to 5 keywords per location.
// Uses the Serper.dev API (cheap, reliable, no
// Google approval needed — $50 covers 50k searches).
//
// What we track per keyword per week:
//   - Organic position (1-20, null = not found)
//   - Local pack position (1-3 or null)
//   - Whether they appear in the map pack at all
// ============================================

const axios   = require('axios');
const { query } = require('../database/db');
const logger  = require('../utils/logger');

const SERPER_API = 'https://google.serper.dev/search';
const MAX_KEYWORDS = 5;

// ── AUTO-GENERATE KEYWORDS ────────────────────────────────────────────────────
// When a customer connects GBP, we seed 5 keywords automatically
// based on their business name, type, and city.
function buildAutoKeywords(businessName, businessType, city, state) {
  const location = [city, state].filter(Boolean).join(', ');
  const type     = businessType?.toLowerCase() || 'business';

  return [
    `${businessName}`,                           // brand query
    `${businessName} ${city}`,                   // brand + city
    `best ${type} in ${city}`,                   // category query
    `${type} near ${city}`,                      // near me variant
    `${type} ${city}`,                           // simple category + city
  ].slice(0, MAX_KEYWORDS);
}

// ── SEED KEYWORDS FOR A LOCATION ─────────────────────────────────────────────
async function seedKeywords(locationId) {
  const locRes = await query(
    'SELECT business_name, business_type, city, state FROM locations WHERE id = $1',
    [locationId]
  );
  const loc = locRes.rows[0];
  if (!loc) return;

  const keywords = buildAutoKeywords(
    loc.business_name, loc.business_type, loc.city, loc.state
  );

  for (const keyword of keywords) {
    await query(
      `INSERT INTO rank_keywords (location_id, keyword, is_auto)
       VALUES ($1, $2, true)
       ON CONFLICT (location_id, keyword) DO NOTHING`,
      [locationId, keyword]
    );
  }

  logger.info(`Seeded ${keywords.length} rank keywords for location ${locationId}`);
}

// ── SEARCH ONE KEYWORD ────────────────────────────────────────────────────────
async function searchKeyword(businessName, keyword, city) {
  if (!process.env.SERPER_API_KEY) {
    // No API key — return mock data for demo/dev
    return {
      position:      Math.floor(Math.random() * 10) + 1,
      inLocalPack:   Math.random() > 0.5,
      packPosition:  Math.random() > 0.5 ? Math.ceil(Math.random() * 3) : null,
      totalResults:  Math.floor(Math.random() * 1000000) + 100000,
    };
  }

  try {
    const res = await axios.post(
      SERPER_API,
      { q: keyword, gl: 'us', hl: 'en', num: 20 },
      {
        headers: {
          'X-API-KEY':    process.env.SERPER_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    const data = res.data;
    const nameNorm = businessName.toLowerCase();

    // ── Check organic results ─────────────────────────────────────────────────
    let position = null;
    const organic = data.organic || [];
    for (let i = 0; i < organic.length; i++) {
      const title = (organic[i].title || '').toLowerCase();
      const link  = (organic[i].link  || '').toLowerCase();
      if (title.includes(nameNorm) || link.includes(nameNorm.replace(/\s+/g, ''))) {
        position = i + 1;
        break;
      }
    }

    // ── Check local pack (map results) ────────────────────────────────────────
    let inLocalPack  = false;
    let packPosition = null;
    const localPack  = data.places || data.localResults || [];
    for (let i = 0; i < localPack.length; i++) {
      const title = (localPack[i].title || localPack[i].name || '').toLowerCase();
      if (title.includes(nameNorm)) {
        inLocalPack  = true;
        packPosition = i + 1;
        break;
      }
    }

    return {
      position,
      inLocalPack,
      packPosition,
      totalResults: data.searchInformation?.totalResults || null,
    };
  } catch (err) {
    logger.error(`Serper search error for "${keyword}":`, err.message);
    return { position: null, inLocalPack: false, packPosition: null, totalResults: null };
  }
}

// ── RUN WEEKLY RANK CHECK FOR A LOCATION ─────────────────────────────────────
async function runRankCheck(locationId) {
  try {
    const locRes = await query(
      'SELECT business_name, city FROM locations WHERE id = $1',
      [locationId]
    );
    const loc = locRes.rows[0];
    if (!loc) return;

    const kwRes = await query(
      'SELECT id, keyword FROM rank_keywords WHERE location_id = $1 AND active = true',
      [locationId]
    );
    const keywords = kwRes.rows;
    if (!keywords.length) {
      await seedKeywords(locationId);
      return;
    }

    logger.info(`Running rank check for ${loc.business_name} (${keywords.length} keywords)`);

    for (const kw of keywords) {
      // Rate limit — 1 search per second to stay within Serper limits
      await new Promise(r => setTimeout(r, 1200));

      const result = await searchKeyword(loc.business_name, kw.keyword, loc.city);

      await query(
        `INSERT INTO rank_results
           (location_id, keyword_id, keyword, position, pack_position,
            in_local_pack, total_results, search_engine)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'google')`,
        [locationId, kw.id, kw.keyword,
         result.position, result.packPosition,
         result.inLocalPack, result.totalResults]
      );

      logger.info(
        `  "${kw.keyword}" → position: ${result.position ?? 'not found'} ` +
        `| pack: ${result.inLocalPack ? `#${result.packPosition}` : 'no'}`
      );
    }
  } catch (err) {
    logger.error(`Rank check error for ${locationId}:`, err.message);
  }
}

// ── GET RANK HISTORY FOR DASHBOARD ───────────────────────────────────────────
async function getRankHistory(locationId, days = 90) {
  // Get current keywords
  const kwRes = await query(
    'SELECT id, keyword, is_auto FROM rank_keywords WHERE location_id = $1 AND active = true ORDER BY is_auto DESC, created_at',
    [locationId]
  );

  // Get latest result per keyword
  const results = [];
  for (const kw of kwRes.rows) {
    const histRes = await query(
      `SELECT position, pack_position, in_local_pack, checked_at
       FROM rank_results
       WHERE keyword_id = $1
         AND checked_at > NOW() - INTERVAL '${days} days'
       ORDER BY checked_at DESC
       LIMIT 13`,  // ~13 weeks of weekly data
      [kw.id]
    );

    const history  = histRes.rows;
    const latest   = history[0];
    const previous = history[1];

    let trend = null;
    if (latest?.position && previous?.position) {
      const diff = previous.position - latest.position; // positive = improved
      trend = diff > 0 ? 'up' : diff < 0 ? 'down' : 'stable';
    }

    results.push({
      keyword:      kw.keyword,
      keywordId:    kw.id,
      isAuto:       kw.is_auto,
      position:     latest?.position     || null,
      packPosition: latest?.pack_position || null,
      inLocalPack:  latest?.in_local_pack || false,
      trend,
      trendDelta:   latest?.position && previous?.position
                      ? previous.position - latest.position : null,
      history:      history.map(h => ({
        position:     h.position,
        packPosition: h.pack_position,
        inLocalPack:  h.in_local_pack,
        date:         h.checked_at,
      })),
    });
  }

  return results;
}

// ── MANAGE KEYWORDS ───────────────────────────────────────────────────────────
async function addKeyword(locationId, keyword) {
  const existing = await query(
    'SELECT COUNT(*) FROM rank_keywords WHERE location_id = $1 AND active = true',
    [locationId]
  );
  if (parseInt(existing.rows[0].count) >= MAX_KEYWORDS) {
    throw new Error(`Maximum ${MAX_KEYWORDS} keywords per location`);
  }

  await query(
    `INSERT INTO rank_keywords (location_id, keyword, is_auto)
     VALUES ($1, $2, false)
     ON CONFLICT (location_id, keyword) DO UPDATE SET active = true`,
    [locationId, keyword.trim().slice(0, 100)]
  );
}

async function removeKeyword(locationId, keywordId) {
  await query(
    'UPDATE rank_keywords SET active = false WHERE id = $1 AND location_id = $2',
    [keywordId, locationId]
  );
}

module.exports = {
  seedKeywords, runRankCheck, getRankHistory,
  addKeyword, removeKeyword, buildAutoKeywords,
};
