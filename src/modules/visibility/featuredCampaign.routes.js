'use strict';

const express = require('express');
const { z } = require('zod');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const audit = require('../../utils/audit');
const { authenticate } = require('../../middleware/auth');
const { requirePermission, requireShopScope } = require('../../middleware/authorize');
const accessControl = require('../../services/accessControl');
const { ok, created, noContent } = require('../../utils/respond');
const vis = require('../../config/visibility');
const campaigns = require('../../services/visibility/campaign.service');
const promotion = require('../../services/visibility/promotion.service');
const featuredPlacements = require('../../services/visibility/featuredPlacement.service');
const merchantEntitlements = require('../../services/visibility/merchantEntitlement.service');

const router = express.Router();

/**
 * The merchant's side of Featured promotion (§7, §8, §9).
 *
 * A merchant builds and schedules a campaign here; a Super Admin approves it
 * in `/visibility/admin` (§22). Splitting the two across routers is not
 * decoration - it is what makes "a merchant cannot put themselves on the home
 * page" a property of the routing table rather than an if-statement somebody
 * could remove.
 *
 * Reading is left to the ordinary shop scope so a merchant whose plan lapsed
 * can still see their own campaign history; only writing checks the Featured
 * entitlement.
 */
router.use(authenticate);

const idParam = z.object({ id: z.coerce.number().int().positive() });

const listingSchema = z.object({
  listingType: z.enum(['offer', 'service_offer', 'shop']),
  listingId: z.coerce.number().int().positive(),
});

const campaignBody = z.object({
  shopId: z.coerce.number().int().positive(),
  slotId: z.coerce.number().int().positive(),
  // Optional link to the merchant's existing ROI campaign, so promotional
  // spend and organic performance report together.
  campaignId: z.coerce.number().int().positive().optional().nullable(),
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(500).optional().nullable(),
  targetCategoryId: z.coerce.number().int().positive().optional().nullable(),
  targetCity: z.string().trim().max(120).optional().nullable(),
  targetLatitude: z.coerce.number().min(-90).max(90).optional().nullable(),
  targetLongitude: z.coerce.number().min(-180).max(180).optional().nullable(),
  targetRadiusKm: z.coerce.number().min(0.1).max(500).optional().nullable(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  listings: z.array(listingSchema).min(1).max(20),
});

const updateBody = campaignBody
  .omit({ shopId: true, slotId: true })
  .partial()
  .extend({ listings: z.array(listingSchema).min(1).max(20).optional() });

/** The campaign, or a 404/403 - never a 403 that reveals a campaign exists. */
async function campaignForCaller(id, user, permission = 'MANAGE_FEATURED_CAMPAIGNS') {
  const campaign = await campaigns.getById(id);
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!accessControl.hasShopPermission(user, campaign.shopId, permission)) {
    throw ApiError.forbidden('This campaign belongs to another shop');
  }
  return campaign;
}

/**
 * The slots a merchant may actually bid for, given their visibility level.
 *
 * The shop is a path parameter, not a query one, because `requireShopScope`
 * resolves it from `req.params` and `req.body` alone - passing it in the query
 * string left the guard with nothing to check and turned every call into "Shop
 * id is required".
 */
router.get(
  '/slots/:shopId',
  requirePermission('MANAGE_FEATURED_CAMPAIGNS'),
  validate({ params: z.object({ shopId: z.coerce.number().int().positive() }) }),
  requireShopScope('MANAGE_FEATURED_CAMPAIGNS', 'shopId'),
  asyncHandler(async (req, res) => {
    const entitlement = await merchantEntitlements.resolve(req.shopId);
    const slots = await featuredPlacements.listSlots({ status: 'active' });

    ok(res, {
      visibilityLevel: entitlement.visibilityLevel,
      featuredAccess: entitlement.featuredAccess,
      // §21's wording for this merchant's own level, so the screen never has
      // to invent a promise - or attribute one to a plan they are not on.
      promise: entitlement.promise,
      slots: slots.map((slot) => ({
        ...slot,
        eligible: entitlement.featuredAccess && entitlement.visibilityRank >= slot.minPlanRank,
      })),
    });
  }),
);

