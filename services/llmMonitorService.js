// ============================================
// services/llmMonitorService.js
// LLM Reputation Monitoring
//
// Queries major AI models to discover what
// they say about a business when asked local
// discovery questions like:
//   "Best Italian restaurant in Sacramento"
//   "Who is the best dentist near [city]?"
//   "What do people say about [business name]?"
//
// Supported LLMs:
//   - Claude (Anthropic) — uses our existing key
//   - OpenAI (ChatGPT/GPT-4o) — needs OPENAI_API_KEY
//   - Google Gemini — needs GEMINI_API_KEY
//   - Perplexity — needs PERPLEXITY_API_KEY
//
// Architecture note:
//   We USE Claude to parse and score results
//   from ALL LLMs — not to generate the queries.
//   Claude acts as the intelligence layer that
//   reads each LLM's raw response and extracts:
//     - Was the business mentioned? Where?
//     - Sentiment of the mention
//     - Accuracy of info (name, address, hours)
//     - Which competitors were named
// ============================================

const Anthropic = require('@anthropic-ai/sdk');
const axios     = require('axios');
const { query } = require('../database/db');
const logger    = require('../utils/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── QUERY TEMPLATES ───────────────────────────────────────────────────────────
// These are the prompts we send to each LLM.
// Generated per business based on their name, type, and city.

function buildQueries(business) {
  const { business_name, business_type, city, state } = business;
  const location = [city, state].filter(Boolean).join(', ') || 'my area';
  const type = normaliseType(business_type);

  return [
    // Discovery queries — would the LLM recommend this business?
    `What are the best ${type}s in ${location}?`,
    `Recommend a good ${type} near ${location}`,
    `Who is the top-rated ${type} in ${location}?`,

    // Direct brand queries — does the LLM know this business?
    `Tell me about ${business_name} in ${location}`,
    `What do customers say about ${business_name}?`,
    `Is ${business_name} in ${location} good?`,

    // Comparison queries — does it come up vs competitors?
    `What is the best ${type} in ${location} and why?`,
    `Compare ${type}s in ${location}`
  ];
}

function normaliseType(businessType) {
  if (!businessType) return 'local business';
  const map = {
    restaurant: 'restaurant', food: 'restaurant', cafe: 'cafe',
    dental: 'dentist', dentist: 'dentist',
    medical: 'doctor', healthcare: 'medical clinic', clinic: 'clinic',
    salon: 'hair salon', beauty: 'beauty salon', spa: 'spa', medspa: 'med spa',
    auto: 'auto repair shop', automotive: 'auto shop', mechanic: 'mechanic',
    gym: 'gym', fitness: 'fitness studio',
    law: 'law firm', legal: 'law firm', attorney: 'attorney',
    home: 'home services company', plumbing: 'plumber', hvac: 'HVAC company',
    retail: 'store', boutique: 'boutique',
    hotel: 'hotel', resort: 'resort',
    vet: 'veterinarian', veterinary: 'vet clinic',
    agency: 'marketing agency'
  };
  const lower = businessType.toLowerCase();
  return map[lower] || businessType.toLowerCase();
}

// ── LLM QUERY FUNCTIONS ───────────────────────────────────────────────────────

async function queryClaudeAI(prompt) {
  const start = Date.now();
  try {
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }]
    });
    return {
      text:        response.content[0]?.text || '',
      response_ms: Date.now() - start,
      model:       'claude-sonnet-4-6',
      error:       null
    };
  } catch (err) {
    return { text: '', response_ms: Date.now() - start, model: 'claude-sonnet-4-6', error: err.message };
  }
}

async function queryOpenAI(prompt) {
  if (!process.env.OPENAI_API_KEY) return { text: '', error: 'OPENAI_API_KEY not configured', skipped: true };
  const start = Date.now();
  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model:    'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );
    return {
      text:        res.data.choices[0]?.message?.content || '',
      response_ms: Date.now() - start,
      model:       'gpt-4o',
      error:       null
    };
  } catch (err) {
    return { text: '', response_ms: Date.now() - start, model: 'gpt-4o', error: err.response?.data?.error?.message || err.message };
  }
}

