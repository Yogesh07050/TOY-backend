'use strict';

const { query, queryOne, execute, rawQuery } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const geo = require('../../utils/geo');
const vis = require('../../config/visibility');
const config = require('./config');
const fairness = require('./fairness');
const promotion = require('./promotion.service');

/**
 * FeaturedPlacementService (§30): "Manages Featured slots and rotation."
 *
 * ## The rotation problem
 *
 * §10 states it plainly. A slot with three positions and eight eligible
 * campaigns must not produce
 *
 *     Merchant A / Merchant A / Merchant A / Merchant A
 *
 * The naive implementation - order by priority, take the top N - produces
 * exactly that, forever, because nothing about the inputs changes between
 * requests. Rotation needs something that does.
 *
 * Three things vary here, in increasing order of authority:
 *
 *   1. `last_shown_at` / `exposure_count` - campaigns that have been shown
 *      least recently sort first. This is the actual circulation mechanism.
 *   2. a per-bucket deterministic jitter - so campaigns that are equally
 *      unexposed still take turns rather than settling into a fixed order by
 *      id, while remaining stable for the length of a bucket so a customer's
 *      screen does not reshuffle under them.
 *   3. one campaign per shop per slot - §10's "avoid A A A A" as a hard rule,
 *      not an emergent property of the sort.
 *
 * ## Eligibility is re-checked on every read
 *
 * §24 requires that ineligible campaigns cannot display, and §9's conditions
 * include things that change without anyone touching the campaign - an offer
 * expiring, a shop being deactivated, a subscription lapsing. So the live query
 * filters on the window and the status, and `promotion.checkCampaign` re-runs
 * the full §9 checklist on whatever survives.
 */

// ---------------------------------------------------------------------------
// Slots

const mapSlot = (row) => ({
  id: Number(row.id),
  code: row.code,
  placementType: row.placement_type,
  name: row.name,
  description: row.description,
  capacity: Number(row.capacity),
  minPlanRank: Number(row.min_plan_rank),
  categoryId: row.category_id === null ? null : Number(row.category_id),
  city: row.city,
  status: row.status,
  activeCampaigns: Number(row.active_campaigns ?? 0),
});

async function listSlots({ placementType, status } = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (placementType) {
    where.push('fs.placement_type = ?');
    params.push(placementType);
  }
  if (status) {
    where.push('fs.status = ?');
    params.push(status);
  }

  const rows = await rawQuery(
    `SELECT fs.*,
            (SELECT COUNT(*) FROM featured_campaigns fc
              WHERE fc.slot_id = fs.id AND fc.status IN ('approved','active')
                AND fc.start_at <= NOW() AND fc.end_at > NOW()) AS active_campaigns
       FROM featured_slots fs
      WHERE ${where.join(' AND ')}
      ORDER BY fs.placement_type, fs.name`,
    params,
  );
  return rows.map(mapSlot);
}

async function getSlot(idOrCode) {
  const row = await queryOne(
    `SELECT fs.*, 0 AS active_campaigns FROM featured_slots fs WHERE fs.id = ? OR fs.code = ?`,
    [Number.parseInt(idOrCode, 10) || 0, String(idOrCode)],
  );
  return row ? mapSlot(row) : null;
}

/**
 * Creates or updates a slot, keyed on its code.
 *
 * An upsert rather than separate create/update paths: `code` is how every
 * caller names a slot, so "make sure HOME_FEATURED looks like this" is the
 * operation the admin screen actually performs. The audit entry recording who
 * changed what is written by the route (§22), which is where the actor lives.
 */
