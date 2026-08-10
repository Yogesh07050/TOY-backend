'use strict';

const nodemailer = require('nodemailer');
const env = require('../config/env');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!env.mail.host) {
    // No SMTP configured: log the message so local development still shows the
    // verification / reset links instead of silently dropping them.
    transporter = {
      sendMail: async (message) => {
        console.log('\n--- EMAIL (SMTP not configured) ---');
        console.log('To:      %s', message.to);
        console.log('Subject: %s', message.subject);
        console.log('%s', message.text || message.html);
        console.log('--- END EMAIL ---\n');
        return { messageId: 'console' };
      },
    };
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: env.mail.host,
    port: env.mail.port,
    secure: env.mail.secure,
    auth: env.mail.user ? { user: env.mail.user, pass: env.mail.password } : undefined,
  });
  return transporter;
}

/** Sends an email; failures are logged rather than surfaced to the caller. */
async function send({ to, subject, text, html }) {
  try {
    await getTransporter().sendMail({ from: env.mail.from, to, subject, text, html });
    return true;
  } catch (error) {
    console.error('[mail] failed to send "%s" to %s: %s', subject, to, error.message);
    return false;
  }
}

const layout = (title, body) => `
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1f2937">
  <h2 style="color:#4338ca;margin:0 0 16px">${title}</h2>
  ${body}
  <p style="margin-top:32px;font-size:12px;color:#6b7280">Offers App &middot; This is an automated message.</p>
</div>`;

const templates = {
  verifyEmail: (name, url) => ({
    subject: 'Verify your email address',
    text: `Hi ${name},\n\nConfirm your email address: ${url}\n\nThe link expires in 24 hours.`,
    html: layout(
      'Confirm your email',
      `<p>Hi ${name},</p><p>Please confirm your email address to activate your Offers App account.</p>
       <p><a href="${url}" style="background:#4338ca;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Verify email</a></p>
       <p style="font-size:13px;color:#6b7280">The link expires in 24 hours.</p>`,
    ),
  }),

  resetPassword: (name, url) => ({
    subject: 'Reset your password',
    text: `Hi ${name},\n\nReset your password: ${url}\n\nThe link expires in 1 hour. Ignore this email if you did not request it.`,
    html: layout(
      'Reset your password',
      `<p>Hi ${name},</p><p>We received a request to reset your password.</p>
       <p><a href="${url}" style="background:#4338ca;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Choose a new password</a></p>
       <p style="font-size:13px;color:#6b7280">The link expires in 1 hour. If you did not request this, no action is needed.</p>`,
    ),
  }),

  newOffer: (name, offer, reason, url) => ({
    subject: `${offer.shop_name}: ${offer.title}`,
    text: `Hi ${name},\n\n${reason}\n\n${offer.title}\n${offer.offer_text || ''}\n\nView it here: ${url}`,
    html: layout(
      offer.title,
      `<p>Hi ${name},</p><p>${reason}</p>
       <p style="font-size:18px;font-weight:600">${offer.offer_text || offer.title}</p>
       <p><a href="${url}" style="background:#4338ca;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">View offer</a></p>`,
    ),
  }),

  offerExpiring: (name, offer, url) => ({
    subject: `Ending soon: ${offer.title}`,
    text: `Hi ${name},\n\nA saved offer is about to expire: ${offer.title}\n\n${url}`,
    html: layout(
      'A saved offer is ending soon',
      `<p>Hi ${name},</p><p><strong>${offer.title}</strong> from ${offer.shop_name} expires soon.</p>
       <p><a href="${url}" style="background:#4338ca;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">View offer</a></p>`,
    ),
  }),
};

module.exports = { send, templates };