async function queryGemini(prompt) {
  if (!process.env.GEMINI_API_KEY) return { text: '', error: 'GEMINI_API_KEY not configured', skipped: true };
  const start = Date.now();
  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] }
    );
    const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return { text, response_ms: Date.now() - start, model: 'gemini-1.5-pro', error: null };
  } catch (err) {
    return { text: '', response_ms: Date.now() - start, model: 'gemini-1.5-pro', error: err.response?.data?.error?.message || err.message };
  }
}

async function queryPerplexity(prompt) {
  if (!process.env.PERPLEXITY_API_KEY) return { text: '', error: 'PERPLEXITY_API_KEY not configured', skipped: true };
  const start = Date.now();
  try {
    const res = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model:    'llama-3.1-sonar-large-128k-online',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024
      },
      { headers: { Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}` } }
    );
    return {
      text:        res.data.choices[0]?.message?.content || '',
      response_ms: Date.now() - start,
      model:       'sonar-large-128k-online',
      error:       null
    };
  } catch (err) {
    return { text: '', response_ms: Date.now() - start, model: 'sonar-large', error: err.response?.data?.error?.message || err.message };
  }
}

// ── ANALYSIS — Claude reads each response ─────────────────────────────────────

async function analyseResponse(businessName, query, rawResponse) {
  if (!rawResponse?.trim()) {
    return { mentioned: false, sentiment: 'not_mentioned', mention_position: null,
             mention_context: null, competitors_named: [], has_accurate_info: null, inaccuracies: [] };
  }

  const prompt = `You are analysing an AI response to determine how a specific business is represented.

BUSINESS NAME: "${businessName}"
QUERY ASKED: "${query}"
AI RESPONSE:
"""
${rawResponse.substring(0, 2000)}
"""

Analyse this response and return a JSON object with exactly these fields:
{
  "mentioned": true/false,
  "mention_position": null or integer (1 = first business mentioned, 2 = second, etc.),
  "mention_context": null or string (the sentence or phrase that mentions the business — max 200 chars),
  "sentiment": "positive" or "neutral" or "negative" or "not_mentioned",
  "sentiment_reason": string (1 sentence explaining the sentiment score),
  "competitors_named": array of strings (other business names mentioned in the response),
  "has_accurate_info": null (if not mentioned) or true/false (does it have correct basic info?),
  "inaccuracies": array of strings (any wrong info found — e.g. wrong address, wrong hours)
}

Return ONLY the JSON object. No preamble, no explanation.`;

  try {
    const res = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 600,
      messages:   [{ role: 'user', content: prompt }]
    });

    const text = res.content[0]?.text?.trim() || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    logger.warn(`Analysis failed for "${businessName}": ${err.message}`);
    return {
      mentioned: rawResponse.toLowerCase().includes(businessName.toLowerCase()),
      sentiment: 'neutral',
      sentiment_reason: 'Analysis failed — manual review needed',
      mention_position: null, mention_context: null,
      competitors_named: [], has_accurate_info: null, inaccuracies: []
    };
  }
}

// ── MAIN SCAN ─────────────────────────────────────────────────────────────────

async function runScan(locationId) {
  // 1. Load business + config
  const bizResult = await query(
    `SELECT l.id, l.business_name, l.business_type, l.city, l.state,
            lmc.id AS config_id,
            lmc.monitor_chatgpt, lmc.monitor_gemini,
            lmc.monitor_claude, lmc.monitor_perplexity,
            lmc.custom_queries
     FROM locations l
     JOIN llm_monitor_configs lmc ON lmc.location_id = l.id
     WHERE l.id = $1 AND lmc.is_active = true`,
    [locationId]
  );

  if (!bizResult.rows[0]) throw new Error('Location or monitor config not found');
  const biz = bizResult.rows[0];

  // 2. Create run record
  const runResult = await query(
    `INSERT INTO llm_monitor_runs (location_id, config_id, status)
     VALUES ($1, $2, 'running') RETURNING id`,
    [locationId, biz.config_id]
  );
  const runId = runResult.rows[0].id;

  logger.info(`LLM scan started: ${biz.business_name} (run ${runId})`);

  try {
    // 3. Build queries
    const queries = [
      ...buildQueries(biz),
      ...(biz.custom_queries || [])
    ];

    // 4. Define which LLMs to query
    const llmFns = [];
    if (biz.monitor_claude)     llmFns.push({ name: 'claude',     fn: queryClaudeAI });
    if (biz.monitor_chatgpt)    llmFns.push({ name: 'chatgpt',    fn: queryOpenAI });
    if (biz.monitor_gemini)     llmFns.push({ name: 'gemini',     fn: queryGemini });
    if (biz.monitor_perplexity) llmFns.push({ name: 'perplexity', fn: queryPerplexity });

    let totalMentions = 0, totalPositive = 0, totalNegative = 0;
    let totalNeutral = 0, totalNotFound = 0, totalQueries = 0;

    // 5. Query each LLM for each query
    for (const q of queries) {
      for (const llm of llmFns) {
        try {
          const response = await llm.fn(q);
          if (response.skipped) continue;

          totalQueries++;

          // Analyse with Claude
          const analysis = await analyseResponse(biz.business_name, q, response.text);

          // Store result
          await query(
            `INSERT INTO llm_monitor_results
               (run_id, location_id, llm_name, llm_model, query_text,
                raw_response, response_ms, mentioned, mention_position,
                mention_context, sentiment, sentiment_reason,
                competitors_named, has_accurate_info, inaccuracies)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [
              runId, locationId, llm.name, response.model, q,
              response.text?.substring(0, 4000), response.response_ms,
              analysis.mentioned, analysis.mention_position,
              analysis.mention_context, analysis.sentiment || 'not_mentioned',
              analysis.sentiment_reason,
              analysis.competitors_named || [],
              analysis.has_accurate_info,
              analysis.inaccuracies || []
            ]
          );

          // Tally counts
          if (analysis.mentioned) {
            totalMentions++;
            if (analysis.sentiment === 'positive')  totalPositive++;
            if (analysis.sentiment === 'negative')  totalNegative++;
            if (analysis.sentiment === 'neutral')   totalNeutral++;
          } else {
            totalNotFound++;
          }

          // Small delay between calls
          await new Promise(r => setTimeout(r, 500));

        } catch (err) {
          logger.error(`LLM query error (${llm.name}): ${err.message}`);
        }
      }
    }

    // 6. Calculate visibility score (0–100)
    const visibilityScore = totalQueries > 0
      ? Math.round((totalMentions / totalQueries) * 100)
      : 0;

    // Get previous score for delta
    const prevRun = await query(
      `SELECT visibility_score FROM llm_monitor_runs
       WHERE location_id = $1 AND status = 'complete'
       ORDER BY completed_at DESC LIMIT 1`,
      [locationId]
    );
    const prevScore = prevRun.rows[0]?.visibility_score || null;

    // 7. Complete the run
    await query(
      `UPDATE llm_monitor_runs SET
         status = 'complete', completed_at = NOW(),
         total_queries = $2, total_mentions = $3,
         total_positive = $4, total_negative = $5,
         total_neutral = $6, total_not_found = $7,
         visibility_score = $8, prev_visibility = $9
       WHERE id = $1`,
      [runId, totalQueries, totalMentions, totalPositive,
       totalNegative, totalNeutral, totalNotFound, visibilityScore, prevScore]
    );

    // 8. Schedule next scan
    const freqMap = { daily: '1 day', weekly: '7 days', monthly: '30 days' };
    const freq = freqMap[biz.scan_frequency || 'weekly'] || '7 days';
    await query(
      `UPDATE llm_monitor_configs
       SET last_scan_at = NOW(),
           next_scan_at = NOW() + INTERVAL '${freq}'
       WHERE id = $1`,
      [biz.config_id]
    );

    logger.info(`LLM scan complete: ${biz.business_name} — score ${visibilityScore}/100`);
    return { runId, visibilityScore, totalMentions, totalQueries };

  } catch (err) {
    await query(
      `UPDATE llm_monitor_runs SET status = 'failed', error_msg = $2 WHERE id = $1`,
      [runId, err.message]
    );
    throw err;
  }
}

