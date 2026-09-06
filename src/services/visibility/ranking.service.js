'use strict';

const { rawQuery } = require('../../db/pool');
const geo = require('../../utils/geo');
const vis = require('../../config/visibility');
const config = require('./config');
const antiManipulation = require('./antiManipulation');
const merchantEntitlements = require('./merchantEntitlement.service');

/**
 * RankingService (§4, §30): "Calculates dynamic ranking scores."
 *
 * ## Shape
 *
 * Two stages, and the split is the whole design:
 *
 *   1. SQL fetches a bounded *candidate pool* - every listing that is legally
 *      allowed to rank at all (§24), with its raw signals attached.
 *   2. JS scores and orders that pool.
 *
 * Ranking in SQL would mean expressing nine weighted factors, exponential decay
 * curves, per-customer preference matching, shop diversity and rotation inside
 * an ORDER BY. Every one of those is possible; together they are unreadable,
 * untestable and impossible to explain to the merchant asking why they placed
 * fourth (§27). Scoring a few hundred rows in JS costs microseconds and leaves
 * every factor as a named function that can be unit-tested on its own.
 *
 * The pool is bounded: `candidateOverfetch` results per requested result, capped
 * at `candidatePoolMax`. That is the honest trade - beyond the pool the ordering
 * is the SQL's coarse one - and it is configurable rather than assumed.
 *
 * ## What this module refuses to do
 *
 * It never sorts by plan. §5 and §21 are unambiguous: subscription is one
 * weighted factor among nine, and no code path exists here that can promote a
 * listing on plan alone. §24's "Admins cannot directly set their own ranking
 * score" is structural for the same reason - there is no score column to set.
 */

// ---------------------------------------------------------------------------
// Candidate SQL

const branchPredicateOffer = (alias) => `(
  (o.applicability_type = 'shop_wide' AND ${alias}.shop_id = o.shop_id)
  OR (o.applicability_type = 'selected_branches' AND EXISTS (
       SELECT 1 FROM offer_locations ol WHERE ol.offer_id = o.id AND ol.branch_id = ${alias}.id))
)`;

const branchPredicateService = (alias) => `(
  (sv.applicability_type = 'shop_wide' AND ${alias}.shop_id = sv.shop_id)
  OR (sv.applicability_type = 'selected_branches' AND EXISTS (
       SELECT 1 FROM service_locations sl WHERE sl.service_id = sv.id AND sl.branch_id = ${alias}.id))
)`;

/**
 * The §24 safety floor, applied to both halves of the union.
 *
 * Every one of §24's rules is here rather than in a later filter, because a
 * filter that runs after LIMIT silently shortens pages and a filter that runs
 * after COUNT reports a total nobody can reach:
 *
 *   - expired offers cannot rank        -> status + date window
 *   - disabled shops cannot rank        -> s.status = 'active'
 *   - disabled branches cannot rank     -> b.status = 'active' in every branch predicate
 *   - deleted listings cannot rank      -> the row is gone; FKs cascade
 *   - ineligible/excluded cannot rank   -> ranking_exclusions
 */
const OFFER_BASE_WHERE = [
  "o.status = 'active'",
  "s.status = 'active'",
  'o.start_date <= NOW()',
  'o.end_date >= NOW()',
];

const SERVICE_BASE_WHERE = [
  "so.status = 'active'",
  "sv.status = 'active'",
  "s.status = 'active'",
  'so.start_date <= NOW()',
  'so.end_date >= NOW()',
];

/**
 * §12's eligibility, resolved the way §23 says it must be:
 *
 *     Subscription Entitlement OR Super Admin Override
 *
 * All three sources are checked - the paid plan, a granted ENDING_SOON feature
 * flag, and a granted visibility *level* - because a merchant let into the
 * section by any one of them belongs there, and a version of this that only
 * knew about the plan would quietly ignore every free-launch grant §23 exists
 * to make.
 */
