'use strict';

const express = require('express');
const { z } = require('zod');
const { query, rawQuery } = require('../../db/pool');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate } = require('../../middleware/auth');
const { requireGlobalPermission } = require('../../middleware/authorize');
const { limitOffset, paginationSchema } = require('../../utils/pagination');
const { ok, paginated } = require('../../utils/respond');

const router = express.Router();

const listQuery = z.object({
  ...paginationSchema,
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(60).optional(),
  entityId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const parseJson = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

router.use(authenticate, requireGlobalPermission('VIEW_AUDIT_LOGS'));

router.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { limit, page, offset } = limitOffset(req.query);
    const where = ['1 = 1'];
    const params = [];

    if (req.query.action) {
      where.push('a.action = ?');
      params.push(req.query.action);
    }
    if (req.query.entityType) {
      where.push('a.entity_type = ?');
      params.push(req.query.entityType);
    }
    if (req.query.entityId) {
      where.push('a.entity_id = ?');
      params.push(req.query.entityId);
    }
    if (req.query.userId) {
      where.push('a.user_id = ?');
      params.push(req.query.userId);
    }
    if (req.query.from) {
      where.push('a.created_at >= ?');
      params.push(req.query.from);
    }
    if (req.query.to) {
      where.push('a.created_at <= ?');
      params.push(req.query.to);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const [rows, countRows] = await Promise.all([
      rawQuery(
        `SELECT a.*, u.name AS user_name, u.email AS user_email
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.user_id
          ${whereSql}
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      rawQuery(`SELECT COUNT(*) AS total FROM audit_logs a ${whereSql}`, params),
    ]);

    paginated(
      res,
      rows.map((row) => ({
        id: Number(row.id),
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id === null ? null : Number(row.entity_id),
        oldValue: parseJson(row.old_value),
        newValue: parseJson(row.new_value),
        ipAddress: row.ip_address,
        createdAt: row.created_at,
        user: row.user_id ? { id: Number(row.user_id), name: row.user_name, email: row.user_email } : null,
      })),
      { page, limit, total: Number(countRows[0].total) },
    );
  }),
);

/** Distinct actions and entity types, used to populate the log filters. */
router.get(
  '/filters',
  asyncHandler(async (_req, res) => {
    const [actions, entityTypes] = await Promise.all([
      query('SELECT DISTINCT action FROM audit_logs ORDER BY action'),
      query('SELECT DISTINCT entity_type FROM audit_logs ORDER BY entity_type'),
    ]);
    ok(res, {
      actions: actions.map((row) => row.action),
      entityTypes: entityTypes.map((row) => row.entity_type),
    });
  }),
);

module.exports = router;
