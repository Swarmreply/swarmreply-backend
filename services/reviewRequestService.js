// ============================================
// services/reviewRequestService.js
// Review request template generator
// Creates personalised email/SMS templates
// that businesses send to customers to ask
// for Google reviews
// ============================================

const Anthropic = require('@anthropic-ai/sdk');
const { query } = require('../database/db');
const logger          = require('../utils/logger');
const platformService = require('./platformService');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================
// DEFAULT TEMPLATE LIBRARY
// ============================================

/**
 * DEFAULT_TEMPLATES
 * Pre-built templates for every business type
 * Customers can use these immediately or customise
 */
const DEFAULT_TEMPLATES = {
  email: {
    restaurant: {
      subject: 'How was your visit to {{business_name}}?',
      body: `Hi {{customer_name}},

Thank you so much for dining with us at {{business_name}} recently. We truly hope you enjoyed your experience.

If you have a moment, we'd love to hear your thoughts. Leaving us a quick Google review helps other food lovers discover us — and it means the world to our team.

It only takes 60 seconds:
{{review_link}}

Thank you for your support,
{{owner_name}}
{{business_name}}`
    },
    dental: {
      subject: 'Thank you for visiting {{business_name}}',
      body: `Hi {{customer_name}},

Thank you for choosing {{business_name}} for your dental care. We hope your visit was comfortable and that you're happy with your results.

If you have a moment, sharing your experience on Google helps other patients find trusted dental care in our area:
{{review_link}}

Your feedback helps us continue improving our practice.

Warm regards,
{{owner_name}}
{{business_name}}`
    },
    gym: {
      subject: 'How\'s your progress at {{business_name}}?',
      body: `Hey {{customer_name}},

We love having you as part of the {{business_name}} community! Your commitment to your fitness goals inspires our whole team.

If you're happy with your experience so far, would you take 60 seconds to share it on Google? It helps us grow our community:
{{review_link}}

Keep crushing it,
{{owner_name}}
{{business_name}}`
    },
    medspa: {
      subject: 'How are you feeling after your visit?',
      body: `Hi {{customer_name}},

Thank you for trusting {{business_name}} with your care. We hope you're feeling refreshed and happy with your results.

If you'd like to share your experience, a Google review helps other clients discover our services:
{{review_link}}

We'd love to see you again soon.

With care,
{{owner_name}}
{{business_name}}`
    },
    default: {
      subject: 'How was your experience at {{business_name}}?',
      body: `Hi {{customer_name}},

Thank you for choosing {{business_name}}. We hope your experience exceeded your expectations.

If you have a moment, we'd be grateful if you could share your experience on Google. It takes less than a minute and makes a big difference to our small business:
{{review_link}}

Thank you for your support,
{{owner_name}}
{{business_name}}`
    }
  },
  sms: {
    restaurant: `Hi {{customer_name}}, thanks for dining at {{business_name}}! If you enjoyed your visit, we'd love a quick Google review — it really helps us: {{review_link}} Thank you! 🙏`,
    dental: `Hi {{customer_name}}, thank you for visiting {{business_name}}. We hope your appointment went well! Would you mind leaving us a Google review? {{review_link}}`,
    gym: `Hey {{customer_name}}! Thanks for being part of {{business_name}}. Would you take 60 secs to leave us a Google review? It means a lot: {{review_link}} 💪`,
    medspa: `Hi {{customer_name}}, thank you for your visit to {{business_name}}. We hope you're loving your results! A quick Google review would mean so much: {{review_link}}`,
    default: `Hi {{customer_name}}, thank you for choosing {{business_name}}! We'd love to hear your feedback — would you leave us a quick Google review? {{review_link}} Thank you!`
  },
  followup: {
    default: {
      subject: 'A quick follow-up from {{business_name}}',
      body: `Hi {{customer_name}},

I wanted to follow up on my earlier message. If you had a positive experience with us, a Google review would mean a great deal to our team and help us reach more customers like you.

Here's the link again — it only takes 60 seconds:
{{review_link}}

If there was anything we could have done better, please reply to this email and let me know personally. I read every message.

Thank you,
{{owner_name}}
{{business_name}}`
    }
  }
};

