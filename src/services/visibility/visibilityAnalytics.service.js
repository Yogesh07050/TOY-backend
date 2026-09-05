'use strict';

const crypto = require('node:crypto');
const { query, execute, rawQuery } = require('../../db/pool');
const logger = require('../../utils/logger');
const vis = require('../../config/visibility');

/**
 * VisibilityAnalyticsService (§30): "Records and aggregates visibility events."
 *
 * Two halves that share a table and nothing else:
 *
 *   write - append one row per visibility event (§32). Best-effort, on the hot
 *           path of every discovery response, and never allowed to fail a
 *           customer request.
 *   read  - the merchant dashboard (§15), Premium analytics (§16) and campaign
 *           performance (§17).
 *
 * ## Why organic and featured share one table
 *
 * §20 requires that "Featured placement must not artificially change or falsify
 * organic analytics". The cheapest way to guarantee that is to make the split a
 * column rather than a convention: `placement_type` is NULL for organic and set
 * for promoted, so every organic figure is `placement_type IS NULL` and no
 * amount of promotional spend can leak into it. Two separate tables would have
 * made the same promise, and would have needed a UNION - and a UNION that
 * someone eventually writes without the filter.
 */

// ---------------------------------------------------------------------------
// Identity hashing

/**
 * Session, device and IP are stored as salted hashes (§25 needs to recognise
 * repetition; nothing needs to recognise the person). The salt is the process's
 * own - deliberately not configurable and not persisted, because these values
 * exist to be compared within a window, never to be reversed or joined to
 * anything outside this table.
 */
const SALT = crypto.randomBytes(16).toString('hex');

const hash = (value) =>
  value === undefined || value === null || value === ''
    ? null
    : crypto.createHash('sha256').update(`${SALT}:${value}`).digest('hex');

/**
 * The identity fields for one request, derived from what the client sent.
 * `x-session-id` is the anonymous browsing session; without it a guest's
 * frequency cap simply cannot apply, which is a better failure than capping a
 * whole household by IP.
 */
function identityFor(req) {
  return {
    userId: req.user?.id ?? null,
    sessionId: hash(req.get?.('x-session-id') ?? req.headers?.['x-session-id'] ?? null),
    deviceHash: hash(req.get?.('x-device-id') ?? req.headers?.['x-device-id'] ?? null),
    ipHash: hash(req.ip ?? null),
  };
}

// ---------------------------------------------------------------------------
// Writes

const COLUMNS = [
  'event_type',
  'surface',
  'placement_type',
  'featured_campaign_id',
  'slot_id',
  'listing_type',
  'listing_id',
  'shop_id',
  'branch_id',
  'category_id',
  'user_id',
  'session_id',
  'device_hash',
  'ip_hash',
  'position',
  'city',
  'latitude',
  'longitude',
  'distance_km',
  'term',
  'created_at',
];

const valuesFor = (payload) => [
  payload.eventType,
  payload.surface ?? null,
  payload.placementType ?? null,
  payload.featuredCampaignId ?? null,
  payload.slotId ?? null,
  payload.listingType ?? vis.LISTING_TYPES.OFFER,
  payload.listingId ?? null,
  payload.shopId ?? null,
  payload.branchId ?? null,
  payload.categoryId ?? null,
  payload.userId ?? null,
  payload.sessionId ?? null,
  payload.deviceHash ?? null,
  payload.ipHash ?? null,
  payload.position ?? null,
  payload.city ?? null,
  payload.latitude ?? null,
  payload.longitude ?? null,
  payload.distanceKm ?? null,
  payload.term ? String(payload.term).slice(0, 160) : null,
  payload.createdAt ?? new Date(),
];

/**
 * Appends events. Never throws - the caller is answering a customer, and losing
 * an analytics row costs far less than losing the response.
 *
 * Batched into one multi-row INSERT because the common case is a whole page of
 * impressions at once: a 20-result search would otherwise be 20 round trips
 * added to a request that has already done its work.
 */
