'use strict';

const express = require('express');
const { z } = require('zod');
const service = require('./banner.service');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const audit = require('../../utils/audit');
const { authenticate } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/authorize');
const { paginationSchema } = require('../../utils/pagination');
const { queryBoolean } = require('../../utils/queryBoolean');
const { ok, created, noContent, paginated } = require('../../utils/respond');

const router = express.Router();

const listQuery = z.object({
  ...paginationSchema,
  status: z.enum(['draft', 'scheduled', 'published', 'expired', 'deactivated', 'all']).optional(),
  shopId: z.coerce.number().int().positive().optional(),
  search: z.string().trim().max(200).optional(),
  live: queryBoolean(),
});

/**
 * Kept as a plain object so `.partial()` still works for updates - `.refine()`
 * would wrap it in ZodEffects, which has no `.partial()`.
 */
const bannerFields = z.object({
  title: z.string().trim().min(3, 'Banner title is required').max(200),
  subtitle: z.string().trim().max(300).optional().nullable(),
  description: z.string().trim().max(2000).optional().nullable(),
  imageUrl: z.string().url().max(500).optional().nullable(),
  mobileImageUrl: z.string().url().max(500).optional().nullable(),
  desktopImageUrl: z.string().url().max(500).optional().nullable(),
  // Required: a V2 banner exists to promote one specific offer (§13).
  offerId: z.coerce.number().int().positive({ message: 'Choose the offer this banner promotes' }),
  buttonText: z.string().trim().max(60).optional().default('View Offer'),
  startDate: z.coerce.date({ required_error: 'Start date is required' }),
  endDate: z.coerce.date({ required_error: 'End date is required' }),
  status: z.enum(['draft', 'scheduled', 'published', 'deactivated']).default('draft'),
  displayOrder: z.coerce.number().int().min(0).max(9999).optional().default(0),
});

const endsAfterStart = (data) =>
  !data.startDate || !data.endDate || data.endDate > data.startDate;
const dateOrderMessage = { message: 'End date must be after the start date', path: ['endDate'] };

const createBannerSchema = bannerFields.refine(endsAfterStart, dateOrderMessage);
// A partial update may send only one of the two dates; the service falls back
// to the stored value, and this still catches the case where both are sent.
const updateBannerSchema = bannerFields.partial().refine(endsAfterStart, dateOrderMessage);

const statusSchema = z.object({
  status: z.enum(['draft', 'scheduled', 'published', 'deactivated']),
});

const trackSchema = z.object({ event: z.enum(['impression', 'click']).default('impression') });
const idParam = z.object({ id: z.coerce.number().int().positive() });

/**
 * Every route here is authenticated and permission-gated (§15). The customer
 * never touches this router - featured banners reach them through
 * `/api/discovery/featured`, which is read-only and returns eligible banners only.
 */
router.use(authenticate);

router.get(
  '/',
  requirePermission('VIEW_BANNERS'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { items, pagination } = await service.list(req.query, req.user);
    paginated(res, items, pagination);
  }),
);

/** Offers the caller may attach a banner to, for the create form. */
router.get(
  '/selectable-offers',
  requirePermission('CREATE_BANNER'),
  asyncHandler(async (req, res) => {
    ok(res, await service.selectableOffers(req.user, req.query['search']));
  }),
);

router.get(
  '/analytics',
  requirePermission('VIEW_ANALYTICS'),
  asyncHandler(async (req, res) => {
    ok(
      res,
      await service.analytics(req.user, {
        days: Number(req.query['days']) || 30,
        shopId: req.query['shopId'] ? Number(req.query['shopId']) : undefined,
      }),
    );
  }),
);

router.get(
  '/:id',
  requirePermission('VIEW_BANNERS'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    ok(res, await service.getById(req.params.id, req.user));
  }),
);

router.post(
  '/',
  requirePermission('CREATE_BANNER'),
  validate({ body: createBannerSchema }),
  asyncHandler(async (req, res) => {
    const banner = await service.create(req.body, req.user);
    await audit.record(req, {
      action: 'BANNER_CREATED',
      entityType: 'banner',
      entityId: banner.id,
      newValue: { title: banner.title, offerId: banner.offerId, status: banner.status },
    });
    created(res, banner);
  }),
);

router.put(
  '/:id',
  requirePermission('EDIT_BANNER'),
  validate({ params: idParam, body: updateBannerSchema }),
  asyncHandler(async (req, res) => {
    const banner = await service.update(req.params.id, req.body, req.user);
    await audit.record(req, {
      action: 'BANNER_UPDATED',
      entityType: 'banner',
      entityId: banner.id,
      newValue: { title: banner.title, status: banner.status, offerId: banner.offerId },
    });
    ok(res, banner);
  }),
);

router.patch(
  '/:id/status',
  requirePermission('PUBLISH_BANNER'),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(async (req, res) => {
    const banner = await service.changeStatus(req.params.id, req.body.status, req.user);
    await audit.record(req, {
      action: banner.status === 'published' ? 'BANNER_PUBLISHED' : 'BANNER_STATUS_CHANGED',
      entityType: 'banner',
      entityId: banner.id,
      newValue: { status: banner.status },
    });
    ok(res, banner);
  }),
);

router.delete(
  '/:id',
  requirePermission('DELETE_BANNER'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const removed = await service.remove(req.params.id, req.user);
    await audit.record(req, {
      action: 'BANNER_DELETED',
      entityType: 'banner',
      entityId: Number(req.params.id),
      oldValue: { title: removed.title },
    });
    noContent(res);
  }),
);

module.exports = router;
module.exports.trackSchema = trackSchema;
