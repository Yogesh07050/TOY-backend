'use strict';

const metrics = require('../../config/businessMetrics');

/**
 * Shared query fragments for the Business Dashboard (Business §32, §33).
 *
 * Every dashboard in this module accepts the same filter set, and every one of
 * them ultimately narrows to "which shops does this cover?" - even the customer
 * metrics, because a customer is only counted for a city or a category through
 * the shops they engaged with. Building that predicate once here is what keeps
 * a city filter meaning the same thing on the Customer page as on the Revenue
 * page, which §33's "do not compare incompatible time windows" is the
 * time-axis version of.
 *
 * Every fragment is parameterised. Nothing in this file interpolates a value
 * into SQL; the only things concatenated are column names chosen by the caller
 * from a fixed set.
 */

// ---------------------------------------------------------------------------
// Shop narrowing (§32)
// ---------------------------------------------------------------------------

/**
 * `EXISTS (...)`-style predicate matching the shops the filters select.
 *
 * Returned as a subquery on ids rather than a join so it can be dropped into
 * any query that has a shop id to hand, whatever it calls the column, without
 * disturbing that query's own grouping.
 *
 * An empty filter set returns an empty fragment - not `IN (SELECT id FROM
 * shops)`, which would make every dashboard pay for a scan it does not need.
 */
function shopFilter(filters = {}, column = 'shop_id') {
  const conditions = [];
  const params = [];

  if (filters.shopId) {
    conditions.push('s.id = ?');
    params.push(filters.shopId);
  }
  if (filters.city) {
    conditions.push(
      `EXISTS (SELECT 1 FROM shop_branches b
                WHERE b.shop_id = s.id AND b.status = 'active' AND b.city = ?)`,
    );
    params.push(filters.city);
  }
  if (filters.area) {
    conditions.push(
      `EXISTS (SELECT 1 FROM shop_branches b
                WHERE b.shop_id = s.id AND b.status = 'active' AND b.area = ?)`,
    );
    params.push(filters.area);
  }
  if (filters.categoryId) {
    // A shop's categories and its listings' categories are separate facts, and
    // a merchant filed under "Food" who posts a clothing offer belongs in both
    // answers. Either match counts.
    conditions.push(
      `(EXISTS (SELECT 1 FROM shop_categories sc WHERE sc.shop_id = s.id AND sc.category_id = ?)
        OR EXISTS (SELECT 1 FROM offers o2
                    WHERE o2.shop_id = s.id
                      AND (o2.category_id = ? OR o2.subcategory_id = ?))
        OR EXISTS (SELECT 1 FROM services sv2
                    WHERE sv2.shop_id = s.id
                      AND (sv2.category_id = ? OR sv2.subcategory_id = ?)))`,
    );
    params.push(filters.categoryId, filters.categoryId, filters.categoryId, filters.categoryId, filters.categoryId);
  }
  if (filters.plan) {
    conditions.push(
      `EXISTS (SELECT 1 FROM shop_subscriptions sub
                WHERE sub.shop_id = s.id AND sub.plan = ?)`,
    );
    params.push(filters.plan);
  }
  if (filters.acquisitionChannel) {
    conditions.push('s.acquisition_channel = ?');
    params.push(filters.acquisitionChannel);
  }
  if (filters.branchId) {
    conditions.push('EXISTS (SELECT 1 FROM shop_branches b2 WHERE b2.id = ? AND b2.shop_id = s.id)');
    params.push(filters.branchId);
  }
  if (filters.offerId) {
    conditions.push('EXISTS (SELECT 1 FROM offers o3 WHERE o3.id = ? AND o3.shop_id = s.id)');
    params.push(filters.offerId);
  }
  if (filters.serviceId) {
    conditions.push('EXISTS (SELECT 1 FROM services sv3 WHERE sv3.id = ? AND sv3.shop_id = s.id)');
    params.push(filters.serviceId);
  }

  if (conditions.length === 0) return { sql: '', params: [], active: false };

  return {
    sql: ` AND ${column} IN (SELECT s.id FROM shops s WHERE ${conditions.join(' AND ')})`,
    params,
    active: true,
  };
}

/**
 * §32's "Listing Type" filter: offers, services, or both.
 *
 * Returned as two booleans rather than SQL because it changes which unions a
 * query includes, not which rows a predicate keeps.
 */
function listingTypes(filters = {}) {
  const type = filters.listingType ?? 'all';
  return { offers: type === 'all' || type === 'offer', services: type === 'all' || type === 'service' };
}

// ---------------------------------------------------------------------------
// Active users (§5.1, §6)
// ---------------------------------------------------------------------------

