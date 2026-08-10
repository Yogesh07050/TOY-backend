'use strict';

const express = require('express');
const { z } = require('zod');
const { query, queryOne, rawQuery } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/authorize');
const accessControl = require('../../services/accessControl');
const { ok } = require('../../utils/respond');

const router = express.Router();

const rangeQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  shopId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const shopIdParam = z.object({ shopId: z.coerce.number().int().positive() });

/**
 * Resolves which shops the caller's analytics may cover.
 * Returns `null` for platform-wide access, otherwise a list of shop ids.
 * An Admin is always narrowed to their own shops (§37).
 */
function analyticsScope(user, requestedShopId) {
  const scope = accessControl.shopScopeFor(user, 'VIEW_ANALYTICS');

  if (requestedShopId) {
    if (scope !== null && !scope.includes(Number(requestedShopId))) {
      throw ApiError.forbidden('You can only view analytics for your own shop');
    }
    return [Number(requestedShopId)];
  }

  if (scope !== null && scope.length === 0) {
    throw ApiError.forbidden('You are not assigned to any shop');
  }
  return scope;
}

/** Builds `AND shop_id IN (...)` for a scope, or an empty string for global. */
function scopeClause(scope, column = 'o.shop_id') {
  if (scope === null) return { sql: '', params: [] };
  return { sql: ` AND ${column} IN (${scope.map(() => '?').join(',')})`, params: scope };
}

router.use(authenticate);
router.use(requirePermission('VIEW_ANALYTICS'));

/** Headline counters for the Super Admin and Admin dashboards (§27, §41). */
router.get(
  '/overview',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const scope = analyticsScope(req.user, req.query.shopId);
    const offerScope = scopeClause(scope);

    const offerCounts = await rawQuery(
      `SELECT status, COUNT(*) AS count FROM offers o
        WHERE 1 = 1${offerScope.sql} GROUP BY status`,
      offerScope.params,
    );
    const byStatus = Object.fromEntries(offerCounts.map((row) => [row.status, Number(row.count)]));

    const engagement = await rawQuery(
      `SELECT COALESCE(SUM(o.view_count), 0) AS views,
              COALESCE(SUM(o.click_count), 0) AS clicks,
              COALESCE(SUM(o.favorite_count), 0) AS favorites
         FROM offers o WHERE 1 = 1${offerScope.sql}`,
      offerScope.params,
    );

    const expiringSoon = await rawQuery(
      `SELECT COUNT(*) AS count FROM offers o
        WHERE o.status = 'active' AND o.end_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 7 DAY)
          ${offerScope.sql}`,
      offerScope.params,
    );

    const data = {
      scope: scope === null ? 'platform' : 'shop',
      shopIds: scope,
      offers: {
        total: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
        draft: byStatus.draft ?? 0,
        scheduled: byStatus.scheduled ?? 0,
        active: byStatus.active ?? 0,
        expired: byStatus.expired ?? 0,
        deactivated: byStatus.deactivated ?? 0,
        expiringSoon: Number(expiringSoon[0].count),
      },
      engagement: {
        views: Number(engagement[0].views),
        clicks: Number(engagement[0].clicks),
        favorites: Number(engagement[0].favorites),
      },
    };

    if (scope === null) {
      const [users, shops, branches, follows] = await Promise.all([
        queryOne(
          "SELECT COUNT(*) AS total, SUM(status = 'active') AS active FROM users",
        ),
        queryOne("SELECT COUNT(*) AS total, SUM(status = 'active') AS active FROM shops"),
        queryOne("SELECT COUNT(*) AS total, SUM(status = 'active') AS active FROM shop_branches"),
        queryOne('SELECT COUNT(*) AS total FROM followed_shops'),
      ]);
      data.platform = {
        totalUsers: Number(users.total),
        activeUsers: Number(users.active ?? 0),
        totalShops: Number(shops.total),
        activeShops: Number(shops.active ?? 0),
        totalBranches: Number(branches.total),
        activeBranches: Number(branches.active ?? 0),
        totalFollows: Number(follows.total),
      };
    } else {
      const [branches, members] = await Promise.all([
        rawQuery(
          `SELECT COUNT(*) AS total FROM shop_branches WHERE shop_id IN (${scope.map(() => '?').join(',')})`,
          scope,
        ),
        rawQuery(
          `SELECT COUNT(*) AS total FROM shop_members WHERE shop_id IN (${scope.map(() => '?').join(',')})`,
          scope,
        ),
      ]);
      data.shop = { branches: Number(branches[0].total), members: Number(members[0].total) };
    }

    ok(res, data);
  }),
);

