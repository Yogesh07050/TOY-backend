'use strict';

const { rawQuery } = require('../db/pool');
const geo = require('../utils/geo');

/**
 * Subscription rank of the offer's shop (V3 §36, §37).
 *
 * Premium buys priority *eligibility*, so this is applied after the relevance
 * score has already ordered the list - a paid plan breaks a tie between two
 * equally relevant offers and does nothing more. A recommendation the customer
 * has given no signal for still scores zero and never appears.
 */
const PLAN_RANK_SQL = `(CASE
  WHEN sub.status = 'active' AND sub.plan = 'PREMIUM'  THEN 2
  WHEN sub.status = 'active' AND sub.plan = 'BUSINESS' THEN 1
  ELSE 0 END)`;

/**
 * Rule-based recommendations (§20, §21).
 *
 * Deliberately not an ML engine: this scores live offers against a handful of
 * explicit signals the customer has already given us. It lives in its own
 * module with a single entry point (`recommend`) so a future model can replace
 * the internals without touching the discovery routes.
 *
 * Weights come straight from §21.
 */
const WEIGHTS = {
  // V2 §12/§21: explicit onboarding preferences outrank passive/behavioral
  // signals below - the customer told us this directly, once, on purpose.
  preferredCategory: 6,
  followedShop: 5,
  followedCategory: 5,
  savedSimilar: 4,
  minDiscountMet: 3,
  preferredOfferType: 3,
  viewedCategory: 3,
  viewedShop: 3,
  searched: 2,
  nearby: 2,
  popular: 2,
  fresh: 1,
};

/** Signals in the order we prefer to explain a recommendation by. */
const REASONS = [
  ['preferredCategory', (offer) => `Because you like ${offer.category?.name ?? 'this category'}`],
  ['followedShop', 'Because you follow this shop'],
  ['followedCategory', 'Because you follow this category'],
  ['savedSimilar', 'Similar to an offer you saved'],
  ['minDiscountMet', 'Matches your discount preference'],
  ['preferredOfferType', 'A deal type you like'],
  ['viewedCategory', (offer) => `Because you viewed ${offer.category?.name ?? 'this category'}`],
  ['viewedShop', 'Because you viewed this shop'],
  ['searched', 'Matches something you searched for'],
  ['nearby', 'Near your location'],
  ['popular', 'Popular right now'],
  ['fresh', 'Just published'],
];

/**
 * @param {object|null} user      signed-in user, or null for an anonymous visitor
 * @param {object} options
 * @param {{latitude:number,longitude:number}|null} [options.position]
 * @param {number} [options.radiusKm]
 * @param {number} [options.limit]
 */
