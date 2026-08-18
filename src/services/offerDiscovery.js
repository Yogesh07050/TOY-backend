'use strict';

const { rawQuery } = require('../db/pool');
const ApiError = require('../utils/ApiError');
const geo = require('../utils/geo');
const { limitOffset } = require('../utils/pagination');

/**
 * "View Offers" union of product offers and service offers (V4 §8, §36):
 * every listing with an active offer, regardless of listing type.
 *
 * A SQL UNION ALL is used rather than merging two independently-paginated
 * queries in JS, which would make page 2 skip or duplicate rows depending on
 * how each half's own LIMIT/OFFSET land. Both halves are shaped into an
 * identical column set so a single ORDER BY / LIMIT / OFFSET works correctly
 * across the combined result.
 */

const branchPredicateProduct = (alias) => `(
  (o.applicability_type = 'shop_wide' AND ${alias}.shop_id = o.shop_id)
  OR (o.applicability_type = 'selected_branches' AND EXISTS (
       SELECT 1 FROM offer_locations ol WHERE ol.offer_id = o.id AND ol.branch_id = ${alias}.id))
)`;

const branchPredicateService = (alias) => `(
  (sv.applicability_type = 'shop_wide' AND ${alias}.shop_id = sv.shop_id)
  OR (sv.applicability_type = 'selected_branches' AND EXISTS (
       SELECT 1 FROM service_locations sl WHERE sl.service_id = sv.id AND sl.branch_id = ${alias}.id))
)`;

const PLAN_RANK_SQL = `(CASE
  WHEN sub.status = 'active' AND sub.plan = 'PREMIUM'  THEN 2
  WHEN sub.status = 'active' AND sub.plan = 'BUSINESS' THEN 1
  ELSE 0 END)`;

const SORT_SQL = {
  newest: 'created_at DESC, source_type ASC, id DESC',
  endingSoon: 'end_date ASC, id ASC',
  mostViewed: 'engagement_count DESC, id DESC',
  nearest: 'distance_km IS NULL, distance_km ASC',
};

function mapRow(row) {
  return {
    id: Number(row.id),
    sourceType: row.source_type,
    serviceId: row.service_id === null ? null : Number(row.service_id),
    title: row.title,
    offerText: row.offer_text,
    discountType: row.discount_type,
    discountValue: row.discount_value === null ? null : Number(row.discount_value),
    originalPrice: row.original_price === null ? null : Number(row.original_price),
    finalPrice: row.final_price === null ? null : Number(row.final_price),
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    imageUrl: row.image_url ?? null,
    distanceKm: row.distance_km === null || row.distance_km === undefined ? null : Number(Number(row.distance_km).toFixed(2)),
    isSaved: Boolean(row.is_saved),
    latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
    longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
    shop: {
      id: Number(row.shop_id),
      name: row.shop_name,
      slug: row.shop_slug,
      logoUrl: row.shop_logo_url,
    },
    category: row.category_id
      ? { id: Number(row.category_id), name: row.category_name, slug: row.category_slug }
      : null,
  };
}

