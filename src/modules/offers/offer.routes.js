'use strict';

const express = require('express');
const controller = require('./offer.controller');
const schema = require('./offer.schema');
const reviewSchema = require('../reviews/review.schema');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate, optionalAuth } = require('../../middleware/auth');
const {
  requirePermission,
  requireShopScope,
  loadOfferForWrite,
} = require('../../middleware/authorize');

const router = express.Router();

// ---- Discovery (public, personalised when a token is present) --------------
router.get('/', optionalAuth, validate({ query: schema.listOffersSchema }), asyncHandler(controller.list));

router.get('/:id', optionalAuth, validate({ params: schema.idParam }), asyncHandler(controller.detail));

router.post(
  '/:id/track',
  optionalAuth,
  validate({ params: schema.idParam, body: schema.trackEventSchema }),
  asyncHandler(controller.track),
);

// ---- Reviews (§36) ---------------------------------------------------------
router.get(
  '/:id/reviews',
  optionalAuth,
  validate({ params: schema.idParam, query: reviewSchema.listReviewsSchema }),
  asyncHandler(controller.listReviews),
);

router.post(
  '/:id/reviews',
  authenticate,
  validate({ params: schema.idParam, body: reviewSchema.createReviewSchema }),
  asyncHandler(controller.createReview),
);

// ---- Management ------------------------------------------------------------
// `requireShopScope` reads shopId from the body, so an Admin can only create
// offers for a shop they are actually a member of.
router.post(
  '/',
  authenticate,
  validate({ body: schema.createOfferSchema }),
  requirePermission('CREATE_OFFER'),
  requireShopScope('CREATE_OFFER', 'shopId'),
  asyncHandler(controller.create),
);

router.put(
  '/:id',
  authenticate,
  validate({ params: schema.idParam, body: schema.updateOfferSchema }),
  loadOfferForWrite('EDIT_OFFER'),
  asyncHandler(controller.update),
);

router.patch(
  '/:id/status',
  authenticate,
  validate({ params: schema.idParam, body: schema.updateStatusSchema }),
  loadOfferForWrite('EDIT_OFFER'),
  asyncHandler(controller.updateStatus),
);

router.delete(
  '/:id',
  authenticate,
  validate({ params: schema.idParam }),
  loadOfferForWrite('DELETE_OFFER'),
  asyncHandler(controller.remove),
);

module.exports = router;