router.get(
  '/',
  requirePermission('MANAGE_FEATURED_CAMPAIGNS'),
  validate({
    query: z.object({
      shopId: z.coerce.number().int().positive().optional(),
      status: z.enum(vis.CAMPAIGN_STATUSES).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const scope = accessControl.shopScopeFor(req.user, 'MANAGE_FEATURED_CAMPAIGNS');
    if (scope !== null && scope.length === 0) {
      throw ApiError.forbidden('You are not assigned to any shop');
    }
    ok(res, await campaigns.list({ ...req.query, shopIds: scope }));
  }),
);

router.get(
  '/:id',
  requirePermission('MANAGE_FEATURED_CAMPAIGNS'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const campaign = await campaignForCaller(req.params.id, req.user);
    // The live §9 verdict alongside the stored record: a merchant looking at an
    // approved campaign that is not appearing needs to be told *why*, and the
    // reason is usually that one of their own offers expired underneath it.
    const eligibility = await promotion.checkCampaign(campaign.id);
    ok(res, { ...campaign, eligibility: { eligible: eligibility.eligible, reasons: eligibility.reasons } });
  }),
);

router.post(
  '/',
  requirePermission('MANAGE_FEATURED_CAMPAIGNS'),
  validate({ body: campaignBody }),
  requireShopScope('MANAGE_FEATURED_CAMPAIGNS', 'shopId'),
  asyncHandler(async (req, res) => {
    const campaign = await campaigns.create(req.body, req.user);

    await audit.record(req, {
      action: 'FEATURED_CAMPAIGN_CREATED',
      entityType: 'featured_campaign',
      entityId: campaign.id,
      newValue: { name: campaign.name, shopId: campaign.shopId, slotId: campaign.slotId },
    });

    created(res, campaign);
  }),
);

router.put(
  '/:id',
  requirePermission('MANAGE_FEATURED_CAMPAIGNS'),
  validate({ params: idParam, body: updateBody }),
  asyncHandler(async (req, res) => {
    const before = await campaignForCaller(req.params.id, req.user);
    await merchantEntitlements.assertFeaturedAccess(before.shopId);

    const campaign = await campaigns.update(req.params.id, req.body);

    await audit.record(req, {
      action: 'FEATURED_CAMPAIGN_UPDATED',
      entityType: 'featured_campaign',
      entityId: campaign.id,
      oldValue: { status: before.status, startAt: before.startAt, endAt: before.endAt },
      newValue: { status: campaign.status, startAt: campaign.startAt, endAt: campaign.endAt },
    });

    ok(res, campaign);
  }),
);

/**
 * Pausing and resuming, which a merchant may do to their own campaign.
 *
 * Deliberately only these two transitions. Approval belongs to the Super Admin
 * (§22), and a merchant who could set their own status to `approved` would have
 * routed around it in one request.
 */
router.post(
  '/:id/status',
  requirePermission('MANAGE_FEATURED_CAMPAIGNS'),
  validate({
    params: idParam,
    body: z.object({ status: z.enum(['paused', 'approved', 'archived']) }),
  }),
  asyncHandler(async (req, res) => {
    const before = await campaignForCaller(req.params.id, req.user);

    if (req.body.status === 'approved' && before.status !== 'paused') {
      throw ApiError.forbidden('Only a paused campaign can be resumed; approval is a Super Admin action');
    }
    if (req.body.status === 'paused' && !['approved', 'active'].includes(before.status)) {
      throw ApiError.badRequest('Only a live campaign can be paused');
    }

    const campaign = await campaigns.setStatus(req.params.id, req.body.status);
    await audit.record(req, {
      action: 'FEATURED_CAMPAIGN_STATUS_CHANGED',
      entityType: 'featured_campaign',
      entityId: campaign.id,
      oldValue: { status: before.status },
      newValue: { status: campaign.status },
    });
    ok(res, campaign);
  }),
);

router.delete(
  '/:id',
  requirePermission('MANAGE_FEATURED_CAMPAIGNS'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const before = await campaignForCaller(req.params.id, req.user);
    await campaigns.remove(req.params.id);

    await audit.record(req, {
      action: 'FEATURED_CAMPAIGN_DELETED',
      entityType: 'featured_campaign',
      entityId: before.id,
      oldValue: { name: before.name, shopId: before.shopId },
    });
    noContent(res);
  }),
);

/**
 * §9's checklist for one listing, before it is added to a campaign.
 *
 * A "why can't I promote this?" endpoint. Without it the merchant's only way to
 * discover that their offer has no image is to submit the campaign and read a
 * validation error, which is a worse way to learn the same thing.
 */
router.get(
  '/eligibility/:listingType/:listingId',
  requirePermission('MANAGE_FEATURED_CAMPAIGNS'),
  validate({
    params: z.object({
      listingType: z.enum(['offer', 'service_offer', 'shop']),
      listingId: z.coerce.number().int().positive(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const check = await promotion.checkListing(req.params.listingType, req.params.listingId);
    if (!check.listing) throw ApiError.notFound('Listing not found');
    if (!accessControl.hasShopPermission(req.user, Number(check.listing.shop_id), 'MANAGE_FEATURED_CAMPAIGNS')) {
      throw ApiError.forbidden('That listing belongs to another shop');
    }

    ok(res, {
      listingType: req.params.listingType,
      listingId: Number(req.params.listingId),
      eligible: check.eligible,
      reasons: check.reasons,
    });
  }),
);

module.exports = router;