function endingSoonEligibility(shopIdSql) {
  return `(
    EXISTS (SELECT 1 FROM shop_subscriptions esub
             WHERE esub.shop_id = ${shopIdSql} AND esub.status = 'active'
               AND esub.plan IN ('BUSINESS','PREMIUM'))
    OR EXISTS (SELECT 1 FROM feature_overrides efo
                WHERE efo.shop_id = ${shopIdSql} AND efo.status = 'active'
                  AND efo.feature_key IN ('ENDING_SOON','ENHANCED_DISCOVERY','PRIORITY_DISCOVERY')
                  AND (efo.expires_at IS NULL OR efo.expires_at > NOW()))
    OR EXISTS (SELECT 1 FROM merchant_visibility_entitlements eve
                WHERE eve.shop_id = ${shopIdSql} AND eve.status = 'active'
                  AND eve.visibility_level IN ('ENHANCED','PRIORITY')
                  AND eve.starts_at <= NOW()
                  AND (eve.expires_at IS NULL OR eve.expires_at > NOW()))
  )`;
}

/**
 * Builds the candidate query.
 *
 * The two halves are UNION ALLed rather than fetched separately and merged in
 * JS: a merge of two independently-limited queries makes the pool composition
 * depend on how each half's own LIMIT lands, which is exactly the bug the
 * existing `offerDiscovery` union was written to avoid.
 */