// ── DASHBOARD DATA ────────────────────────────────────────────────────────────

async function getLatestReport(locationId) {
  // Latest completed run
  const run = await query(
    `SELECT * FROM llm_monitor_runs
     WHERE location_id = $1 AND status = 'complete'
     ORDER BY completed_at DESC LIMIT 1`,
    [locationId]
  );
  if (!run.rows[0]) return null;

  const r = run.rows[0];

  // Results breakdown by LLM
  const byLLM = await query(
    `SELECT llm_name,
            COUNT(*) AS total_queries,
            COUNT(*) FILTER (WHERE mentioned) AS mentions,
            ROUND(AVG(CASE WHEN mentioned THEN 1.0 ELSE 0.0 END) * 100) AS visibility_pct,
            COUNT(*) FILTER (WHERE sentiment = 'positive') AS positive,
            COUNT(*) FILTER (WHERE sentiment = 'negative') AS negative
     FROM llm_monitor_results
     WHERE run_id = $1
     GROUP BY llm_name
     ORDER BY llm_name`,
    [r.id]
  );

  // Best and worst mentions
  const bestMentions = await query(
    `SELECT llm_name, query_text, mention_context, sentiment, competitors_named
     FROM llm_monitor_results
     WHERE run_id = $1 AND mentioned = true AND sentiment = 'positive'
     ORDER BY mention_position ASC NULLS LAST
     LIMIT 3`,
    [r.id]
  );

  const missedQueries = await query(
    `SELECT llm_name, query_text
     FROM llm_monitor_results
     WHERE run_id = $1 AND mentioned = false
     ORDER BY llm_name
     LIMIT 5`,
    [r.id]
  );

  const competitors = await query(
    `SELECT unnest(competitors_named) AS competitor, COUNT(*) AS mentions
     FROM llm_monitor_results
     WHERE run_id = $1 AND array_length(competitors_named, 1) > 0
     GROUP BY competitor
     ORDER BY mentions DESC
     LIMIT 5`,
    [r.id]
  );

  return {
    run: r,
    byLLM:        byLLM.rows,
    bestMentions: bestMentions.rows,
    missedQueries: missedQueries.rows,
    topCompetitors: competitors.rows
  };
}