/**
 * `(user_id, day)` for every meaningful customer activity in a window.
 *
 * Four sources are unioned because the platform records engagement in four
 * places and always has: the generic event stream, the dedicated offer-view
 * table, claims, and saves. Reading only `analytics_events` would undercount
 * DAU by exactly the actions that matter most.
 *
 * `UNION ALL` rather than `UNION`: the caller always wraps this in
 * `COUNT(DISTINCT user_id)`, so paying to deduplicate twice is waste.
 *
 * When a shop-narrowing filter is in play, an activity only counts if it can be
 * attributed to a matching shop. App opens and searches carry no shop, so they
 * drop out of a city or category view - which is the honest answer: "how many
 * people were active in Madurai" cannot include someone who only launched the
 * app. With no filter, everything counts.
 */
function activeUserSource(from, to, filters = {}) {
  const scoped = shopFilter(filters, 'ae.shop_id');
  const params = [];

  const eventPlaceholders = metrics.ACTIVE_USER_EVENTS.map(() => '?').join(',');

  // 1. Generic event stream.
  let sql = `SELECT ae.user_id AS user_id, DATE(ae.created_at) AS day
               FROM analytics_events ae
              WHERE ae.user_id IS NOT NULL
                AND ae.event_type IN (${eventPlaceholders})
                AND ae.created_at BETWEEN ? AND ?`;
  params.push(...metrics.ACTIVE_USER_EVENTS, from, to);
  if (scoped.active) {
    sql += ` AND ae.shop_id IS NOT NULL${scoped.sql}`;
    params.push(...scoped.params);
  }

  // 2. Offer detail views, clicks and shares. Impressions are excluded here for
  //    the same reason they are excluded from the event list.
  const viewScope = shopFilter(filters, 'o.shop_id');
  sql += `
    UNION ALL
    SELECT v.user_id AS user_id, DATE(v.created_at) AS day
      FROM offer_views v JOIN offers o ON o.id = v.offer_id
     WHERE v.user_id IS NOT NULL
       AND v.event_type IN ('view', 'click', 'share')
       AND v.created_at BETWEEN ? AND ?${viewScope.sql}`;
  params.push(from, to, ...viewScope.params);

  // 3. Claims.
  const claimScope = shopFilter(filters, 'c.shop_id');
  sql += `
    UNION ALL
    SELECT c.user_id AS user_id, DATE(c.claimed_at) AS day
      FROM offer_claims c
     WHERE c.claimed_at BETWEEN ? AND ?${claimScope.sql}`;
  params.push(from, to, ...claimScope.params);

  // 4. Saves.
  const favScope = shopFilter(filters, 'o.shop_id');
  sql += `
    UNION ALL
    SELECT f.user_id AS user_id, DATE(f.created_at) AS day
      FROM favorites f JOIN offers o ON o.id = f.offer_id
     WHERE f.created_at BETWEEN ? AND ?${favScope.sql}`;
  params.push(from, to, ...favScope.params);

  return { sql, params };
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const num = (value) => Number(value ?? 0);

/** A ratio as a percentage to one decimal, or null when there is no base. */
const percent = (value, base) =>
  base > 0 ? Number(((value / base) * 100).toFixed(1)) : null;

/** A per-unit average to two decimals, or null when there is no denominator. */
const per = (value, base) => (base > 0 ? Number((value / base).toFixed(2)) : null);

/** Period-over-period change, to one decimal. Null when there is no baseline. */
const change = (current, previous) =>
  previous > 0 ? Number((((current - previous) / previous) * 100).toFixed(1)) : null;

const trendOf = (delta) => {
  if (delta === null) return 'flat';
  if (delta > 1) return 'up';
  if (delta < -1) return 'down';
  return 'flat';
};

/**
 * A KPI card in the shape §4 asks for: current value, previous period, change,
 * trend. `format` tells the UI whether it is looking at a count, a percentage
 * or rupees, so the dashboard never has to guess from the key name.
 */
function kpi(key, label, current, previous, options = {}) {
  const delta = change(current, previous);
  return {
    key,
    label,
    value: current,
    previous,
    change: delta,
    trend: options.invertTrend ? invert(trendOf(delta)) : trendOf(delta),
    format: options.format ?? 'number',
    hint: options.hint ?? null,
  };
}

/**
 * Churn going up is bad. Without this, the churn card renders a cheerful green
 * arrow for the worst news on the page.
 */
const invert = (trend) => (trend === 'up' ? 'down' : trend === 'down' ? 'up' : 'flat');

/** The middle value of a sorted list, which §12 asks for alongside the mean. */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2))
    : Number(sorted[middle].toFixed(2));
}

module.exports = {
  shopFilter,
  listingTypes,
  activeUserSource,
  num,
  percent,
  per,
  change,
  trendOf,
  invert,
  kpi,
  median,
};
