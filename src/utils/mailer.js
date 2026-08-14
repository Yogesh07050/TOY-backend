'use strict';

const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');
const env = require('../config/env');

/**
 * Outbound email.
 *
 * When SMTP is configured, mail is sent for real. When it is not, messages are
 * written to `mail-outbox/` as .html files and the actionable link is logged, so
 * signup and password-reset flows can still be completed locally.
 *
 * What this deliberately does not do is pretend. `send()` reports which path it
 * took, and the API passes that up so the UI can say "check your inbox" or
 * "email is not configured on this server" truthfully.
 */

/** True when a real SMTP transport is configured. */
const isConfigured = Boolean(env.mail.host);

const OUTBOX_DIR = path.resolve(__dirname, '../../mail-outbox');

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.mail.host,
      port: env.mail.port,
      secure: env.mail.secure,
      auth: env.mail.user ? { user: env.mail.user, pass: env.mail.password } : undefined,
    });
  }
  return transporter;
}

/** Pulls the first http(s) link out of a message, for logging. */
function firstLink(text = '') {
  const match = /https?:\/\/\S+/.exec(text);
  return match ? match[0] : null;
}

function writeToOutbox(message) {
  try {
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeTo = String(message.to).replace(/[^a-z0-9@._-]/gi, '_');
    const file = path.join(OUTBOX_DIR, `${stamp}__${safeTo}.html`);
    fs.writeFileSync(
      file,
      `<!-- To: ${message.to}\n     Subject: ${message.subject} -->\n${message.html || `<pre>${message.text}</pre>`}`,
    );
    return file;
  } catch (error) {
    console.error('[mail] could not write to the outbox: %s', error.message);
    return null;
  }
}

/**
 * Sends an email.
 * @returns {Promise<{delivered: boolean, transport: 'smtp'|'outbox', error?: string}>}
 */
async function send({ to, subject, text, html }) {
  if (!isConfigured) {
    const file = writeToOutbox({ to, subject, text, html });
    const link = firstLink(text);

    console.warn(
      '\n[mail] SMTP is not configured - "%s" for %s was NOT sent.\n' +
        '       Saved to: %s\n' +
        (link ? '       Link:     %s\n' : '%s') +
        '       Set SMTP_HOST and friends in .env to deliver mail for real.\n',
      subject,
      to,
      file ?? '(outbox unavailable)',
      link ?? '',
    );
    return { delivered: false, transport: 'outbox' };
  }

  try {
    await getTransporter().sendMail({ from: env.mail.from, to, subject, text, html });
    return { delivered: true, transport: 'smtp' };
  } catch (error) {
    console.error('[mail] failed to send "%s" to %s: %s', subject, to, error.message);
    return { delivered: false, transport: 'smtp', error: error.message };
  }
}

/**
 * Checks the SMTP connection once at boot so a bad password surfaces on
 * startup rather than the first time a customer resets their password.
 */
async function verifyTransport() {
  if (!isConfigured) {
    console.warn(
      '[mail] SMTP_HOST is empty - verification and password-reset emails will be written to\n' +
        '       %s instead of being sent. See .env.example to configure delivery.',
      OUTBOX_DIR,
    );
    return false;
  }

  try {
    await getTransporter().verify();
    console.log('[mail] SMTP ready at %s:%d', env.mail.host, env.mail.port);
    return true;
  } catch (error) {
    console.error(
      '[mail] SMTP at %s:%d is NOT working: %s\n' +
        '       Emails will fail until this is fixed.',
      env.mail.host,
      env.mail.port,
      error.message,
    );
    return false;
  }
}

const layout = (title, body) => `
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1f2937">
  <h2 style="color:#b45309;margin:0 0 16px">${title}</h2>
  ${body}
  <p style="margin-top:32px;font-size:12px;color:#6b7280">Offers App &middot; This is an automated message.</p>
</div>`;

const button = (url, label) =>
  `<a href="${url}" style="background:#f59e0b;color:#3b2600;font-weight:600;padding:10px 18px;border-radius:8px;text-decoration:none">${label}</a>`;

const templates = {
  verifyEmail: (name, url) => ({
    subject: 'Verify your email address',
    text: `Hi ${name},\n\nConfirm your email address: ${url}\n\nThe link expires in 24 hours.`,
    html: layout(
      'Confirm your email',
      `<p>Hi ${name},</p><p>Please confirm your email address to activate your Offers App account.</p>
       <p>${button(url, 'Verify email')}</p>
       <p style="font-size:13px;color:#6b7280">The link expires in 24 hours.</p>`,
    ),
  }),

  resetPassword: (name, url) => ({
    subject: 'Reset your password',
    text: `Hi ${name},\n\nReset your password: ${url}\n\nThe link expires in 1 hour. Ignore this email if you did not request it.`,
    html: layout(
      'Reset your password',
      `<p>Hi ${name},</p><p>We received a request to reset your password.</p>
       <p>${button(url, 'Choose a new password')}</p>
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
       <p>${button(url, 'View offer')}</p>`,
    ),
  }),

  offerExpiring: (name, offer, url) => ({
    subject: `Ending soon: ${offer.title}`,
    text: `Hi ${name},\n\nA saved offer is about to expire: ${offer.title}\n\n${url}`,
    html: layout(
      'A saved offer is ending soon',
      `<p>Hi ${name},</p><p><strong>${offer.title}</strong> from ${offer.shop_name} expires soon.</p>
       <p>${button(url, 'View offer')}</p>`,
    ),
  }),

  serviceOfferExpiring: (name, offer, url) => ({
    subject: `Ending soon: ${offer.title}`,
    text: `Hi ${name},\n\nA saved service deal is about to expire: ${offer.title}\n\n${url}`,
    html: layout(
      "Don't miss this service deal",
      `<p>Hi ${name},</p><p><strong>${offer.title}</strong> at ${offer.shop_name} expires soon.</p>
       <p>${button(url, 'View service')}</p>`,
    ),
  }),
};

module.exports = { send, templates, verifyTransport, isConfigured, OUTBOX_DIR };