async function getHistoricalScores(locationId, weeks = 8) {
  const result = await query(
    `SELECT visibility_score, total_mentions, total_queries,
            completed_at::date AS scan_date
     FROM llm_monitor_runs
     WHERE location_id = $1 AND status = 'complete'
     ORDER BY completed_at DESC
     LIMIT $2`,
    [locationId, weeks]
  );
  return result.rows.reverse(); // chronological order
}

async function getOrCreateConfig(locationId) {
  const existing = await query(
    `SELECT * FROM llm_monitor_configs WHERE location_id = $1`,
    [locationId]
  );
  if (existing.rows[0]) return existing.rows[0];

  const created = await query(
    `INSERT INTO llm_monitor_configs (location_id)
     VALUES ($1) RETURNING *`,
    [locationId]
  );
  return created.rows[0];
}

async function updateConfig(locationId, updates) {
  const allowed = ['monitor_chatgpt','monitor_gemini','monitor_claude',
                   'monitor_perplexity','monitor_copilot','custom_queries',
                   'alert_on_mention','alert_on_missing','alert_on_negative',
                   'scan_frequency'];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (!fields.length) throw new Error('No valid fields');

  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values    = fields.map(f => updates[f]);

  const result = await query(
    `UPDATE llm_monitor_configs SET ${setClause}
     WHERE location_id = $1 RETURNING *`,
    [locationId, ...values]
  );
  return result.rows[0];
}

// ── SCHEDULER HELPER ──────────────────────────────────────────────────────────
async function getLocationsForScan() {
  const result = await query(
    `SELECT location_id FROM llm_monitor_configs
     WHERE is_active = true AND next_scan_at <= NOW()`,
  );
  return result.rows.map(r => r.location_id);
}

module.exports = {
  runScan, getLatestReport, getHistoricalScores,
  getOrCreateConfig, updateConfig, getLocationsForScan,
  buildQueries
};
