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

  // ---- V3 claim codes & redemption (§32) ----------------------------------
  // The customer looking at a code they already hold, and looking at the QR
  // specifically. Both are client-posted: they are screen views, and the only
  // question they answer is whether customers can find their codes again.
  OFFER_CLAIM_VIEW: 'OFFER_CLAIM_VIEW',
  CLAIM_QR_VIEW: 'CLAIM_QR_VIEW',
  // The merchant's side, all server-recorded. ATTEMPT is every scan or typed
  // code; SUCCESS and FAILURE split it by outcome. A shop whose attempts run
  // far ahead of its successes is either training staff badly or being probed.
  CLAIM_VERIFICATION_ATTEMPT: 'CLAIM_VERIFICATION_ATTEMPT',
  CLAIM_VERIFICATION_SUCCESS: 'CLAIM_VERIFICATION_SUCCESS',
  CLAIM_VERIFICATION_FAILURE: 'CLAIM_VERIFICATION_FAILURE',
  // A verified claim the merchant then declined to redeem, which is not the
  // same as a code that failed to verify.
  OFFER_REDEMPTION_REJECTED: 'OFFER_REDEMPTION_REJECTED',

  BANNER_IMPRESSION: 'BANNER_IMPRESSION',
  BANNER_CLICK: 'BANNER_CLICK',

  SEARCH: 'SEARCH',
  CATEGORY_VIEW: 'CATEGORY_VIEW',
  SHOP_VIEW: 'SHOP_VIEW',

  LOCATION_SEARCH: 'LOCATION_SEARCH',
  NEARBY_OFFER_VIEW: 'NEARBY_OFFER_VIEW',

  CUSTOMER_SIGNUP: 'CUSTOMER_SIGNUP',
  CUSTOMER_RETURN: 'CUSTOMER_RETURN',

  // ---- V2 personalization (§32) --------------------------------------------
  // *_SELECTED/STARTED are pure UI signals fired as the customer moves through
  // onboarding - client-postable. *_COMPLETED/UPDATED are recorded server-side
  // by the preferences module itself, only once the write actually commits.
  PREFERENCE_ONBOARDING_STARTED: 'PREFERENCE_ONBOARDING_STARTED',
  PREFERENCE_CATEGORY_SELECTED: 'PREFERENCE_CATEGORY_SELECTED',
  PREFERENCE_SHOP_SELECTED: 'PREFERENCE_SHOP_SELECTED',
  PREFERENCE_DISCOUNT_SELECTED: 'PREFERENCE_DISCOUNT_SELECTED',
  PREFERENCE_OFFER_TYPE_SELECTED: 'PREFERENCE_OFFER_TYPE_SELECTED',
  PREFERENCE_ONBOARDING_COMPLETED: 'PREFERENCE_ONBOARDING_COMPLETED',
  PREFERENCE_UPDATED: 'PREFERENCE_UPDATED',

  // PERSONALIZED_OFFER_VIEW/SAVE/CLAIM are reserved vocabulary, not yet wired:
  // view/save/claim already record via OFFER_VIEW/OFFER_SAVE/OFFER_CLAIM on
  // their existing endpoints (track/favorites/claims), which have no "was this
  // shown in a personalized rail" context to tag on. Distinguishing them would
  // mean threading that context through those endpoints - left for when a
  // consumer actually needs the split, rather than building an unused path.
  PERSONALIZED_OFFER_IMPRESSION: 'PERSONALIZED_OFFER_IMPRESSION',
  PERSONALIZED_OFFER_VIEW: 'PERSONALIZED_OFFER_VIEW',
  PERSONALIZED_OFFER_SAVE: 'PERSONALIZED_OFFER_SAVE',
  PERSONALIZED_OFFER_CLAIM: 'PERSONALIZED_OFFER_CLAIM',

  RECOMMENDATION_CLICK: 'RECOMMENDATION_CLICK',
  RECOMMENDATION_DISMISS: 'RECOMMENDATION_DISMISS',

  // ---- V4 Services -----------------------------------------------------
  // Services have no dedicated raw-event table (unlike offers/offer_views) -
  // these all land in analytics_events, tagged with service_id.
  SERVICE_VIEW: 'SERVICE_VIEW',
  SERVICE_SAVE: 'SERVICE_SAVE',
  SERVICE_SHARE: 'SERVICE_SHARE',
  SERVICE_ENQUIRE: 'SERVICE_ENQUIRE',
  SERVICE_BOOK: 'SERVICE_BOOK',
  SERVICE_CANCEL: 'SERVICE_CANCEL',
  SERVICE_CLAIM: 'SERVICE_CLAIM',
  SERVICE_REDEEM: 'SERVICE_REDEEM',
  SERVICE_OFFER_VIEW: 'SERVICE_OFFER_VIEW',
  SERVICE_OFFER_CLAIM: 'SERVICE_OFFER_CLAIM',
  SERVICE_OFFER_REDEEM: 'SERVICE_OFFER_REDEEM',
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
  EVENT_TYPES.OFFER_CLAIM_VIEW,
  EVENT_TYPES.CLAIM_QR_VIEW,

  EVENT_TYPES.PREFERENCE_ONBOARDING_STARTED,
  EVENT_TYPES.PREFERENCE_CATEGORY_SELECTED,
  EVENT_TYPES.PREFERENCE_SHOP_SELECTED,
  EVENT_TYPES.PREFERENCE_DISCOUNT_SELECTED,
  EVENT_TYPES.PREFERENCE_OFFER_TYPE_SELECTED,
  EVENT_TYPES.PERSONALIZED_OFFER_IMPRESSION,
  EVENT_TYPES.RECOMMENDATION_CLICK,
  EVENT_TYPES.RECOMMENDATION_DISMISS,
];

/**
 * Appends one event. Never throws - callers sit on request paths where losing
 * an analytics row is far cheaper than losing the response.
 */
async function record(eventType, payload = {}) {
  try {
    await execute(
      `INSERT INTO analytics_events
         (event_type, shop_id, offer_id, service_id, banner_id, branch_id, category_id, user_id,
          city, pincode, latitude, longitude, term, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventType,
        payload.shopId ?? null,
        payload.offerId ?? null,
        payload.serviceId ?? null,
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

/** Resolves the shop (and its city) behind a service, for event enrichment. */
async function shopContextForService(serviceId) {
  if (!serviceId) return null;
  return queryOne(
    `SELECT sv.shop_id AS shopId, sv.category_id AS categoryId,
            (SELECT b.city FROM shop_branches b
              WHERE b.shop_id = sv.shop_id AND b.status = 'active'
              ORDER BY b.is_primary DESC, b.id LIMIT 1) AS city
       FROM services sv WHERE sv.id = ?`,
    [serviceId],
  );
}

module.exports = {
  EVENT_TYPES,
  EVENT_TYPE_NAMES,
  CLIENT_EVENT_TYPES,
  record,
  touchShopCustomer,
  shopContextForOffer,
  shopContextForService,
};