async function recommend(user, { position = null, radiusKm = 10, limit = 8 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 8, 1), 24);
  const userId = user?.id ?? null;
  const params = [];

  // Each signal is a 0/1 flag so the score stays inspectable and the reason
  // shown to the customer can be derived from which flags fired.
  const signals = {};

  if (userId) {
    // V2 §5/§9: explicit onboarding preference, distinct from followedCategory
    // (a notification opt-in) even though both are "user likes category X".
    signals.preferredCategory = `CASE WHEN EXISTS (
      SELECT 1 FROM customer_category_preferences ccp
       WHERE ccp.user_id = ? AND ccp.category_id IN (o.category_id, o.subcategory_id)
    ) THEN 1 ELSE 0 END`;
    // Favorite shops (V2 §6) intentionally reuse followed_shops - see schema.sql -
    // so this one signal already covers both "follows for notifications" and
    // "selected as a favorite shop during onboarding".
    signals.followedShop = `CASE WHEN EXISTS (
      SELECT 1 FROM followed_shops fs WHERE fs.user_id = ? AND fs.shop_id = o.shop_id
    ) THEN 1 ELSE 0 END`;
    signals.followedCategory = `CASE WHEN EXISTS (
      SELECT 1 FROM followed_categories fc
       WHERE fc.user_id = ? AND fc.category_id IN (o.category_id, o.subcategory_id)
    ) THEN 1 ELSE 0 END`;
    signals.savedSimilar = `CASE WHEN EXISTS (
      SELECT 1 FROM favorites f JOIN offers so ON so.id = f.offer_id
       WHERE f.user_id = ? AND so.id <> o.id AND so.category_id = o.category_id
    ) THEN 1 ELSE 0 END`;
    // V2 §7: "discount >= X%" only makes sense against a percentage discount -
    // a flat-amount or non-discount offer has no percentage to compare.
    signals.minDiscountMet = `CASE WHEN EXISTS (
      SELECT 1 FROM users u
       WHERE u.id = ? AND u.minimum_discount_percent IS NOT NULL
         AND o.discount_type = 'percentage' AND o.discount_value >= u.minimum_discount_percent
    ) THEN 1 ELSE 0 END`;
    // V2 §8: maps the customer-facing deal-type vocabulary onto the offer
    // columns that actually distinguish them. CASHBACK/FREE_ITEM/COMBO_OFFER/
    // CLEARANCE_SALE/APP_EXCLUSIVE have no corresponding offer column yet (see
    // preferences.constants.js) so they deliberately match nothing here rather
    // than guessing.
    signals.preferredOfferType = `CASE WHEN EXISTS (
      SELECT 1 FROM customer_preferred_offer_types cpot
       WHERE cpot.user_id = ?
         AND ((cpot.offer_type = 'PERCENTAGE_DISCOUNT' AND o.offer_type = 'percentage')
           OR (cpot.offer_type = 'FLAT_DISCOUNT' AND o.offer_type = 'flat')
           OR (cpot.offer_type = 'BUY_ONE_GET_ONE' AND o.offer_type = 'buy_x_get_y'
               AND o.buy_quantity = 1 AND o.get_quantity = 1)
           OR (cpot.offer_type = 'BUY_TWO_GET_ONE' AND o.offer_type = 'buy_x_get_y'
               AND o.buy_quantity = 2 AND o.get_quantity = 1))
    ) THEN 1 ELSE 0 END`;
    signals.viewedCategory = `CASE WHEN EXISTS (
      SELECT 1 FROM offer_views v JOIN offers vo ON vo.id = v.offer_id
       WHERE v.user_id = ? AND v.event_type = 'view'
         AND vo.id <> o.id AND vo.category_id = o.category_id
    ) THEN 1 ELSE 0 END`;
    signals.viewedShop = `CASE WHEN EXISTS (
      SELECT 1 FROM offer_views v2 JOIN offers vo2 ON vo2.id = v2.offer_id
       WHERE v2.user_id = ? AND v2.event_type = 'view'
         AND vo2.id <> o.id AND vo2.shop_id = o.shop_id
    ) THEN 1 ELSE 0 END`;
    signals.searched = `CASE WHEN EXISTS (
      SELECT 1 FROM search_history sh
       WHERE sh.user_id = ?
         AND (o.title LIKE CONCAT('%', sh.term, '%')
           OR o.product_name LIKE CONCAT('%', sh.term, '%'))
    ) THEN 1 ELSE 0 END`;
    params.push(userId, userId, userId, userId, userId, userId, userId, userId, userId);
  } else {
    // Anonymous visitors get the non-personal signals only.
    for (const key of [
      'preferredCategory',
      'followedShop',
      'followedCategory',
      'savedSimilar',
      'minDiscountMet',
      'preferredOfferType',
      'viewedCategory',
      'viewedShop',
      'searched',
    ]) {
      signals[key] = '0';
    }
  }

  if (position) {
    const box = geo.boundingBox(position.latitude, position.longitude, radiusKm);
    signals.nearby = `CASE WHEN EXISTS (
      SELECT 1 FROM shop_branches b
       WHERE b.status = 'active'
         AND b.latitude BETWEEN ? AND ? AND b.longitude BETWEEN ? AND ?
         AND ((o.applicability_type = 'shop_wide' AND b.shop_id = o.shop_id)
           OR (o.applicability_type = 'selected_branches'
               AND EXISTS (SELECT 1 FROM offer_locations ol
                            WHERE ol.offer_id = o.id AND ol.branch_id = b.id)))
    ) THEN 1 ELSE 0 END`;
    params.push(box.minLat, box.maxLat, box.minLng, box.maxLng);
  } else {
    signals.nearby = '0';
  }

  // "Popular" is relative to the current catalogue rather than a fixed number,
  // so a quiet platform still surfaces its best performers.
  signals.popular = `CASE WHEN (o.favorite_count * 3 + o.click_count * 2 + o.view_count)
      >= (SELECT COALESCE(AVG(favorite_count * 3 + click_count * 2 + view_count), 0)
            FROM offers WHERE status = 'active')
    THEN 1 ELSE 0 END`;
  signals.fresh = `CASE WHEN o.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 ELSE 0 END`;

  const scoreSql = Object.entries(signals)
    .map(([key, sql]) => `(${sql}) * ${WEIGHTS[key]}`)
    .join(' + ');

  const flagSelects = Object.entries(signals)
    .map(([key, sql]) => `(${sql}) AS sig_${key}`)
    .join(',\n           ');

  // The signal expressions appear twice (score + flags), so their parameters
  // have to be supplied twice, in the same order.
  const doubledParams = [...params, ...params];

  const rows = await rawQuery(
    `SELECT o.id, o.title, o.offer_text, o.offer_type, o.discount_type, o.discount_value,
            o.original_price, o.discounted_price, o.buy_quantity, o.get_quantity,
            o.product_name, o.start_date, o.end_date, o.status, o.applicability_type,
            o.view_count, o.click_count, o.favorite_count, o.created_at, o.updated_at,
            o.shop_id, o.category_id,
            s.name AS shop_name, s.slug AS shop_slug, s.logo_url AS shop_logo_url,
            c.name AS category_name, c.slug AS category_slug,
            (SELECT oi.image_url FROM offer_images oi
              WHERE oi.offer_id = o.id ORDER BY oi.display_order, oi.id LIMIT 1) AS image_url,
            (SELECT oi.thumbnail_url FROM offer_images oi
              WHERE oi.offer_id = o.id ORDER BY oi.display_order, oi.id LIMIT 1) AS thumbnail_url,
            (${scoreSql}) AS score,
            ${PLAN_RANK_SQL} AS plan_rank,
            ${flagSelects}
       FROM offers o
       JOIN shops s ON s.id = o.shop_id AND s.status = 'active'
       LEFT JOIN categories c ON c.id = o.category_id
      LEFT JOIN shop_subscriptions sub ON sub.shop_id = o.shop_id
      WHERE o.status = 'active' AND o.start_date <= NOW() AND o.end_date >= NOW()
        ${userId ? 'AND NOT EXISTS (SELECT 1 FROM favorites fx WHERE fx.offer_id = o.id AND fx.user_id = ?)' : ''}
      HAVING score > 0
      ORDER BY score DESC, plan_rank DESC, o.favorite_count DESC, o.created_at DESC
      LIMIT ${safeLimit}`,
    userId ? [...doubledParams, userId] : doubledParams,
  );

  return rows.map((row) => {
    const offer = {
      id: Number(row.id),
      title: row.title,
      productName: row.product_name,
      offerText: row.offer_text,
      offerType: row.offer_type,
      discountType: row.discount_type,
      discountValue: row.discount_value === null ? null : Number(row.discount_value),
      originalPrice: row.original_price === null ? null : Number(row.original_price),
      discountedPrice: row.discounted_price === null ? null : Number(row.discounted_price),
      buyQuantity: row.buy_quantity === null ? null : Number(row.buy_quantity),
      getQuantity: row.get_quantity === null ? null : Number(row.get_quantity),
      startDate: row.start_date,
      endDate: row.end_date,
      status: row.status,
      applicabilityType: row.applicability_type,
      imageUrl: row.image_url,
      thumbnailUrl: row.thumbnail_url,
      viewCount: Number(row.view_count),
      clickCount: Number(row.click_count),
      favoriteCount: Number(row.favorite_count),
      distanceKm: null,
      locationLabel: null,
      isFavorite: false,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      shop: {
        id: Number(row.shop_id),
        name: row.shop_name,
        slug: row.shop_slug,
        logoUrl: row.shop_logo_url,
      },
      category: row.category_id
        ? { id: Number(row.category_id), name: row.category_name, slug: row.category_slug }
        : null,
      score: Number(row.score),
    };

    // Explain the recommendation using the highest-weight signal that fired.
    const hit = REASONS.find(([key]) => Number(row[`sig_${key}`]) === 1);
    offer.reason = hit ? (typeof hit[1] === 'function' ? hit[1](offer) : hit[1]) : 'Popular right now';
    return offer;
  });
}

/** Records a search term as a (mild) personalisation signal. */
async function rememberSearch(userId, term) {
  if (!userId || !term || term.trim().length < 2) return;
  await rawQuery('INSERT INTO search_history (user_id, term) VALUES (?, ?)', [
    userId,
    term.trim().slice(0, 120),
  ]);
  // Keep only the most recent terms so the signal stays current and the table
  // does not grow without bound.
  await rawQuery(
    `DELETE FROM search_history
      WHERE user_id = ? AND id NOT IN (
        SELECT id FROM (
          SELECT id FROM search_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
        ) AS keep
      )`,
    [userId, userId],
  );
}

module.exports = { recommend, rememberSearch, WEIGHTS };