function buildCandidateSql(params, user, poolSize) {
  const hasPosition = params.latitude !== undefined && params.longitude !== undefined;
  const distanceParams = hasPosition ? geo.distanceKmParams(params.latitude, params.longitude) : [];

  const nearest = (predicate, column) =>
    hasPosition
      ? `(SELECT b.${column} FROM shop_branches b
           WHERE b.status = 'active' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
             AND ${predicate('b')}
           ORDER BY ${geo.distanceKmSql('b.latitude', 'b.longitude')} ASC LIMIT 1)`
      : 'NULL';

  const distanceOf = (predicate) =>
    hasPosition
      ? `(SELECT MIN(${geo.distanceKmSql('b.latitude', 'b.longitude')}) FROM shop_branches b
           WHERE b.status = 'active' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
             AND ${predicate('b')})`
      : 'NULL';

  const offerWhere = [...OFFER_BASE_WHERE];
  const offerParams = [];
  const serviceWhere = [...SERVICE_BASE_WHERE];
  const serviceParams = [];

  // §25/§24: excluded listings and shops never enter the pool.
  offerWhere.push(antiManipulation.exclusionPredicate("'offer'", 'o.id', 'o.shop_id'));
  serviceWhere.push(antiManipulation.exclusionPredicate("'service_offer'", 'so.id', 'sv.shop_id'));

  // §12: Ending Soon is a Business-and-Premium section, so an ineligible shop
  // is *absent*, not ranked low. Applied in SQL rather than as a post-filter
  // on the page: filtering after the LIMIT silently shortens a page, and
  // filtering after the COUNT reports a total no client can ever page to.
  if (params.requireEndingSoonEligible) {
    offerWhere.push(endingSoonEligibility('o.shop_id'));
    serviceWhere.push(endingSoonEligibility('sv.shop_id'));
  }

  if (params.search) {
    const term = `%${params.search}%`;
    offerWhere.push(
      '(o.title LIKE ? OR o.product_name LIKE ? OR o.offer_text LIKE ? OR o.description LIKE ? OR s.name LIKE ?)',
    );
    offerParams.push(term, term, term, term, term);
    serviceWhere.push('(sv.name LIKE ? OR sv.description LIKE ? OR so.offer_text LIKE ? OR s.name LIKE ?)');
    serviceParams.push(term, term, term, term);
  }
  if (params.categoryId) {
    offerWhere.push('(o.category_id = ? OR o.subcategory_id = ?)');
    offerParams.push(params.categoryId, params.categoryId);
    serviceWhere.push('(sv.category_id = ? OR sv.subcategory_id = ?)');
    serviceParams.push(params.categoryId, params.categoryId);
  }
  if (params.shopId) {
    offerWhere.push('o.shop_id = ?');
    offerParams.push(params.shopId);
    serviceWhere.push('sv.shop_id = ?');
    serviceParams.push(params.shopId);
  }
  if (params.city) {
    offerWhere.push(`EXISTS (SELECT 1 FROM shop_branches bc
                              WHERE bc.status = 'active' AND bc.city = ? AND ${branchPredicateOffer('bc')})`);
    offerParams.push(params.city);
    serviceWhere.push(`EXISTS (SELECT 1 FROM shop_branches bcs
                                WHERE bcs.status = 'active' AND bcs.city = ? AND ${branchPredicateService('bcs')})`);
    serviceParams.push(params.city);
  }
  // §12: Ending Soon is a window, not a sort. Listings outside it are not
  // "ranked lower", they are not in the section at all.
  if (params.withinHours) {
    offerWhere.push('o.end_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL ? HOUR)');
    offerParams.push(params.withinHours);
    serviceWhere.push('so.end_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL ? HOUR)');
    serviceParams.push(params.withinHours);
  }
  // Bounding box before the trigonometry, so MySQL can range-scan the branch
  // geo index instead of computing a distance for every branch in the country.
  if (params.radiusKm && hasPosition) {
    const box = geo.boundingBox(params.latitude, params.longitude, params.radiusKm);
    offerWhere.push(`EXISTS (SELECT 1 FROM shop_branches bb
                              WHERE bb.status = 'active'
                                AND bb.latitude BETWEEN ? AND ? AND bb.longitude BETWEEN ? AND ?
                                AND ${branchPredicateOffer('bb')})`);
    offerParams.push(box.minLat, box.maxLat, box.minLng, box.maxLng);
    serviceWhere.push(`EXISTS (SELECT 1 FROM shop_branches bbs
                                WHERE bbs.status = 'active'
                                  AND bbs.latitude BETWEEN ? AND ? AND bbs.longitude BETWEEN ? AND ?
                                  AND ${branchPredicateService('bbs')})`);
    serviceParams.push(box.minLat, box.maxLat, box.minLng, box.maxLng);
  }

  const offerSaved = user
    ? '(SELECT 1 FROM favorites fv WHERE fv.offer_id = o.id AND fv.user_id = ?) AS is_saved'
    : '0 AS is_saved';
  const serviceSaved = user
    ? '(SELECT 1 FROM saved_services ssv WHERE ssv.service_id = sv.id AND ssv.user_id = ?) AS is_saved'
    : '0 AS is_saved';
  const savedParams = user ? [user.id] : [];

  const offerSql = `
    SELECT o.id AS id, 'offer' AS listing_type, NULL AS service_id,
           o.title AS title, o.product_name AS product_name, o.description AS description,
           o.offer_text AS offer_text,
           o.shop_id AS shop_id, s.name AS shop_name, s.slug AS shop_slug, s.logo_url AS shop_logo_url,
           o.category_id AS category_id, o.subcategory_id AS subcategory_id,
           c.name AS category_name, c.slug AS category_slug,
           o.discount_type AS discount_type, o.discount_value AS discount_value,
           o.original_price AS original_price, o.discounted_price AS final_price,
           o.start_date AS start_date, o.end_date AS end_date, o.status AS status,
           o.created_at AS created_at, o.updated_at AS updated_at,
           o.total_claim_limit AS total_claim_limit,
           (SELECT COUNT(*) FROM offer_claims oc WHERE oc.offer_id = o.id
              AND oc.status IN ('claimed','redeemed')) AS claims_used,
           (SELECT oi.image_url FROM offer_images oi WHERE oi.offer_id = o.id
             ORDER BY oi.display_order, oi.id LIMIT 1) AS image_url,
           COALESCE(lqs.quality_score, 0) AS quality_score,
           COALESCE(lqs.engagement_score, 0) AS engagement_score,
           lqs.listing_id IS NOT NULL AS has_scores,
           ${nearest(branchPredicateOffer, 'latitude')} AS latitude,
           ${nearest(branchPredicateOffer, 'longitude')} AS longitude,
           ${nearest(branchPredicateOffer, 'id')} AS branch_id,
           ${nearest(branchPredicateOffer, 'city')} AS branch_city,
           ${distanceOf(branchPredicateOffer)} AS distance_km,
           ${offerSaved}
      FROM offers o
      JOIN shops s ON s.id = o.shop_id
      LEFT JOIN categories c ON c.id = o.category_id
      LEFT JOIN listing_quality_scores lqs
             ON lqs.listing_type = 'offer' AND lqs.listing_id = o.id
     WHERE ${offerWhere.join(' AND ')}`;

  const serviceSql = `
    SELECT so.id AS id, 'service_offer' AS listing_type, sv.id AS service_id,
           sv.name AS title, NULL AS product_name, sv.description AS description,
           so.offer_text AS offer_text,
           sv.shop_id AS shop_id, s.name AS shop_name, s.slug AS shop_slug, s.logo_url AS shop_logo_url,
           sv.category_id AS category_id, sv.subcategory_id AS subcategory_id,
           c.name AS category_name, c.slug AS category_slug,
           so.discount_type AS discount_type, so.discount_value AS discount_value,
           so.original_price AS original_price, so.offer_price AS final_price,
           so.start_date AS start_date, so.end_date AS end_date, so.status AS status,
           so.created_at AS created_at, so.updated_at AS updated_at,
           so.total_claim_limit AS total_claim_limit,
           (SELECT COUNT(*) FROM service_offer_claims sc WHERE sc.service_offer_id = so.id
              AND sc.status IN ('claimed','redeemed')) AS claims_used,
           (SELECT si.image_url FROM service_images si WHERE si.service_id = sv.id
             ORDER BY si.display_order, si.id LIMIT 1) AS image_url,
           COALESCE(lqs.quality_score, 0) AS quality_score,
           COALESCE(lqs.engagement_score, 0) AS engagement_score,
           lqs.listing_id IS NOT NULL AS has_scores,
           ${nearest(branchPredicateService, 'latitude')} AS latitude,
           ${nearest(branchPredicateService, 'longitude')} AS longitude,
           ${nearest(branchPredicateService, 'id')} AS branch_id,
           ${nearest(branchPredicateService, 'city')} AS branch_city,
           ${distanceOf(branchPredicateService)} AS distance_km,
           ${serviceSaved}
      FROM service_offers so
      JOIN services sv ON sv.id = so.service_id
      JOIN shops s ON s.id = sv.shop_id
      LEFT JOIN categories c ON c.id = sv.category_id
      LEFT JOIN listing_quality_scores lqs
             ON lqs.listing_type = 'service_offer' AND lqs.listing_id = so.id
     WHERE ${serviceWhere.join(' AND ')}`;

  // One set of distance parameters per `distanceKmSql()` occurrence, in text
  // order: latitude, longitude, branch_id, distance_km. Getting this wrong
  // shifts every following placeholder, so the order is spelled out rather
  // than inferred.
  // One set per `distanceKmSql()` occurrence in a half's SELECT list, in text
  // order: latitude, longitude, branch_id, branch_city, distance_km.
  const perHalfDistance = [
    ...distanceParams,
    ...distanceParams,
    ...distanceParams,
    ...distanceParams,
    ...distanceParams,
  ];

  const parts = [];
  const unionParams = [];
  if (params.type !== 'service') {
    parts.push(offerSql);
    unionParams.push(...perHalfDistance, ...savedParams, ...offerParams);
  }
  if (params.type !== 'product') {
    parts.push(serviceSql);
    unionParams.push(...perHalfDistance, ...savedParams, ...serviceParams);
  }

  // The pool's own coarse ordering. It is not the ranking - it decides which
  // rows the scorer gets to see. Nearest-first when a position is known,
  // newest-first otherwise, so the pool is drawn from the listings most likely
  // to score well rather than from whatever the storage engine returns first.
  const poolOrder = hasPosition
    ? 'distance_km IS NULL, distance_km ASC, created_at DESC'
    : 'created_at DESC, id DESC';

  return {
    sql: `SELECT * FROM (${parts.join('\nUNION ALL\n')}) AS pool
           ORDER BY ${poolOrder}
           LIMIT ${Number.parseInt(poolSize, 10)}`,
    params: unionParams,
    countSql: `SELECT COUNT(*) AS total FROM (${parts.join('\nUNION ALL\n')}) AS pool`,
  };
}

