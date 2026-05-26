// ============================================
// services/emailService.js
// All transactional emails via Resend
// ============================================

const { Resend } = require('resend');
const logger = require('../utils/logger');

let _resend = null;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY || 'placeholder');
  return _resend;
}

/**
 * sendWeeklyDigest()
 * Weekly summary email to customer
 */
async function sendWeeklyDigest(customer) {
  try {
    await getResend().emails.send({
      from: process.env.EMAIL_FROM,
      to: customer.email,
      subject: `Your SwarmReply Weekly Summary 🐝`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="font-size: 24px; color: #0d0d0d;">Your week in reviews</h1>
          <p style="color: #666;">Hi ${customer.name},</p>
          <p style="color: #666;">Here's what SwarmReply handled for you this week:</p>

          <div style="background: #f8f7f4; border-radius: 12px; padding: 24px; margin: 24px 0;">
            <div style="display: flex; gap: 24px;">
              <div style="text-align: center;">
                <div style="font-size: 32px; font-weight: 700; color: #0d0d0d;">${customer.reply_count}</div>
                <div style="font-size: 14px; color: #666;">Reviews replied to</div>
              </div>
              <div style="text-align: center;">
                <div style="font-size: 32px; font-weight: 700; color: #0d0d0d;">${parseFloat(customer.avg_rating || 0).toFixed(1)}★</div>
                <div style="font-size: 14px; color: #666;">Average rating</div>
              </div>
            </div>
          </div>

          <p style="color: #666;">All replies were professional, on-brand, and posted automatically — you didn't have to lift a finger.</p>

          <a href="https://swarmreply.com/dashboard"
             style="display: inline-block; background: #0d0d0d; color: white; padding: 14px 28px; border-radius: 50px; text-decoration: none; font-weight: 600; margin-top: 16px;">
            View Your Dashboard
          </a>

          <p style="color: #999; font-size: 12px; margin-top: 40px;">
            SwarmReply | hello@swarmreply.com<br>
            <a href="https://swarmreply.com/unsubscribe" style="color: #999;">Unsubscribe from digest emails</a>
          </p>
        </div>
      `
    });

    logger.info(`Weekly digest sent to: ${customer.email}`);
  } catch (error) {
    logger.error(`Failed to send digest to ${customer.email}:`, error.message);
  }
}

/**
 * sendWelcomeEmail()
 * Sent when new customer connects their first location
 */
async function sendWelcomeEmail(customer, locationName) {
  try {
    await getResend().emails.send({
      from: process.env.EMAIL_FROM,
      to: customer.email,
      subject: `Your swarm is live 🐝 — ${locationName}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="font-size: 24px; color: #0d0d0d;">You're all set, ${customer.name}!</h1>
          <p style="color: #666;">SwarmReply is now monitoring <strong>${locationName}</strong> and will automatically reply to every new review within 1 business day.</p>
          <p style="color: #666;">You don't need to do anything — we've got it from here.</p>
          <a href="https://swarmreply.com/dashboard"
             style="display: inline-block; background: #0d0d0d; color: white; padding: 14px 28px; border-radius: 50px; text-decoration: none; font-weight: 600; margin-top: 16px;">
            View Dashboard
          </a>
        </div>
      `
    });
  } catch (error) {
    logger.error(`Failed to send welcome email to ${customer.email}:`, error.message);
  }
}

/**
 * sendConnectionErrorAlert()
 * Alert customer when their Google connection breaks
 */
async function sendConnectionErrorAlert(customer, locationName) {
  try {
    await getResend().emails.send({
      from: process.env.EMAIL_FROM,
      to: customer.email,
      subject: `Action needed — SwarmReply connection issue`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="font-size: 24px; color: #0d0d0d;">Connection issue detected</h1>
          <p style="color: #666;">Hi ${customer.name},</p>
          <p style="color: #666;">SwarmReply lost its connection to <strong>${locationName}</strong> on Google. This usually happens when Google revokes access after a password change.</p>
          <p style="color: #666;">Your reviews are not being replied to until this is fixed. It takes less than 2 minutes to reconnect.</p>
          <a href="https://swarmreply.com/dashboard/reconnect"
             style="display: inline-block; background: #0d0d0d; color: white; padding: 14px 28px; border-radius: 50px; text-decoration: none; font-weight: 600; margin-top: 16px;">
            Reconnect Now
          </a>
        </div>
      `
    });
  } catch (error) {
    logger.error(`Failed to send connection alert to ${customer.email}:`, error.message);
  }
}


/**
 * sendWelcomeWithCredentials()
 * Sent to brand-new customers after Stripe checkout.
 * Includes their temp password and a forced-reset link.
 */