async function record(events) {
  const list = Array.isArray(events) ? events : [events];
  if (!list.length) return;

  try {
    const placeholders = list.map(() => `(${COLUMNS.map(() => '?').join(',')})`).join(',');
    const params = list.flatMap(valuesFor);
    await execute(`INSERT INTO visibility_events (${COLUMNS.join(',')}) VALUES ${placeholders}`, params);
  } catch (error) {
    logger.warn(
      {
        event: 'VISIBILITY_EVENT_DROPPED',
        category: 'DATABASE',
        dependency: 'DATABASE',
        dropped: list.length,
        err_message: error.message,
      },
      'Visibility events dropped',
    );
  }
}

/**
 * Recently-counted impressions, so one screen's re-fetch is not two impressions.
 *
 * A ranked screen fetches more than once as its inputs settle: the first
 * request has no coordinates, the next has them, and both return substantially
 * the same listings. Counting each would inflate every merchant's reach - it
 * tripled it in testing - for a customer who saw one screen.
 *
 * In-process and best-effort. Across several app instances each keeps its own
 * table, so a customer whose two requests land on different instances is still
 * counted twice; that is a far smaller error than the one it removes, and the
 * alternative - a shared store consulted on the hot path of every served page -
 * costs more than the accuracy is worth.
 */
const recentImpressions = new Map();
const IMPRESSION_DEDUPE_MS = 10 * 60 * 1000;

function alreadyCounted(key, now) {
  const seenAt = recentImpressions.get(key);
  if (seenAt && now - seenAt < IMPRESSION_DEDUPE_MS) return true;
  recentImpressions.set(key, now);
  return false;
}

/**
 * Drops expired keys. Called on each serve rather than on a timer: the map only
 * grows while impressions are being served, so that is exactly when it needs
 * trimming, and it keeps the module free of a background handle.
 */
function pruneImpressionKeys(now) {
  if (recentImpressions.size < 10000) return;
  for (const [key, seenAt] of recentImpressions) {
    if (now - seenAt >= IMPRESSION_DEDUPE_MS) recentImpressions.delete(key);
  }
}

/**
 * Records the impressions for one served page (§32).
 *
 * Position is the whole point: without the rank each listing occupied, §15's
 * "average position" is unanswerable and §10's rotation has nothing to prove it
 * worked. It is 1-based and taken from the array order, so it always matches
 * what the customer actually saw.
 *
 * ## Why this is the only place impressions are counted
 *
 * The server knows what it sent, in what order, to whom. A client knows what it
 * rendered - which is more accurate in principle, and was implemented in the
 * mobile app until it turned out both were reporting the same page. Two sources
 * for one number is not redundancy, it is double counting, and the merchant
 * sees the inflated total rather than the discrepancy.
 *
 * So impressions are recorded here, once, for every client. Clients report only
 * what the server cannot see: which card was tapped, which shop profile was
 * opened, which directions link was followed.
 *
 * Fire-and-forget by design - the response has already been decided, and
 * awaiting this would put an INSERT between the customer and their results.
 */
function recordImpressions(items, context) {
  if (!items?.length) return;

  const now = Date.now();
  pruneImpressionKeys(now);
  // Identity first, so two people looking at the same page both count.
  const who = context.identity?.userId ?? context.identity?.sessionId ?? context.identity?.deviceHash;

  // The rank is captured *before* filtering. Filtering first and numbering
  // afterwards would report a surviving listing at the position of the one
  // dropped ahead of it - a listing that ranked fourth would be recorded as
  // first, and §15's "average position" would quietly become fiction.
  const ranked = items.map((item, index) => ({ item, position: index + 1 }));
  const fresh = who
    ? ranked.filter(
        ({ item }) =>
          !alreadyCounted(
            `${who}:${context.surface}:${item.featured ? 'f' : 'o'}:${item.listingType ?? 'offer'}:${item.id}`,
            now,
          ),
      )
    : ranked;
  if (!fresh.length) return;

  const events = fresh.map(({ item, position }) => ({
    eventType: item.featured
      ? vis.EVENT_TYPES.FEATURED_IMPRESSION
      : vis.EVENT_TYPES.IMPRESSION,
    surface: context.surface,
    placementType: item.placementType ?? null,
    featuredCampaignId: item.featuredCampaignId ?? null,
    slotId: item.slotId ?? null,
    listingType: item.listingType ?? vis.LISTING_TYPES.OFFER,
    listingId: item.id,
    shopId: item.shop?.id ?? item.shopId ?? null,
    categoryId: item.category?.id ?? item.categoryId ?? null,
    position,
    distanceKm: item.distanceKm ?? null,
    ...context.identity,
    city: context.city ?? null,
    latitude: context.latitude ?? null,
    longitude: context.longitude ?? null,
    term: context.term ?? null,
  }));

  record(events).catch(() => {});
}