// ---------------------------------------------------------------------------
// Factor scores. Each returns 0-1 and is independently testable.

/** Words a query is made of, ignoring noise too short to discriminate. */
const tokenize = (text) =>
  String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);

/**
 * §2.1, §4: how closely the listing matches what the customer asked for.
 *
 * Fielded matching rather than one blob: a query word in the title means the
 * listing *is* that thing, while the same word in the shop's name only means
 * the shop might sell it. Scoring them the same is how a search for "shoes"
 * ends up returning a shoe shop's entire catalogue above the actual shoe offer.
 *
 * With no query, relevance is not zero - there is nothing to be irrelevant to -
 * so it falls back to category and interest alignment, which is what makes a
 * signed-out home feed sensible.
 */
function relevanceScore(candidate, context) {
  const tokens = context.queryTokens;

  if (!tokens.length) {
    if (context.categoryId) {
      const matches =
        Number(candidate.category_id) === context.categoryId ||
        Number(candidate.subcategory_id) === context.categoryId;
      return matches ? 1 : 0.4;
    }
    // §4's "customer interests" half, for a browse with no query at all.
    if (context.preferredCategories?.size) {
      return context.preferredCategories.has(Number(candidate.category_id)) ? 1 : 0.5;
    }
    return 0.6;
  }

  const fields = [
    { text: candidate.title, weight: 1 },
    { text: candidate.product_name, weight: 0.9 },
    { text: candidate.offer_text, weight: 0.7 },
    { text: candidate.category_name, weight: 0.6 },
    { text: candidate.shop_name, weight: 0.5 },
    { text: candidate.description, weight: 0.35 },
  ];

  let best = 0;
  let covered = 0;

  for (const token of tokens) {
    let tokenBest = 0;
    for (const field of fields) {
      const text = String(field.text ?? '').toLowerCase();
      if (!text) continue;
      if (text === token) tokenBest = Math.max(tokenBest, field.weight);
      // A word boundary match beats a substring one: "car" inside "carpet" is
      // not a match for someone shopping for a car.
      else if (new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)) {
        tokenBest = Math.max(tokenBest, field.weight * 0.9);
      } else if (text.includes(token)) tokenBest = Math.max(tokenBest, field.weight * 0.4);
    }
    if (tokenBest > 0) covered += 1;
    best += tokenBest;
  }

  // Coverage matters more than depth: matching every word of "kids school
  // shoes" weakly beats matching "shoes" perfectly and ignoring the rest.
  const coverage = covered / tokens.length;
  const strength = best / tokens.length;
  return Math.max(0, Math.min(1, coverage * 0.6 + strength * 0.4));
}

