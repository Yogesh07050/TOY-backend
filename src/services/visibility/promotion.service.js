'use strict';

const { queryOne, query } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const vis = require('../../config/visibility');
const merchantEntitlements = require('./merchantEntitlement.service');

/**
 * PromotionService (§30): "Validates promotional eligibility."
 *
 * §9 lists the conditions a merchant or campaign must meet:
 *
 *   - Required subscription or permission exists
 *   - Offer is active
 *   - Offer is not expired
 *   - Shop is active
 *   - Location is valid
 *   - Required promotional content is complete
 *   - Campaign passes platform validation
 *
 * Every one is checked twice, on purpose. On write, so a merchant is told what
 * is wrong while they can still fix it; on read, so a campaign that was valid
 * on Monday and whose offer expired on Tuesday stops displaying on Tuesday
 * rather than whenever someone next edits it (§24: "Ineligible Featured
 * campaigns cannot display").
 *
 * The two checks share these functions, which is what stops them drifting -
 * a write-time rule that the read path does not know about is a rule that
 * eventually shows an expired offer on the home page.
 */

/**
 * Whether one listing may currently be promoted, and why not if it cannot.
 *
 * Returns reasons rather than throwing, because both callers need them
 * differently: the write path turns them into a 400 the merchant can act on,
 * and the read path uses them to skip a placement silently.
 */
async function checkListing(listingType, listingId) {
  const reasons = [];

  const row = await listingRow(listingType, listingId);
  if (!row) return { eligible: false, reasons: ['Listing not found'], listing: null };

  // §9 / §24: active, not expired, and its shop is active.
  if (row.status !== 'active') reasons.push('The offer is not active');
  if (row.end_date && new Date(row.end_date) <= new Date()) reasons.push('The offer has expired');
  if (row.start_date && new Date(row.start_date) > new Date()) {
    reasons.push('The offer has not started yet');
  }
  if (row.shop_status !== 'active') reasons.push('The shop is not active');

  // §9's "Location is valid". An online-only listing has no branch by design
  // and is exempt; anything claiming a physical location must actually have a
  // locatable, active branch behind it, or Near Me placements would promote a
  // shop no customer can be routed to (§24).
  if (row.applicability_type !== 'online' && !Number(row.has_valid_location)) {
    reasons.push('No active branch with a confirmed location');
  }

  // §9's "Required promotional content is complete": a promotional card with
  // no image is not a promotion, it is a blank space.
  if (!row.image_url) reasons.push('A promotional image is required');
  if (!row.headline) reasons.push('An offer title or headline is required');

  return { eligible: reasons.length === 0, reasons, listing: row };
}

/** The eligibility columns for either listing kind, in one shape. */
async function listingRow(listingType, listingId) {
  if (listingType === vis.LISTING_TYPES.OFFER) {
    return queryOne(
      `SELECT o.id, o.shop_id, o.status, o.start_date, o.end_date, o.applicability_type,
              o.category_id, s.status AS shop_status, s.name AS shop_name,
              COALESCE(NULLIF(TRIM(o.title), ''), NULLIF(TRIM(o.offer_text), '')) AS headline,
              (SELECT oi.image_url FROM offer_images oi WHERE oi.offer_id = o.id
                ORDER BY oi.display_order, oi.id LIMIT 1) AS image_url,
              EXISTS (SELECT 1 FROM shop_branches b
                       WHERE b.status = 'active' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
                         AND ((o.applicability_type = 'shop_wide' AND b.shop_id = o.shop_id)
                           OR (o.applicability_type = 'selected_branches'
                               AND EXISTS (SELECT 1 FROM offer_locations ol
                                            WHERE ol.offer_id = o.id AND ol.branch_id = b.id))))
                AS has_valid_location
         FROM offers o JOIN shops s ON s.id = o.shop_id WHERE o.id = ?`,
      [listingId],
    );
  }

  if (listingType === vis.LISTING_TYPES.SERVICE_OFFER) {
    return queryOne(
      `SELECT so.id, sv.shop_id, so.status, so.start_date, so.end_date, sv.applicability_type,
              sv.category_id, s.status AS shop_status, s.name AS shop_name,
              COALESCE(NULLIF(TRIM(sv.name), ''), NULLIF(TRIM(so.offer_text), '')) AS headline,
              (SELECT si.image_url FROM service_images si WHERE si.service_id = sv.id
                ORDER BY si.display_order, si.id LIMIT 1) AS image_url,
              EXISTS (SELECT 1 FROM shop_branches b
                       WHERE b.status = 'active' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
                         AND ((sv.applicability_type = 'shop_wide' AND b.shop_id = sv.shop_id)
                           OR (sv.applicability_type = 'selected_branches'
                               AND EXISTS (SELECT 1 FROM service_locations sl
                                            WHERE sl.service_id = sv.id AND sl.branch_id = b.id))))
                AS has_valid_location
         FROM service_offers so
         JOIN services sv ON sv.id = so.service_id
         JOIN shops s ON s.id = sv.shop_id WHERE so.id = ?`,
      [listingId],
    );
  }

  if (listingType === vis.LISTING_TYPES.SHOP) {
    return queryOne(
      `SELECT s.id, s.id AS shop_id, s.status, NULL AS start_date, NULL AS end_date,
              'shop_wide' AS applicability_type, NULL AS category_id,
              s.status AS shop_status, s.name AS shop_name, s.name AS headline,
              s.logo_url AS image_url,
              EXISTS (SELECT 1 FROM shop_branches b
                       WHERE b.shop_id = s.id AND b.status = 'active'
                         AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL) AS has_valid_location
         FROM shops s WHERE s.id = ?`,
      [listingId],
    );
  }

  return null;
}

