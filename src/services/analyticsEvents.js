'use strict';

const { execute, queryOne } = require('../db/pool');

/**
 * Analytics event tracking (V3 §28).
 *
 * Offer and banner events keep their existing dedicated tables - they carry
 * counters the listings depend on. Everything else lands in `analytics_events`,
 * which is append-only, indexed for the dashboard access patterns, and holds
 * only the fields a dashboard aggregates (§28: "events should contain only the
 * information necessary for analytics").
 *
 * Recording is deliberately best-effort: a failed insert must never break the
 * customer request that triggered it.
 */

const EVENT_TYPES = {
  OFFER_IMPRESSION: 'OFFER_IMPRESSION',
  OFFER_VIEW: 'OFFER_VIEW',
  OFFER_SAVE: 'OFFER_SAVE',
  OFFER_SHARE: 'OFFER_SHARE',
  OFFER_CLAIM: 'OFFER_CLAIM',
  OFFER_REDEMPTION: 'OFFER_REDEMPTION',

  BANNER_IMPRESSION: 'BANNER_IMPRESSION',
  BANNER_CLICK: 'BANNER_CLICK',

  SEARCH: 'SEARCH',
  CATEGORY_VIEW: 'CATEGORY_VIEW',
  SHOP_VIEW: 'SHOP_VIEW',

  LOCATION_SEARCH: 'LOCATION_SEARCH',
  NEARBY_OFFER_VIEW: 'NEARBY_OFFER_VIEW',

  CUSTOMER_SIGNUP: 'CUSTOMER_SIGNUP',
  CUSTOMER_RETURN: 'CUSTOMER_RETURN',
};

const EVENT_TYPE_NAMES = Object.keys(EVENT_TYPES);

/** Events a client is allowed to post directly; the rest are server-recorded. */
const CLIENT_EVENT_TYPES = [
  EVENT_TYPES.OFFER_IMPRESSION,
  EVENT_TYPES.SEARCH,
  EVENT_TYPES.CATEGORY_VIEW,
  EVENT_TYPES.SHOP_VIEW,
  EVENT_TYPES.LOCATION_SEARCH,
  EVENT_TYPES.NEARBY_OFFER_VIEW,
  EVENT_TYPES.BANNER_IMPRESSION,
];

/**
 * Appends one event. Never throws - callers sit on request paths where losing
 * an analytics row is far cheaper than losing the response.
 */
async function record(eventType, payload = {}) {
  try {
    await execute(
      `INSERT INTO analytics_events
         (event_type, shop_id, offer_id, banner_id, branch_id, category_id, user_id,
          city, pincode, latitude, longitude, term, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventType,
        payload.shopId ?? null,
        payload.offerId ?? null,
        payload.bannerId ?? null,
        payload.branchId ?? null,
        payload.categoryId ?? null,
        payload.userId ?? null,
        payload.city ?? null,
        payload.pincode ?? null,
        payload.latitude ?? null,
        payload.longitude ?? null,
        // Search terms are truncated rather than rejected; they are a trend
        // signal, not a record worth failing a request over.
        payload.term ? String(payload.term).slice(0, 160) : null,
        payload.createdAt ?? new Date(),
      ],
    );
  } catch (error) {
    console.error('[analytics] %s event dropped: %s', eventType, error.message);
  }
}

/**
 * Records that a customer engaged with a shop and answers whether this was
 * their first time (§14, §23). Uses one upsert so concurrent events cannot
 * double-count a first visit.
 */
async function touchShopCustomer(shopId, userId, kind = 'visit') {
  if (!shopId || !userId) return { isNew: false };

  const column = { save: 'save_count', claim: 'claim_count', redeem: 'redeem_count' }[kind];
  const increment = column ? `, ${column} = ${column} + 1` : '';

  try {
    const result = await execute(
      `INSERT INTO shop_customers (shop_id, user_id, first_seen_at, last_seen_at, visit_count${column ? `, ${column}` : ''})
       VALUES (?, ?, NOW(), NOW(), 1${column ? ', 1' : ''})
       ON DUPLICATE KEY UPDATE last_seen_at = NOW(), visit_count = visit_count + 1${increment}`,
      [shopId, userId],
    );
    // mysql2 reports affectedRows = 1 for an insert and 2 for an update.
    return { isNew: result.affectedRows === 1 };
  } catch (error) {
    console.error('[analytics] shop customer touch failed: %s', error.message);
    return { isNew: false };
  }
}

/** Resolves the shop (and its city) behind an offer, for event enrichment. */
async function shopContextForOffer(offerId) {
  if (!offerId) return null;
  return queryOne(
    `SELECT o.shop_id AS shopId, o.category_id AS categoryId,
            (SELECT b.city FROM shop_branches b
              WHERE b.shop_id = o.shop_id AND b.status = 'active'
              ORDER BY b.is_primary DESC, b.id LIMIT 1) AS city
       FROM offers o WHERE o.id = ?`,
    [offerId],
  );
}

module.exports = {
  EVENT_TYPES,
  EVENT_TYPE_NAMES,
  CLIENT_EVENT_TYPES,
  record,
  touchShopCustomer,
  shopContextForOffer,
};