/**
 * §2.2, §4. 1 / (1 + km/decay): 1.0 at the door, 0.5 at the decay distance,
 * asymptotically approaching but never reaching 0.
 *
 * Never a hard cutoff, because §5's worked example requires that a genuinely
 * better listing 5 km away can still appear - it must be *penalised*, not
 * excluded. Exclusion is what `radiusKm` is for, and that is the customer's
 * choice rather than the ranking's.
 */
function distanceScore(candidate, context, rules) {
  const distance = candidate.distance_km;
  if (distance === null || distance === undefined) return rules.distanceUnknownScore;
  return 1 / (1 + Math.max(0, Number(distance)) / rules.distanceDecayKm);
}

/**
 * §2.3: "New and recently updated offers receive a temporary freshness
 * advantage. This advantage should gradually reduce over time."
 *
 * Exponential half-life rather than tiers, so nothing jumps when a threshold is
 * crossed - a listing does not lose a rank at midnight for turning four days
 * old. "Recently updated" counts as fresh too: the later of created and updated
 * is used, which is what makes a merchant's correction worth making.
 */
function freshnessScore(candidate, rules, now) {
  const created = new Date(candidate.created_at).getTime();
  const updated = candidate.updated_at ? new Date(candidate.updated_at).getTime() : created;
  const ageDays = (now - Math.max(created, updated)) / 86400000;

  if (!Number.isFinite(ageDays) || ageDays < 0) return 1;
  if (ageDays >= rules.freshnessMaxDays) return 0;
  return Math.pow(0.5, ageDays / rules.freshnessHalfLifeDays);
}

/**
 * §2.4, precomputed by `signals.service`. Cold-start rather than zero for a
 * listing with no history: a brand-new offer that scored 0 on engagement could
 * never accumulate any, which is a trap the freshness factor exists to avoid.
 */
function engagementScore(candidate, rules) {
  if (!Number(candidate.has_scores)) return rules.coldStartEngagementScore;
  return Math.max(0, Math.min(1, Number(candidate.engagement_score)));
}

/** §4's completeness checklist, precomputed by `signals.service`. */
function qualityScore(candidate) {
  return Math.max(0, Math.min(1, Number(candidate.quality_score)));
}

/**
 * §2.5, §5. The shop's visibility level, resolved from plan *or* Super Admin
 * grant (§23), as a 0-1 contribution.
 *
 * This is the only place a subscription touches ranking, and it is one weighted
 * factor among nine. On every surface its weight is smaller than relevance and
 * distance combined - which is the arithmetic that makes §5's promise true and
 * §26's "the most expensive plan is always shown first" impossible.
 */
function subscriptionScore(candidate, context) {
  return context.entitlements.get(Number(candidate.shop_id))?.subscriptionScore ?? 0;
}

