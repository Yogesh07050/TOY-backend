'use strict';

const express = require('express');
const controller = require('./service.controller');
const schema = require('./service.schema');
const serviceOfferRoutes = require('./serviceOffer.routes');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate, optionalAuth } = require('../../middleware/auth');
const { requirePermission, requireShopScope, loadServiceForWrite } = require('../../middleware/authorize');
const { idempotent } = require('../../middleware/idempotency');

const router = express.Router();

// ---- Offers on a service (§5, §6, §16) --------------------------------------
router.use('/:id/offers', serviceOfferRoutes);

// ---- Discovery (public, personalised when a token is present) --------------
router.get('/', optionalAuth, validate({ query: schema.listServicesSchema }), asyncHandler(controller.list));

router.get('/:id', optionalAuth, validate({ params: schema.idParam }), asyncHandler(controller.detail));

router.post(
  '/:id/track',
  optionalAuth,
  validate({ params: schema.idParam, body: schema.trackEventSchema }),
  asyncHandler(controller.track),
);

// ---- Booking (§11: Book / Enquire) ------------------------------------------
router.post(
  '/:id/book',
  authenticate,
  validate({ params: schema.idParam, body: schema.bookingBody }),
  // §51 lists Create Booking among the actions that must not double-fire. Two
  // bookings for the same slot is a real cost to the merchant, and unlike a
  // claim there is no unique key that would catch it.
  idempotent(),
  asyncHandler(controller.book),
);

router.patch(
  '/:id/bookings/:bookingId',
  authenticate,
  requirePermission('MANAGE_SERVICE_BOOKING'),
  validate({ params: schema.bookingIdParam, body: schema.bookingStatusSchema }),
  asyncHandler(controller.updateBookingStatus),
);

// ---- Management --------------------------------------------------------------
router.post(
  '/',
  authenticate,
  validate({ body: schema.createServiceSchema }),
  requirePermission('CREATE_SERVICE'),
  // The services twin of create-offer's protection (§51).
  idempotent(),
  requireShopScope('CREATE_SERVICE', 'shopId'),
  asyncHandler(controller.create),
);

router.put(
  '/:id',
  authenticate,
  validate({ params: schema.idParam, body: schema.updateServiceSchema }),
  loadServiceForWrite('EDIT_SERVICE'),
  asyncHandler(controller.update),
);

router.patch(
  '/:id/status',
  authenticate,
  validate({ params: schema.idParam, body: schema.updateStatusSchema }),
  loadServiceForWrite('PUBLISH_SERVICE'),
  asyncHandler(controller.updateStatus),
);

router.post(
  '/:id/duplicate',
  authenticate,
  validate({ params: schema.idParam }),
  loadServiceForWrite('CREATE_SERVICE'),
  asyncHandler(controller.duplicate),
);

router.delete(
  '/:id',
  authenticate,
  validate({ params: schema.idParam }),
  loadServiceForWrite('DELETE_SERVICE'),
  asyncHandler(controller.remove),
);

module.exports = router;
