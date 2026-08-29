'use strict';

/**
 * Sensitive value masking (§37).
 *
 * §37 splits its list in two, and the split is the important part. Passwords,
 * CVVs, UPI PINs, tokens, API keys and database passwords are *never logged* -
 * there is no masked form of them that is worth having, so they are removed by
 * the logger's redaction rules rather than passed through anything here.
 *
 * What this module is for is the other half: identifiers that are genuinely
 * useful in a log and genuinely personal. An email is how support finds the
 * account a complaint belongs to, and `t***@example.com` is enough to confirm
 * "yes, that is the address you gave us" without the log itself becoming a
 * mailing list if it is ever exported.
 *
 * Everything here is total: no input throws, and anything unrecognisable comes
 * back as null rather than as itself. A masking function that falls through to
 * the raw value on a shape it did not expect is worse than none at all,
 * because it looks like it is working.
 */

/**
 * `timothy@example.com` -> `t***@example.com`.
 *
 * The domain is kept whole. It carries no personal information on its own and
 * it is often the actual signal - a spike of failures from one corporate domain
 * says something a masked domain would hide.
 */
function maskEmail(value) {
  if (typeof value !== 'string') return null;
  const at = value.lastIndexOf('@');
  // No '@', or nothing on one side of it: not an address, so nothing to mask
  // shape-preservingly. Report that it was present without echoing it.
  if (at < 1 || at === value.length - 1) return '***';
  return `${value[0]}***${value.slice(at)}`;
}

/**
 * `+919876541234` -> `******1234`.
 *
 * The last four digits are the convention every support desk already uses to
 * confirm a number over the phone. Non-digits are dropped first so that a
 * number stored with spaces, dashes or a country code masks identically -
 * otherwise the same phone produces two different strings and grouping breaks.
 */
function maskPhone(value) {
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `******${digits.slice(-4)}`;
}

/**
 * Anything that is a secret rather than an identifier: a token, a key, a
 * signature. Only its length survives, which is occasionally the whole answer
 * ("the key is 0 characters long" is a configuration bug).
 */
function maskSecret(value) {
  if (value === null || value === undefined) return null;
  return `[redacted:${String(value).length}]`;
}

/** Masks the identifying fields of a user row, for log context (§31). */
function maskUser(user) {
  if (!user) return null;
  return {
    id: user.id ?? null,
    email: user.email ? maskEmail(user.email) : undefined,
    phone: user.phone ? maskPhone(user.phone) : undefined,
  };
}

module.exports = { maskEmail, maskPhone, maskSecret, maskUser };
