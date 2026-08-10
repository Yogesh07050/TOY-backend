'use strict';

const express = require('express');
const { z } = require('zod');
const { query, queryOne, execute, rawQuery, transaction } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const audit = require('../../utils/audit');
const { authenticate } = require('../../middleware/auth');
const { requireGlobalPermission } = require('../../middleware/authorize');
const { limitOffset, paginationSchema } = require('../../utils/pagination');
const { ok, paginated } = require('../../utils/respond');

const router = express.Router();

const listQuery = z.object({
  ...paginationSchema,
  search: z.string().trim().max(190).optional(),
  roleId: z.coerce.number().int().positive().optional(),
  shopId: z.coerce.number().int().positive().optional(),
  status: z.enum(['active', 'inactive', 'all']).optional(),
  sort: z.enum(['newest', 'name', 'lastLogin']).default('newest'),
});

const updateUserSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(30).optional().nullable(),
  avatarUrl: z.string().url().max(500).optional().nullable(),
  roleIds: z.array(z.coerce.number().int().positive()).optional(),
});

/** Self-service profile update (§40) - no role changes allowed here. */
const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(30).optional().nullable(),
  avatarUrl: z.string().url().max(500).optional().nullable(),
  preferredLocation: z
    .object({
      city: z.string().trim().max(120).optional().nullable(),
      latitude: z.coerce.number().min(-90).max(90).optional().nullable(),
      longitude: z.coerce.number().min(-180).max(180).optional().nullable(),
    })
    .optional()
    .nullable(),
});

const statusSchema = z.object({ status: z.enum(['active', 'inactive']) });
const idParam = z.object({ id: z.coerce.number().int().positive() });

const ROLE_AGG = `(
  SELECT GROUP_CONCAT(CONCAT(r.id, '::', r.name) SEPARATOR '||')
    FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id
)`;

const mapUser = (row) => ({
  id: Number(row.id),
  name: row.name,
  email: row.email,
  phone: row.phone,
  status: row.status,
  emailVerified: Boolean(row.email_verified),
  avatarUrl: row.avatar_url,
  preferredLocation: {
    city: row.pref_city,
    latitude: row.pref_latitude === null ? null : Number(row.pref_latitude),
    longitude: row.pref_longitude === null ? null : Number(row.pref_longitude),
  },
  lastLoginAt: row.last_login_at,
  createdAt: row.created_at,
  roles: row.role_list
    ? row.role_list.split('||').map((entry) => {
        const [id, name] = entry.split('::');
        return { id: Number(id), name };
      })
    : [],
  shops: row.shop_list
    ? row.shop_list.split('||').map((entry) => {
        const [id, name] = entry.split('::');
        return { id: Number(id), name };
      })
    : [],
});

router.use(authenticate);

// ---- Self service ----------------------------------------------------------

router.put(
  '/me',
  validate({ body: updateProfileSchema }),
  asyncHandler(async (req, res) => {
    const existing = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const location = req.body.preferredLocation;

    await execute(
      `UPDATE users SET name = ?, phone = ?, avatar_url = ?,
              pref_city = ?, pref_latitude = ?, pref_longitude = ?
        WHERE id = ?`,
      [
        req.body.name ?? existing.name,
        req.body.phone !== undefined ? req.body.phone : existing.phone,
        req.body.avatarUrl !== undefined ? req.body.avatarUrl : existing.avatar_url,
        location !== undefined ? location?.city ?? null : existing.pref_city,
        location !== undefined ? location?.latitude ?? null : existing.pref_latitude,
        location !== undefined ? location?.longitude ?? null : existing.pref_longitude,
        req.user.id,
      ],
    );

    const row = await queryOne(
      `SELECT u.*, ${ROLE_AGG} AS role_list, NULL AS shop_list FROM users u WHERE u.id = ?`,
      [req.user.id],
    );
    ok(res, mapUser(row));
  }),
);

// ---- Administration --------------------------------------------------------

