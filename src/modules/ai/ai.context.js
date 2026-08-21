'use strict';

const env = require('../../config/env');
const { query, queryOne, rawQuery } = require('../../db/pool');
const geo = require('../../utils/geo');

/**
 * Builds the merchant context the AI service is allowed to see (§30).
 *
 * Everything is scoped to a single shop id, which the caller has already proved
 * the user administers. Nothing platform-wide and nothing customer-identifying
 * leaves this module: the location and timing sections are aggregate counts, and
 * the category trends are category-level (§12, §31).
 *
 * Premium-only sections are simply not queried when the plan does not include
 * them, so an unentitled shop's context cannot leak the data even by accident.
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const toNumber = (value) => (value === null || value === undefined ? 0 : Number(value));

/** Distance bands used for "customers within N km" advice (§12). */
const RADIUS_BANDS = [
  { label: '0-2 km', minKm: 0, maxKm: 2 },
  { label: '2-5 km', minKm: 2, maxKm: 5 },
  { label: '5-10 km', minKm: 5, maxKm: 10 },
  { label: '10-25 km', minKm: 10, maxKm: 25 },
  { label: '25+ km', minKm: 25, maxKm: null },
];

async function shopProfile(shopId) {
  const shop = await queryOne(
    `SELECT s.id, s.name, s.description,
            (SELECT COUNT(*) FROM shop_branches b WHERE b.shop_id = s.id AND b.status = 'active') AS branch_count,
            (SELECT b.city FROM shop_branches b
              WHERE b.shop_id = s.id AND b.status = 'active'
              ORDER BY b.is_primary DESC, b.id ASC LIMIT 1) AS city
       FROM shops s WHERE s.id = ?`,
    [shopId],
  );
  if (!shop) return null;

  const categories = await query(
    `SELECT c.name FROM shop_categories sc
       JOIN categories c ON c.id = sc.category_id
      WHERE sc.shop_id = ?`,
    [shopId],
  );

  return {
    name: shop.name,
    description: shop.description ? String(shop.description).slice(0, 600) : null,
    categories: categories.map((row) => row.name),
    city: shop.city,
    branchCount: toNumber(shop.branch_count),
    currency: 'INR',
  };
}

/**
 * Offers with their measured funnel. `finished` picks between the history the
 * assistant learns from and the offers running right now (§4).
 */
async function offerPerformance(shopId, { finished, limit }) {
  const since = new Date(Date.now() - env.ai.historyWindowDays * 86400000);

  const rows = await rawQuery(
    `SELECT o.title, o.offer_type, o.offer_text, o.discount_type, o.discount_value,
            o.buy_quantity, o.get_quantity, o.start_date, o.end_date,
            o.view_count, o.click_count, o.favorite_count,
            c.name AS category_name,
            DATEDIFF(o.end_date, o.start_date) AS duration_days,
            (SELECT COUNT(*) FROM offer_claims cl WHERE cl.offer_id = o.id) AS claims,
            (SELECT COUNT(*) FROM offer_claims cl
              WHERE cl.offer_id = o.id AND cl.status = 'redeemed') AS redemptions
       FROM offers o
       LEFT JOIN categories c ON c.id = o.category_id
      WHERE o.shop_id = ?
        AND o.status ${finished ? "IN ('expired', 'deactivated')" : "= 'active'"}
        ${finished ? 'AND o.end_date >= ?' : ''}
      ORDER BY o.end_date DESC
      LIMIT ?`,
    finished ? [shopId, since, limit] : [shopId, limit],
  );

  return rows.map((row) => ({
    title: row.title,
    offerType: row.offer_type,
    offerText: row.offer_text,
    categoryName: row.category_name,
    discountType: row.discount_type,
    discountValue: row.discount_value === null ? null : Number(row.discount_value),
    buyQuantity: row.buy_quantity === null ? null : Number(row.buy_quantity),
    getQuantity: row.get_quantity === null ? null : Number(row.get_quantity),
    startDate: row.start_date,
    endDate: row.end_date,
    durationDays: row.duration_days === null ? null : Number(row.duration_days),
    views: toNumber(row.view_count),
    clicks: toNumber(row.click_count),
    claims: toNumber(row.claims),
    redemptions: toNumber(row.redemptions),
    favorites: toNumber(row.favorite_count),
  }));
}

/**
 * Engagement by how far the customer was from the branch.
 *
 * Distance comes from the customer's *saved preferred location*, which is the
 * only position this system stores, and the result is bucketed and counted
 * before it leaves the database - no row here maps back to a person (§12).
 */