async function upsertSlot(payload) {
  if (!vis.PLACEMENT_TYPE_KEYS.includes(payload.placementType)) {
    throw ApiError.badRequest('Unknown placement type');
  }

  await execute(
    `INSERT INTO featured_slots
       (code, placement_type, name, description, capacity, min_plan_rank, category_id, city, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       placement_type = VALUES(placement_type), name = VALUES(name),
       description = VALUES(description), capacity = VALUES(capacity),
       min_plan_rank = VALUES(min_plan_rank), category_id = VALUES(category_id),
       city = VALUES(city), status = VALUES(status)`,
    [
      payload.code,
      payload.placementType,
      payload.name,
      payload.description ?? null,
      payload.capacity ?? 4,
      payload.minPlanRank ?? 2,
      payload.categoryId ?? null,
      payload.city ?? null,
      payload.status ?? 'active',
    ],
  );
  return getSlot(payload.code);
}

// ---------------------------------------------------------------------------
// Serving a slot

/**
 * Campaigns currently eligible for a slot, before rotation.
 *
 * The targeting filters are written as "no target means no restriction", which
 * is the right default for the small merchant §1 is written for: they have one
 * shop, one city, and no interest in defining a service area. A campaign that
 * *does* target is held to it.
 */
async function eligibleCampaigns(slot, context) {
  const where = [
    'fc.slot_id = ?',
    "fc.status IN ('approved','active')",
    'fc.start_at <= NOW()',
    'fc.end_at > NOW()',
    "s.status = 'active'",
  ];
  const params = [slot.id];

  if (context.categoryId) {
    where.push('(fc.target_category_id IS NULL OR fc.target_category_id = ?)');
    params.push(context.categoryId);
  }
  if (context.city) {
    where.push('(fc.target_city IS NULL OR fc.target_city = ?)');
    params.push(context.city);
  }

  const rows = await rawQuery(
    `SELECT fc.*, s.name AS shop_name, s.slug AS shop_slug, s.logo_url AS shop_logo_url
       FROM featured_campaigns fc
       JOIN shops s ON s.id = fc.shop_id
      WHERE ${where.join(' AND ')}`,
    params,
  );

  // Radius targeting is applied here rather than in SQL: it needs the distance
  // to the campaign's own point, and the alternative is a trigonometric
  // expression in a WHERE clause over a table this small. A slot holds tens of
  // campaigns, not thousands.
  if (context.latitude === undefined || context.longitude === undefined) return rows;

  return rows.filter((row) => {
    if (row.target_radius_km === null || row.target_latitude === null) return true;
    const distance = haversineKm(
      Number(context.latitude),
      Number(context.longitude),
      Number(row.target_latitude),
      Number(row.target_longitude),
    );
    return distance <= Number(row.target_radius_km);
  });
}

/** Great-circle distance, matching `utils/geo`'s SQL so both agree. */
function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * §10's rotation order.
 *
 * Sorted by **exposure rate**: how often the campaign has been served per hour
 * it has been live. Lowest rate goes first, and serving a campaign raises its
 * rate immediately, which puts it behind whoever it just overtook. That is the
 * circulation - it is what turns "A A A A" into "A B C A".
 *
 * ## Why a rate rather than a timestamp
 *
 * The first version of this sorted by hours since `last_shown_at`, banded to
 * the whole hour. In a slot serving several requests a minute every eligible
 * campaign sits in the same band - all shown seconds ago - so the sort fell
 * through to the bucket jitter, and one merchant held the position for the
 * entire fifteen-minute bucket. Precisely the pattern §10 exists to prevent.
 *
 * ## Why a rate rather than a raw count
 *
 * A count alone starves long-running campaigns: a campaign in its third week
 * can never catch a campaign created this morning, so the new one would hold
 * the slot until its own count caught up. Dividing by hours live makes an old
 * campaign and a new one comparable, which is what "fairly" means here.
 *
 * Priority and the bucket jitter break genuine ties only - a Super Admin's
 * ordering hint nudges equals past each other, and can never buy the permanent
 * position §21 forbids.
 */