router.get(
  '/',
  requireGlobalPermission('VIEW_USERS'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { limit, page, offset } = limitOffset(req.query);
    const where = ['1 = 1'];
    const params = [];

    if (req.query.search) {
      const term = `%${req.query.search}%`;
      where.push('(u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)');
      params.push(term, term, term);
    }
    if (req.query.status && req.query.status !== 'all') {
      where.push('u.status = ?');
      params.push(req.query.status);
    }
    if (req.query.roleId) {
      where.push('EXISTS (SELECT 1 FROM user_roles ur2 WHERE ur2.user_id = u.id AND ur2.role_id = ?)');
      params.push(req.query.roleId);
    }
    if (req.query.shopId) {
      where.push('EXISTS (SELECT 1 FROM shop_members sm2 WHERE sm2.user_id = u.id AND sm2.shop_id = ?)');
      params.push(req.query.shopId);
    }

    const orderBy = {
      newest: 'u.created_at DESC',
      name: 'u.name ASC',
      lastLogin: 'u.last_login_at IS NULL, u.last_login_at DESC',
    }[req.query.sort];

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const [rows, countRows] = await Promise.all([
      rawQuery(
        `SELECT u.*, ${ROLE_AGG} AS role_list,
                (SELECT GROUP_CONCAT(CONCAT(s.id, '::', s.name) SEPARATOR '||')
                   FROM shop_members sm JOIN shops s ON s.id = sm.shop_id
                  WHERE sm.user_id = u.id) AS shop_list
           FROM users u ${whereSql} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      rawQuery(`SELECT COUNT(*) AS total FROM users u ${whereSql}`, params),
    ]);

    paginated(res, rows.map(mapUser), { page, limit, total: Number(countRows[0].total) });
  }),
);

router.get(
  '/:id',
  requireGlobalPermission('VIEW_USERS'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const row = await queryOne(
      `SELECT u.*, ${ROLE_AGG} AS role_list,
              (SELECT GROUP_CONCAT(CONCAT(s.id, '::', s.name) SEPARATOR '||')
                 FROM shop_members sm JOIN shops s ON s.id = sm.shop_id
                WHERE sm.user_id = u.id) AS shop_list
         FROM users u WHERE u.id = ?`,
      [req.params.id],
    );
    if (!row) throw ApiError.notFound('User not found');

    const memberships = await query(
      `SELECT sm.id, sm.shop_id, s.name AS shop_name, sm.branch_id, b.branch_name,
              sm.designation, sm.status, r.name AS role_name
         FROM shop_members sm
         JOIN shops s ON s.id = sm.shop_id
         LEFT JOIN shop_branches b ON b.id = sm.branch_id
         LEFT JOIN roles r ON r.id = sm.role_id
        WHERE sm.user_id = ?`,
      [req.params.id],
    );

    ok(res, {
      ...mapUser(row),
      memberships: memberships.map((membership) => ({
        id: Number(membership.id),
        shopId: Number(membership.shop_id),
        shopName: membership.shop_name,
        branchId: membership.branch_id === null ? null : Number(membership.branch_id),
        branchName: membership.branch_name,
        designation: membership.designation,
        status: membership.status,
        roleName: membership.role_name,
      })),
    });
  }),
);

router.put(
  '/:id',
  requireGlobalPermission('MANAGE_USERS'),
  validate({ params: idParam, body: updateUserSchema }),
  asyncHandler(async (req, res) => {
    const existing = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!existing) throw ApiError.notFound('User not found');

    await transaction(async (connection) => {
      await connection.execute('UPDATE users SET name = ?, phone = ?, avatar_url = ? WHERE id = ?', [
        req.body.name ?? existing.name,
        req.body.phone !== undefined ? req.body.phone : existing.phone,
        req.body.avatarUrl !== undefined ? req.body.avatarUrl : existing.avatar_url,
        req.params.id,
      ]);

      if (req.body.roleIds !== undefined) {
        await connection.execute('DELETE FROM user_roles WHERE user_id = ?', [req.params.id]);
        for (const roleId of req.body.roleIds) {
          await connection.execute(
            'INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)',
            [req.params.id, roleId],
          );
        }
      }
    });

    const row = await queryOne(
      `SELECT u.*, ${ROLE_AGG} AS role_list, NULL AS shop_list FROM users u WHERE u.id = ?`,
      [req.params.id],
    );
    await audit.record(req, {
      action: req.body.roleIds !== undefined ? 'USER_ROLES_ASSIGNED' : 'USER_UPDATED',
      entityType: 'user',
      entityId: Number(req.params.id),
      oldValue: audit.sanitize(existing),
      newValue: { name: row.name, roleIds: req.body.roleIds },
    });
    ok(res, mapUser(row));
  }),
);

router.patch(
  '/:id/status',
  requireGlobalPermission('MANAGE_USERS'),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(async (req, res) => {
    if (Number(req.params.id) === req.user.id) {
      throw ApiError.badRequest('You cannot change your own account status');
    }
    const existing = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!existing) throw ApiError.notFound('User not found');

    await execute('UPDATE users SET status = ? WHERE id = ?', [req.body.status, req.params.id]);
    if (req.body.status === 'inactive') {
      // Deactivation must end existing sessions, not just block new logins.
      await execute(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
        [req.params.id],
      );
    }

    await audit.record(req, {
      action: req.body.status === 'inactive' ? 'USER_DEACTIVATED' : 'USER_ACTIVATED',
      entityType: 'user',
      entityId: Number(req.params.id),
      oldValue: { status: existing.status },
      newValue: { status: req.body.status },
    });

    const row = await queryOne(
      `SELECT u.*, ${ROLE_AGG} AS role_list, NULL AS shop_list FROM users u WHERE u.id = ?`,
      [req.params.id],
    );
    ok(res, mapUser(row));
  }),
);

module.exports = router;