async function radiusBands(shopId) {
  // Great-circle distance between two *columns*. The shared geo helper binds the
  // customer position as parameters, which does not apply here, so the same
  // formula is written out against the two tables.
  const distanceKm = `(${geo.EARTH_RADIUS_KM} * ACOS(
    LEAST(1, GREATEST(-1,
      COS(RADIANS(u.pref_latitude)) * COS(RADIANS(b.latitude))
        * COS(RADIANS(b.longitude) - RADIANS(u.pref_longitude))
      + SIN(RADIANS(u.pref_latitude)) * SIN(RADIANS(b.latitude))
    ))
  ))`;

  // Bucketing in SQL keeps one row per band coming back rather than one per
  // distinct distance, and the counts are aggregated before they leave the DB.
  const bandCase = `CASE
      ${RADIUS_BANDS.map((band, index) =>
        band.maxKm === null
          ? `WHEN nearest_km >= ${band.minKm} THEN ${index}`
          : `WHEN nearest_km >= ${band.minKm} AND nearest_km < ${band.maxKm} THEN ${index}`,
      ).join('\n      ')}
    END`;

  const rows = await rawQuery(
    `SELECT ${bandCase} AS band_index,
            SUM(is_redeemed) AS redemptions,
            COUNT(*)         AS claims
       FROM (
         SELECT cl.id,
                (cl.status = 'redeemed') AS is_redeemed,
                MIN(${distanceKm})       AS nearest_km
           FROM offer_claims cl
           JOIN offers o        ON o.id = cl.offer_id
           JOIN users u         ON u.id = cl.user_id
           JOIN shop_branches b ON b.shop_id = o.shop_id AND b.status = 'active'
          WHERE o.shop_id = ?
            AND u.pref_latitude IS NOT NULL AND u.pref_longitude IS NOT NULL
            AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
            AND (cl.branch_id IS NULL OR cl.branch_id = b.id)
          GROUP BY cl.id, is_redeemed
       ) AS nearest
      GROUP BY band_index
      HAVING band_index IS NOT NULL`,
    [shopId],
  );

  return rows
    .map((row) => {
      const band = RADIUS_BANDS[Number(row.band_index)];
      if (!band) return null;
      return {
        ...band,
        views: 0,
        claims: toNumber(row.claims),
        redemptions: toNumber(row.redemptions),
      };
    })
    .filter((band) => band && (band.claims > 0 || band.redemptions > 0))
    .sort((a, b) => a.minKm - b.minKm);
}

/** Engagement by weekday, from the raw view and claim events (§13). */
async function dayPerformance(shopId) {
  const rows = await rawQuery(
    `SELECT DAYOFWEEK(v.created_at) AS day_index,
            SUM(v.event_type = 'view')  AS views,
            SUM(v.event_type = 'click') AS clicks
       FROM offer_views v
       JOIN offers o ON o.id = v.offer_id
      WHERE o.shop_id = ?
      GROUP BY day_index`,
    [shopId],
  );

  const claims = await rawQuery(
    `SELECT DAYOFWEEK(cl.claimed_at) AS day_index,
            COUNT(*) AS claims,
            SUM(cl.status = 'redeemed') AS redemptions
       FROM offer_claims cl
       JOIN offers o ON o.id = cl.offer_id
      WHERE o.shop_id = ?
      GROUP BY day_index`,
    [shopId],
  );

  const byIndex = new Map();
  for (const row of rows) {
    byIndex.set(Number(row.day_index), {
      weekday: WEEKDAYS[Number(row.day_index) - 1],
      views: toNumber(row.views),
      claims: 0,
      redemptions: 0,
    });
  }
  for (const row of claims) {
    const index = Number(row.day_index);
    const entry = byIndex.get(index) ?? {
      weekday: WEEKDAYS[index - 1],
      views: 0,
      claims: 0,
      redemptions: 0,
    };
    entry.claims = toNumber(row.claims);
    entry.redemptions = toNumber(row.redemptions);
    byIndex.set(index, entry);
  }

  return [...byIndex.values()]
    .filter((entry) => entry.weekday)
    .sort((a, b) => b.views + b.claims - (a.views + a.claims));
}