async function sendWelcomeWithCredentials({ email, name, plan, tempPassword, resetUrl, dashUrl }) {
  const planLabel = plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : 'Starter';
  const prices    = { starter: '$99', growth: '$199', agency: 'custom' };
  const price     = prices[plan] || '$99';

  try {
    await getResend().emails.send({
      from:    process.env.EMAIL_FROM || 'hello@swarmreply.com',
      to:      email,
      subject: `Welcome to SwarmReply — your login details`,
      html: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="margin:0;padding:0;background:#f8f7f4;font-family:'Helvetica Neue',Arial,sans-serif">
          <div style="max-width:560px;margin:40px auto;padding:0 20px">

            <!-- Logo -->
            <div style="text-align:center;margin-bottom:32px">
              <span style="font-size:28px;font-weight:900;color:#0a0a0a;letter-spacing:-.5px">
                🐝 SwarmReply
              </span>
            </div>

            <!-- Card -->
            <div style="background:white;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.07)">

              <!-- Header -->
              <div style="background:#0a0a0a;padding:32px 36px">
                <div style="font-size:22px;font-weight:900;color:white;margin-bottom:8px;line-height:1.2">
                  Your swarm is ready, ${name || 'there'}!
                </div>
                <div style="font-size:14px;color:rgba(255,255,255,.55);line-height:1.6">
                  ${planLabel} plan · ${price}/mo · No contracts
                </div>
              </div>

              <!-- Body -->
              <div style="padding:32px 36px">
                <p style="font-size:15px;color:#3a3a38;line-height:1.75;margin:0 0 24px">
                  Welcome to SwarmReply — the complete AI reputation management platform
                  for your business. Here are your login details.
                </p>

                <!-- Credentials box -->
                <div style="background:#f8f7f4;border:1.5px solid #e4e0d8;border-radius:12px;
                             padding:20px 24px;margin-bottom:24px">
                  <div style="font-size:11px;font-weight:700;letter-spacing:.1em;
                               text-transform:uppercase;color:#7a7670;margin-bottom:12px">
                    Your login credentials
                  </div>
                  <div style="margin-bottom:8px">
                    <span style="font-size:13px;color:#7a7670;display:block;margin-bottom:2px">Email</span>
                    <span style="font-size:15px;font-weight:600;color:#0a0a0a">${email}</span>
                  </div>
                  <div>
                    <span style="font-size:13px;color:#7a7670;display:block;margin-bottom:2px">Temporary password</span>
                    <span style="font-size:15px;font-weight:600;color:#0a0a0a;
                                 font-family:monospace;letter-spacing:.05em">${tempPassword}</span>
                  </div>
                </div>

                <!-- Security notice -->
                <div style="background:#fff8e8;border:1px solid #fde68a;border-radius:10px;
                             padding:13px 16px;margin-bottom:24px">
                  <div style="font-size:13px;color:#92690a;line-height:1.6">
                    <strong>Set your own password</strong> — for security, please create
                    a permanent password before logging in.
                  </div>
                </div>

                <!-- Primary CTA -->
                <div style="text-align:center;margin-bottom:16px">
                  <a href="${resetUrl}" style="display:inline-block;background:#0a0a0a;color:white;
                     padding:14px 32px;border-radius:50px;text-decoration:none;
                     font-size:15px;font-weight:700">
                    Set my password →
                  </a>
                </div>

                <div style="text-align:center;margin-bottom:28px">
                  <a href="${dashUrl}" style="font-size:13px;color:#7a7670;text-decoration:none">
                    Or log in with your temporary password →
                  </a>
                </div>

                <!-- What to do next -->
                <div style="border-top:1px solid #f0eeea;padding-top:24px">
                  <div style="font-size:13px;font-weight:700;color:#0a0a0a;margin-bottom:14px">
                    3 things to do first
                  </div>
                  ${[
                    ['Connect Google Business Profile', 'Settings → Integrations → Connect Google. Takes 30 seconds.'],
                    ['Set your AI reply tone',          'Settings → AI Replies → choose Warm, Professional, or Casual.'],
                    ['Send your first review request',  'Grow → Review Requests → pick a happy customer and send.'],
                  ].map(([title, desc], i) => `
                    <div style="display:flex;gap:12px;margin-bottom:12px">
                      <div style="width:24px;height:24px;border-radius:50%;background:#f5c842;
                                   display:flex;align-items:center;justify-content:center;
                                   font-size:12px;font-weight:800;color:#0a0a0a;flex-shrink:0">
                        ${i + 1}
                      </div>
                      <div>
                        <div style="font-size:13px;font-weight:600;color:#0a0a0a">${title}</div>
                        <div style="font-size:13px;color:#7a7670;line-height:1.5">${desc}</div>
                      </div>
                    </div>
                  `).join('')}
                </div>
              </div>

              <!-- Footer -->
              <div style="background:#f8f7f4;padding:20px 36px;border-top:1px solid #f0eeea">
                <p style="font-size:12px;color:#7a7670;margin:0;line-height:1.6">
                  Questions? Reply to this email or write to us at
                  <a href="mailto:hello@swarmreply.com" style="color:#0a0a0a;font-weight:600">
                    hello@swarmreply.com
                  </a>
                  — we respond to every message. 🐝
                </p>
              </div>
            </div>

            <p style="text-align:center;font-size:12px;color:#7a7670;margin-top:24px">
              SwarmReply · No contracts · Cancel anytime
            </p>
          </div>
        </body>
        </html>
      `.replace(/\$\{([^}]+)\}/g, (_, k) => ({
        name, email, plan: planLabel, price, tempPassword, resetUrl, dashUrl
      }[k] || ''))
    });
    logger.info(`Welcome + credentials email sent to ${email}`);
    return true;
  } catch (err) {
    logger.error(`Failed to send welcome credentials email to ${email}:`, err.message);
    return false;
  }
}

module.exports = {
  sendWeeklyDigest,
  sendWelcomeEmail,
  sendWelcomeWithCredentials,
  sendConnectionErrorAlert
};
