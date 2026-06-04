// ============================================
// services/aiService.js
// AI reply generation using Claude API
// Handles all edge cases, legal guardrails,
// tone detection, and retry logic
// ============================================

const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');

// Initialize Anthropic client only if a key is present (so a missing key can't
// crash boot — replies fall back to the safe canned response instead).
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Model is env-overridable so a provider model rename never needs a code change.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// ============================================
// MAIN REPLY GENERATOR
// ============================================

/**
 * generateReviewReply()
 * Core AI engine — generates a professional review reply
 * Handles all edge cases and legal guardrails
 *
 * @param {Object} review - Review data from database
 * @param {Object} businessProfile - Location/business settings
 * @returns {string} Generated reply text
 */
async function generateReviewReply(review, businessProfile) {
  try {
    // Detect edge cases before generating
    const edgeCaseInstructions = detectEdgeCases(review, businessProfile);
    const isLegalRisk = edgeCaseInstructions.includes('LEGAL RISK');

    // For legal risk reviews, return safe hardcoded response immediately
    // Do not send to AI — too risky
    if (isLegalRisk) {
      logger.warn(`Legal risk detected in review ${review.id} — using safe fallback`);
      return getSafeLegalResponse(businessProfile.contactEmail);
    }

    // Build prompts
    const systemPrompt = buildSystemPrompt(businessProfile);
    const userPrompt = buildUserPrompt(review, businessProfile, edgeCaseInstructions);

    // Generate reply with retry logic
    const reply = await callClaudeWithRetry(systemPrompt, userPrompt);

    // Validate the generated reply
    const validatedReply = validateReply(reply, businessProfile);

    logger.info(`Reply generated for review ${review.id}: ${validatedReply.length} chars`);
    return validatedReply;

  } catch (error) {
    logger.error(`Failed to generate reply for review ${review.id}:`, error.message);

    // Return safe fallback reply — never fail silently
    return getSafeFallbackReply(businessProfile.contactEmail);
  }
}

// ============================================
// PROMPT BUILDERS
// ============================================

/**
 * buildSystemPrompt()
 * Build the AI system prompt with all rules and guardrails
 */
function buildSystemPrompt(businessProfile) {
  const healthcareRules = businessProfile.isHealthcare ? `
HEALTHCARE BUSINESS — ADDITIONAL STRICT RULES:
- NEVER reference, confirm, or deny any specific treatment or appointment
- NEVER confirm the reviewer is or was a patient
- NEVER include any information that could identify a patient
- Use only: "we take all feedback seriously" or "we care about all our clients"
- Always direct to private communication for any clinical matters
- These rules comply with HIPAA privacy requirements
` : '';

  return `You are a professional review response writer for local businesses.
You write genuine, helpful responses to customer reviews on behalf of business owners.
Your responses must sound like a real human business owner — warm, authentic, never robotic.

ABSOLUTE RULES — NEVER BREAK THESE UNDER ANY CIRCUMSTANCES:
1. Never admit legal fault or liability ("we were negligent", "we failed", "that was our mistake")
2. Never mention specific staff members negatively — always say "our team"
3. Never make promises you cannot guarantee ("this will never happen again")
4. Never offer specific discounts or compensation publicly — say "please reach out to us directly"
5. Never use ALL CAPS or more than one exclamation mark per response
6. Never write more than 150 words — concise responses perform better
7. Always move conflict resolution offline with a contact email or phone
8. Never engage with reviews that appear to be from competitors or contain threats
9. Never mention competitors by name
10. Never include marketing language or promotional offers in responses
11. Vary your language — never start two replies the same way
12. Never use generic openers like "Thank you for your review" — be specific to the review content

FTC COMPLIANCE:
- Never offer incentives for reviews or in review responses
- Never claim affiliations that don't exist

DEFAMATION PREVENTION:
- Never make false factual claims about the reviewer
- Never call a review "fake" or "dishonest" publicly
- If you suspect a fake review, respond professionally as if it were real

${healthcareRules}

OUTPUT FORMAT:
- Write only the reply text
- No preamble, no explanation, no quotation marks around the reply
- Plain text only — no markdown, no bullet points
- 2-4 sentences maximum`;
}

/**
 * buildUserPrompt()
 * Build the specific prompt for this review
 */
