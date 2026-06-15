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

// Only construct the Anthropic client if a key is present — otherwise the SDK
// can throw at boot. Claude is optional; OpenAI + Gemini carry the scan.
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Model IDs are env-overridable so provider model churn never needs a code change.
const OPENAI_MODEL    = process.env.OPENAI_MODEL    || 'gpt-5-mini';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const GEMINI_MODEL    = process.env.GEMINI_MODEL    || 'gemini-3.5-flash';

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
  if (!anthropic) return { text: '', error: 'ANTHROPIC_API_KEY not configured', skipped: true };
  const start = Date.now();
  try {
    const response = await anthropic.messages.create({
      model:      ANTHROPIC_MODEL,
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }]
    });
    return {
      text:        response.content[0]?.text || '',
      response_ms: Date.now() - start,
      model:       ANTHROPIC_MODEL,
      error:       null
    };
  } catch (err) {
    return { text: '', response_ms: Date.now() - start, model: ANTHROPIC_MODEL, error: err.message };
  }
}

async function queryOpenAI(prompt) {
  if (!process.env.OPENAI_API_KEY) return { text: '', error: 'OPENAI_API_KEY not configured', skipped: true };
  const start = Date.now();
  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model:    OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: 2048
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );
    const choice = res.data.choices?.[0];
    const text   = choice?.message?.content || '';
    // Succeeded but no visible content — usually a reasoning model that spent its
    // whole budget on hidden reasoning. Surface the real reason, not "unknown".
    const error  = text ? null
      : `empty content (model: ${OPENAI_MODEL}, finish_reason: ${choice?.finish_reason || 'n/a'}, completion_tokens: ${res.data.usage?.completion_tokens ?? 'n/a'})`;
    return { text, response_ms: Date.now() - start, model: OPENAI_MODEL, error };
  } catch (err) {
    return { text: '', response_ms: Date.now() - start, model: OPENAI_MODEL, error: err.response?.data?.error?.message || err.message };
  }
}