/** Engagement by hour of day, for the "best time" half of §13. */
async function hourPerformance(shopId) {
  const rows = await rawQuery(
    `SELECT HOUR(v.created_at) AS hour, COUNT(*) AS views
       FROM offer_views v
       JOIN offers o ON o.id = v.offer_id
      WHERE o.shop_id = ? AND v.event_type IN ('view', 'click')
      GROUP BY hour
      ORDER BY views DESC
      LIMIT 6`,
    [shopId],
  );
  return rows.map((row) => ({ hour: Number(row.hour), views: toNumber(row.views), claims: 0 }));
}

/**
 * Category-level activity in the categories this shop sells in (§31).
 *
 * Aggregated across every merchant and never attributed, so it can say
 * "footwear offers are getting more engagement" without exposing whose.
 */
async function categoryTrends(shopId) {
  const rows = await rawQuery(
    `SELECT c.name AS category_name,
            COUNT(DISTINCT o.id) AS active_offers,
            COALESCE(SUM(o.view_count), 0) AS views,
            (SELECT COUNT(*) FROM offer_claims cl
               JOIN offers o2 ON o2.id = cl.offer_id
              WHERE o2.category_id = c.id AND o2.status = 'active') AS claims
       FROM categories c
       JOIN offers o ON o.category_id = c.id AND o.status = 'active'
      WHERE c.id IN (SELECT category_id FROM shop_categories WHERE shop_id = ?)
      GROUP BY c.id, c.name
      HAVING active_offers >= 3
      ORDER BY views DESC
      LIMIT 5`,
    [shopId],
  );

  return rows.map((row) => ({
    categoryName: row.category_name,
    activeOffers: toNumber(row.active_offers),
    views: toNumber(row.views),
    claims: toNumber(row.claims),
  }));
}

async function catalogue(shopId) {
  const [categories, products] = await Promise.all([
    query("SELECT name FROM categories WHERE status = 'active' ORDER BY name LIMIT 60"),
    query(
      // GROUP BY rather than DISTINCT: the ordering column has to be an
      // aggregate for MySQL to allow it alongside de-duplication.
      `SELECT product_name FROM offers
        WHERE shop_id = ? AND product_name IS NOT NULL AND product_name <> ''
        GROUP BY product_name
        ORDER BY MAX(updated_at) DESC
        LIMIT 30`,
      [shopId],
    ),
  ]);
  return {
    availableCategories: categories.map((row) => row.name),
    availableProducts: products.map((row) => row.product_name),
  };
}

/**
 * Assemble the context for one shop under one plan.
 *
 * @param {number} shopId
 * @param {object} plan  resolved subscription plan
 */
async function build(shopId, plan) {
  const [profile, activeOffers, cat] = await Promise.all([
    shopProfile(shopId),
    offerPerformance(shopId, { finished: false, limit: 6 }),
    catalogue(shopId),
  ]);

  const context = {
    shop: profile ?? {},
    previousOffers: [],
    activeOffers,
    radiusBands: [],
    dayPerformance: [],
    hourPerformance: [],
    categoryTrends: [],
    availableCategories: cat.availableCategories,
    availableProducts: cat.availableProducts,
    historyAvailable: false,
    locationDataAvailable: false,
    timingDataAvailable: false,
    allowHistoricalInsights: Boolean(plan.historicalInsights),
    allowLocationInsights: Boolean(plan.locationInsights),
    allowTimingInsights: Boolean(plan.timingInsights),
  };

  if (plan.historicalInsights) {
    context.previousOffers = await offerPerformance(shopId, {
      finished: true,
      limit: env.ai.historyOfferLimit,
    });
    // "Enough to reason from" is a real threshold, not a boolean on emptiness:
    // one finished offer with no claims is not a pattern (§38).
    const measured = context.previousOffers.filter(
      (offer) => offer.views > 0 || offer.claims > 0 || offer.redemptions > 0,
    );
    context.historyAvailable = measured.length >= env.ai.minHistoryOffers;
  }

  if (plan.locationInsights) {
    context.radiusBands = await radiusBands(shopId);
    context.locationDataAvailable = context.radiusBands.length >= 2;
  }

  if (plan.timingInsights) {
    const [days, hours] = await Promise.all([dayPerformance(shopId), hourPerformance(shopId)]);
    context.dayPerformance = days.slice(0, 7);
    context.hourPerformance = hours;
    context.timingDataAvailable = days.length >= 3;
  }

  context.categoryTrends = await categoryTrends(shopId).catch(() => []);

  return context;
}

module.exports = { build, RADIUS_BANDS };