function buildUserPrompt(review, businessProfile, edgeCaseInstructions) {
  // Tone based on star rating
  const toneGuide = {
    5: 'enthusiastic and genuinely grateful — this customer loves you',
    4: 'warm and appreciative — gently acknowledge any minor feedback mentioned',
    3: 'balanced and solution-focused — thank them and directly address concerns',
    2: 'empathetic and constructive — take concerns seriously without admitting fault',
    1: 'deeply empathetic and professional — take the complaint very seriously, offer private resolution'
  };

  const tone = toneGuide[review.star_rating] || 'professional and warm';

  return `Write a review response for this business.

BUSINESS DETAILS:
- Name: ${businessProfile.businessName}
- Type: ${businessProfile.businessType || 'local business'}
- Tone preference: ${businessProfile.tone} (for this ${review.star_rating}-star review, be: ${tone})
- Contact email: ${businessProfile.contactEmail || 'our team directly'}
- Always include these words/themes: ${businessProfile.alwaysInclude?.join(', ') || 'none'}
- Never include these words: ${businessProfile.neverInclude?.join(', ') || 'none'}
${businessProfile.customInstructions ? `- Custom instructions: ${businessProfile.customInstructions}` : ''}

REVIEW TO RESPOND TO:
- Reviewer name: ${review.reviewer_name || 'a customer'}
- Star rating: ${review.star_rating}/5 stars
- Review text: "${review.review_text || '(no text — rating only)'}"

SPECIAL HANDLING REQUIRED:
${edgeCaseInstructions}

Write the response now. Remember: under 150 words, sound human, no generic openers.`;
}

// ============================================
// EDGE CASE DETECTION
// ============================================

/**
 * detectEdgeCases()
 * Scan review for situations requiring special handling
 * Returns instructions string for the AI prompt
 */
