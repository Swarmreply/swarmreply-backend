// ============================================
// config/features.js
// Backend feature kill-switches. Flip to true and redeploy
// when the feature is ready for customers.
// ============================================

module.exports = {
  AUTO_REPLY_ENABLED: true,      // LIVE: AI replies generate for every new review; posting honors each location's approval_mode
  SOCIAL_POSTING_ENABLED: false, // Q3 2026: reserved for social posting backend gating
};
