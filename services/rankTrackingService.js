// ============================================
// services/rankTrackingService.js
// Item 13 — Google search rank tracking
//
// Tracks where a business appears in Google search
// results for up to 15 keywords per location.
// Uses the DataForSEO SERP API (Google Organic, Live
// Advanced) — HTTP Basic auth with login + password.
//
// What we track per keyword per check:
//   - Organic position (rank_group, null = not found)
//   - Local pack position (1-N or null)
//   - Whether they appear in the map pack at all
// ============================================

const axios   = require('axios');
const { query } = require('../database/db');
const logger  = require('../utils/logger');

// DataForSEO Google Organic — Live Advanced (real-time, returns local pack too)
const DATAFORSEO_URL = 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced';
// Country-level context is always a valid location_name; geo intent comes from the
// keyword itself (e.g. "best dentist in Sacramento"). Override for finer targeting.
const DATAFORSEO_LOCATION = process.env.DATAFORSEO_LOCATION || 'United States';

const MAX_KEYWORDS  = 15;  // total keywords a location can track
const AUTO_KEYWORDS = 5;   // starter keywords seeded automatically

function hasCreds() {
  return !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}

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
  ].slice(0, AUTO_KEYWORDS);
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

// ── SEARCH ONE KEYWORD (DataForSEO Google Organic, Live Advanced) ─────────────
async function searchKeyword(businessName, keyword, city) {
  const nameNorm    = (businessName || '').toLowerCase().trim();
  const nameCompact = nameNorm.replace(/\s+/g, '');

  try {
    const res = await axios.post(
      DATAFORSEO_URL,
      [{
        keyword,
        location_name: DATAFORSEO_LOCATION,
        language_code: 'en',
        device:        'desktop',
        depth:         20,
      }],
      {
        auth: {
          username: process.env.DATAFORSEO_LOGIN,
          password: process.env.DATAFORSEO_PASSWORD,
        },
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );

    const task   = res.data?.tasks?.[0];
    if (task && task.status_code && task.status_code !== 20000) {
      logger.error(`DataForSEO task error for "${keyword}": ${task.status_message}`);
    }
    const result = task?.result?.[0];
    const items  = result?.items || [];

    let position     = null;   // organic rank_group (position among organic results)
    let inLocalPack  = false;
    let packPosition = null;
    let localCount   = 0;

    for (const it of items) {
      // Organic match — first organic result whose title/domain/url matches the business
      if (it.type === 'organic' && position === null) {
        const title  = (it.title  || '').toLowerCase();
        const domain = (it.domain || '').toLowerCase();
        const url    = (it.url    || '').toLowerCase();
        if (nameNorm && (title.includes(nameNorm) ||
            (nameCompact && (domain.includes(nameCompact) || url.includes(nameCompact))))) {
          position = it.rank_group || it.rank_absolute || null;
        }
      }
      // Local pack — count entries; record position of the first matching one
      if (it.type === 'local_pack') {
        localCount++;
        if (!inLocalPack) {
          const title = (it.title || '').toLowerCase();
          if (nameNorm && title.includes(nameNorm)) {
            inLocalPack  = true;
            packPosition = localCount;
          }
        }
      }
    }

    return {
      position,
      inLocalPack,
      packPosition,
      totalResults: result?.se_results_count || null,
    };
  } catch (err) {
    logger.error(`DataForSEO search error for "${keyword}": ${err.response?.data?.status_message || err.message}`);
    return { position: null, inLocalPack: false, packPosition: null, totalResults: null };
  }
}

// ── RUN WEEKLY RANK CHECK FOR A LOCATION ─────────────────────────────────────
async function runRankCheck(locationId) {
  if (!hasCreds()) {
    logger.error('Rank check: DataForSEO credentials not configured');
    return { error: 'no_credentials', message: 'Rank tracking is not configured (set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD).' };
  }
  try {
    const locRes = await query(
      'SELECT business_name, city FROM locations WHERE id = $1',
      [locationId]
    );
    const loc = locRes.rows[0];
    if (!loc) return { error: 'no_location' };

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
      // Light pacing between live SERP calls
      await new Promise(r => setTimeout(r, 500));

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
    return { checked: keywords.length };
  } catch (err) {
    logger.error(`Rank check error for ${locationId}:`, err.message);
    return { error: err.message };
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