// ============================================
// AI TEMPLATE GENERATOR
// ============================================

/**
 * generateCustomTemplate()
 * Use Claude to generate a custom review request template
 * tailored to the specific business, tone, and instructions
 *
 * @param {Object} params - Generation parameters
 * @returns {Object} Generated template { subject, body }
 */
async function generateCustomTemplate(params) {
  const {
    businessName,
    businessType,
    ownerName,
    tone,
    channel,        // email | sms
    instructions,   // custom instructions from owner
    reviewLink
  } = params;

  const isEmail = channel === 'email';
  const toneGuide = {
    warm: 'warm, friendly, and personal — like a message from a friend',
    professional: 'professional and polished — appropriate for medical or legal businesses',
    casual: 'casual, fun and upbeat — conversational and energetic',
    empathetic: 'caring and genuine — focuses on the relationship'
  };

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: isEmail ? 500 : 200,
      system: `You write review request templates for local businesses.
The template must feel genuine, never pushy or desperate.
Use these variables exactly as written: {{customer_name}}, {{business_name}}, {{owner_name}}, {{review_link}}
${isEmail ? 'Return JSON: {"subject": "...", "body": "..."}' : 'Return JSON: {"body": "..."}'}
Return valid JSON only, no other text.
Keep SMS under 160 characters if possible (excluding variables).
Keep email body under 150 words.
Never use aggressive language like "please please" or "we desperately need".
Never offer incentives for reviews — this violates Google policy.`,
      messages: [{
        role: 'user',
        content: `Write a ${channel} review request template for:
Business name: ${businessName}
Business type: ${businessType || 'local business'}
Owner name: ${ownerName || 'the owner'}
Tone: ${toneGuide[tone] || toneGuide.warm}
${instructions ? `Special instructions: ${instructions}` : ''}
Review link placeholder: {{review_link}}`
      }]
    });

    const text = message.content[0]?.text?.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    if (!result.body) throw new Error('No body in response');
    return result;

  } catch (error) {
    logger.error('Custom template generation failed:', error.message);
    // Fall back to default template
    const defaults = DEFAULT_TEMPLATES[channel];
    const typeTemplate = defaults[businessType] || defaults.default;
    return isEmail ? typeTemplate : { body: typeTemplate };
  }
}

// ============================================
// TEMPLATE CRUD
// ============================================

/**
 * getTemplates()
 * Get all templates for a location
 * Includes both custom and default templates
 *
 * @param {string} locationId
 * @returns {Array} Templates array
 */
async function getTemplates(locationId) {
  try {
    const result = await query(
      `SELECT * FROM review_request_templates
       WHERE location_id = $1
       ORDER BY is_default DESC, created_at DESC`,
      [locationId]
    );

    return result.rows;
  } catch (error) {
    logger.error(`Failed to get templates for ${locationId}:`, error.message);
    throw error;
  }
}

/**
 * createTemplate()
 * Save a template to the database
 *
 * @param {Object} templateData
 * @returns {Object} Created template
 */
async function createTemplate(templateData) {
  const {
    locationId, name, channel, subject,
    body, isDefault = false
  } = templateData;

  try {
    const result = await query(
      `INSERT INTO review_request_templates
       (location_id, name, channel, subject, body, is_default)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [locationId, name, channel, subject || null, body, isDefault]
    );

    logger.info(`Template created for location ${locationId}: ${name}`);
    return result.rows[0];
  } catch (error) {
    logger.error('Failed to create template:', error.message);
    throw error;
  }
}

/**
 * updateTemplate()
 * Update an existing template
 */
async function updateTemplate(templateId, updates) {
  const { name, subject, body } = updates;
  try {
    const result = await query(
      `UPDATE review_request_templates
       SET name = COALESCE($1, name),
           subject = COALESCE($2, subject),
           body = COALESCE($3, body),
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [name, subject, body, templateId]
    );
    return result.rows[0];
  } catch (error) {
    logger.error('Failed to update template:', error.message);
    throw error;
  }
}

