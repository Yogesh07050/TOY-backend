'use strict';

const express = require('express');
const { z } = require('zod');
const { query, queryOne, execute, transaction } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const audit = require('../../utils/audit');
const { authenticate } = require('../../middleware/auth');
const { requireGlobalPermission } = require('../../middleware/authorize');
const { ok, created, noContent } = require('../../utils/respond');

const router = express.Router();

const roleBody = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Role name is required')
    .max(80)
    .regex(/^[A-Za-z0-9 _-]+$/, 'Use letters, numbers, spaces, hyphens or underscores'),
  description: z.string().trim().max(255).optional().nullable(),
  // 'shop' roles only take effect for shops the user is a member of (§3.2).
  scope: z.enum(['global', 'shop']).optional().default('shop'),
  status: z.enum(['active', 'inactive']).optional().default('active'),
  permissionIds: z.array(z.coerce.number().int().positive()).optional().default([]),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

const mapRole = (row) => ({
  id: Number(row.id),
  name: row.name,
  description: row.description,
  scope: row.scope,
  status: row.status,
  isSystem: Boolean(row.is_system),
  userCount: row.user_count === undefined ? undefined : Number(row.user_count),
  permissions: row.permission_list
    ? row.permission_list.split('||').map((entry) => {
        const [id, name] = entry.split('::');
        return { id: Number(id), name };
      })
    : [],
  createdAt: row.created_at,
});

const PERMISSION_AGG = `(
  SELECT GROUP_CONCAT(CONCAT(p.id, '::', p.name) ORDER BY p.name SEPARATOR '||')
    FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
   WHERE rp.role_id = r.id
)`;

router.use(authenticate);

router.get(
  '/',
  requireGlobalPermission('MANAGE_ROLES'),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT r.*, ${PERMISSION_AGG} AS permission_list,
              (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id)
              + (SELECT COUNT(*) FROM shop_members sm WHERE sm.role_id = r.id) AS user_count
         FROM roles r ORDER BY r.is_system DESC, r.name`,
    );
    ok(res, rows.map(mapRole));
  }),
);

router.get(
  '/:id',
  requireGlobalPermission('MANAGE_ROLES'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const row = await queryOne(
      `SELECT r.*, ${PERMISSION_AGG} AS permission_list FROM roles r WHERE r.id = ?`,
      [req.params.id],
    );
    if (!row) throw ApiError.notFound('Role not found');
    ok(res, mapRole(row));
  }),
);

router.post(
  '/',
  requireGlobalPermission('MANAGE_ROLES'),
  validate({ body: roleBody }),
  asyncHandler(async (req, res) => {
    const name = req.body.name.toUpperCase().replace(/\s+/g, '_');
    const duplicate = await queryOne('SELECT id FROM roles WHERE name = ?', [name]);
    if (duplicate) throw ApiError.conflict('A role with that name already exists');

    const roleId = await transaction(async (connection) => {
      const [result] = await connection.execute(
        'INSERT INTO roles (name, description, scope, status) VALUES (?, ?, ?, ?)',
        [name, req.body.description ?? null, req.body.scope, req.body.status],
      );
      for (const permissionId of req.body.permissionIds) {
        await connection.execute(
          'INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
          [result.insertId, permissionId],
        );
      }
      return result.insertId;
    });

    const row = await queryOne(
      `SELECT r.*, ${PERMISSION_AGG} AS permission_list FROM roles r WHERE r.id = ?`,
      [roleId],
    );
    await audit.record(req, {
      action: 'ROLE_CREATED',
      entityType: 'role',
      entityId: roleId,
      newValue: { name, permissionIds: req.body.permissionIds },
    });
    created(res, mapRole(row));
  }),
);

router.put(
  '/:id',
  requireGlobalPermission('MANAGE_ROLES'),
  validate({ params: idParam, body: roleBody.partial() }),
  asyncHandler(async (req, res) => {
    const existing = await queryOne('SELECT * FROM roles WHERE id = ?', [req.params.id]);
    if (!existing) throw ApiError.notFound('Role not found');

    // System roles keep their name and stay active; their permission set is
    // still editable so an operator can tune what an Admin may do.
    if (existing.is_system && (req.body.name || req.body.status === 'inactive')) {
      throw ApiError.badRequest('Built-in roles cannot be renamed or deactivated');
    }

    const previousPermissions = await query(
      'SELECT permission_id FROM role_permissions WHERE role_id = ?',
      [req.params.id],
    );

    await transaction(async (connection) => {
      await connection.execute(
        'UPDATE roles SET name = ?, description = ?, scope = ?, status = ? WHERE id = ?',
        [
          req.body.name ? req.body.name.toUpperCase().replace(/\s+/g, '_') : existing.name,
          req.body.description !== undefined ? req.body.description : existing.description,
          // The scope of a built-in role is part of the security model.
          existing.is_system ? existing.scope : (req.body.scope ?? existing.scope),
          req.body.status ?? existing.status,
          req.params.id,
        ],
      );

      if (req.body.permissionIds !== undefined) {
        await connection.execute('DELETE FROM role_permissions WHERE role_id = ?', [req.params.id]);
        for (const permissionId of req.body.permissionIds) {
          await connection.execute(
            'INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
            [req.params.id, permissionId],
          );
        }
      }
    });

    const row = await queryOne(
      `SELECT r.*, ${PERMISSION_AGG} AS permission_list FROM roles r WHERE r.id = ?`,
      [req.params.id],
    );
    await audit.record(req, {
      action: 'ROLE_UPDATED',
      entityType: 'role',
      entityId: Number(req.params.id),
      oldValue: {
        name: existing.name,
        status: existing.status,
        permissionIds: previousPermissions.map((p) => Number(p.permission_id)),
      },
      newValue: { name: row.name, status: row.status, permissionIds: req.body.permissionIds },
    });
    ok(res, mapRole(row));
  }),
);

router.delete(
  '/:id',
  requireGlobalPermission('MANAGE_ROLES'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const existing = await queryOne('SELECT * FROM roles WHERE id = ?', [req.params.id]);
    if (!existing) throw ApiError.notFound('Role not found');
    if (existing.is_system) throw ApiError.badRequest('Built-in roles cannot be deleted');

    const inUse = await queryOne(
      `SELECT (SELECT COUNT(*) FROM user_roles WHERE role_id = ?)
            + (SELECT COUNT(*) FROM shop_members WHERE role_id = ?) AS count`,
      [req.params.id, req.params.id],
    );
    if (Number(inUse.count) > 0) {
      throw ApiError.conflict('This role is still assigned to users. Reassign them first.');
    }

    await execute('DELETE FROM roles WHERE id = ?', [req.params.id]);
    await audit.record(req, {
      action: 'ROLE_DELETED',
      entityType: 'role',
      entityId: Number(req.params.id),
      oldValue: audit.sanitize(existing),
    });
    noContent(res);
  }),
);

module.exports = router;
