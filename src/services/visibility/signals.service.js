'use strict';

const { query, execute } = require('../../db/pool');
const config = require('./config');

/**
 * Precomputed listing quality and engagement scores (§2.4, §4, §33).
 *
 * §33 recommends precomputing merchant/listing quality scores, and both of
 * these need it for the same reason: each is a multi-table aggregate that would
 * otherwise run inside every ranked request. Offer quality joins the listing,
 * its images, its branches and its shop; engagement scans a month of events.
 * Neither changes minute to minute, so both are rebuilt on a schedule and read
 * back as one indexed lookup.
 *
 * Staleness is bounded and safe. An hour-old engagement score can never show an
 * expired offer - expiry is checked live in the candidate query (§24) - it can
 * only mean a listing that took off in the last hour has not been rewarded for
 * it yet.
 */

// ---------------------------------------------------------------------------
// Offer quality (§4)

/**
 * The completeness checklist, as SQL predicates.
 *
 * Each returns 0/1 and is weighted by `qualityWeights`. They are written as
 * "is this actually useful to a customer" rather than "is this column NOT
 * NULL": a two-word description and an empty one are equally useless to
 * someone deciding whether to walk to a shop, so the description test has a
 * length floor.
 */
const OFFER_QUALITY_SQL = `
  SELECT o.id AS listing_id, 'offer' AS listing_type, o.shop_id,
         (CHAR_LENGTH(TRIM(COALESCE(o.title, ''))) >= 8) AS has_title,
         (CHAR_LENGTH(TRIM(COALESCE(o.description, ''))) >= 30) AS has_description,
         ((o.discount_value IS NOT NULL AND o.discount_value > 0)
           OR o.discounted_price IS NOT NULL
           OR CHAR_LENGTH(TRIM(COALESCE(o.offer_text, ''))) >= 4) AS has_discount,
         EXISTS (SELECT 1 FROM offer_images oi WHERE oi.offer_id = o.id) AS has_image,
         (o.category_id IS NOT NULL) AS has_category,
         EXISTS (SELECT 1 FROM shop_branches b
                  WHERE b.status = 'active' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
                    AND ((o.applicability_type = 'shop_wide' AND b.shop_id = o.shop_id)
                      OR (o.applicability_type = 'selected_branches'
                          AND EXISTS (SELECT 1 FROM offer_locations ol
                                       WHERE ol.offer_id = o.id AND ol.branch_id = b.id)))) AS has_location,
         (o.start_date IS NOT NULL AND o.end_date IS NOT NULL AND o.end_date > o.start_date) AS has_dates,
         (CHAR_LENGTH(TRIM(COALESCE(s.description, ''))) >= 20 AND s.logo_url IS NOT NULL) AS has_shop_profile
    FROM offers o
    JOIN shops s ON s.id = o.shop_id
   WHERE o.status IN ('active', 'scheduled') AND s.status = 'active'`;

const SERVICE_OFFER_QUALITY_SQL = `
  SELECT so.id AS listing_id, 'service_offer' AS listing_type, sv.shop_id,
         (CHAR_LENGTH(TRIM(COALESCE(sv.name, ''))) >= 8) AS has_title,
         (CHAR_LENGTH(TRIM(COALESCE(sv.description, ''))) >= 30) AS has_description,
         ((so.discount_value IS NOT NULL AND so.discount_value > 0)
           OR so.offer_price IS NOT NULL
           OR CHAR_LENGTH(TRIM(COALESCE(so.offer_text, ''))) >= 4) AS has_discount,
         EXISTS (SELECT 1 FROM service_images si WHERE si.service_id = sv.id) AS has_image,
         (sv.category_id IS NOT NULL) AS has_category,
         EXISTS (SELECT 1 FROM shop_branches b
                  WHERE b.status = 'active' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
                    AND ((sv.applicability_type = 'shop_wide' AND b.shop_id = sv.shop_id)
                      OR (sv.applicability_type = 'selected_branches'
                          AND EXISTS (SELECT 1 FROM service_locations sl
                                       WHERE sl.service_id = sv.id AND sl.branch_id = b.id)))) AS has_location,
         (so.start_date IS NOT NULL AND so.end_date IS NOT NULL AND so.end_date > so.start_date) AS has_dates,
         (CHAR_LENGTH(TRIM(COALESCE(s.description, ''))) >= 20 AND s.logo_url IS NOT NULL) AS has_shop_profile
    FROM service_offers so
    JOIN services sv ON sv.id = so.service_id
    JOIN shops s ON s.id = sv.shop_id
   WHERE so.status IN ('active', 'scheduled') AND sv.status = 'active' AND s.status = 'active'`;