function rotate(campaigns, rules, now = Date.now()) {
  const bucket = fairness.bucketFor(rules, now);

  const scored = campaigns.map((campaign) => {
    const startedAt = campaign.start_at ? new Date(campaign.start_at).getTime() : now;
    // Floored at a quarter of an hour so a campaign that went live a second ago
    // does not divide by ~0 and report an astronomical rate.
    const hoursLive = Math.max(0.25, (now - Math.min(startedAt, now)) / 3600000);
    const exposureRate = Number(campaign.exposure_count ?? 0) / hoursLive;
    // Never shown sorts oldest, so a new campaign gets its turn immediately
    // rather than queueing behind every established one.
    const lastShown = campaign.last_shown_at ? new Date(campaign.last_shown_at).getTime() : 0;

    return {
      campaign,
      exposureRate,
      lastShown,
      priority: Number(campaign.priority ?? 0),
      jitter: fairness.rotationJitter(`campaign:${campaign.id}`, bucket),
    };
  });

  return scored
    .sort((a, b) => {
      if (a.exposureRate !== b.exposureRate) return a.exposureRate - b.exposureRate;
      if (a.lastShown !== b.lastShown) return a.lastShown - b.lastShown;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.jitter - a.jitter;
    })
    .map((entry) => entry.campaign);
}

/**
 * The campaigns to show in one slot right now, capped at its capacity.
 *
 * §10's "avoid A A A A" is enforced as one campaign per shop per slot: without
 * it, a merchant with four approved campaigns would legitimately win all four
 * positions on exposure alone, and the output would be exactly the pattern §10
 * says to avoid.
 */
async function resolveSlot(slotCode, context = {}) {
  const slot = await getSlot(slotCode);
  if (!slot || slot.status !== 'active') return { slot: slot ?? null, campaigns: [] };

  const { rules, frequencyLimits } = await config.get();
  const candidates = await eligibleCampaigns(slot, context);
  if (!candidates.length) return { slot, campaigns: [] };

  // §18: a customer who has already seen this campaign too often today does
  // not see it again, and the position goes to someone else.
  const limits = fairness.limitsFor(frequencyLimits, slot.placementType);
  const notFatigued = context.frequencyCounts
    ? fairness.filterFatiguedCampaigns(candidates, limits, context.frequencyCounts)
    : candidates;

  const rotated = rotate(notFatigued, rules);

  const chosen = [];
  const shopsUsed = new Set();
  for (const campaign of rotated) {
    if (chosen.length >= slot.capacity) break;
    if (shopsUsed.has(Number(campaign.shop_id))) continue;

    // §24: the full §9 checklist, on every read. A campaign whose only offer
    // expired an hour ago is dropped here even though its own row still looks
    // perfectly healthy.
    const check = await promotion.checkCampaign(campaign.id);
    if (!check.eligible) continue;

    chosen.push({ campaign, listings: check.eligibleListings });
    shopsUsed.add(Number(campaign.shop_id));
  }

  return { slot, campaigns: chosen };
}

/**
 * Attaches the nearest applicable branch to each served item.
 *
 * Featured placements had no distance at all, which meant §16 could not
 * attribute a city to a promoted impression the way it does an organic one -
 * so location analytics silently counted organic reach only.
 *
 * Resolved here rather than inside `promotion.listingRow`, which is also the
 * write-time eligibility check: that path has no customer and no coordinates,
 * and giving it an optional position it ignores would be a worse shape than
 * one extra query on the read path that actually needs it.
 *
 * One query per listing kind for the whole rail - a slot serves a handful of
 * items, not a page - and only when a position is known.
 */
