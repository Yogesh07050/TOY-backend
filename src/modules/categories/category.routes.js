'use strict';

const express = require('express');
const { z } = require('zod');
const { query, queryOne, execute } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const { uniqueSlug } = require('../../utils/slug');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const audit = require('../../utils/audit');
const { authenticate, optionalAuth } = require('../../middleware/auth');
const { requireGlobalPermission } = require('../../middleware/authorize');
const { ok, created, noContent } = require('../../utils/respond');

const router = express.Router();

const categoryBody = z.object({
  name: z.string().trim().min(2, 'Category name is required').max(120),
  description: z.string().trim().max(500).optional().nullable(),
  icon: z.string().trim().max(80).optional().nullable(),
  imageUrl: z.string().url().max(500).optional().nullable(),
  parentId: z.coerce.number().int().positive().optional().nullable(),
  status: z.enum(['active', 'inactive']).optional().default('active'),
});

const listQuery = z.object({
  status: z.enum(['active', 'inactive', 'all']).optional(),
  parentId: z.coerce.number().int().positive().optional(),
  withCounts: z.coerce.boolean().optional().default(true),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

const mapCategory = (row, user) => ({
  id: Number(row.id),
  name: row.name,
  slug: row.slug,
  description: row.description,
  icon: row.icon,
  imageUrl: row.image_url,
  parentId: row.parent_id === null ? null : Number(row.parent_id),
  status: row.status,
  offerCount: row.offer_count === undefined ? undefined : Number(row.offer_count),
  shopCount: row.shop_count === undefined ? undefined : Number(row.shop_count),
  isFollowing: user ? Boolean(row.is_following) : undefined,
  createdAt: row.created_at,
});

router.get(
  '/',
  optionalAuth,
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const where = [];
    const params = [];

    if (req.query.status === 'all') {
      // Inactive categories are only meaningful to the people who manage them.
      if (!req.user?.isSuperAdmin) where.push("c.status = 'active'");
    } else if (req.query.status) {
      where.push('c.status = ?');
      params.push(req.query.status);
    } else {
      where.push("c.status = 'active'");
    }

    if (req.query.parentId) {
      where.push('c.parent_id = ?');
      params.push(req.query.parentId);
    }

    const followSelect = req.user
      ? '(SELECT 1 FROM followed_categories fc WHERE fc.category_id = c.id AND fc.user_id = ?) AS is_following'
      : '0 AS is_following';
    const followParams = req.user ? [req.user.id] : [];

    const rows = await query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM offers o
                WHERE o.status = 'active' AND (o.category_id = c.id OR o.subcategory_id = c.id)) AS offer_count,
              (SELECT COUNT(*) FROM shop_categories sc WHERE sc.category_id = c.id) AS shop_count,
              ${followSelect}
         FROM categories c
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY c.name`,
      [...followParams, ...params],
    );

    ok(res, rows.map((row) => mapCategory(row, req.user)));
  }),
);

router.get(
  '/:id',
  optionalAuth,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const row = await queryOne('SELECT * FROM categories WHERE id = ?', [req.params.id]);
    if (!row) throw ApiError.notFound('Category not found');
    ok(res, mapCategory(row, req.user));
  }),
);

router.post(
  '/',
  authenticate,
  requireGlobalPermission('MANAGE_CATEGORIES'),
  validate({ body: categoryBody }),
  asyncHandler(async (req, res) => {
    const slug = await uniqueSlug('categories', req.body.name);
    const result = await execute(
      `INSERT INTO categories (name, slug, description, icon, image_url, parent_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.body.name,
        slug,
        req.body.description ?? null,
        req.body.icon ?? null,
        req.body.imageUrl ?? null,
        req.body.parentId ?? null,
        req.body.status,
      ],
    );
    const row = await queryOne('SELECT * FROM categories WHERE id = ?', [result.insertId]);
    await audit.record(req, {
      action: 'CATEGORY_CREATED',
      entityType: 'category',
      entityId: result.insertId,
      newValue: { name: row.name },
    });
    created(res, mapCategory(row));
  }),
);

router.put(
  '/:id',
  authenticate,
  requireGlobalPermission('MANAGE_CATEGORIES'),
  validate({ params: idParam, body: categoryBody.partial() }),
  asyncHandler(async (req, res) => {
    const existing = await queryOne('SELECT * FROM categories WHERE id = ?', [req.params.id]);
    if (!existing) throw ApiError.notFound('Category not found');
    if (req.body.parentId && Number(req.body.parentId) === Number(req.params.id)) {
      throw ApiError.badRequest('A category cannot be its own parent');
    }

    const slug =
      req.body.name && req.body.name !== existing.name
        ? await uniqueSlug('categories', req.body.name, req.params.id)
        : existing.slug;
    const keep = (value, current) => (value !== undefined ? value : current);

    await execute(
      `UPDATE categories SET name = ?, slug = ?, description = ?, icon = ?, image_url = ?,
              parent_id = ?, status = ? WHERE id = ?`,
      [
        req.body.name ?? existing.name,
        slug,
        keep(req.body.description, existing.description),
        keep(req.body.icon, existing.icon),
        keep(req.body.imageUrl, existing.image_url),
        keep(req.body.parentId, existing.parent_id),
        req.body.status ?? existing.status,
        req.params.id,
      ],
    );

    const row = await queryOne('SELECT * FROM categories WHERE id = ?', [req.params.id]);
    await audit.record(req, {
      action: 'CATEGORY_UPDATED',
      entityType: 'category',
      entityId: Number(req.params.id),
      oldValue: audit.sanitize(existing),
      newValue: { name: row.name, status: row.status },
    });
    ok(res, mapCategory(row));
  }),
);

router.delete(
  '/:id',
  authenticate,
  requireGlobalPermission('MANAGE_CATEGORIES'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const existing = await queryOne('SELECT * FROM categories WHERE id = ?', [req.params.id]);
    if (!existing) throw ApiError.notFound('Category not found');

    const inUse = await queryOne(
      'SELECT COUNT(*) AS count FROM offers WHERE category_id = ? OR subcategory_id = ?',
      [req.params.id, req.params.id],
    );
    if (Number(inUse.count) > 0) {
      throw ApiError.conflict(
        'Offers are still using this category. Deactivate it instead of deleting it.',
      );
    }

    await execute('DELETE FROM categories WHERE id = ?', [req.params.id]);
    await audit.record(req, {
      action: 'CATEGORY_DELETED',
      entityType: 'category',
      entityId: Number(req.params.id),
      oldValue: audit.sanitize(existing),
    });
    noContent(res);
  }),
);

module.exports = router;
