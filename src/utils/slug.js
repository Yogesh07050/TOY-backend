'use strict';

const { queryOne } = require('../db/pool');

const slugify = (value) =>
  String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 150) || 'item';

/**
 * Returns a slug that is unique within `table`, appending -2, -3 ... as needed.
 * `excludeId` lets an update keep its own slug.
 */
async function uniqueSlug(table, value, excludeId = null) {
  const base = slugify(value);
  let candidate = base;
  let suffix = 1;

  // Table name is never user supplied - callers pass a literal.
  for (;;) {
    const row = await queryOne(
      `SELECT id FROM \`${table}\` WHERE slug = ? ${excludeId ? 'AND id <> ?' : ''} LIMIT 1`,
      excludeId ? [candidate, excludeId] : [candidate],
    );
    if (!row) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
}

module.exports = { slugify, uniqueSlug };