async function attachNearestBranch(items, context) {
  if (context.latitude === undefined || context.longitude === undefined) return;

  const distanceParams = geo.distanceKmParams(context.latitude, context.longitude);
  const nearest = (predicate, column) =>
    `(SELECT b.${column} FROM shop_branches b
       WHERE b.status = 'active' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
         AND ${predicate}
       ORDER BY ${geo.distanceKmSql('b.latitude', 'b.longitude')} ASC LIMIT 1)`;
  const distanceOf = (predicate) =>
    `(SELECT MIN(${geo.distanceKmSql('b.latitude', 'b.longitude')}) FROM shop_branches b
       WHERE b.status = 'active' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
         AND ${predicate})`;

  const offerPredicate = `((o.applicability_type = 'shop_wide' AND b.shop_id = o.shop_id)
     OR (o.applicability_type = 'selected_branches' AND EXISTS (
          SELECT 1 FROM offer_locations ol WHERE ol.offer_id = o.id AND ol.branch_id = b.id)))`;
  const servicePredicate = `((sv.applicability_type = 'shop_wide' AND b.shop_id = sv.shop_id)
     OR (sv.applicability_type = 'selected_branches' AND EXISTS (
          SELECT 1 FROM service_locations sl WHERE sl.service_id = sv.id AND sl.branch_id = b.id)))`;

  const byKind = {
    offer: items.filter((item) => item.listingType === vis.LISTING_TYPES.OFFER).map((item) => item.id),
    service_offer: items
      .filter((item) => item.listingType === vis.LISTING_TYPES.SERVICE_OFFER)
      .map((item) => item.id),
  };

  const resolved = new Map();

  if (byKind.offer.length) {
    const rows = await rawQuery(
      `SELECT o.id,
              ${nearest(offerPredicate, 'id')} AS branch_id,
              ${nearest(offerPredicate, 'city')} AS branch_city,
              ${distanceOf(offerPredicate)} AS distance_km
         FROM offers o WHERE o.id IN (${byKind.offer.map(() => '?').join(',')})`,
      // One parameter set per distanceKmSql() occurrence, in text order.
      [...distanceParams, ...distanceParams, ...distanceParams, ...byKind.offer],
    );
    for (const row of rows) resolved.set(`offer:${row.id}`, row);
  }

  if (byKind.service_offer.length) {
    const rows = await rawQuery(
      `SELECT so.id,
              ${nearest(servicePredicate, 'id')} AS branch_id,
              ${nearest(servicePredicate, 'city')} AS branch_city,
              ${distanceOf(servicePredicate)} AS distance_km
         FROM service_offers so
         JOIN services sv ON sv.id = so.service_id
        WHERE so.id IN (${byKind.service_offer.map(() => '?').join(',')})`,
      [...distanceParams, ...distanceParams, ...distanceParams, ...byKind.service_offer],
    );
    for (const row of rows) resolved.set(`service_offer:${row.id}`, row);
  }

  for (const item of items) {
    const row = resolved.get(`${item.listingType}:${item.id}`);
    if (!row) continue;
    item.branchId = row.branch_id === null ? null : Number(row.branch_id);
    item.branchCity = row.branch_city ?? null;
    item.distanceKm =
      row.distance_km === null || row.distance_km === undefined
        ? null
        : Number(Number(row.distance_km).toFixed(2));
  }
}

/**
 * Serves a placement as flat, renderable items.
 *
 * Each item is tagged `featured: true` with its campaign and slot, which is
 * what §11's "Featured content should be clearly distinguishable from normal
 * organic results" needs from the API - the client cannot label what it cannot
 * tell apart - and what keeps §20's analytics split honest, since the
 * impression writer reads the same fields.
 */
