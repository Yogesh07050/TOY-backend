'use strict';

const { z } = require('zod');

/**
 * A boolean that survives a query string.
 *
 * `z.coerce.boolean()` is just `Boolean(value)`, and every non-empty string is
 * truthy - including the string "false". Query parameters are always strings,
 * so a query schema built on the coercing version reads `?flag=false` as true.
 * That is how the notification centre came to hide every notification the
 * moment it was read: the app sends `unreadOnly=false`, and the server heard
 * "unread only, yes".
 *
 * This reads the word rather than the truthiness. A real boolean is passed
 * through unchanged, so the same helper works for a JSON body.
 *
 * Use it for anything parsed out of `req.query`. Request bodies reach us as
 * JSON, where a boolean arrives as a boolean and `z.coerce.boolean()` is
 * harmless - that is why the body schemas still use it. If a body ever starts
 * arriving as multipart or urlencoded, its booleans become strings too and
 * they will need this as well.
 *
 * @param {boolean} [defaultValue] applied when the parameter is absent.
 */
const TRUE_WORDS = new Set(['true', '1', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off', '']);

function queryBoolean(defaultValue) {
  const base = z
    .union([z.boolean(), z.string()])
    .superRefine((value, ctx) => {
      if (typeof value === 'boolean') return;
      const word = value.trim().toLowerCase();
      if (!TRUE_WORDS.has(word) && !FALSE_WORDS.has(word)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Expected a boolean, received "${value}"`,
        });
      }
    })
    .transform((value) => (typeof value === 'boolean' ? value : TRUE_WORDS.has(value.trim().toLowerCase())));

  return defaultValue === undefined ? base.optional() : base.optional().default(defaultValue);
}

module.exports = { queryBoolean };