/**
 * Whether a merchant may run a Featured campaign at all (§9's first condition,
 * and §23's override channel).
 */
async function checkMerchant(shopId) {
  const resolved = await merchantEntitlements.resolve(shopId);
  return {
    eligible: resolved.featuredAccess,
    reasons: resolved.featuredAccess
      ? []
      : ['This shop does not have Featured placement access on its current plan'],
    entitlement: resolved,
  };
}

/**
 * Whether a campaign is currently displayable (§9, §24).
 *
 * The window is re-derived from `start_at`/`end_at` rather than trusted from
 * `status`. The scheduler keeps `status` in step (§8), but a scheduler that has
 * not run in the last minute must not be able to leave an ended campaign on the
 * home page - so the timestamps are authoritative and the status is a cache.
 */
function campaignWindowIsOpen(campaign, now = new Date()) {
  return new Date(campaign.start_at) <= now && new Date(campaign.end_at) > now;
}

async function checkCampaign(campaignId) {
  const campaign = await queryOne(
    `SELECT fc.*, s.status AS shop_status, fs.status AS slot_status, fs.min_plan_rank
       FROM featured_campaigns fc
       JOIN shops s ON s.id = fc.shop_id
       JOIN featured_slots fs ON fs.id = fc.slot_id
      WHERE fc.id = ?`,
    [campaignId],
  );
  if (!campaign) return { eligible: false, reasons: ['Campaign not found'], campaign: null };

  const reasons = [];
  if (!['approved', 'active'].includes(campaign.status)) {
    reasons.push(`Campaign status is "${campaign.status}"`);
  }
  if (!campaignWindowIsOpen(campaign)) reasons.push('Campaign is outside its scheduled window');
  if (campaign.shop_status !== 'active') reasons.push('The shop is not active');
  if (campaign.slot_status !== 'active') reasons.push('The featured slot is not active');

  const merchant = await checkMerchant(campaign.shop_id);
  if (!merchant.eligible) reasons.push(...merchant.reasons);
  if (merchant.entitlement.visibilityRank < Number(campaign.min_plan_rank)) {
    reasons.push('This slot requires a higher visibility level');
  }

  // At least one listing in the campaign must still be promotable, or the
  // campaign is a slot occupied by nothing.
  const placements = await query(
    `SELECT listing_type, listing_id FROM promotion_placements
      WHERE featured_campaign_id = ? AND status = 'active'`,
    [campaignId],
  );
  const checks = await Promise.all(
    placements.map(async (row) => ({
      // The listing kind travels with the row rather than being inferred from
      // its shape downstream: an `offers` row and a `service_offers` row look
      // identical once selected into a common column set, and guessing wrong
      // sends the customer to the wrong detail screen.
      listingType: row.listing_type,
      ...(await checkListing(row.listing_type, Number(row.listing_id))),
    })),
  );
  const usable = checks.filter((check) => check.eligible);
  if (!usable.length) reasons.push('No active, valid listing remains in this campaign');

  return {
    eligible: reasons.length === 0,
    reasons,
    campaign,
    eligibleListings: usable.map((check) => ({ ...check.listing, listingType: check.listingType })),
  };
}

/** Throws a 400 listing every §9 condition the campaign fails. */
async function assertCampaignEligible(campaignId) {
  const result = await checkCampaign(campaignId);
  if (result.eligible) return result;
  throw ApiError.badRequest(`This campaign is not eligible: ${result.reasons.join('; ')}`);
}

/** Throws unless the listing may be added to a campaign. */
async function assertListingPromotable(listingType, listingId, shopId) {
  const result = await checkListing(listingType, listingId);
  if (!result.listing) throw ApiError.notFound('Listing not found');
  // Checked before the eligibility reasons so a merchant is never told what is
  // wrong with a listing that is not theirs.
  if (Number(result.listing.shop_id) !== Number(shopId)) {
    throw ApiError.badRequest('That listing belongs to another shop');
  }
  if (!result.eligible) {
    throw ApiError.badRequest(`This listing cannot be promoted: ${result.reasons.join('; ')}`);
  }
  return result.listing;
}

module.exports = {
  checkListing,
  checkMerchant,
  checkCampaign,
  campaignWindowIsOpen,
  assertCampaignEligible,
  assertListingPromotable,
  listingRow,
};