const CHECK_TO_WEIGHT = {
  has_title: 'title',
  has_description: 'description',
  has_discount: 'discountValue',
  has_image: 'image',
  has_category: 'category',
  has_location: 'location',
  has_dates: 'validDates',
  has_shop_profile: 'shopProfile',
};

/** 0-1 completeness, plus the per-item detail a merchant can be shown (§27). */
function qualityFrom(row, weights) {
  let earned = 0;
  let possible = 0;
  const detail = {};

  for (const [column, weightKey] of Object.entries(CHECK_TO_WEIGHT)) {
    const weight = weights[weightKey] ?? 0;
    possible += weight;
    const present = Number(row[column]) === 1;
    if (present) earned += weight;
    detail[weightKey] = present;
  }

  return { score: possible > 0 ? earned / possible : 0, detail };
}

// ---------------------------------------------------------------------------
// Engagement (§2.4)

/**
 * Engagement events per listing over the window, already excluding anything the
 * anti-manipulation sweep flagged (§25).
 *
 * `distinct_users` is selected alongside the raw counts because §25's whole
 * point is that a hundred views from a hundred people and a hundred views from
 * one person are not the same signal, and no weighting of the raw counts alone
 * can tell them apart.
 */
async function engagementRows(windowDays) {
  return query(
    `SELECT listing_type, listing_id, shop_id,
            SUM(event_type IN ('IMPRESSION','FEATURED_IMPRESSION')) AS impressions,
            SUM(event_type = 'VIEW') AS views,
            SUM(event_type = 'SAVE') AS saves,
            SUM(event_type = 'CLAIM') AS claims,
            SUM(event_type = 'REDEMPTION') AS redemptions,
            SUM(event_type IN ('SEARCH_CLICK','FEATURED_CLICK')) AS search_clicks,
            SUM(event_type = 'PROFILE_VIEW') AS profile_views,
            SUM(event_type = 'DIRECTIONS_CLICK') AS directions_clicks,
            COUNT(*) AS total_events,
            COUNT(DISTINCT COALESCE(CAST(user_id AS CHAR), device_hash, session_id)) AS distinct_users
       FROM visibility_events
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        AND is_suspicious = 0 AND listing_id IS NOT NULL AND shop_id IS NOT NULL
      GROUP BY listing_type, listing_id, shop_id`,
    [windowDays],
  );
}

/**
 * Legacy counters, used only for listings the event stream has never seen.
 *
 * The visibility event stream starts empty on the day this ships, and without
 * this every listing on the platform would score cold-start engagement at once
 * - which would flatten the ENGAGEMENT factor into noise for a month. The
 * denormalized counters already on `offers` are a coarse but real history, so
 * they seed the score until the stream has its own.
 */
async function legacyOfferRows() {
  return query(
    `SELECT 'offer' AS listing_type, o.id AS listing_id, o.shop_id,
            o.view_count AS views, o.favorite_count AS saves, o.click_count AS search_clicks,
            (SELECT COUNT(*) FROM offer_claims c WHERE c.offer_id = o.id) AS claims,
            (SELECT COUNT(*) FROM offer_claims c WHERE c.offer_id = o.id AND c.status = 'redeemed')
              AS redemptions
       FROM offers o JOIN shops s ON s.id = o.shop_id
      WHERE o.status IN ('active','scheduled') AND s.status = 'active'`,
  );
}

async function legacyServiceOfferRows() {
  return query(
    `SELECT 'service_offer' AS listing_type, so.id AS listing_id, sv.shop_id,
            so.view_count AS views, 0 AS saves, 0 AS search_clicks,
            so.claim_count AS claims,
            (SELECT COUNT(*) FROM service_offer_claims c
              WHERE c.service_offer_id = so.id AND c.status = 'redeemed') AS redemptions
       FROM service_offers so
       JOIN services sv ON sv.id = so.service_id
       JOIN shops s ON s.id = sv.shop_id
      WHERE so.status IN ('active','scheduled') AND sv.status = 'active' AND s.status = 'active'`,
  );
}

