// ============================================
// services/multiLanguageService.js
// Multi-language review reply support
// Detects review language using Claude
// Replies in the same language as the review
// Growth & Agency plans only
// ============================================

const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Supported languages with their names
const SUPPORTED_LANGUAGES = {
  en: 'English', es: 'Spanish', zh: 'Chinese (Simplified)',
  fr: 'French', de: 'German', ja: 'Japanese',
  ko: 'Korean', pt: 'Portuguese', it: 'Italian',
  ar: 'Arabic', ru: 'Russian', hi: 'Hindi',
  vi: 'Vietnamese', tl: 'Tagalog', th: 'Thai'
};

// ============================================
// LANGUAGE DETECTION
// ============================================

/**
 * detectLanguage()
 * Detect the language of a review text
 * Returns ISO 639-1 language code (e.g. 'es', 'zh', 'en')
 *
 * @param {string} text - Review text to detect
 * @returns {Object} { code, name, confidence }
 */
async function detectLanguage(text) {
  if (!text || text.trim().length < 3) {
    return { code: 'en', name: 'English', confidence: 'low' };
  }

  // Quick heuristic for common scripts before calling AI
  const quickDetect = quickLanguageDetect(text);
  if (quickDetect) return quickDetect;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 50,
      system: 'Detect the language of the text. Return ONLY valid JSON: {"code": "es", "name": "Spanish", "confidence": "high"}. Use ISO 639-1 codes. confidence: high/medium/low.',
      messages: [{ role: 'user', content: `Detect language: "${text.substring(0, 200)}"` }]
    });

    const result = JSON.parse(message.content[0].text.trim());
    return result;

  } catch (error) {
    logger.error('Language detection failed:', error.message);
    return { code: 'en', name: 'English', confidence: 'low' };
  }
}

/**
 * quickLanguageDetect()
 * Fast script-based detection for common non-Latin scripts
 * Avoids API call for obvious cases
 */
function quickLanguageDetect(text) {
  // CJK characters (Chinese/Japanese/Korean)
  if (/[\u4e00-\u9fff]/.test(text)) {
    if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) return { code: 'ja', name: 'Japanese', confidence: 'high' };
    if (/[\uac00-\ud7af]/.test(text)) return { code: 'ko', name: 'Korean', confidence: 'high' };
    return { code: 'zh', name: 'Chinese (Simplified)', confidence: 'high' };
  }
  // Arabic
  if (/[\u0600-\u06ff]/.test(text)) return { code: 'ar', name: 'Arabic', confidence: 'high' };
  // Cyrillic (Russian)
  if (/[\u0400-\u04ff]/.test(text)) return { code: 'ru', name: 'Russian', confidence: 'high' };
  // Devanagari (Hindi)
  if (/[\u0900-\u097f]/.test(text)) return { code: 'hi', name: 'Hindi', confidence: 'high' };
  // Thai
  if (/[\u0e00-\u0e7f]/.test(text)) return { code: 'th', name: 'Thai', confidence: 'high' };
  return null;
}

// ============================================
// MULTI-LANGUAGE REPLY GENERATOR
// ============================================

/**
 * generateMultiLanguageReply()
 * Generate a reply in the same language as the review
 * Falls back to English if language is unsupported
 *
 * @param {Object} review - Review data
 * @param {Object} businessProfile - Business settings
 * @param {Object} detectedLanguage - From detectLanguage()
 * @returns {Object} { reply, language, translatedFor }
 */
async function generateMultiLanguageReply(review, businessProfile, detectedLanguage) {
  const langCode = detectedLanguage?.code || 'en';
  const langName = detectedLanguage?.name || 'English';
  const isEnglish = langCode === 'en';

  // For English, use the standard AI service (no change needed)
  if (isEnglish) {
    return { replyLanguage: 'en', replyLanguageName: 'English', isTranslated: false };
  }

  // Check if language is supported
  if (!SUPPORTED_LANGUAGES[langCode]) {
    logger.info(`Language ${langCode} not in supported list — defaulting to English`);
    return { replyLanguage: 'en', replyLanguageName: 'English', isTranslated: false };
  }

  try {
    const toneGuide = {
      5: 'enthusiastic and genuinely grateful',
      4: 'warm and appreciative, gently acknowledge any minor feedback',
      3: 'balanced and solution-focused',
      2: 'empathetic and constructive',
      1: 'deeply empathetic, take the complaint very seriously'
    };

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: `You are a professional review response writer. 
Write the response in ${langName} ONLY.
Keep the same cultural norms and politeness level appropriate for ${langName}-speaking customers.
Under 150 words. Sound like a real human business owner.
Follow these rules: never admit legal fault, never name staff negatively, always offer private contact for complaints, no ALL CAPS.
${businessProfile.isHealthcare ? 'This is a healthcare business — never confirm patient status.' : ''}
Return only the reply text, nothing else.`,
      messages: [{
        role: 'user',
        content: `Write a reply to this ${langName} review for ${businessProfile.businessName}.
Star rating: ${review.star_rating}/5
Tone: ${toneGuide[review.star_rating] || 'professional and warm'}
Review: "${review.review_text}"
Contact email for complaints: ${businessProfile.contactEmail || 'our team'}
Always include: ${businessProfile.alwaysInclude?.join(', ') || 'none'}
Never include: ${businessProfile.neverInclude?.join(', ') || 'none'}`
      }]
    });

    const reply = message.content[0]?.text?.trim();
    if (!reply || reply.length < 5) throw new Error('Empty reply generated');

    return {
      reply,
      replyLanguage: langCode,
      replyLanguageName: langName,
      isTranslated: true
    };

  } catch (error) {
    logger.error(`Multi-language reply failed for ${langCode}:`, error.message);
    // Return null to signal fallback to English
    return { replyLanguage: 'en', replyLanguageName: 'English', isTranslated: false, fallback: true };
  }
}

/**
 * updateReviewLanguage()
 * Store detected language on the review record
 */
async function updateReviewLanguage(reviewId, languageCode) {
  const { query } = require('../database/db');
  try {
    await query(
      'UPDATE reviews SET language = $1 WHERE id = $2',
      [languageCode, reviewId]
    );
  } catch (error) {
    logger.error('Failed to update review language:', error.message);
  }
}

module.exports = {
  detectLanguage,
  generateMultiLanguageReply,
  updateReviewLanguage,
  SUPPORTED_LANGUAGES
};
