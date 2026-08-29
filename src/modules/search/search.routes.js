'use strict';

const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../../utils/asyncHandler');
const validate = require('../../middleware/validate');
const { optionalAuth } = require('../../middleware/auth');
const { searchLimiter } = require('../../middleware/rateLimit');
const { ok } = require('../../utils/respond');
const { query } = require('../../db/pool');
const offerDiscovery = require('../../services/offerDiscovery');
const shopService = require('../shops/shop.service');
const serviceService = require('../services/service.service');
const recommendations = require('../../services/recommendations');

const router = express.Router();

/**
 * Public marketplace search (Guest Browsing §16, §25).
 *
 * One anonymous-friendly endpoint that answers across every public entity a
 * visitor can search by - products, services, shops and categories - rather
 * than making the client fan out to four listing endpoints and reconcile the
 * results. `optionalAuth` only enriches the response (`isSaved`,
 * `isFollowing`); it is never required.
 *
 * Each group is capped and returned side by side with its own total, so the
 * client can render "Offers (12) · Services (4) · Shops (2)" and deep-link
 * into the full listing endpoint for whichever group the visitor picks.
 */

const GROUPS = ['offers', 'services', 'shops', 'categories'];

const searchQuery = z.object({
  q: z.string().trim().min(1).max(120),
  // Which groups to answer with. Omitted means all of them.
  type: z
    .union([z.enum([...GROUPS, 'all']), z.array(z.enum(GROUPS))])
    .optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  city: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(6),
});

const wanted = (type) => {
  if (!type || type === 'all') return new Set(GROUPS);
  return new Set(Array.isArray(type) ? type : [type]);
};

router.get(
  '/',
  optionalAuth,
  // §56. After `optionalAuth` so a signed-in merchant is limited as a user
  // rather than sharing their office's IP budget with every colleague.
  searchLimiter,
  validate({ query: searchQuery }),
  asyncHandler(async (req, res) => {
    const { q, limit, latitude, longitude, city } = req.query;
    const groups = wanted(req.query.type);
    const position = latitude !== undefined && longitude !== undefined ? { latitude, longitude } : {};

    // §12: search history is an authenticated recommendation signal. A guest's
    // session behaviour informs the current response and is not persisted.
    if (req.user) recommendations.rememberSearch(req.user.id, q).catch(() => {});

    const [offers, services, shops, categories] = await Promise.all([
      groups.has('offers')
        ? offerDiscovery.listAllOffers({ search: q, city, ...position, page: 1, limit }, req.user)
        : null,
      groups.has('services')
        ? serviceService.list({ search: q, city, ...position, page: 1, limit }, req.user)
        : null,
      groups.has('shops')
        ? shopService.list({ search: q, city, ...position, page: 1, limit }, req.user)
        : null,
      groups.has('categories') ? searchCategories(q, limit, req.user) : null,
    ]);

    const section = (result) =>
      result ? { items: result.items, total: result.pagination?.total ?? result.items.length } : undefined;

    const payload = {
      query: q,
      offers: section(offers),
      services: section(services),
      shops: section(shops),
      categories: section(categories),
    };

    ok(res, payload, {
      total:
        (payload.offers?.total ?? 0) +
        (payload.services?.total ?? 0) +
        (payload.shops?.total ?? 0) +
        (payload.categories?.total ?? 0),
    });
  }),
);

/**
 * Categories are a small, flat, entirely public list, so they get a direct
 * query rather than going through the management listing in
 * `category.routes` - which also carries counts a search result does not need.
 */
async function searchCategories(term, limit, user) {
  const like = `%${term}%`;
  const followSelect = user
    ? '(SELECT 1 FROM followed_categories fc WHERE fc.category_id = c.id AND fc.user_id = ?) AS is_following'
    : '0 AS is_following';
  const followParams = user ? [user.id] : [];

  const rows = await query(
    `SELECT c.id, c.name, c.slug, c.icon, c.image_url, c.parent_id,
            (SELECT COUNT(*) FROM offers o
              WHERE o.status = 'active' AND (o.category_id = c.id OR o.subcategory_id = c.id)) AS offer_count,
            ${followSelect}
       FROM categories c
      WHERE c.status = 'active' AND (c.name LIKE ? OR c.slug LIKE ?)
      ORDER BY offer_count DESC, c.name
      LIMIT ${Number.parseInt(limit, 10)}`,
    [...followParams, like, like],
  );

  return {
    items: rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      slug: row.slug,
      icon: row.icon,
      imageUrl: row.image_url,
      parentId: row.parent_id === null ? null : Number(row.parent_id),
      offerCount: Number(row.offer_count),
      isFollowing: user ? Boolean(row.is_following) : undefined,
    })),
  };
}

module.exports = router;
