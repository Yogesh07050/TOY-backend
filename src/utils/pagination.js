'use strict';

const { z } = require('zod');

const MAX_LIMIT = 100;

/** Reusable `page` / `limit` query fields. */
const paginationSchema = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(20),
};

/**
 * LIMIT/OFFSET cannot be bound as prepared-statement parameters in MySQL, so the
 * values are coerced to integers here and inlined. Zod has already constrained
 * them to a safe range; Number() is a second guard against anything slipping in.
 */
function limitOffset({ page = 1, limit = 20 }) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), MAX_LIMIT);
  const safePage = Math.max(Number.parseInt(page, 10) || 1, 1);
  return { limit: safeLimit, page: safePage, offset: (safePage - 1) * safeLimit };
}

module.exports = { paginationSchema, limitOffset, MAX_LIMIT };
