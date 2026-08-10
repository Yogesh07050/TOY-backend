'use strict';

const express = require('express');
const { z } = require('zod');
const { query, queryOne, execute } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate } = require('../../middleware/auth');
const { ok, created, noContent } = require('../../utils/respond');

const router = express.Router();

const shopIdParam = z.object({ shopId: z.coerce.number().int().positive() });
const categoryIdParam = z.object({ categoryId: z.coerce.number().int().positive() });

router.use(authenticate);

// ---- Shops (§23) -----------------------------------------------------------

router.get(
  '/shops',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT s.id, s.name, s.slug, s.logo_url, s.description, fs.created_at AS followed_at,
              (SELECT COUNT(*) FROM offers o WHERE o.shop_id = s.id AND o.status = 'active') AS active_offer_count
         FROM followed_shops fs
         JOIN shops s ON s.id = fs.shop_id
        WHERE fs.user_id = ?
        ORDER BY s.name`,
      [req.user.id],
    );
    ok(
      res,
      rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        slug: row.slug,
        logoUrl: row.logo_url,
        description: row.description,
        activeOfferCount: Number(row.active_offer_count),
        followedAt: row.followed_at,
      })),
    );
  }),
);

router.post(
  '/shops/:shopId',
  validate({ params: shopIdParam }),
  asyncHandler(async (req, res) => {
    const shop = await queryOne("SELECT id FROM shops WHERE id = ? AND status = 'active'", [
      req.params.shopId,
    ]);
    if (!shop) throw ApiError.notFound('Shop not found');

    await execute('INSERT IGNORE INTO followed_shops (user_id, shop_id) VALUES (?, ?)', [
      req.user.id,
      req.params.shopId,
    ]);
    created(res, { shopId: Number(req.params.shopId), isFollowing: true });
  }),
);

router.delete(
  '/shops/:shopId',
  validate({ params: shopIdParam }),
  asyncHandler(async (req, res) => {
    await execute('DELETE FROM followed_shops WHERE user_id = ? AND shop_id = ?', [
      req.user.id,
      req.params.shopId,
    ]);
    noContent(res);
  }),
);

// ---- Categories ------------------------------------------------------------

router.get(
  '/categories',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT c.id, c.name, c.slug, c.icon, c.image_url, fc.created_at AS followed_at,
              (SELECT COUNT(*) FROM offers o
                WHERE o.status = 'active' AND (o.category_id = c.id OR o.subcategory_id = c.id)) AS active_offer_count
         FROM followed_categories fc
         JOIN categories c ON c.id = fc.category_id
        WHERE fc.user_id = ?
        ORDER BY c.name`,
      [req.user.id],
    );
    ok(
      res,
      rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        slug: row.slug,
        icon: row.icon,
        imageUrl: row.image_url,
        activeOfferCount: Number(row.active_offer_count),
        followedAt: row.followed_at,
      })),
    );
  }),
);

router.post(
  '/categories/:categoryId',
  validate({ params: categoryIdParam }),
  asyncHandler(async (req, res) => {
    const category = await queryOne("SELECT id FROM categories WHERE id = ? AND status = 'active'", [
      req.params.categoryId,
    ]);
    if (!category) throw ApiError.notFound('Category not found');

    await execute('INSERT IGNORE INTO followed_categories (user_id, category_id) VALUES (?, ?)', [
      req.user.id,
      req.params.categoryId,
    ]);
    created(res, { categoryId: Number(req.params.categoryId), isFollowing: true });
  }),
);

router.delete(
  '/categories/:categoryId',
  validate({ params: categoryIdParam }),
  asyncHandler(async (req, res) => {
    await execute('DELETE FROM followed_categories WHERE user_id = ? AND category_id = ?', [
      req.user.id,
      req.params.categoryId,
    ]);
    noContent(res);
  }),
);

module.exports = router;
