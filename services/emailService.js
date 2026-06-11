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
      subject: `Your SwarmReply Weekly Summary`,
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
  const firstName = (customer.name || 'there').split(' ')[0];
  try {
    await getResend().emails.send({
      from: process.env.EMAIL_FROM || 'hello@swarmreply.com',
      to: customer.email,
      subject: `Welcome to SwarmReply — your reputation dashboard is ready`,
      html: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="margin:0;padding:0;background:#f8f7f4;font-family:'Helvetica Neue',Arial,sans-serif">
          <div style="max-width:560px;margin:40px auto;padding:0 20px">

            <!-- Logo -->
            <div style="text-align:center;margin-bottom:32px">
              <span style="font-size:26px;font-weight:900;color:#0a0a0a;letter-spacing:-.5px;display:inline-flex;align-items:center;gap:10px"><img src="https://swarmreply.com/bee-logo.png" alt="SwarmReply" style="width:206px;height:206px;object-fit:contain;display:inline-block;vertical-align:middle"> SwarmReply</span>
            </div>

            <!-- Card -->
            <div style="background:white;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.07)">

              <!-- Header -->
              <div style="background:#0a0a0a;padding:32px 36px">
                <div style="font-size:22px;font-weight:900;color:white;margin-bottom:8px;line-height:1.2">
                  Your swarm is ready, ${firstName}. 🎉
                </div>
                <div style="font-size:14px;color:rgba(255,255,255,.5);line-height:1.6">
                  Your AI reputation dashboard is live and ready to explore
                </div>
              </div>

              <!-- Body -->
              <div style="padding:32px 36px">
                <p style="font-size:15px;color:#3a3a38;line-height:1.75;margin:0 0 20px">
                  Welcome aboard! You now have access to the complete SwarmReply platform —
                  AI review replies, reputation analytics, LLM visibility monitoring, listings sync,
                  webchat, SMS campaigns, and more.
                </p>

                <p style="font-size:15px;color:#3a3a38;line-height:1.75;margin:0 0 28px">
                  Your first step: connect your Google Business Profile so SwarmReply can start
                  monitoring your reviews and replying automatically. It takes about 30 seconds.
                </p>

                <!-- What's waiting -->
                <div style="background:#f8f7f4;border-radius:12px;padding:20px 24px;margin-bottom:28px">
                  <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#7a7670;margin-bottom:14px">What's inside your dashboard</div>
                  <table style="width:100%;border-collapse:collapse">
                    <tr><td style="padding:8px 0;border-bottom:1px solid #ede9e4;font-size:14px;font-weight:700;color:#0a0a0a">⭐ &nbsp;AI Review Replies</td></tr>
                    <tr><td style="padding:8px 0;border-bottom:1px solid #ede9e4;font-size:14px;font-weight:700;color:#0a0a0a">🤖 &nbsp;LLM Visibility</td></tr>
                    <tr><td style="padding:8px 0;border-bottom:1px solid #ede9e4;font-size:14px;font-weight:700;color:#0a0a0a">📊 &nbsp;Reputation Analytics</td></tr>
                    <tr><td style="padding:8px 0;border-bottom:1px solid #ede9e4;font-size:14px;font-weight:700;color:#0a0a0a">💬 &nbsp;Webchat &amp; AI Inbox</td></tr>
                    <tr><td style="padding:8px 0;border-bottom:1px solid #ede9e4;font-size:14px;font-weight:700;color:#0a0a0a">📲 &nbsp;SMS Campaigns</td></tr>
                    <tr><td style="padding:8px 0;font-size:14px;font-weight:700;color:#7a7670">...and so much more</td></tr>
                  </table>
                </div>

                <!-- CTA -->
                <div style="text-align:center">
                  <a href="https://app.swarmreply.com/dashboard"
                     style="display:inline-block;background:#f5c842;color:#0a0a0a;padding:15px 36px;border-radius:50px;text-decoration:none;font-weight:700;font-size:15px;letter-spacing:-.2px">
                    Open your dashboard →
                  </a>
                  <div style="margin-top:12px;font-size:13px;color:#7a7670">
                    Questions? Reply to this email anytime — we read every one.
                  </div>
                </div>
              </div>

              <!-- Footer -->
              <div style="padding:20px 36px;border-top:1px solid #f0ede8;text-align:center">
                <div style="font-size:12px;color:#b0ada8">
                  SwarmReply · AI Reputation Management · <a href="https://swarmreply.com" style="color:#b0ada8">swarmreply.com</a>
                </div>
              </div>

            </div>
          </div>
        </body>
        </html>
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
      subject: `You're in — your SwarmReply login details`,
      html: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="margin:0;padding:0;background:#f8f7f4;font-family:'Helvetica Neue',Arial,sans-serif">
          <div style="max-width:560px;margin:40px auto;padding:0 20px">

            <!-- Logo -->
            <div style="text-align:center;margin-bottom:32px">
              <span style="font-size:28px;font-weight:900;color:#0a0a0a;letter-spacing:-.5px">
                <img src="https://swarmreply.com/bee-logo.png" alt="🐝" style="width:38px;height:38px;object-fit:contain;vertical-align:middle;display:inline-block"> SwarmReply
              </span>
            </div>

            <!-- Card -->
            <div style="background:white;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.07)">

              <!-- Header -->
              <div style="background:#0a0a0a;padding:32px 36px">
                <div style="font-size:22px;font-weight:900;color:white;margin-bottom:8px;line-height:1.2">
                  Welcome to SwarmReply, ${name ? name.split(' ')[0] : 'there'}! 🎉
                </div>
                <div style="font-size:14px;color:rgba(255,255,255,.55);line-height:1.6">
                  Your AI reputation dashboard is live and ready to explore
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
                  — we respond to every message. <img src="https://swarmreply.com/bee-logo.png" alt="🐝" style="width:38px;height:38px;object-fit:contain;vertical-align:middle;display:inline-block">
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

async function sendPasswordReset({ email, name, resetUrl }) {
  const firstName = (name || '').trim().split(' ')[0] || 'there';
  try {
    await getResend().emails.send({
      from:    process.env.EMAIL_FROM || 'hello@swarmreply.com',
      to:      email,
      subject: 'Reset your SwarmReply password',
      html: [
        '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
        '<body style="margin:0;padding:0;background:#f4f4f0;font-family:Arial,sans-serif">',
        '<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 16px">',
        '<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#fff;border-radius:12px;overflow:hidden">',
        '<tr><td style="background:#f5c842;padding:18px 28px"><strong style="font-size:18px;color:#0a0a0a">SwarmReply</strong></td></tr>',
        '<tr><td style="padding:32px 28px">',
        '<h2 style="margin:0 0 14px;font-size:1.2rem;color:#0a0a0a">Reset your password</h2>',
        '<p style="font-size:.9rem;line-height:1.7;color:#3a3a38;margin:0 0 24px">Hi ' + firstName + ', we received a request to reset your password. This link expires in 1 hour. If you did not request it, you can safely ignore this email.</p>',
        '<div style="text-align:center;margin-bottom:8px">',
        '<a href="' + resetUrl + '" style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:13px 30px;border-radius:50px;font-weight:700;font-size:.9rem">Reset password</a>',
        '</div></td></tr></table></td></tr></table></body></html>'
      ].join(''),
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

/**
 * sendSupportRequest()
 * Sends a customer's in-app support message to the SwarmReply team inbox.
 * reply_to is set to the customer's email so replying in Gmail goes straight
 * back to them. Throws on failure so the route can tell the customer to
 * email directly instead of silently losing the message.
 */
async function sendSupportRequest({ customer, subject, message }) {
  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const inbox = process.env.SUPPORT_INBOX || 'nick@swarmreply.com';

  await getResend().emails.send({
    from:     process.env.EMAIL_FROM || 'SwarmReply <hello@swarmreply.com>',
    to:       inbox,
    reply_to: customer.email,
    subject:  `[Support] ${subject} — ${customer.name || customer.email}`,
    html: `
      <div style="font-family: sans-serif; max-width: 640px; margin: 0 auto; padding: 32px 20px;">
        <h2 style="font-size: 18px; color: #0d0d0d; margin: 0 0 4px;">New support request</h2>
        <p style="color: #999; font-size: 13px; margin: 0 0 20px;">Sent from the in-app Support page — just hit reply to answer the customer.</p>

        <table style="border-collapse: collapse; font-size: 14px; color: #333; margin-bottom: 24px;">
          <tr><td style="padding: 4px 16px 4px 0; color: #999;">Customer</td><td style="padding: 4px 0;"><strong>${esc(customer.name)}</strong></td></tr>
          <tr><td style="padding: 4px 16px 4px 0; color: #999;">Email</td><td style="padding: 4px 0;">${esc(customer.email)}</td></tr>
          <tr><td style="padding: 4px 16px 4px 0; color: #999;">Plan</td><td style="padding: 4px 0;">${esc(customer.plan || 'unknown')}</td></tr>
          <tr><td style="padding: 4px 16px 4px 0; color: #999;">Customer ID</td><td style="padding: 4px 0; font-family: monospace; font-size: 12px;">${esc(customer.id)}</td></tr>
        </table>

        <div style="background: #f8f7f4; border-radius: 12px; padding: 20px 22px;">
          <div style="font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #999; margin-bottom: 8px;">${esc(subject)}</div>
          <div style="font-size: 15px; color: #0d0d0d; line-height: 1.6; white-space: pre-wrap;">${esc(message)}</div>
        </div>
      </div>
    `
  });

  logger.info(`Support request sent from customer ${customer.id} (${customer.email})`);
}

module.exports = {
  sendWeeklyDigest,
  sendWelcomeEmail,
  sendWelcomeWithCredentials,
  sendConnectionErrorAlert,
  sendPasswordReset,
  sendSupportRequest
};
