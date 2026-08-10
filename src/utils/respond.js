'use strict';

/** Envelope helpers so every endpoint answers with the same shape. */

const ok = (res, data, meta) =>
  res.json(meta ? { success: true, data, meta } : { success: true, data });

const created = (res, data) => res.status(201).json({ success: true, data });

const noContent = (res) => res.status(204).send();

/**
 * @param {object} res
 * @param {Array} items
 * @param {{page:number, limit:number, total:number}} pagination
 */
const paginated = (res, items, { page, limit, total }) =>
  res.json({
    success: true,
    data: items,
    meta: {
      page,
      limit,
      total,
      totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
      hasNext: page * limit < total,
    },
  });

module.exports = { ok, created, noContent, paginated };
