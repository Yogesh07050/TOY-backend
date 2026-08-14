'use strict';

const express = require('express');
const controller = require('./serviceOffer.controller');
const schema = require('./serviceOffer.schema');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate, optionalAuth } = require('../../middleware/auth');
const { loadServiceForWrite, loadServiceOfferForWrite } = require('../../middleware/authorize');

/** Mounted at /services/:id/offers - `mergeParams` exposes the parent `:id`. */
const router = express.Router({ mergeParams: true });

router.get(
  '/',
  optionalAuth,
  validate({ params: schema.serviceIdParam, query: schema.listServiceOffersSchema }),
  asyncHandler(controller.list),
);

router.get(
  '/:offerId',
  optionalAuth,
  validate({ params: schema.serviceOfferIdParam }),
  asyncHandler(controller.detail),
);

router.post(
  '/',
  authenticate,
  validate({ params: schema.serviceIdParam, body: schema.serviceOfferBody }),
  // Loads the parent service by :id and checks the caller may manage its
  // offers - a service offer has no shopId of its own on create.
  loadServiceForWrite('MANAGE_SERVICE_OFFER'),
  asyncHandler(controller.create),
);

router.put(
  '/:offerId',
  authenticate,
  validate({ params: schema.serviceOfferIdParam, body: schema.serviceOfferBody }),
  loadServiceOfferForWrite('MANAGE_SERVICE_OFFER'),
  asyncHandler(controller.update),
);

router.patch(
  '/:offerId/status',
  authenticate,
  validate({ params: schema.serviceOfferIdParam, body: schema.updateStatusSchema }),
  loadServiceOfferForWrite('MANAGE_SERVICE_OFFER'),
  asyncHandler(controller.updateStatus),
);

router.delete(
  '/:offerId',
  authenticate,
  validate({ params: schema.serviceOfferIdParam }),
  loadServiceOfferForWrite('MANAGE_SERVICE_OFFER'),
  asyncHandler(controller.remove),
);

module.exports = router;