async function listAllOffers(params, user) {
  const hasPosition = params.latitude !== undefined && params.longitude !== undefined;
  const { limit, page, offset } = limitOffset(params);
  const type = params.type && params.type !== 'all' ? params.type : null;
  if (type && !['product', 'service'].includes(type)) {
    throw ApiError.badRequest('type must be "product", "service" or "all"');
  }

  const productDistance = hasPosition
    ? `(SELECT MIN(${geo.distanceKmSql('b.latitude', 'b.longitude')}) FROM shop_branches b
         WHERE b.status = 'active' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
           AND ${branchPredicateProduct('b')})`
    : 'NULL';
  const serviceDistance = hasPosition
    ? `(SELECT MIN(${geo.distanceKmSql('b.latitude', 'b.longitude')}) FROM shop_branches b
         WHERE b.status = 'active' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
           AND ${branchPredicateService('b')})`
    : 'NULL';
  // Nearest matching branch's own coordinates, for plotting the listing on a
  // map (mobile Near Me tab) - mirrors productDistance/serviceDistance's
  // predicate and NULL-when-no-position behaviour exactly, just selecting the
  // branch's lat/lng instead of the computed distance.
  const productLat = hasPosition
    ? `(SELECT b.latitude FROM shop_branches b
         WHERE b.status = 'active' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
           AND ${branchPredicateProduct('b')}
         ORDER BY ${geo.distanceKmSql('b.latitude', 'b.longitude')} ASC LIMIT 1)`
    : 'NULL';
  const productLng = hasPosition
    ? `(SELECT b.longitude FROM shop_branches b
         WHERE b.status = 'active' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
           AND ${branchPredicateProduct('b')}
         ORDER BY ${geo.distanceKmSql('b.latitude', 'b.longitude')} ASC LIMIT 1)`
    : 'NULL';
  const serviceLat = hasPosition
    ? `(SELECT b.latitude FROM shop_branches b
         WHERE b.status = 'active' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
           AND ${branchPredicateService('b')}
         ORDER BY ${geo.distanceKmSql('b.latitude', 'b.longitude')} ASC LIMIT 1)`
    : 'NULL';
  const serviceLng = hasPosition
    ? `(SELECT b.longitude FROM shop_branches b
         WHERE b.status = 'active' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
           AND ${branchPredicateService('b')}
         ORDER BY ${geo.distanceKmSql('b.latitude', 'b.longitude')} ASC LIMIT 1)`
    : 'NULL';
  const distanceParams = hasPosition ? geo.distanceKmParams(params.latitude, params.longitude) : [];

  const productSaved = user
    ? '(SELECT 1 FROM favorites fv WHERE fv.offer_id = o.id AND fv.user_id = ?) AS is_saved'
    : '0 AS is_saved';
  const serviceSaved = user
    ? '(SELECT 1 FROM saved_services ssv WHERE ssv.service_id = sv.id AND ssv.user_id = ?) AS is_saved'
    : '0 AS is_saved';
  const savedParams = user ? [user.id] : [];

  const productWhere = ["o.status = 'active'", "s.status = 'active'", 'o.start_date <= NOW()', 'o.end_date >= NOW()'];
  const productParams = [];
  const serviceWhere = [
    "so.status = 'active'",
    "sv.status = 'active'",
    "s.status = 'active'",
    'so.start_date <= NOW()',
    'so.end_date >= NOW()',
  ];
  const serviceParams = [];

  if (params.search) {
    const term = `%${params.search}%`;
    productWhere.push('(o.title LIKE ? OR o.product_name LIKE ? OR o.offer_text LIKE ? OR s.name LIKE ?)');
    productParams.push(term, term, term, term);
    serviceWhere.push('(sv.name LIKE ? OR so.offer_text LIKE ? OR s.name LIKE ?)');
    serviceParams.push(term, term, term);
  }
  if (params.categoryId) {
    productWhere.push('(o.category_id = ? OR o.subcategory_id = ?)');
    productParams.push(params.categoryId, params.categoryId);
    serviceWhere.push('(sv.category_id = ? OR sv.subcategory_id = ?)');
    serviceParams.push(params.categoryId, params.categoryId);
  }
  if (params.shopId) {
    productWhere.push('o.shop_id = ?');
    productParams.push(params.shopId);
    serviceWhere.push('sv.shop_id = ?');
    serviceParams.push(params.shopId);
  }
  if (params.city) {
    productWhere.push(`EXISTS (SELECT 1 FROM shop_branches b2
                         WHERE b2.status = 'active' AND b2.city = ? AND ${branchPredicateProduct('b2')})`);
    productParams.push(params.city);
    serviceWhere.push(`EXISTS (SELECT 1 FROM shop_branches b3
                         WHERE b3.status = 'active' AND b3.city = ? AND ${branchPredicateService('b3')})`);
    serviceParams.push(params.city);
  }

  const productSql = `
    SELECT o.id AS id, 'product' AS source_type, NULL AS service_id,
           o.title AS title, o.offer_text AS offer_text,
           o.shop_id AS shop_id, s.name AS shop_name, s.slug AS shop_slug, s.logo_url AS shop_logo_url,
           o.category_id AS category_id, c.name AS category_name, c.slug AS category_slug,
           o.discount_type AS discount_type, o.discount_value AS discount_value,
           o.original_price AS original_price, o.discounted_price AS final_price,
           o.start_date AS start_date, o.end_date AS end_date, o.status AS status, o.created_at AS created_at,
           (SELECT oi.image_url FROM offer_images oi WHERE oi.offer_id = o.id ORDER BY oi.display_order, oi.id LIMIT 1) AS image_url,
           (o.favorite_count * 3 + o.click_count * 2 + o.view_count) AS engagement_count,
           ${PLAN_RANK_SQL} AS plan_rank,
           ${productLat} AS latitude,
           ${productLng} AS longitude,
           ${productDistance} AS distance_km,
           ${productSaved}
      FROM offers o
      JOIN shops s ON s.id = o.shop_id
      LEFT JOIN categories c ON c.id = o.category_id
      LEFT JOIN shop_subscriptions sub ON sub.shop_id = o.shop_id
     WHERE ${productWhere.join(' AND ')}`;

  const serviceSql = `
    SELECT so.id AS id, 'service' AS source_type, sv.id AS service_id,
           sv.name AS title, so.offer_text AS offer_text,
           sv.shop_id AS shop_id, s.name AS shop_name, s.slug AS shop_slug, s.logo_url AS shop_logo_url,
           sv.category_id AS category_id, c.name AS category_name, c.slug AS category_slug,
           so.discount_type AS discount_type, so.discount_value AS discount_value,
           so.original_price AS original_price, so.offer_price AS final_price,
           so.start_date AS start_date, so.end_date AS end_date, so.status AS status, so.created_at AS created_at,
           (SELECT si.image_url FROM service_images si WHERE si.service_id = sv.id ORDER BY si.display_order, si.id LIMIT 1) AS image_url,
           (so.claim_count * 3 + so.view_count) AS engagement_count,
           ${PLAN_RANK_SQL} AS plan_rank,
           ${serviceLat} AS latitude,
           ${serviceLng} AS longitude,
           ${serviceDistance} AS distance_km,
           ${serviceSaved}
      FROM service_offers so
      JOIN services sv ON sv.id = so.service_id
      JOIN shops s ON s.id = sv.shop_id
      LEFT JOIN categories c ON c.id = sv.category_id
      LEFT JOIN shop_subscriptions sub ON sub.shop_id = sv.shop_id
     WHERE ${serviceWhere.join(' AND ')}`;

  const parts = [];
  const unionParams = [];
  if (type !== 'service') {
    parts.push(productSql);
    // One set of distanceParams per distanceKmSql() occurrence in productSql's
    // SELECT list, in text order: latitude, longitude, distance_km.
    unionParams.push(...distanceParams, ...distanceParams, ...distanceParams, ...savedParams, ...productParams);
  }
  if (type !== 'product') {
    parts.push(serviceSql);
    unionParams.push(...distanceParams, ...distanceParams, ...distanceParams, ...savedParams, ...serviceParams);
  }
  const unionSql = parts.join('\nUNION ALL\n');

  const orderBy = SORT_SQL[params.sort] || SORT_SQL.newest;
  const sql = `
    SELECT * FROM (${unionSql}) AS listings
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}`;

  const countSql = `SELECT COUNT(*) AS total FROM (${unionSql}) AS listings`;

  const [rows, countRows] = await Promise.all([
    rawQuery(sql, unionParams),
    rawQuery(countSql, unionParams),
  ]);

  return {
    items: rows.map(mapRow),
    pagination: { page, limit, total: Number(countRows[0]?.total ?? 0) },
  };
}

module.exports = { listAllOffers };