// ---------------------------------------------------------------------------
// Aggregation helpers

/** `SUM(event_type = 'X')` reads better than a CASE and counts the same. */
const countOf = (type, alias) => `COALESCE(SUM(event_type = '${type}'), 0) AS ${alias}`;

const num = (value) => Number(value ?? 0);

function scopeClause(shopIds, column = 'shop_id') {
  if (shopIds === null) return { sql: '', params: [] };
  if (!shopIds.length) return { sql: ' AND 1 = 0', params: [] };
  return { sql: ` AND ${column} IN (${shopIds.map(() => '?').join(',')})`, params: shopIds };
}

// ---------------------------------------------------------------------------
// §15 - Merchant Visibility Dashboard

/**
 * The Overview block: the eight headline counters §15 lists.
 *
 * Featured impressions are counted in `impressions` as well as separately,
 * because a merchant asking "how many people saw my offer" means all of them.
 * The split is reported alongside so the organic figure is never lost (§20).
 */
async function overview(shopIds, range) {
  const scope = scopeClause(shopIds);
  const rows = await rawQuery(
    `SELECT ${countOf('IMPRESSION', 'organic_impressions')},
            ${countOf('FEATURED_IMPRESSION', 'featured_impressions')},
            ${countOf('VIEW', 'views')},
            ${countOf('SAVE', 'saves')},
            ${countOf('CLAIM', 'claims')},
            ${countOf('REDEMPTION', 'redemptions')},
            ${countOf('PROFILE_VIEW', 'profile_views')},
            ${countOf('DIRECTIONS_CLICK', 'directions_clicks')},
            ${countOf('SEARCH_CLICK', 'search_clicks')},
            COALESCE(SUM(surface = 'SEARCH' AND event_type IN ('IMPRESSION','FEATURED_IMPRESSION')), 0)
              AS search_appearances,
            COUNT(DISTINCT user_id) AS unique_customers
       FROM visibility_events
      WHERE created_at BETWEEN ? AND ? AND is_suspicious = 0${scope.sql}`,
    [range.from, range.to, ...scope.params],
  );

  const row = rows[0] ?? {};
  const organic = num(row.organic_impressions);
  const featured = num(row.featured_impressions);

  return {
    impressions: organic + featured,
    organicImpressions: organic,
    featuredImpressions: featured,
    views: num(row.views),
    saves: num(row.saves),
    claims: num(row.claims),
    redemptions: num(row.redemptions),
    profileVisits: num(row.profile_views),
    directionsClicks: num(row.directions_clicks),
    searchClicks: num(row.search_clicks),
    searchAppearances: num(row.search_appearances),
    uniqueCustomers: num(row.unique_customers),
  };
}

/**
 * The Visibility block: where the impressions came from, and how prominently.
 *
 * `averagePosition` is reported as a range as well as a mean, because §15 asks
 * for "average position/ranking range" and a mean of 4.0 built from 1s and 7s
 * describes a very different fortnight from one built entirely from 4s.
 */