/**
 * Turns raw counts into a 0-1 score.
 *
 * Two shaping decisions carry §2.4:
 *
 *   - the weights make a verified redemption worth 500 impressions, because
 *     §2.4 calls redemptions "a particularly strong quality signal" and warns
 *     that "raw impressions alone should not create a large ranking advantage".
 *   - the log curve means the score saturates. A listing with ten times the
 *     engagement of another scores maybe 1.4x, not 10x, so one runaway hit
 *     cannot own an entire category - which is the arithmetic behind §2.6's
 *     exposure balancing.
 */
function engagementFrom(counts, rules) {
  const weights = rules.engagementWeights;

  // Everything a customer actually chose to do.
  const actions =
    (counts.views ?? 0) * weights.views +
    (counts.saves ?? 0) * weights.saves +
    (counts.claims ?? 0) * weights.claims +
    (counts.redemptions ?? 0) * weights.redemptions +
    (counts.searchClicks ?? 0) * weights.searchClicks +
    (counts.profileViews ?? 0) * weights.profileViews +
    (counts.directionsClicks ?? 0) * weights.directionsClicks;

  // §2.4/§4: "Raw impressions alone should not create a large ranking
  // advantage." A low per-impression weight is not enough on its own - a
  // listing shown 50,000 times still out-scores one that was genuinely
  // redeemed. So impressions are capped against the actions they produced:
  // a listing nobody engages with earns nothing from having been shown, no
  // matter how often, while a listing with a healthy funnel gets full credit
  // for its reach. The ratio is configurable, but the shape is the rule.
  const impressionsRaw = (counts.impressions ?? 0) * weights.impressions;
  const raw = actions + Math.min(impressionsRaw, actions * rules.engagementImpressionCapRatio);

  if (raw <= 0) return 0;

  // Concentration discount (§25): how much of this came from distinct people.
  // 1.0 when every event is a different customer, and as low as
  // (1 - distinctWeight) when it is all one account.
  const totalEvents = counts.totalEvents ?? 0;
  const distinct = counts.distinctUsers ?? 0;
  const spread = totalEvents > 0 ? Math.min(1, distinct / totalEvents) : 1;
  const factor = rules.antiManipulationDistinctWeight * spread + (1 - rules.antiManipulationDistinctWeight);

  const effective = raw * factor;
  const score = Math.log1p(effective) / Math.log1p(rules.engagementSaturation);
  return Math.max(0, Math.min(1, score));
}

// ---------------------------------------------------------------------------
// Rebuild

const keyFor = (type, id) => `${type}:${id}`;

/** Whether a count bundle carries any actual engagement, as opposed to zeros. */
const hasSignal = (counts) =>
  Boolean(counts) &&
  ['impressions', 'views', 'saves', 'claims', 'redemptions', 'searchClicks', 'profileViews', 'directionsClicks']
    .some((key) => Number(counts[key] ?? 0) > 0);

/**
 * Recomputes every active listing's quality and engagement score.
 *
 * One upsert per listing rather than a TRUNCATE and reload: the table is read
 * by live ranking, and a truncate would give every concurrent search a moment
 * where nothing has any engagement at all.
 */