/** Offer activity over time plus the best and soonest-to-expire offers. */
router.get(
  '/offers',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const scope = analyticsScope(req.user, req.query.shopId);
    const offerScope = scopeClause(scope);
    const days = req.query.days;
    const limit = req.query.limit;

    const [created, events, topViewed, topPopular, expiring] = await Promise.all([
      rawQuery(
        `SELECT DATE(o.created_at) AS day, COUNT(*) AS count
           FROM offers o
          WHERE o.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)${offerScope.sql}
          GROUP BY day ORDER BY day`,
        [days, ...offerScope.params],
      ),
      rawQuery(
        `SELECT DATE(v.created_at) AS day, v.event_type, COUNT(*) AS count
           FROM offer_views v JOIN offers o ON o.id = v.offer_id
          WHERE v.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)${offerScope.sql}
          GROUP BY day, v.event_type ORDER BY day`,
        [days, ...offerScope.params],
      ),
      rawQuery(
        `SELECT o.id, o.title, o.view_count, o.click_count, o.favorite_count, s.name AS shop_name
           FROM offers o JOIN shops s ON s.id = o.shop_id
          WHERE 1 = 1${offerScope.sql}
          ORDER BY o.view_count DESC LIMIT ${limit}`,
        offerScope.params,
      ),
      rawQuery(
        `SELECT o.id, o.title, o.view_count, o.click_count, o.favorite_count, s.name AS shop_name,
                (o.favorite_count * 3 + o.click_count * 2 + o.view_count) AS popularity
           FROM offers o JOIN shops s ON s.id = o.shop_id
          WHERE 1 = 1${offerScope.sql}
          ORDER BY popularity DESC LIMIT ${limit}`,
        offerScope.params,
      ),
      rawQuery(
        `SELECT o.id, o.title, o.end_date, s.name AS shop_name
           FROM offers o JOIN shops s ON s.id = o.shop_id
          WHERE o.status = 'active' AND o.end_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 14 DAY)
            ${offerScope.sql}
          ORDER BY o.end_date ASC LIMIT ${limit}`,
        offerScope.params,
      ),
    ]);

    const timeline = new Map();
    for (const row of created) {
      timeline.set(String(row.day), { day: row.day, created: Number(row.count), views: 0, clicks: 0, shares: 0 });
    }
    for (const row of events) {
      const key = String(row.day);
      const entry = timeline.get(key) || { day: row.day, created: 0, views: 0, clicks: 0, shares: 0 };
      entry[`${row.event_type}s`] = Number(row.count);
      timeline.set(key, entry);
    }

    ok(res, {
      timeline: [...timeline.values()].sort((a, b) => String(a.day).localeCompare(String(b.day))),
      mostViewed: topViewed.map(mapOfferStat),
      mostPopular: topPopular.map(mapOfferStat),
      expiringSoon: expiring.map((row) => ({
        id: Number(row.id),
        title: row.title,
        shopName: row.shop_name,
        endDate: row.end_date,
      })),
    });
  }),
);

const mapOfferStat = (row) => ({
  id: Number(row.id),
  title: row.title,
  shopName: row.shop_name,
  views: Number(row.view_count),
  clicks: Number(row.click_count),
  favorites: Number(row.favorite_count),
});