function detectEdgeCases(review, businessProfile) {
  const instructions = [];
  const text = (review.review_text || '').toLowerCase();
  const reviewer = (review.reviewer_name || '').toLowerCase();

  // Empty or very short review — rating only
  if (!review.review_text || review.review_text.trim().length < 5) {
    instructions.push('This is a rating-only review with no text. Write a brief 1-2 sentence warm response acknowledging their rating.');
  }

  // Detect foreign language (simple heuristic)
  const englishWords = ['the', 'and', 'was', 'is', 'are', 'have', 'this', 'that', 'very', 'good', 'great', 'bad'];
  const hasEnglish = englishWords.some(w => text.includes(` ${w} `) || text.startsWith(w));
  if (!hasEnglish && text.length > 15) {
    instructions.push('This review may be in a foreign language. Respond warmly in English only.');
  }

  // Detect staff name mentions
  // Look for capitalized words that could be names (not at start of sentence)
  const staffNamePattern = /(?<![.!?]\s)[A-Z][a-z]{2,}/g;
  const potentialNames = review.review_text?.match(staffNamePattern) || [];
  // Filter out common non-name words
  const nonNames = ['Google', 'Yelp', 'TripAdvisor', 'California', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const likelyNames = potentialNames.filter(n => !nonNames.includes(n));
  if (likelyNames.length > 0) {
    instructions.push(`Review mentions what appears to be staff names (${likelyNames.join(', ')}). Do NOT repeat these names. Refer to "our team" instead.`);
  }

  // LEGAL RISK — highest priority
  const legalTerms = ['lawsuit', 'lawyer', 'attorney', 'sue', 'court', 'legal action', 'police', 'report you', 'news', 'bbb', 'better business'];
  if (legalTerms.some(term => text.includes(term))) {
    instructions.push('LEGAL RISK — USE SAFE LEGAL RESPONSE ONLY');
    return instructions.join('\n');
  }

  // Health/injury complaints
  const healthTerms = ['food poison', 'sick', 'ill ', 'vomit', 'hospital', 'allergic', 'allergy', 'injured', 'hurt', 'pain', 'infection'];
  if (healthTerms.some(term => text.includes(term))) {
    instructions.push('Health/injury mentioned: Express genuine concern, do NOT admit fault, immediately direct to private contact. Do not speculate about what happened.');
  }

  // Clearly fake review signals
  const fakeSignals = ["never been", "never visited", "never went there", "never came", "i didn't go", "wrong business", "wrong place"];
  if (fakeSignals.some(signal => text.includes(signal))) {
    instructions.push('This may be a mistaken or fake review. Respond professionally and warmly as if real — politely note you cannot find a record of their visit and invite them to reach out directly. Never accuse them of lying.');
  }

  // Threatening language
  const threatTerms = ['kill', 'destroy', 'ruin', 'threaten'];
  if (threatTerms.some(term => text.includes(term))) {
    instructions.push('Review contains strong language. Respond calmly and professionally. Do not match their energy. Keep it brief and redirect to private contact.');
  }

  // Competitor mention
  if (text.includes('competitor') || text.includes('other place') || text.includes('down the street')) {
    instructions.push('Review mentions other businesses. Do not reference competitors in your reply.');
  }

  return instructions.length > 0 ? instructions.join('\n') : 'No special handling needed — write a natural response.';
}

// ============================================
// CLAUDE API CALL WITH RETRY
// ============================================

/**
 * callClaudeWithRetry()
 * Call Claude API with exponential backoff retry
 * Handles rate limits, timeouts, and API errors
 */
async function callClaudeWithRetry(systemPrompt, userPrompt, maxRetries = 3) {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY not configured');
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const message = await anthropic.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt }
        ]
      });

      const reply = message.content[0]?.text?.trim();

      // Validate we got a real response
      if (!reply || reply.length < 10) {
        throw new Error('Claude returned empty or too-short reply');
      }

      // Log token usage for cost tracking
      logger.debug(`Claude tokens used: ${message.usage.input_tokens} in, ${message.usage.output_tokens} out`);

      return reply;

    } catch (error) {
      lastError = error;

      // Check if error is retryable
      const isRetryable = (
        error.status === 429 ||         // rate limit
        error.status === 500 ||         // server error
        error.status === 503 ||         // service unavailable
        error.message?.includes('timeout') ||
        error.message?.includes('network')
      );

      if (isRetryable && attempt < maxRetries) {
        const waitTime = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        logger.warn(`Claude API attempt ${attempt} failed (${error.status || error.message}), retrying in ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      // Non-retryable error or out of retries
      logger.error(`Claude API failed after ${attempt} attempts:`, error.message);
      break;
    }
  }

  throw lastError;
}

// ============================================
// REPLY VALIDATION
// ============================================

/**
 * validateReply()
 * Validate generated reply before posting
 * Catches any issues the AI might have missed
 */
function validateReply(reply, businessProfile) {
  let validated = reply.trim();

  // Remove any quotation marks the AI added
  validated = validated.replace(/^["']|["']$/g, '');

  // Truncate if too long (safety net)
  if (validated.length > 1000) {
    validated = validated.substring(0, 997) + '...';
    logger.warn('Reply was truncated — AI generated too long a response');
  }

  // Check for any forbidden phrases from business settings
  if (businessProfile.neverInclude && businessProfile.neverInclude.length > 0) {
    for (const phrase of businessProfile.neverInclude) {
      if (validated.toLowerCase().includes(phrase.toLowerCase())) {
        logger.warn(`Reply contains forbidden phrase "${phrase}" — flagging for review`);
        // Don't block — flag for manual review instead
      }
    }
  }

  return validated;
}

// ============================================
// SAFE FALLBACK RESPONSES
// ============================================

/**
 * getSafeLegalResponse()
 * Hardcoded safe response for reviews with legal language
 * Never generated by AI to avoid liability risk
 */
function getSafeLegalResponse(contactEmail) {
  return `We take all feedback seriously and would encourage you to reach out to us privately so we can address your concerns directly. Please contact us at ${contactEmail || 'our team directly'} and we will make every effort to resolve this for you.`;
}

/**
 * getSafeFallbackReply()
 * Generic safe reply when AI completely fails
 * Better than no reply at all
 */
function getSafeFallbackReply(contactEmail) {
  return `Thank you for taking the time to share your experience with us. Your feedback is important and we'd love to hear more. Please don't hesitate to reach out to us at ${contactEmail || 'our team directly'} — we're always here to help.`;
}

module.exports = {
  generateReviewReply,
  detectEdgeCases,
  getSafeLegalResponse,
  getSafeFallbackReply
};