/**
 * deleteTemplate()
 * Delete a custom template (can't delete defaults)
 */
async function deleteTemplate(templateId) {
  try {
    await query(
      'DELETE FROM review_request_templates WHERE id = $1 AND is_default = false',
      [templateId]
    );
  } catch (error) {
    logger.error('Failed to delete template:', error.message);
    throw error;
  }
}

/**
 * seedDefaultTemplates()
 * Create default templates for a new location
 * Called when a location is first connected
 *
 * @param {string} locationId
 * @param {Object} location - Location data (businessType, tone etc)
 */
async function seedDefaultTemplates(locationId, location) {
  try {
    const businessType = location.business_type || 'default';
    const emailDefaults = DEFAULT_TEMPLATES.email;
    const smsDefaults = DEFAULT_TEMPLATES.sms;

    // Get type-specific or fall back to default
    const emailTemplate = emailDefaults[businessType] || emailDefaults.default;
    const smsTemplate = smsDefaults[businessType] || smsDefaults.default;
    const followupTemplate = DEFAULT_TEMPLATES.followup.default;

    // Seed 3 default templates
    const templates = [
      {
        locationId,
        name: 'Email — Standard request',
        channel: 'email',
        subject: emailTemplate.subject,
        body: emailTemplate.body,
        isDefault: true
      },
      {
        locationId,
        name: 'SMS — Quick request',
        channel: 'sms',
        subject: null,
        body: smsTemplate,
        isDefault: true
      },
      {
        locationId,
        name: 'Email — Follow-up (7 days later)',
        channel: 'email',
        subject: followupTemplate.subject,
        body: followupTemplate.body,
        isDefault: true
      }
    ];

    for (const t of templates) {
      // Only seed if not already seeded
      const existing = await query(
        'SELECT id FROM review_request_templates WHERE location_id = $1 AND name = $2',
        [locationId, t.name]
      );
      if (existing.rows.length === 0) {
        await createTemplate(t);
      }
    }

    logger.info(`Default templates seeded for location ${locationId}`);
  } catch (error) {
    logger.error(`Failed to seed templates for ${locationId}:`, error.message);
  }
}

/**
 * previewTemplate()
 * Render a template with sample data for preview
 *
 * @param {string} body - Template body with {{variables}}
 * @param {string} subject - Template subject (email only)
 * @param {Object} location - Location data for preview values
 * @returns {Object} Rendered preview { subject, body }
 */
function previewTemplate(body, subject, location) {
  const sampleData = {
    customer_name: 'Sarah',
    business_name: location.business_name || 'Your Business',
    owner_name: location.owner_name || 'The Team',
    review_link: 'https://g.page/r/your-business/review'
  };

  function replace(text) {
    if (!text) return '';
    return text
      .replace(/\{\{customer_name\}\}/g, sampleData.customer_name)
      .replace(/\{\{business_name\}\}/g, sampleData.business_name)
      .replace(/\{\{owner_name\}\}/g, sampleData.owner_name)
      .replace(/\{\{review_link\}\}/g, sampleData.review_link);
  }

  return {
    subject: replace(subject),
    body: replace(body)
  };
}

/**
 * trackSend()
 * Log when a template was used/sent
 * Tracks usage stats per template
 */
async function trackSend(templateId) {
  try {
    await query(
      `UPDATE review_request_templates
       SET send_count = send_count + 1,
           last_sent_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [templateId]
    );
  } catch (error) {
    logger.error('Failed to track template send:', error.message);
  }
}

module.exports = {
  generateCustomTemplate,
  getTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  seedDefaultTemplates,
  previewTemplate,
  trackSend,
  DEFAULT_TEMPLATES
};