/** Per-shop analytics, including performance by branch (§27). */
router.get(
  '/shops/:shopId',
  validate({ params: shopIdParam, query: rangeQuery }),
  asyncHandler(async (req, res) => {
    analyticsScope(req.user, req.params.shopId);
    const shopId = Number(req.params.shopId);

    const shop = await queryOne('SELECT id, name FROM shops WHERE id = ?', [shopId]);
    if (!shop) throw ApiError.notFound('Shop not found');

    const [statuses, engagement, branchPerformance, topOffers] = await Promise.all([
      query('SELECT status, COUNT(*) AS count FROM offers WHERE shop_id = ? GROUP BY status', [shopId]),
      queryOne(
        `SELECT COALESCE(SUM(view_count), 0) AS views, COALESCE(SUM(click_count), 0) AS clicks,
                COALESCE(SUM(favorite_count), 0) AS favorites
           FROM offers WHERE shop_id = ?`,
        [shopId],
      ),
      query(
        `SELECT b.id, b.branch_name, b.city,
                (SELECT COUNT(*) FROM offers o
                  WHERE o.shop_id = b.shop_id AND o.status = 'active'
                    AND (o.applicability_type = 'shop_wide'
                      OR EXISTS (SELECT 1 FROM offer_locations ol
                                  WHERE ol.offer_id = o.id AND ol.branch_id = b.id))) AS active_offers,
                (SELECT COUNT(*) FROM offer_views v WHERE v.branch_id = b.id AND v.event_type = 'view') AS views
           FROM shop_branches b WHERE b.shop_id = ? ORDER BY b.is_primary DESC, b.branch_name`,
        [shopId],
      ),
      query(
        `SELECT o.id, o.title, o.view_count, o.click_count, o.favorite_count, s.name AS shop_name
           FROM offers o JOIN shops s ON s.id = o.shop_id
          WHERE o.shop_id = ? ORDER BY o.view_count DESC LIMIT 10`,
        [shopId],
      ),
    ]);

    const byStatus = Object.fromEntries(statuses.map((row) => [row.status, Number(row.count)]));
    ok(res, {
      shop: { id: Number(shop.id), name: shop.name },
      offers: {
        total: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
        draft: byStatus.draft ?? 0,
        scheduled: byStatus.scheduled ?? 0,
        active: byStatus.active ?? 0,
        expired: byStatus.expired ?? 0,
        deactivated: byStatus.deactivated ?? 0,
      },
      engagement: {
        views: Number(engagement.views),
        clicks: Number(engagement.clicks),
        favorites: Number(engagement.favorites),
      },
      branches: branchPerformance.map((row) => ({
        id: Number(row.id),
        branchName: row.branch_name,
        city: row.city,
        activeOffers: Number(row.active_offers),
        views: Number(row.views),
      })),
      mostViewed: topOffers.map(mapOfferStat),
    });
  }),
);

/** Most popular categories. */
router.get(
  '/categories',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const scope = analyticsScope(req.user, req.query.shopId);
    const offerScope = scopeClause(scope);

    const rows = await rawQuery(
      `SELECT c.id, c.name,
              COUNT(o.id) AS offer_count,
              COALESCE(SUM(o.view_count), 0) AS views,
              (SELECT COUNT(*) FROM followed_categories fc WHERE fc.category_id = c.id) AS followers
         FROM categories c
         LEFT JOIN offers o ON o.category_id = c.id${offerScope.sql}
        GROUP BY c.id, c.name
        ORDER BY offer_count DESC, views DESC
        LIMIT ${req.query.limit}`,
      offerScope.params,
    );

    ok(
      res,
      rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        offerCount: Number(row.offer_count),
        views: Number(row.views),
        followers: Number(row.followers),
      })),
    );
  }),
);

/** Most popular locations, by city. */
router.get(
  '/locations',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const scope = analyticsScope(req.user, req.query.shopId);
    const scoped = scopeClause(scope, 'b.shop_id');

    const rows = await rawQuery(
      `SELECT b.city, b.state,
              COUNT(DISTINCT b.id) AS branch_count,
              COUNT(DISTINCT b.shop_id) AS shop_count,
              (SELECT COUNT(DISTINCT o2.id)
                 FROM offers o2
                 JOIN shop_branches b2 ON b2.shop_id = o2.shop_id
                                      AND b2.city = b.city AND b2.status = 'active'
                WHERE o2.status = 'active') AS active_offers
         FROM shop_branches b
        WHERE b.city IS NOT NULL AND b.status = 'active'${scoped.sql}
        GROUP BY b.city, b.state
        ORDER BY active_offers DESC, branch_count DESC
        LIMIT ${req.query.limit}`,
      scoped.params,
    );

    ok(
      res,
      rows.map((row) => ({
        city: row.city,
        state: row.state,
        branchCount: Number(row.branch_count),
        shopCount: Number(row.shop_count),
        activeOffers: Number(row.active_offers),
      })),
    );
  }),
);

/** Most popular shops - platform-wide view for the Super Admin. */
router.get(
  '/shops',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const scope = analyticsScope(req.user, req.query.shopId);
    const scoped = scopeClause(scope, 's.id');

    const rows = await rawQuery(
      `SELECT s.id, s.name, s.logo_url,
              (SELECT COUNT(*) FROM offers o WHERE o.shop_id = s.id AND o.status = 'active') AS active_offers,
              (SELECT COALESCE(SUM(o.view_count), 0) FROM offers o WHERE o.shop_id = s.id) AS views,
              (SELECT COUNT(*) FROM followed_shops fs WHERE fs.shop_id = s.id) AS followers
         FROM shops s
        WHERE s.status = 'active'${scoped.sql}
        ORDER BY followers DESC, views DESC
        LIMIT ${req.query.limit}`,
      scoped.params,
    );

    ok(
      res,
      rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        logoUrl: row.logo_url,
        activeOffers: Number(row.active_offers),
        views: Number(row.views),
        followers: Number(row.followers),
      })),
    );
  }),
);

module.exports = router;