async function visibilityBreakdown(shopIds, range) {
  const scope = scopeClause(shopIds);
  const params = [range.from, range.to, ...scope.params];

  const [bySurface, byCategory, position] = await Promise.all([
    rawQuery(
      `SELECT surface, placement_type,
              COUNT(*) AS impressions, COUNT(DISTINCT user_id) AS customers
         FROM visibility_events
        WHERE created_at BETWEEN ? AND ? AND is_suspicious = 0
          AND event_type IN ('IMPRESSION','FEATURED_IMPRESSION')${scope.sql}
        GROUP BY surface, placement_type`,
      params,
    ),
    rawQuery(
      `SELECT category_id, COUNT(*) AS impressions
         FROM visibility_events
        WHERE created_at BETWEEN ? AND ? AND is_suspicious = 0 AND category_id IS NOT NULL
          AND event_type IN ('IMPRESSION','FEATURED_IMPRESSION')${scope.sql}
        GROUP BY category_id ORDER BY impressions DESC LIMIT 20`,
      params,
    ),
    rawQuery(
      `SELECT AVG(position) AS avg_position, MIN(position) AS best, MAX(position) AS worst,
              COUNT(*) AS ranked
         FROM visibility_events
        WHERE created_at BETWEEN ? AND ? AND is_suspicious = 0 AND position IS NOT NULL
          AND event_type IN ('IMPRESSION','FEATURED_IMPRESSION')${scope.sql}`,
      params,
    ),
  ]);

  const surfaceTotals = {};
  for (const key of vis.SURFACE_KEYS) surfaceTotals[key] = { organic: 0, featured: 0 };
  for (const row of bySurface) {
    const bucket = surfaceTotals[row.surface] ?? (surfaceTotals[row.surface] = { organic: 0, featured: 0 });
    if (row.placement_type) bucket.featured += num(row.impressions);
    else bucket.organic += num(row.impressions);
  }

  const stats = position[0] ?? {};
  const categoryIds = byCategory.map((row) => Number(row.category_id));
  const categoryNames = categoryIds.length
    ? await query(
        `SELECT id, name FROM categories WHERE id IN (${categoryIds.map(() => '?').join(',')})`,
        categoryIds,
      )
    : [];
  const nameById = new Map(categoryNames.map((row) => [Number(row.id), row.name]));

  return {
    nearMeImpressions: surfaceTotals.NEAR_ME.organic + surfaceTotals.NEAR_ME.featured,
    searchImpressions: surfaceTotals.SEARCH.organic + surfaceTotals.SEARCH.featured,
    featuredImpressions: Object.values(surfaceTotals).reduce((sum, b) => sum + b.featured, 0),
    categoryImpressions: surfaceTotals.CATEGORY.organic + surfaceTotals.CATEGORY.featured,
    bySurface: surfaceTotals,
    byCategory: byCategory.map((row) => ({
      categoryId: Number(row.category_id),
      categoryName: nameById.get(Number(row.category_id)) ?? null,
      impressions: num(row.impressions),
    })),
    averagePosition: stats.avg_position === null || stats.avg_position === undefined
      ? null
      : Number(Number(stats.avg_position).toFixed(2)),
    positionRange:
      stats.best === null || stats.best === undefined
        ? null
        : { best: num(stats.best), worst: num(stats.worst) },
    rankedImpressions: num(stats.ranked),
  };
}

/**
 * §15's conversion funnel.
 *
 * Each stage's rate is expressed against the stage above it, not against
 * impressions: "3% of the people who opened it saved it" is a number a merchant
 * can act on, whereas "0.4% of impressions became saves" mostly measures how
 * many lists the offer appeared in.
 */
function funnelFrom(totals) {
  const rate = (numerator, denominator) =>
    denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(2)) : null;

  return {
    stages: [
      { key: 'impressions', label: 'Impressions', value: totals.impressions, rateFromPrevious: null },
      { key: 'views', label: 'Views', value: totals.views, rateFromPrevious: rate(totals.views, totals.impressions) },
      { key: 'saves', label: 'Saves', value: totals.saves, rateFromPrevious: rate(totals.saves, totals.views) },
      { key: 'claims', label: 'Claims', value: totals.claims, rateFromPrevious: rate(totals.claims, totals.saves) },
      {
        key: 'redemptions',
        label: 'Redemptions',
        value: totals.redemptions,
        rateFromPrevious: rate(totals.redemptions, totals.claims),
      },
    ],
    overallConversion: rate(totals.redemptions, totals.impressions),
  };
}