/**
 * §4's Customer Preference.
 *
 * Signed-in customers are scored against their stated interests and behaviour;
 * guests against the session context the request itself carries - the city they
 * are browsing, the category they are in. §4 asks for exactly this split, and
 * it is why a guest's feed is contextual rather than flat.
 */
function preferenceScore(candidate, context) {
  const signals = [];

  if (context.preferredCategories?.size) {
    signals.push(
      context.preferredCategories.has(Number(candidate.category_id)) ||
        context.preferredCategories.has(Number(candidate.subcategory_id))
        ? 1
        : 0,
    );
  }
  if (context.followedShops?.size) {
    signals.push(context.followedShops.has(Number(candidate.shop_id)) ? 1 : 0);
  }
  if (context.minimumDiscountPercent) {
    const value = Number(candidate.discount_value ?? 0);
    const isPercent = candidate.discount_type === 'percentage';
    signals.push(isPercent && value >= context.minimumDiscountPercent ? 1 : 0.3);
  }
  if (context.recentTerms?.length) {
    const text = `${candidate.title} ${candidate.offer_text} ${candidate.category_name}`.toLowerCase();
    signals.push(context.recentTerms.some((term) => text.includes(term)) ? 1 : 0.3);
  }
  // A saved listing is the strongest preference statement a customer can make,
  // short of claiming it.
  if (Number(candidate.is_saved)) signals.push(1);

  // Neutral rather than zero when nothing is known: a guest with no signals
  // should have this factor drop out of the ranking, not drag every listing
  // down by the same amount - which would change nothing but the numbers.
  if (!signals.length) return 0.5;
  return signals.reduce((sum, value) => sum + value, 0) / signals.length;
}

/**
 * §4's Availability, and §12's ordering signal for Ending Soon.
 *
 * Two things at once, deliberately. In general a listing with a long life ahead
 * and stock left is more useful than one about to vanish - so the score rises
 * with time remaining. On the ENDING_SOON surface the meaning inverts: the
 * whole point of the section is urgency, so the same factor is read the other
 * way up. One factor with two readings beats two factors that must be kept in
 * step.
 */
function availabilityScore(candidate, context, now) {
  const endsAt = new Date(candidate.end_date).getTime();
  const hoursLeft = (endsAt - now) / 3600000;
  if (hoursLeft <= 0) return 0;

  const limit = candidate.total_claim_limit;
  if (limit !== null && limit !== undefined) {
    const used = Number(candidate.claims_used ?? 0);
    const remaining = Number(limit) - used;
    // A fully claimed offer cannot be given to anyone else. It stays visible
    // (the merchant may still honour walk-ins) but it stops competing.
    if (remaining <= 0) return 0;
  }

  if (context.surface === vis.SURFACES.ENDING_SOON) {
    // §12: less time remaining ranks higher. 1.0 within the hour, decaying
    // across the section's own window.
    const window = Math.max(1, context.withinHours ?? 72);
    return Math.max(0, Math.min(1, 1 - hoursLeft / window));
  }

  // Elsewhere: full marks from a week out, tapering as it runs down.
  return Math.max(0.15, Math.min(1, hoursLeft / 168));
}

/**
 * §4's Placement Eligibility: is this listing fit to be shown prominently?
 *
 * §9 lists what makes a listing eligible for a promotional space, and all but
 * one of its conditions are about the *listing* - active, not expired, valid
 * location, complete promotional content. Those are what this factor measures.
 *
 * It deliberately does **not** read the shop's plan. It did once, and that was
 * a bug worth naming: with a plan bonus here as well as in SUBSCRIPTION, a
 * Premium listing collected the same advantage twice, and the combined weight
 * was enough to lift a Premium offer 5 km away above a Free one 500 m away -
 * the exact outcome §5 uses as its worked example of what must *not* happen.
 * Subscription is counted once, by the factor named after it.
 *
 * The one plan-shaped exception is ENDING_SOON, because §12 makes eligibility
 * for that section a subscription rule rather than a content rule.
 */
function placementScore(candidate, context, rules) {
  if (context.surface === vis.SURFACES.ENDING_SOON) {
    return context.entitlements.get(Number(candidate.shop_id))?.endingSoonEligible ? 1 : 0;
  }

  // "Required promotional content is complete" (§9): a card with no image is
  // not something to put in a prominent position, whatever it costs.
  const hasImage = Boolean(candidate.image_url);
  const complete = Number(candidate.quality_score) >= rules.placementQualityFloor;

  if (hasImage && complete) return 1;
  if (hasImage || complete) return 0.6;
  return 0.2;
}

