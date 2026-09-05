'use strict';

const { query, queryOne, execute, rawQuery, transaction } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const vis = require('../../config/visibility');
const promotion = require('./promotion.service');
const merchantEntitlements = require('./merchantEntitlement.service');

/**
 * CampaignService (§30): "Handles scheduled campaigns."
 *
 * A Featured campaign is a merchant's bid for a promotional slot over a window
 * (§8). This module owns its life: creation, the listings inside it, Super
 * Admin approval (§22), and the scheduled activation and deactivation §8
 * requires the system to perform on its own.
 *
 * ## Status is a cache, the window is the truth
 *
 * `sync()` moves campaigns between approved / active / completed on a clock.
 * Nothing depends on it having run: every read path re-derives the window from
 * `start_at`/`end_at` (`promotion.campaignWindowIsOpen`). A scheduler that is
 * a minute late can therefore make an admin list look stale, but can never
 * leave an ended campaign on the home page - which is §24's requirement, and
 * the reason the redundancy is worth having.
 */

const mapCampaign = (row) => ({
  id: Number(row.id),
  shopId: Number(row.shop_id),
  shopName: row.shop_name ?? null,
  slotId: Number(row.slot_id),
  slotCode: row.slot_code ?? null,
  slotName: row.slot_name ?? null,
  campaignId: row.campaign_id === null ? null : Number(row.campaign_id),
  name: row.name,
  description: row.description,
  placementType: row.placement_type,
  target: {
    categoryId: row.target_category_id === null ? null : Number(row.target_category_id),
    categoryName: row.target_category_name ?? null,
    city: row.target_city,
    latitude: row.target_latitude === null ? null : Number(row.target_latitude),
    longitude: row.target_longitude === null ? null : Number(row.target_longitude),
    radiusKm: row.target_radius_km === null ? null : Number(row.target_radius_km),
  },
  startAt: row.start_at,
  endAt: row.end_at,
  priority: Number(row.priority),
  status: row.status,
  exposureCount: Number(row.exposure_count ?? 0),
  lastShownAt: row.last_shown_at,
  placementCount: Number(row.placement_count ?? 0),
  approvedBy: row.approved_by === null ? null : Number(row.approved_by),
  approvedAt: row.approved_at,
  rejectionReason: row.rejection_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const SELECT_CAMPAIGN = `
  SELECT fc.*, s.name AS shop_name,
         fs.code AS slot_code, fs.name AS slot_name,
         c.name AS target_category_name,
         (SELECT COUNT(*) FROM promotion_placements pp
           WHERE pp.featured_campaign_id = fc.id AND pp.status = 'active') AS placement_count
    FROM featured_campaigns fc
    JOIN shops s ON s.id = fc.shop_id
    JOIN featured_slots fs ON fs.id = fc.slot_id
    LEFT JOIN categories c ON c.id = fc.target_category_id`;

async function getById(id) {
  const row = await queryOne(`${SELECT_CAMPAIGN} WHERE fc.id = ?`, [id]);
  if (!row) return null;

  const placements = await query(
    `SELECT id, listing_type, listing_id, display_order, status, exposure_count, last_shown_at
       FROM promotion_placements WHERE featured_campaign_id = ? ORDER BY display_order, id`,
    [id],
  );

  return {
    ...mapCampaign(row),
    placements: placements.map((placement) => ({
      id: Number(placement.id),
      listingType: placement.listing_type,
      listingId: Number(placement.listing_id),
      displayOrder: Number(placement.display_order),
      status: placement.status,
      exposureCount: Number(placement.exposure_count),
      lastShownAt: placement.last_shown_at,
    })),
  };
}

async function list({ shopIds, shopId, status, placementType, slotId, active, limit = 50, offset = 0 } = {}) {
  const where = ['1 = 1'];
  const params = [];

  // `shopIds` is the caller's scope: null means platform-wide (Super Admin),
  // an array narrows to the shops they manage. An empty array is not "no
  // filter" - it is "no shops", and must return nothing.
  if (Array.isArray(shopIds)) {
    if (!shopIds.length) return [];
    where.push(`fc.shop_id IN (${shopIds.map(() => '?').join(',')})`);
    params.push(...shopIds);
  }
  if (shopId) {
    where.push('fc.shop_id = ?');
    params.push(shopId);
  }
  if (status) {
    where.push('fc.status = ?');
    params.push(status);
  }
  if (placementType) {
    where.push('fc.placement_type = ?');
    params.push(placementType);
  }
  if (slotId) {
    where.push('fc.slot_id = ?');
    params.push(slotId);
  }
  if (active) {
    where.push("fc.status IN ('approved','active') AND fc.start_at <= NOW() AND fc.end_at > NOW()");
  }

  const rows = await rawQuery(
    `${SELECT_CAMPAIGN} WHERE ${where.join(' AND ')}
      ORDER BY fc.start_at DESC, fc.id DESC
      LIMIT ${Number.parseInt(limit, 10)} OFFSET ${Number.parseInt(offset, 10)}`,
    params,
  );
  return rows.map(mapCampaign);
}

/** The slot a campaign is bidding for, with its own rules. */
async function slotOrThrow(slotId) {
  const slot = await queryOne('SELECT * FROM featured_slots WHERE id = ?', [slotId]);
  if (!slot) throw ApiError.notFound('Featured slot not found');
  if (slot.status !== 'active') throw ApiError.badRequest('That featured slot is not active');
  return slot;
}

/**
 * Creates a campaign, in `pending_approval`.
 *
 * Never straight to `active`, even for a paying Premium merchant. §22 gives
 * Super Admin campaign approval, and a promotional space shared by every
 * merchant on the platform is exactly the kind of surface that needs a human
 * between "a merchant typed something" and "every customer sees it".
 */
async function create(payload, actor) {
  const entitlement = await merchantEntitlements.assertFeaturedAccess(payload.shopId);
  const slot = await slotOrThrow(payload.slotId);

  if (entitlement.visibilityRank < Number(slot.min_plan_rank)) {
    throw ApiError.forbidden('This featured slot requires a higher visibility level');
  }
  if (new Date(payload.endAt) <= new Date(payload.startAt)) {
    throw ApiError.badRequest('The campaign end must be after its start');
  }
  if (new Date(payload.endAt) <= new Date()) {
    throw ApiError.badRequest('The campaign end is in the past');
  }
  // A slot that pins its own category (a "Featured in Clothing" space) decides
  // the targeting; letting a campaign override it would let a shoe shop into
  // the clothing rail.
  const targetCategoryId = slot.category_id ?? payload.targetCategoryId ?? null;

  // §9, at write time: every listing must belong to this shop and be
  // promotable. Checked before the insert so a merchant is told what is wrong
  // while they can still fix it, rather than discovering it as silence on the
  // home page a week later.
  await validateListings(payload.shopId, payload.listings);

  const id = await transaction(async (connection) => {
    const [result] = await connection.execute(
      `INSERT INTO featured_campaigns
         (shop_id, slot_id, campaign_id, name, description, placement_type,
          target_category_id, target_city, target_latitude, target_longitude, target_radius_km,
          start_at, end_at, priority, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?)`,
      [
        payload.shopId,
        slot.id,
        payload.campaignId ?? null,
        payload.name,
        payload.description ?? null,
        slot.placement_type,
        targetCategoryId,
        slot.city ?? payload.targetCity ?? null,
        payload.targetLatitude ?? null,
        payload.targetLongitude ?? null,
        payload.targetRadiusKm ?? null,
        payload.startAt,
        payload.endAt,
        payload.priority ?? 0,
        actor?.id ?? null,
      ],
    );

    for (const [index, listing] of (payload.listings ?? []).entries()) {
      await connection.execute(
        `INSERT INTO promotion_placements
           (featured_campaign_id, shop_id, listing_type, listing_id, display_order)
         VALUES (?, ?, ?, ?, ?)`,
        [result.insertId, payload.shopId, listing.listingType, listing.listingId, index],
      );
    }

    return result.insertId;
  });

  return getById(id);
}

async function update(id, payload) {
  const existing = await queryOne('SELECT * FROM featured_campaigns WHERE id = ?', [id]);
  if (!existing) throw ApiError.notFound('Campaign not found');
  if (['completed', 'archived'].includes(existing.status)) {
    throw ApiError.badRequest('A finished campaign can no longer be edited');
  }

  const keep = (value, current) => (value !== undefined ? value : current);
  const startAt = keep(payload.startAt, existing.start_at);
  const endAt = keep(payload.endAt, existing.end_at);
  if (new Date(endAt) <= new Date(startAt)) {
    throw ApiError.badRequest('The campaign end must be after its start');
  }

  // Editing the schedule, the targeting or the listings changes what was
  // approved, so approval is withdrawn and the campaign goes back in the
  // queue. Anything else - a description, a priority - leaves it alone.
  const materialChange =
    payload.startAt !== undefined ||
    payload.endAt !== undefined ||
    payload.listings !== undefined ||
    payload.targetCategoryId !== undefined ||
    payload.targetCity !== undefined ||
    payload.targetRadiusKm !== undefined;

  const nextStatus =
    materialChange && ['approved', 'active'].includes(existing.status)
      ? 'pending_approval'
      : existing.status;

  if (payload.listings) await validateListings(existing.shop_id, payload.listings);

  await transaction(async (connection) => {
    await connection.execute(
      `UPDATE featured_campaigns
          SET name = ?, description = ?, target_category_id = ?, target_city = ?,
              target_latitude = ?, target_longitude = ?, target_radius_km = ?,
              start_at = ?, end_at = ?, priority = ?, status = ?
        WHERE id = ?`,
      [
        keep(payload.name, existing.name),
        keep(payload.description, existing.description),
        keep(payload.targetCategoryId, existing.target_category_id),
        keep(payload.targetCity, existing.target_city),
        keep(payload.targetLatitude, existing.target_latitude),
        keep(payload.targetLongitude, existing.target_longitude),
        keep(payload.targetRadiusKm, existing.target_radius_km),
        startAt,
        endAt,
        keep(payload.priority, existing.priority),
        nextStatus,
        id,
      ],
    );

    if (payload.listings) {
      await connection.execute('DELETE FROM promotion_placements WHERE featured_campaign_id = ?', [id]);
      for (const [index, listing] of payload.listings.entries()) {
        await connection.execute(
          `INSERT INTO promotion_placements
             (featured_campaign_id, shop_id, listing_type, listing_id, display_order)
           VALUES (?, ?, ?, ?, ?)`,
          [id, existing.shop_id, listing.listingType, listing.listingId, index],
        );
      }
    }
  });

  return getById(id);
}

/** Every listing in the campaign must belong to the shop and be promotable (§9). */
async function validateListings(shopId, listings) {
  for (const listing of listings ?? []) {
    if (!Object.values(vis.LISTING_TYPES).includes(listing.listingType)) {
      throw ApiError.badRequest(`Unknown listing type "${listing.listingType}"`);
    }
    await promotion.assertListingPromotable(listing.listingType, listing.listingId, shopId);
  }
}

// ---------------------------------------------------------------------------
// Super Admin approval (§22)

async function approve(id, actor) {
  const existing = await queryOne('SELECT * FROM featured_campaigns WHERE id = ?', [id]);
  if (!existing) throw ApiError.notFound('Campaign not found');
  if (['completed', 'archived', 'rejected'].includes(existing.status)) {
    throw ApiError.badRequest(`A ${existing.status} campaign cannot be approved`);
  }

  // Approved, not active. Whether it *displays* is decided by the window on
  // every read, so approving a future campaign schedules it rather than
  // launching it - which is what §8 asks for.
  await execute(
    `UPDATE featured_campaigns
        SET status = 'approved', approved_by = ?, approved_at = NOW(), rejection_reason = NULL
      WHERE id = ?`,
    [actor?.id ?? null, id],
  );
  await sync();
  return getById(id);
}

async function reject(id, reason, actor) {
  const existing = await queryOne('SELECT id FROM featured_campaigns WHERE id = ?', [id]);
  if (!existing) throw ApiError.notFound('Campaign not found');

  await execute(
    `UPDATE featured_campaigns
        SET status = 'rejected', approved_by = ?, approved_at = NOW(), rejection_reason = ?
      WHERE id = ?`,
    [actor?.id ?? null, reason ?? null, id],
  );
  return getById(id);
}

async function setStatus(id, status) {
  if (!vis.CAMPAIGN_STATUSES.includes(status)) throw ApiError.badRequest('Unknown campaign status');
  const result = await execute('UPDATE featured_campaigns SET status = ? WHERE id = ?', [status, id]);
  if (!result.affectedRows) throw ApiError.notFound('Campaign not found');
  return getById(id);
}

async function remove(id) {
  const result = await execute('DELETE FROM featured_campaigns WHERE id = ?', [id]);
  if (!result.affectedRows) throw ApiError.notFound('Campaign not found');
}

// ---------------------------------------------------------------------------
// Scheduling (§8)

/**
 * Moves campaigns across their schedule boundaries.
 *
 * Two transitions, both idempotent:
 *
 *   approved -> active     the start time has arrived
 *   active   -> completed  the end time has passed
 *
 * A campaign that was never approved is never activated, no matter what its
 * dates say - which is what keeps §22's approval step meaningful rather than
 * something the clock eventually works around.
 */
async function sync() {
  const activated = await execute(
    `UPDATE featured_campaigns
        SET status = 'active'
      WHERE status = 'approved' AND start_at <= NOW() AND end_at > NOW()`,
  );
  const completed = await execute(
    `UPDATE featured_campaigns
        SET status = 'completed'
      WHERE status IN ('approved','active','paused') AND end_at <= NOW()`,
  );

  return { activated: activated.affectedRows, completed: completed.affectedRows };
}

module.exports = {
  getById,
  list,
  create,
  update,
  validateListings,
  approve,
  reject,
  setStatus,
  remove,
  sync,
  mapCampaign,
};
