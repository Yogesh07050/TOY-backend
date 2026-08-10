'use strict';

const express = require('express');
const { z } = require('zod');
const { query, queryOne, execute } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const audit = require('../../utils/audit');
const { authenticate } = require('../../middleware/auth');
const { requireGlobalPermission } = require('../../middleware/authorize');
const { PERMISSION_NAMES } = require('../../config/permissions');
const { ok, created, noContent } = require('../../utils/respond');

const router = express.Router();

const permissionBody = z.object({
  name: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Use SCREAMING_SNAKE_CASE, e.g. MANAGE_BANNERS')
    .transform((value) => value.toUpperCase()),
  description: z.string().trim().max(255).optional().nullable(),
  category: z.string().trim().max(60).optional().nullable(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

const mapPermission = (row) => ({
  id: Number(row.id),
  name: row.name,
  description: row.description,
  category: row.category,
  // Permissions the code itself checks cannot be deleted without breaking RBAC.
  isBuiltIn: PERMISSION_NAMES.includes(row.name),
  roleCount: row.role_count === undefined ? undefined : Number(row.role_count),
});

router.use(authenticate);

router.get(
  '/',
  requireGlobalPermission('MANAGE_ROLES'),
  asyncHandler(async (_req, res) => {
    const rows = await query(
      `SELECT p.*, (SELECT COUNT(*) FROM role_permissions rp WHERE rp.permission_id = p.id) AS role_count
         FROM permissions p ORDER BY p.category, p.name`,
    );
    ok(res, rows.map(mapPermission));
  }),
);

router.post(
  '/',
  requireGlobalPermission('MANAGE_PERMISSIONS'),
  validate({ body: permissionBody }),
  asyncHandler(async (req, res) => {
    const duplicate = await queryOne('SELECT id FROM permissions WHERE name = ?', [req.body.name]);
    if (duplicate) throw ApiError.conflict('That permission already exists');

    const result = await execute(
      'INSERT INTO permissions (name, description, category) VALUES (?, ?, ?)',
      [req.body.name, req.body.description ?? null, req.body.category ?? null],
    );
    const row = await queryOne('SELECT * FROM permissions WHERE id = ?', [result.insertId]);
    await audit.record(req, {
      action: 'PERMISSION_CREATED',
      entityType: 'permission',
      entityId: result.insertId,
      newValue: { name: row.name },
    });
    created(res, mapPermission(row));
  }),
);

router.put(
  '/:id',
  requireGlobalPermission('MANAGE_PERMISSIONS'),
  validate({ params: idParam, body: permissionBody.partial() }),
  asyncHandler(async (req, res) => {
    const existing = await queryOne('SELECT * FROM permissions WHERE id = ?', [req.params.id]);
    if (!existing) throw ApiError.notFound('Permission not found');
    if (PERMISSION_NAMES.includes(existing.name) && req.body.name && req.body.name !== existing.name) {
      throw ApiError.badRequest('Built-in permissions cannot be renamed');
    }

    await execute('UPDATE permissions SET name = ?, description = ?, category = ? WHERE id = ?', [
      req.body.name ?? existing.name,
      req.body.description !== undefined ? req.body.description : existing.description,
      req.body.category !== undefined ? req.body.category : existing.category,
      req.params.id,
    ]);

    const row = await queryOne('SELECT * FROM permissions WHERE id = ?', [req.params.id]);
    await audit.record(req, {
      action: 'PERMISSION_UPDATED',
      entityType: 'permission',
      entityId: Number(req.params.id),
      oldValue: audit.sanitize(existing),
      newValue: audit.sanitize(row),
    });
    ok(res, mapPermission(row));
  }),
);

router.delete(
  '/:id',
  requireGlobalPermission('MANAGE_PERMISSIONS'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const existing = await queryOne('SELECT * FROM permissions WHERE id = ?', [req.params.id]);
    if (!existing) throw ApiError.notFound('Permission not found');
    if (PERMISSION_NAMES.includes(existing.name)) {
      throw ApiError.badRequest('Built-in permissions are enforced by the API and cannot be deleted');
    }

    await execute('DELETE FROM permissions WHERE id = ?', [req.params.id]);
    await audit.record(req, {
      action: 'PERMISSION_DELETED',
      entityType: 'permission',
      entityId: Number(req.params.id),
      oldValue: audit.sanitize(existing),
    });
    noContent(res);
  }),
);

module.exports = router;