// ---------------------------------------------------------------------------
// Scoring

/**
 * Scores one candidate, returning the total and every component.
 *
 * The breakdown is returned rather than discarded because §27 promises the
 * merchant an explanation, and because the only practical way to answer "why is
 * this ranked here" is to be able to print the nine numbers that decided it.
 */
function scoreCandidate(candidate, context, weights, rules) {
  const factors = {
    RELEVANCE: relevanceScore(candidate, context),
    DISTANCE: distanceScore(candidate, context, rules),
    FRESHNESS: freshnessScore(candidate, rules, context.now),
    ENGAGEMENT: engagementScore(candidate, rules),
    OFFER_QUALITY: qualityScore(candidate),
    SUBSCRIPTION: subscriptionScore(candidate, context),
    CUSTOMER_PREFERENCE: preferenceScore(candidate, context),
    AVAILABILITY: availabilityScore(candidate, context, context.now),
    PLACEMENT: placementScore(candidate, context, rules),
  };

  let total = 0;
  let weightSum = 0;
  const contributions = {};

  for (const [factor, value] of Object.entries(factors)) {
    const weight = weights[factor] ?? 0;
    weightSum += weight;
    const contribution = value * weight;
    contributions[factor] = Number(contribution.toFixed(4));
    total += contribution;
  }

  // Normalised to 0-1 so a score is comparable across surfaces with different
  // weight sums - and so the rotation tie band (§10) means the same thing
  // everywhere instead of being four times wider on one surface than another.
  return {
    score: weightSum > 0 ? total / weightSum : 0,
    factors,
    contributions,
  };
}

// ---------------------------------------------------------------------------
// Entry point

/**
 * Fetches, scores and returns the ranked pool. Fairness (diversity, rotation,
 * frequency) is applied by `visibility.service` on top of this, because those
 * rules operate on the *ordered list*, not on individual listings.
 */
async function rank(params, user, context = {}) {
  const { weights: allWeights, rules } = await config.get();
  const surface = params.surface ?? vis.SURFACES.HOME;
  const weights = allWeights[surface] ?? allWeights[vis.SURFACES.HOME];

  const requested = params.limit ?? 20;
  const poolSize = Math.min(
    rules.candidatePoolMax,
    Math.max(requested, requested * rules.candidateOverfetch),
  );

  // §24: Near Me must not rank an invalid location. Enforced by requiring a
  // radius, which the bounding box then applies in SQL - so an unlocatable
  // listing is absent from the pool rather than merely scored low.
  const effectiveParams = { ...params };
  if (surface === vis.SURFACES.ENDING_SOON) effectiveParams.requireEndingSoonEligible = true;
  if (surface === vis.SURFACES.NEAR_ME && rules.nearMeRequiresLocation) {
    effectiveParams.radiusKm = Math.min(
      params.radiusKm ?? rules.defaultRadiusKm,
      rules.maxRadiusKm,
    );
  }

  const built = buildCandidateSql(effectiveParams, user, poolSize);
  const [rows, countRows] = await Promise.all([
    rawQuery(built.sql, built.params),
    rawQuery(built.countSql, built.params),
  ]);

  const entitlements = await merchantEntitlements.resolveMany(rows.map((row) => row.shop_id));

  const scoringContext = {
    ...context,
    surface,
    now: Date.now(),
    withinHours: params.withinHours,
    categoryId: params.categoryId ? Number(params.categoryId) : null,
    queryTokens: tokenize(params.search),
    entitlements,
  };

  const scored = rows.map((row) => {
    const result = scoreCandidate(row, scoringContext, weights, rules);
    return { row, ...result };
  });

  scored.sort((a, b) => b.score - a.score || Number(a.row.id) - Number(b.row.id));

  return {
    scored,
    total: Number(countRows[0]?.total ?? 0),
    weights,
    rules,
    surface,
    entitlements,
    poolSize: rows.length,
  };
}

module.exports = {
  rank,
  endingSoonEligibility,
  scoreCandidate,
  buildCandidateSql,
  tokenize,
  relevanceScore,
  distanceScore,
  freshnessScore,
  engagementScore,
  qualityScore,
  subscriptionScore,
  preferenceScore,
  availabilityScore,
  placementScore,
};