async function queryGemini(prompt) {
  if (!process.env.GEMINI_API_KEY) return { text: '', error: 'GEMINI_API_KEY not configured', skipped: true };
  const start = Date.now();
  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] }
    );
    const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const finish = res.data.candidates?.[0]?.finishReason;
    const blocked = res.data.promptFeedback?.blockReason;
    const error = text ? null
      : `empty content (model: ${GEMINI_MODEL}, finishReason: ${finish || 'n/a'}${blocked ? ', blocked: ' + blocked : ''})`;
    return { text, response_ms: Date.now() - start, model: GEMINI_MODEL, error };
  } catch (err) {
    return { text: '', response_ms: Date.now() - start, model: GEMINI_MODEL, error: err.response?.data?.error?.message || err.message };
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

// ── REAL VISIBILITY SCAN ──────────────────────────────────────────────────────
// Calls the live LLMs and derives the report from genuine responses. Mention
// detection is done locally (string + heuristics) so we don't pay for a second
// analysis call per query. Producers: only providers whose API key is set AND
// that actually returned text are included — a misconfigured provider is
// skipped rather than dragging the score to zero.

const POSITIVE_WORDS = /\b(best|top|recommend|recommended|great|excellent|highly|popular|favou?rite|love|trusted|leading|standout|go-to)\b/i;

const COMPETITOR_STOPWORDS = new Set([
  'The','This','That','These','Those','There','Their','They','You','Your','Yelp','Google',
  'Maps','Reviews','Review','Facebook','Instagram','TripAdvisor','OpenTable','Here','Some',
  'Many','Most','Based','However','While','When','With','For','And','But','Also','One','Each',
  'If','It','In','On','At','As','To','Of','A','An','I','We','Overall','Note','Tips','Best',
]);

function detectMention(text, businessName) {
  if (!text || !businessName) return { mentioned: false, position: null, sentiment: 'not_mentioned', snippet: null };
  const lowerText = text.toLowerCase();
  const lowerName = businessName.toLowerCase().trim();
  const idx = lowerText.indexOf(lowerName);
  if (idx === -1) return { mentioned: false, position: null, sentiment: 'not_mentioned', snippet: null };

  // Rough prominence by where the name first appears in the response.
  const frac = idx / Math.max(1, text.length);
  const position = frac < 0.15 ? 1 : frac < 0.45 ? 2 : 3;

  // Sentiment from a window around the mention.
  const window = text.slice(Math.max(0, idx - 120), idx + lowerName.length + 120);
  const sentiment = POSITIVE_WORDS.test(window) ? 'positive' : 'neutral';

  // Snippet = the sentence containing the mention, trimmed.
  const sentences = text.split(/(?<=[.!?])\s+/);
  let snippet = sentences.find(s => s.toLowerCase().includes(lowerName)) || text.slice(idx, idx + 200);
  snippet = snippet.trim().replace(/\s+/g, ' ');
  if (snippet.length > 220) snippet = snippet.slice(0, 217) + '…';

  return { mentioned: true, position, sentiment, snippet };
}

function extractCompetitors(allTexts, businessName) {
  const lowerName = (businessName || '').toLowerCase();
  const counts = {};
  const re = /\b([A-Z][a-zA-Z&'’.]+(?:\s+[A-Z][a-zA-Z&'’.]+){0,3})\b/g;
  for (const text of allTexts) {
    if (!text) continue;
    const seen = new Set();
    let m;
    while ((m = re.exec(text)) !== null) {
      const phrase = m[1].trim();
      const first = phrase.split(/\s+/)[0];
      if (phrase.length < 4) continue;
      if (COMPETITOR_STOPWORDS.has(first)) continue;
      if (phrase.toLowerCase() === lowerName) continue;
      if (lowerName && phrase.toLowerCase().includes(lowerName)) continue;
      if (seen.has(phrase.toLowerCase())) continue; // count once per response
      seen.add(phrase.toLowerCase());
      counts[phrase] = (counts[phrase] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .filter(([, c]) => c >= 2)            // mentioned in 2+ responses to count
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([competitor, mentions]) => ({ competitor, mentions }));
}

// LLM-based insights — one structured call over the collected AI responses that
// returns, grounded in what the models actually said:
//   - competitors: real business names + WHY each was favored (feature 1)
//   - recommendations: prioritized, specific actions grounded in the query gaps
//     and competitor strengths (feature 4)
// Returns the parsed object on success, or null on failure (caller falls back).
async function extractInsightsLLM(allTexts, businessName, queryGaps, overallScore, providers) {
  if (!providers || !providers.length) return null;
  // This is a single synthesis call (summary + competitors + recommendations),
  // run once per location per scan — so cost is negligible. Prefer Gemini (free
  // tier) and fall back to the others if it isn't configured or the call fails.
  const order  = ['gemini', 'chatgpt', 'claude'];
  const chosen = order.map(n => providers.find(p => p.name === n)).find(Boolean) || providers[0];

  const corpus = allTexts.filter(Boolean).join('\n\n---\n\n').slice(0, 6000);
  if (!corpus.trim()) return null;

  const gapList = (queryGaps || []).map(g => `- "${g.query_text}"`).join('\n') || '(none)';

  const prompt =
    `You are analysing how AI assistants describe local businesses, to help "${businessName}" become more visible in AI answers.\n\n` +
    `Business: ${businessName}\n` +
    `Current AI visibility score: ${overallScore}/100\n` +
    `Search queries where ${businessName} is MISSING from the AI answers:\n${gapList}\n\n` +
    `Below are the actual AI assistant responses.\n\n` +
    `Respond with ONLY a JSON object in exactly this shape, no other text:\n` +
    `{\n` +
    `  "executiveSummary": "<2-4 sentence plain-English overview written for the owner of ${businessName}: how visible they are in AI answers this week, the trend vs last week, which competitors the AI favoured and the main reason, and the single biggest opportunity. Address them directly. Honest and specific — no hype, no guarantees.>",\n` +
    `  "competitors": [{ "name": "<real business name>", "reasons": ["<short reason the AI favoured them, grounded in the text>"] }],\n` +
    `  "recommendations": [{ "priority": "high|medium|low", "action": "<specific action ${businessName} can take>", "rationale": "<why it matters, referencing a missing query or a competitor strength>", "steps": ["<concrete how-to step>", "<another step>"] }]\n` +
    `}\n\n` +
    `Rules:\n` +
    `- executiveSummary: ground every claim in the actual responses and the score (${overallScore}/100). Mention a real competitor name if one stands out. Keep it to 2-4 sentences.\n` +
    `- competitors: only real business/brand names mentioned as alternatives to ${businessName}; exclude ${businessName}; max 5; each reason <= 10 words and drawn from the responses (ratings, review counts, specialties the AI cited).\n` +
    `- recommendations: 3-5 concrete, prioritised actions grounded in the missing queries above and what competitors are praised for. No generic filler.\n` +
    `- steps: for EACH recommendation, give 2-4 specific, practical how-to steps the owner can actually do. Tailor them to the business type you infer from the responses — e.g. a software/SaaS company should get steps about review sites like G2/Capterra, comparison/"vs alternatives" pages, and content; a local service business should get steps about Google Business Profile, local directories/citations, and asking customers for reviews. Steps must be real actions (improve reviews, web presence, listings, on-page content) — never promise that an action guarantees a ranking change.\n\n` +
    `Responses:\n${corpus}`;

  try {
    const r = await chosen.fn(prompt);
    if (!r.text) return null;
    let raw = r.text.trim().replace(/```json/gi, '').replace(/```/g, '').trim();
    const match = raw.match(/\{[\s\S]*\}/);   // isolate the JSON object if wrapped in prose
    if (match) raw = match[0];
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      executiveSummary: typeof parsed.executiveSummary === 'string' ? parsed.executiveSummary.trim() : '',
      competitors:    Array.isArray(parsed.competitors)    ? parsed.competitors    : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
    };
  } catch (e) {
    logger.warn('Insights extraction (LLM) failed, falling back to heuristic: ' + e.message);
    return null;
  }
}

// Honest, templated executive summary used when the LLM insights call fails —
// grounded entirely in the real score, trend, mention counts and competitors.
function buildFallbackSummary(businessName, score, prevScore, mentions, queries, competitors, recommendations) {
  const delta = (prevScore != null) ? (score - prevScore) : 0;
  const trend = delta > 0 ? `up ${delta} point${delta === 1 ? '' : 's'} from last week`
              : delta < 0 ? `down ${Math.abs(delta)} point${Math.abs(delta) === 1 ? '' : 's'} from last week`
              : 'about level with last week';
  let s = `This week AI assistants mentioned ${businessName} in ${mentions} of ${queries} test questions — a ${score}% visibility score, ${trend}.`;
  const top = (competitors || [])[0];
  if (top && top.competitor) {
    const reason = (top.reasons && top.reasons[0]) ? ` (${String(top.reasons[0]).toLowerCase()})` : '';
    s += ` ${top.competitor} came up most often as an alternative${reason}.`;
  }
  const rec = (recommendations || [])[0];
  if (rec && rec.action) s += ` Biggest opportunity right now: ${String(rec.action).replace(/\.\s*$/, '')}.`;
  return s;
}

// Honest fallback recommendations when the LLM insights call fails — still
// grounded in the real score and the real query gaps, just not LLM-authored.
function buildFallbackRecommendations(overallScore, queryGaps, byLLM) {
  const recs = [];
  const gapCount = (queryGaps || []).length;
  if (gapCount) {
    recs.push({
      priority: 'high',
      action: `Strengthen your presence for the ${gapCount} search${gapCount > 1 ? 'es' : ''} where AI doesn't mention you yet`,
      rationale: 'These are the queries customers ask AI assistants where competitors appear and you do not.',
      steps: [
        'Add content to your website that directly answers these searches (a service page or FAQ using that wording)',
        'Ask recent customers to mention the relevant service or specialty in their reviews',
        'Make sure these services are listed explicitly on your Google Business Profile and directory listings',
      ],
    });
  }
  recs.push({
    priority: overallScore < 40 ? 'high' : 'medium',
    action: 'Collect more recent, detailed customer reviews on Google',
    rationale: 'Review volume and recency are among the strongest signals AI models use when recommending local businesses.',
    steps: [
      'Send review requests to recent happy customers (SwarmReply automates this)',
      'Aim for a steady cadence rather than a one-time burst — recency matters',
      'Reply to every review so the profile looks active and engaged',
    ],
  });
  recs.push({
    priority: 'medium',
    action: 'Make sure your Google Business Profile is complete and current',
    rationale: 'AI assistants lean heavily on Google Business Profile data when answering "best near me" questions.',
    steps: [
      'Fill in every field: hours, services, categories, description, photos',
      'Keep your name, address, and phone identical across all sites',
      'Post updates periodically so the profile stays active',
    ],
  });
  return recs;
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// ── SCAN STATUS (in-memory) ───────────────────────────────────────────────────
// Tracks which customers have a scan running right now, so the API can report
// "scanning" while the work happens in the background and the UI can poll.
// NOTE: in-memory = single-instance. Fine pre-launch; move to DB if we scale out.
const _scanning = new Set();
function markScanning(id)  { _scanning.add(String(id)); }
function clearScanning(id) { _scanning.delete(String(id)); }
function isScanning(id)    { return _scanning.has(String(id)); }

// ── RETRY HELPERS ─────────────────────────────────────────────────────────────
const RETRY_DELAYS_MS = [2000, 5000, 10000]; // up to 3 retries, seconds-scale backoff

function isTransient(msg) {
  if (!msg) return false;
  return /high demand|temporar|overload|rate.?limit|too many requests|try again|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|\b(429|500|502|503|504)\b/i.test(msg);
}

// Short, honest reason shown to the user when a provider is skipped this scan.
function friendlyProviderError(msg) {
  if (!msg) return 'temporarily unavailable';
  if (/api key not valid|invalid.*key|incorrect api key|unauthor/i.test(msg)) return 'API key issue';
  if (/model/i.test(msg) && /not found|does not exist|unknown|unsupported/i.test(msg)) return 'model not available';
  if (/empty content/i.test(msg)) return 'no response returned';
  return 'temporarily unavailable';
}

// Call a provider, retrying only on transient errors (overload, rate limit, 5xx,
// network). Permanent errors (bad key, model not found, empty reasoning output)
// are returned immediately — retrying wouldn't help.
async function callWithRetry(fn, prompt, label) {
  let r = await fn(prompt);
  let attempt = 0;
  while (!r.text && r.error && isTransient(r.error) && attempt < RETRY_DELAYS_MS.length) {
    const delay = RETRY_DELAYS_MS[attempt];
    logger.warn(`AI Visibility: ${label} transient error (${r.error}) — retrying in ${delay / 1000}s`);
    await new Promise(res => setTimeout(res, delay));
    r = await fn(prompt);
    attempt++;
  }
  return r;
}

async function runRealScan({ businessName, businessType, city, state, customQueries, prevScore = null, maxQueries = 15 }) {
  const queries = (Array.isArray(customQueries) && customQueries.length
    ? customQueries
    : buildQueries({ business_name: businessName, business_type: businessType, city, state })
  ).slice(0, maxQueries);

  const providers = [];
  if (process.env.OPENAI_API_KEY) providers.push({ name: 'chatgpt', fn: queryOpenAI });
  if (process.env.GEMINI_API_KEY) providers.push({ name: 'gemini',  fn: queryGemini });
  if (anthropic)                  providers.push({ name: 'claude',  fn: queryClaudeAI });

  if (providers.length === 0) {
    return { error: 'no_providers', message: 'No LLM API keys configured (set OPENAI_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY).' };
  }

  const allTexts = [];
  let totalPositive = 0;

  // Scan one provider: its queries run sequentially, each call retried on
  // transient errors. Returns its own result bundle (no shared mutation).
  async function scanProvider(provider) {
    const modelResults = [];
    const snippets = [];
    const texts = [];
    let modelMentions = 0;
    let hadText = false;
    let lastError = null;

    for (const q of queries) {
      const r = await callWithRetry(provider.fn, q, provider.name);
      if (r.text) { hadText = true; texts.push(r.text); }
      if (r.error) lastError = r.error;
      const det = detectMention(r.text, businessName);
      modelResults.push({
        llm_name: provider.name, query_text: q,
        mentioned: det.mentioned, mention_position: det.position,
        sentiment: det.sentiment, prev_mentioned: false,
      });
      if (det.mentioned) {
        modelMentions++;
        if (snippets.length < 2 && det.snippet) snippets.push({ query: q, text: det.snippet });
      }
    }
    return { provider, modelResults, snippets, texts, modelMentions, hadText, lastError };
  }

  // Run all providers in parallel — they're independent, so this is ~Nx faster.
  const providerOutputs = await Promise.all(providers.map(scanProvider));

  const byLLM = [];
  const results = [];
  const skippedProviders = [];
  let totalMentions = 0, totalQueries = 0;

  for (const out of providerOutputs) {
    const { provider, modelResults, snippets, texts, modelMentions, hadText, lastError } = out;

    // Skip providers that returned nothing even after retries — note them
    // honestly instead of silently dropping them or faking a 0%.
    if (!hadText) {
      logger.warn(`AI Visibility: ${provider.name} returned no text (${lastError || 'unknown'}) — excluded from report`);
      skippedProviders.push({ llm_name: provider.name, reason: friendlyProviderError(lastError) });
      continue;
    }

    allTexts.push(...texts);
    results.push(...modelResults);
    totalQueries  += queries.length;
    totalMentions += modelMentions;
    for (const mr of modelResults) if (mr.mentioned && mr.sentiment === 'positive') totalPositive++;

    const vis = Math.round((modelMentions / queries.length) * 100);
    let rec;
    if (vis === 0)      rec = `${cap(provider.name)} isn't recommending you yet for these searches. A complete Google Business Profile and more recent reviews are the fastest ways to start appearing.`;
    else if (vis < 60)  rec = `${cap(provider.name)} mentions you in ${modelMentions} of ${queries.length} queries. More recent, detailed reviews and a fuller profile can lift this.`;
    else                rec = `${cap(provider.name)} recommends you in ${vis}% of these queries — keep your profile and reviews fresh to hold that lead.`;

    byLLM.push({
      llm_name:       provider.name,
      visibility_pct: vis,
      total_queries:  queries.length,
      mentions:       modelMentions,
      sentiment:      vis >= 60 ? 'positive' : vis > 0 ? 'neutral' : 'not_mentioned',
      snippets,
      citations:      [],          // real citations aren't returned by chat APIs; left empty rather than faked
      recommendations: [rec],
    });
  }

  if (byLLM.length === 0) {
    return { error: 'all_providers_failed', message: 'No LLM returned a usable response. Check your API keys and model settings.', skippedProviders };
  }

  const overallScore = Math.round(byLLM.reduce((s, m) => s + m.visibility_pct, 0) / byLLM.length);

  const bestMentions = results.filter(r => r.sentiment === 'positive').slice(0, 5)
    .map(r => ({ llm_name: r.llm_name, query_text: r.query_text, position: r.mention_position }));
  const missedQueries = results.filter(r => !r.mentioned).slice(0, 8)
    .map(r => ({ llm_name: r.llm_name, query_text: r.query_text }));

  // ── Query gaps (feature 2) — deterministic, from the per-query results ───────
  // For each query, which models mentioned you vs missed you. Surface the ones
  // where you're absent on at least one model (most-missed first).
  const gapMap = {};
  for (const r of results) {
    if (!gapMap[r.query_text]) gapMap[r.query_text] = { query_text: r.query_text, missedOn: [], mentionedOn: [] };
    (r.mentioned ? gapMap[r.query_text].mentionedOn : gapMap[r.query_text].missedOn).push(r.llm_name);
  }
  const queryGaps = Object.values(gapMap)
    .filter(g => g.missedOn.length > 0)
    .sort((a, b) => b.missedOn.length - a.missedOn.length)
    .slice(0, 8);

  // ── Insights (features 1 + 4) — one grounded LLM call; heuristic fallback ────
  const insights = await extractInsightsLLM(allTexts, businessName, queryGaps, overallScore, providers);

  let competitors;
  let recommendations;
  if (insights) {
    const lowerBiz = (businessName || '').toLowerCase();
    competitors = (insights.competitors || [])
      .map(c => {
        const name = (c && typeof c.name === 'string') ? c.name.trim() : '';
        if (!name) return null;
        const lname = name.toLowerCase();
        if (lname === lowerBiz || (lowerBiz && lname.includes(lowerBiz))) return null;
        let mentions = 0;
        for (const t of allTexts) if (t && t.toLowerCase().includes(lname)) mentions++;
        const reasons = Array.isArray(c.reasons)
          ? c.reasons.filter(x => typeof x === 'string' && x.trim()).slice(0, 3)
          : [];
        return { competitor: name, mentions: Math.max(1, mentions), reasons };
      })
      .filter(Boolean)
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 5);
    recommendations = (insights.recommendations || [])
      .filter(r => r && typeof r.action === 'string' && r.action.trim())
      .map(r => ({
        priority:  ['high', 'medium', 'low'].includes((r.priority || '').toLowerCase()) ? r.priority.toLowerCase() : 'medium',
        action:    r.action.trim(),
        rationale: typeof r.rationale === 'string' ? r.rationale.trim() : '',
        steps:     Array.isArray(r.steps) ? r.steps.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()).slice(0, 4) : [],
      }))
      .slice(0, 5);
  } else {
    // LLM call failed — fall back to the regex extractor (names only, no reasons)
    competitors = extractCompetitors(allTexts, businessName).map(c => ({ ...c, reasons: [] }));
    recommendations = [];
  }
  if (!recommendations.length) {
    recommendations = buildFallbackRecommendations(overallScore, queryGaps, byLLM);
  }

  const topCompetitors = [
    { competitor: `${businessName} (You)`, mentions: totalMentions, reasons: [] },
    ...competitors,
  ];

  const executiveSummary = (insights && insights.executiveSummary)
    ? insights.executiveSummary
    : buildFallbackSummary(businessName, overallScore, prevScore, totalMentions, totalQueries, competitors, recommendations);

  const now = new Date();
  const nextScan = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  return {
    run: {
      completed_at:     now.toISOString(),
      visibility_score: overallScore,
      prev_visibility:  prevScore != null ? prevScore : overallScore,
      total_queries:    totalQueries,
      total_mentions:   totalMentions,
      total_positive:   totalPositive,
      total_not_found:  totalQueries - totalMentions,
    },
    overallScore,
    byLLM,
    results,
    bestMentions,
    missedQueries,
    topCompetitors,
    queryGaps,
    recommendations,
    executiveSummary,
    skippedProviders,
    nextScanAt: nextScan.toISOString(),
    lastScanAt: now.toISOString(),
  };
}

module.exports = {
  runScan, getLatestReport, getHistoricalScores,
  getOrCreateConfig, updateConfig, getLocationsForScan,
  buildQueries, runRealScan,
  markScanning, clearScanning, isScanning
};