async function serve(placementType, context = {}, { limit = 10 } = {}) {
  const slots = await listSlots({ placementType, status: 'active' });
  const items = [];

  for (const slot of slots) {
    if (slot.categoryId && context.categoryId && slot.categoryId !== context.categoryId) continue;
    if (slot.city && context.city && slot.city !== context.city) continue;

    const resolved = await resolveSlot(slot.code, context);
    for (const entry of resolved.campaigns) {
      for (const listing of entry.listings) {
        items.push({
          featured: true,
          placementType: slot.placementType,
          slotId: slot.id,
          slotCode: slot.code,
          featuredCampaignId: Number(entry.campaign.id),
          campaignName: entry.campaign.name,
          promotionalMessage: entry.campaign.description,
          listingType: listing.listingType,
          id: Number(listing.id),
          headline: listing.headline,
          imageUrl: listing.image_url,
          categoryId: listing.category_id === null ? null : Number(listing.category_id),
          shop: {
            id: Number(entry.campaign.shop_id),
            name: entry.campaign.shop_name,
            slug: entry.campaign.shop_slug,
            logoUrl: entry.campaign.shop_logo_url,
          },
          startsAt: entry.campaign.start_at,
          endsAt: entry.campaign.end_at,
        });
        if (items.length >= limit) break;
      }
      if (items.length >= limit) break;
    }
    if (items.length >= limit) break;
  }

  const served = items.slice(0, limit);
  // §16: a promoted impression should be attributable to a place the same way
  // an organic one is.
  await attachNearestBranch(served, context);
  return served;
}

/**
 * Records that these campaigns were served, which is what makes the next
 * rotation different from this one.
 *
 * Fire-and-forget: the response has already been decided, and a customer must
 * never wait on rotation bookkeeping. A lost update costs one campaign one turn
 * of the rotation, which self-corrects on the following request.
 */
function markServed(items) {
  const campaignIds = [...new Set(items.filter((item) => item.featured).map((item) => item.featuredCampaignId))];
  if (!campaignIds.length) return;

  execute(
    `UPDATE featured_campaigns
        SET exposure_count = exposure_count + 1, last_shown_at = NOW()
      WHERE id IN (${campaignIds.map(() => '?').join(',')})`,
    campaignIds,
  ).catch(() => {});

  const listingIds = items.filter((item) => item.featured).map((item) => item.id);
  if (!listingIds.length) return;
  execute(
    `UPDATE promotion_placements
        SET exposure_count = exposure_count + 1, last_shown_at = NOW()
      WHERE featured_campaign_id IN (${campaignIds.map(() => '?').join(',')})
        AND listing_id IN (${listingIds.map(() => '?').join(',')})`,
    [...campaignIds, ...listingIds],
  ).catch(() => {});
}

/** How exposure has actually been distributed, so §10 can be audited (§22). */
async function rotationReport(slotCode, days = 7) {
  const slot = await getSlot(slotCode);
  if (!slot) throw ApiError.notFound('Featured slot not found');

  const rows = await query(
    `SELECT fc.id, fc.name, fc.shop_id, s.name AS shop_name,
            fc.exposure_count, fc.last_shown_at,
            (SELECT COUNT(*) FROM visibility_events ve
              WHERE ve.featured_campaign_id = fc.id
                AND ve.event_type = 'FEATURED_IMPRESSION'
                AND ve.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)) AS impressions
       FROM featured_campaigns fc
       JOIN shops s ON s.id = fc.shop_id
      WHERE fc.slot_id = ? AND fc.status IN ('approved','active','completed')
      ORDER BY impressions DESC`,
    [days, slot.id],
  );

  const total = rows.reduce((sum, row) => sum + Number(row.impressions), 0);
  return {
    slot,
    windowDays: days,
    totalImpressions: total,
    campaigns: rows.map((row) => ({
      campaignId: Number(row.id),
      name: row.name,
      shopId: Number(row.shop_id),
      shopName: row.shop_name,
      impressions: Number(row.impressions),
      // The number that answers "is the rotation fair?". An even split across
      // n campaigns is 100/n percent each; a slot where one merchant holds 80%
      // is a rotation that is not working.
      sharePercent: total > 0 ? Number(((Number(row.impressions) / total) * 100).toFixed(1)) : 0,
      exposureCount: Number(row.exposure_count),
      lastShownAt: row.last_shown_at,
    })),
  };
}

module.exports = {
  listSlots,
  getSlot,
  upsertSlot,
  eligibleCampaigns,
  rotate,
  resolveSlot,
  serve,
  markServed,
  rotationReport,
  haversineKm,
};