/** The whole §15 dashboard in one response. */
async function merchantDashboard(shopIds, range) {
  const [totals, visibility] = await Promise.all([
    overview(shopIds, range),
    visibilityBreakdown(shopIds, range),
  ]);
  return { range, overview: totals, visibility, funnel: funnelFrom(totals) };
}

// ---------------------------------------------------------------------------
// §16 - Premium analytics

/**
 * The Premium-only slices. Each is a straightforward GROUP BY over the same
 * event stream - which is the point: §16 is not a different dataset, it is
 * permission to cut the same one more finely.
 */
async function premiumInsights(shopIds, range, { limit = 10 } = {}) {
  const scope = scopeClause(shopIds);
  const params = [range.from, range.to, ...scope.params];
  const impressionFilter = "event_type IN ('IMPRESSION','FEATURED_IMPRESSION')";

  const [byBranch, byLocation, byOffer, byDay, byHour, byWeekday, searchTerms] = await Promise.all([
    rawQuery(
      `SELECT branch_id, COUNT(*) AS impressions, COUNT(DISTINCT user_id) AS customers
         FROM visibility_events
        WHERE created_at BETWEEN ? AND ? AND is_suspicious = 0 AND branch_id IS NOT NULL
          AND ${impressionFilter}${scope.sql}
        GROUP BY branch_id ORDER BY impressions DESC LIMIT ${Number.parseInt(limit, 10)}`,
      params,
    ),
    rawQuery(
      `SELECT city, COUNT(*) AS impressions, COUNT(DISTINCT user_id) AS customers
         FROM visibility_events
        WHERE created_at BETWEEN ? AND ? AND is_suspicious = 0 AND city IS NOT NULL
          AND ${impressionFilter}${scope.sql}
        GROUP BY city ORDER BY impressions DESC LIMIT ${Number.parseInt(limit, 10)}`,
      params,
    ),
    rawQuery(
      `SELECT listing_type, listing_id,
              ${countOf('IMPRESSION', 'organic_impressions')},
              ${countOf('FEATURED_IMPRESSION', 'featured_impressions')},
              ${countOf('VIEW', 'views')},
              ${countOf('SAVE', 'saves')},
              ${countOf('CLAIM', 'claims')},
              ${countOf('REDEMPTION', 'redemptions')}
         FROM visibility_events
        WHERE created_at BETWEEN ? AND ? AND is_suspicious = 0 AND listing_id IS NOT NULL${scope.sql}
        GROUP BY listing_type, listing_id
        ORDER BY redemptions DESC, views DESC LIMIT ${Number.parseInt(limit, 10)}`,
      params,
    ),
    rawQuery(
      `SELECT DATE(created_at) AS day, COUNT(*) AS impressions,
              ${countOf('VIEW', 'views')}, ${countOf('REDEMPTION', 'redemptions')}
         FROM visibility_events
        WHERE created_at BETWEEN ? AND ? AND is_suspicious = 0${scope.sql}
        GROUP BY day ORDER BY day`,
      params,
    ),
    rawQuery(
      `SELECT HOUR(created_at) AS hour, COUNT(*) AS events, ${countOf('VIEW', 'views')}
         FROM visibility_events
        WHERE created_at BETWEEN ? AND ? AND is_suspicious = 0${scope.sql}
        GROUP BY hour ORDER BY hour`,
      params,
    ),
    rawQuery(
      // MySQL's DAYOFWEEK is 1=Sunday; mapped to names below rather than left
      // as a number no dashboard can label without repeating the mapping.
      `SELECT DAYOFWEEK(created_at) AS weekday, COUNT(*) AS events, ${countOf('VIEW', 'views')}
         FROM visibility_events
        WHERE created_at BETWEEN ? AND ? AND is_suspicious = 0${scope.sql}
        GROUP BY weekday ORDER BY weekday`,
      params,
    ),
    rawQuery(
      `SELECT term, COUNT(*) AS appearances, ${countOf('SEARCH_CLICK', 'clicks')}
         FROM visibility_events
        WHERE created_at BETWEEN ? AND ? AND is_suspicious = 0 AND term IS NOT NULL
          AND surface = 'SEARCH'${scope.sql}
        GROUP BY term ORDER BY appearances DESC LIMIT ${Number.parseInt(limit, 10)}`,
      params,
    ),
  ]);

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return {
    byBranch: byBranch.map((row) => ({
      branchId: Number(row.branch_id),
      impressions: num(row.impressions),
      customers: num(row.customers),
    })),
    byLocation: byLocation.map((row) => ({
      city: row.city,
      impressions: num(row.impressions),
      customers: num(row.customers),
    })),
    bestPerformingOffers: byOffer.map((row) => ({
      listingType: row.listing_type,
      listingId: Number(row.listing_id),
      impressions: num(row.organic_impressions) + num(row.featured_impressions),
      views: num(row.views),
      saves: num(row.saves),
      claims: num(row.claims),
      redemptions: num(row.redemptions),
    })),
    bestPerformingDays: byDay.map((row) => ({
      date: row.day,
      impressions: num(row.impressions),
      views: num(row.views),
      redemptions: num(row.redemptions),
    })),
    bestPerformingHours: byHour.map((row) => ({
      hour: num(row.hour),
      events: num(row.events),
      views: num(row.views),
    })),
    bestPerformingWeekdays: byWeekday.map((row) => ({
      weekday: WEEKDAYS[num(row.weekday) - 1] ?? null,
      events: num(row.events),
      views: num(row.views),
    })),
    searchPerformance: searchTerms.map((row) => ({
      term: row.term,
      appearances: num(row.appearances),
      clicks: num(row.clicks),
      clickThroughRate:
        num(row.appearances) > 0
          ? Number(((num(row.clicks) / num(row.appearances)) * 100).toFixed(2))
          : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// §17 - Campaign performance

/**
 * The §17 card for one campaign, read from the daily rollup.
 *
 * Falls back to the raw stream for today, which the nightly rollup has not
 * covered yet - a campaign that launched this morning showing all zeros would
 * be the single most alarming thing a merchant could see, and it would be
 * wrong.
 */
async function campaignPerformance(campaignId, range) {
  const [rolled, live] = await Promise.all([
    query(
      `SELECT * FROM campaign_events
        WHERE featured_campaign_id = ? AND event_date BETWEEN DATE(?) AND DATE(?)
          AND event_date < CURDATE()
        ORDER BY event_date`,
      [campaignId, range.from, range.to],
    ),
    rawQuery(
      `SELECT ${countOf('FEATURED_IMPRESSION', 'impressions')},
              ${countOf('FEATURED_CLICK', 'banner_clicks')},
              ${countOf('VIEW', 'offer_views')},
              ${countOf('SAVE', 'saves')},
              ${countOf('CLAIM', 'claims')},
              ${countOf('REDEMPTION', 'redemptions')},
              ${countOf('PROFILE_VIEW', 'shop_visits')},
              ${countOf('DIRECTIONS_CLICK', 'directions_clicks')},
              COUNT(DISTINCT user_id) AS unique_customers
         FROM visibility_events
        WHERE featured_campaign_id = ? AND is_suspicious = 0 AND created_at >= CURDATE()
          AND created_at <= ?`,
      [campaignId, range.to],
    ),
  ]);

  const totals = {
    impressions: 0,
    bannerClicks: 0,
    offerViews: 0,
    saves: 0,
    claims: 0,
    redemptions: 0,
    shopVisits: 0,
    directionsClicks: 0,
    uniqueCustomers: 0,
  };

  const daily = rolled.map((row) => {
    totals.impressions += num(row.impressions);
    totals.bannerClicks += num(row.banner_clicks);
    totals.offerViews += num(row.offer_views);
    totals.saves += num(row.saves);
    totals.claims += num(row.claims);
    totals.redemptions += num(row.redemptions);
    totals.shopVisits += num(row.shop_visits);
    totals.directionsClicks += num(row.directions_clicks);
    totals.uniqueCustomers += num(row.unique_customers);
    return {
      date: row.event_date,
      impressions: num(row.impressions),
      bannerClicks: num(row.banner_clicks),
      offerViews: num(row.offer_views),
      saves: num(row.saves),
      claims: num(row.claims),
      redemptions: num(row.redemptions),
    };
  });

  const today = live[0] ?? {};
  totals.impressions += num(today.impressions);
  totals.bannerClicks += num(today.banner_clicks);
  totals.offerViews += num(today.offer_views);
  totals.saves += num(today.saves);
  totals.claims += num(today.claims);
  totals.redemptions += num(today.redemptions);
  totals.shopVisits += num(today.shop_visits);
  totals.directionsClicks += num(today.directions_clicks);

  const rate = (a, b) => (b > 0 ? Number(((a / b) * 100).toFixed(2)) : null);

  return {
    campaignId: Number(campaignId),
    totals,
    daily,
    rates: {
      clickThrough: rate(totals.bannerClicks, totals.impressions),
      viewToClaim: rate(totals.claims, totals.offerViews),
      claimToRedemption: rate(totals.redemptions, totals.claims),
    },
  };
}

/**
 * Rebuilds one day of `campaign_events` from the raw stream.
 *
 * Idempotent by construction: it deletes nothing and inserts with an upsert
 * keyed on (campaign, date), so a re-run corrects a day rather than doubling
 * it. That matters because the natural response to a bad number is to run the
 * rollup again.
 */
async function rollupCampaignDay(date) {
  const day = date instanceof Date ? date : new Date(date);
  const dayKey = day.toISOString().slice(0, 10);

  const result = await execute(
    `INSERT INTO campaign_events
       (featured_campaign_id, shop_id, event_date, impressions, banner_clicks, offer_views,
        saves, claims, redemptions, shop_visits, directions_clicks, unique_customers)
     SELECT ve.featured_campaign_id, fc.shop_id, DATE(ve.created_at),
            ${countOf('FEATURED_IMPRESSION', 'impressions')},
            ${countOf('FEATURED_CLICK', 'banner_clicks')},
            ${countOf('VIEW', 'offer_views')},
            ${countOf('SAVE', 'saves')},
            ${countOf('CLAIM', 'claims')},
            ${countOf('REDEMPTION', 'redemptions')},
            ${countOf('PROFILE_VIEW', 'shop_visits')},
            ${countOf('DIRECTIONS_CLICK', 'directions_clicks')},
            COUNT(DISTINCT ve.user_id)
       FROM visibility_events ve
       JOIN featured_campaigns fc ON fc.id = ve.featured_campaign_id
      WHERE ve.featured_campaign_id IS NOT NULL AND ve.is_suspicious = 0
        AND DATE(ve.created_at) = ?
      GROUP BY ve.featured_campaign_id, fc.shop_id, DATE(ve.created_at)
     ON DUPLICATE KEY UPDATE
       impressions = VALUES(impressions), banner_clicks = VALUES(banner_clicks),
       offer_views = VALUES(offer_views), saves = VALUES(saves), claims = VALUES(claims),
       redemptions = VALUES(redemptions), shop_visits = VALUES(shop_visits),
       directions_clicks = VALUES(directions_clicks), unique_customers = VALUES(unique_customers)`,
    [dayKey],
  );

  return result.affectedRows;
}

module.exports = {
  identityFor,
  hash,
  record,
  recordImpressions,
  overview,
  visibilityBreakdown,
  funnelFrom,
  merchantDashboard,
  premiumInsights,
  campaignPerformance,
  rollupCampaignDay,
  scopeClause,
};