async function rebuild() {
  const { rules } = await config.get();

  const [offerQuality, serviceQuality, events, legacyOffers, legacyServices] = await Promise.all([
    query(OFFER_QUALITY_SQL),
    query(SERVICE_OFFER_QUALITY_SQL),
    engagementRows(rules.engagementWindowDays),
    legacyOfferRows(),
    legacyServiceOfferRows(),
  ]);

  const eventsByKey = new Map(
    events.map((row) => [
      keyFor(row.listing_type, Number(row.listing_id)),
      {
        impressions: Number(row.impressions),
        views: Number(row.views),
        saves: Number(row.saves),
        claims: Number(row.claims),
        redemptions: Number(row.redemptions),
        searchClicks: Number(row.search_clicks),
        profileViews: Number(row.profile_views),
        directionsClicks: Number(row.directions_clicks),
        totalEvents: Number(row.total_events),
        distinctUsers: Number(row.distinct_users),
      },
    ]),
  );

  const legacyByKey = new Map(
    [...legacyOffers, ...legacyServices].map((row) => [
      keyFor(row.listing_type, Number(row.listing_id)),
      {
        views: Number(row.views ?? 0),
        saves: Number(row.saves ?? 0),
        claims: Number(row.claims ?? 0),
        redemptions: Number(row.redemptions ?? 0),
        searchClicks: Number(row.search_clicks ?? 0),
        // No identity information exists for legacy counters, so they are
        // treated as maximally spread rather than penalised for something the
        // old schema never recorded.
        totalEvents: 0,
        distinctUsers: 0,
      },
    ]),
  );

  let written = 0;
  const rows = [...offerQuality, ...serviceQuality];

  for (const row of rows) {
    const key = keyFor(row.listing_type, Number(row.listing_id));
    const quality = qualityFrom(row, rules.qualityWeights);

    // A legacy row exists for every active listing, including brand-new ones
    // whose counters are all zero - so "has a legacy row" is not the same as
    // "has a history". Only a row with something in it counts, or every new
    // offer would score a hard 0 on engagement and the cold-start floor below
    // would never apply to the listings it exists for.
    const legacy = legacyByKey.get(key);
    const counts = eventsByKey.get(key) ?? (hasSignal(legacy) ? legacy : null);
    const engagement = counts
      ? engagementFrom(counts, rules)
      : rules.coldStartEngagementScore;

    await execute(
      `INSERT INTO listing_quality_scores
         (listing_type, listing_id, shop_id, quality_score, engagement_score,
          quality_detail, engagement_raw, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         shop_id = VALUES(shop_id), quality_score = VALUES(quality_score),
         engagement_score = VALUES(engagement_score), quality_detail = VALUES(quality_detail),
         engagement_raw = VALUES(engagement_raw), computed_at = NOW()`,
      [
        row.listing_type,
        row.listing_id,
        row.shop_id,
        quality.score.toFixed(4),
        engagement.toFixed(4),
        JSON.stringify(quality.detail),
        counts ? JSON.stringify(counts) : null,
      ],
    );
    written += 1;
  }

  // Scores for listings that are no longer active are dead weight, and leaving
  // them lets a re-activated listing inherit a month-old engagement figure.
  await execute(
    `DELETE lqs FROM listing_quality_scores lqs
      WHERE lqs.listing_type = 'offer'
        AND NOT EXISTS (SELECT 1 FROM offers o
                         WHERE o.id = lqs.listing_id AND o.status IN ('active','scheduled'))`,
  );
  await execute(
    `DELETE lqs FROM listing_quality_scores lqs
      WHERE lqs.listing_type = 'service_offer'
        AND NOT EXISTS (SELECT 1 FROM service_offers so
                         WHERE so.id = lqs.listing_id AND so.status IN ('active','scheduled'))`,
  );

  return written;
}

/** The quality detail for one listing, for §27's "why does my offer rank here". */
async function detailFor(listingType, listingId) {
  const rows = await query(
    `SELECT * FROM listing_quality_scores WHERE listing_type = ? AND listing_id = ?`,
    [listingType, listingId],
  );
  if (!rows.length) return null;

  const row = rows[0];
  const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
  const detail = parse(row.quality_detail) ?? {};

  return {
    listingType: row.listing_type,
    listingId: Number(row.listing_id),
    qualityScore: Number(row.quality_score),
    engagementScore: Number(row.engagement_score),
    checklist: detail,
    // The actionable half: what is missing, in the order the weights say it
    // matters. A merchant handed "0.62" learns nothing; handed "add an image"
    // they can fix it in a minute.
    missing: Object.entries(detail)
      .filter(([, present]) => !present)
      .map(([key]) => key),
    engagement: parse(row.engagement_raw),
    computedAt: row.computed_at,
  };
}

module.exports = {
  rebuild,
  detailFor,
  qualityFrom,
  engagementFrom,
  CHECK_TO_WEIGHT,
};
