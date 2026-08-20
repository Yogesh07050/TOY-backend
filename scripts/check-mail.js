'use strict';

/**
 * Verifies the SMTP configuration end to end.
 *
 *   node scripts/check-mail.js                 # verify the connection only
 *   node scripts/check-mail.js you@example.com # ...and send a test message
 *
 * Reports what is wrong in the words Gmail actually uses, because its two
 * common failures - 2-Step Verification off, and an account password used
 * where an App Password is required - look identical from the outside.
 */

const nodemailer = require('nodemailer');
const env = require('../src/config/env');

const HINTS = [
  {
    match: /application-specific password required|username and password not accepted/i,
    text: [
      'Gmail rejected the credentials.',
      '',
      '  1. The password must be a 16-character App Password, not the account password.',
      '  2. App passwords only exist once 2-Step Verification is ON for the account.',
      '     Google Account > Security > 2-Step Verification > App passwords',
      '  3. Paste it with no spaces.',
    ],
  },
  {
    match: /invalid login|authentication failed/i,
    text: ['The mailbox rejected SMTP_USER / SMTP_PASSWORD. Check both for typos.'],
  },
  {
    match: /etimedout|econnrefused|enotfound/i,
    text: [
      'Could not reach the SMTP server.',
      '  - Port 465 needs SMTP_SECURE=true; port 587 needs SMTP_SECURE=false.',
      '  - A network or firewall may be blocking outbound SMTP.',
    ],
  },
];

function explain(error) {
  const message = `${error.message} ${error.response ?? ''}`;
  const hint = HINTS.find((entry) => entry.match.test(message));
  return hint ? hint.text : ['Unrecognised SMTP error - the raw message is above.'];
}

async function main() {
  const recipient = process.argv[2];

  if (!env.mail.host) {
    console.log('SMTP_HOST is empty: mail is written to ./mail-outbox/ instead of sent.');
    console.log('That is a supported mode - nothing to verify.');
    return;
  }

  console.log('Host       : %s:%d (secure: %s)', env.mail.host, env.mail.port, env.mail.secure);
  console.log('Username   : %s', env.mail.user || '(none)');
  console.log('From       : %s', env.mail.from);

  // The From address has to be the authenticated mailbox, or a "Send mail as"
  // alias verified on it. Mismatches are a common silent surprise: Gmail
  // quietly rewrites the sender rather than refusing.
  const fromAddress = /<([^>]+)>/.exec(env.mail.from)?.[1] ?? env.mail.from;
  if (env.mail.user && fromAddress.toLowerCase() !== env.mail.user.toLowerCase()) {
    console.log(
      '\n! MAIL_FROM (%s) is not SMTP_USER (%s).\n  Gmail will rewrite the sender unless it is a verified alias.',
      fromAddress,
      env.mail.user,
    );
  }

  if (!env.mail.password) {
    console.log('\nFAIL: SMTP_PASSWORD is empty.');
    console.log('Add the 16-character App Password for %s to .env', env.mail.user);
    process.exitCode = 1;
    return;
  }

  const transporter = nodemailer.createTransport({
    host: env.mail.host,
    port: env.mail.port,
    secure: env.mail.secure,
    auth: { user: env.mail.user, pass: env.mail.password },
  });

  try {
    await transporter.verify();
    console.log('\nConnection + credentials: OK');
  } catch (error) {
    console.error('\nFAIL: %s', error.message);
    for (const line of explain(error)) console.error('  %s', line);
    process.exitCode = 1;
    return;
  }

  if (!recipient) {
    console.log('\nPass an address to send a real test message:');
    console.log('  node scripts/check-mail.js you@example.com');
    return;
  }

  try {
    const info = await transporter.sendMail({
      from: env.mail.from,
      to: recipient,
      subject: 'Offers App - SMTP test',
      text: 'If you are reading this, the Offers App backend can send email.',
      html: '<p>If you are reading this, the Offers App backend can send email.</p>',
    });
    console.log('Sent to %s (id %s)', recipient, info.messageId);
  } catch (error) {
    console.error('\nFAIL sending: %s', error.message);
    for (const line of explain(error)) console.error('  %s', line);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
