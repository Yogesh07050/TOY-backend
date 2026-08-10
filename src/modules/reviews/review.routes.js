'use strict';

const express = require('express');
const service = require('./review.service');
const schema = require('./review.schema');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const audit = require('../../utils/audit');
const { authenticate } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/authorize');
const { ok, noContent, paginated } = require('../../utils/respond');

const router = express.Router();

router.use(authenticate);

/** Moderation queue (§26). */
router.get(
  '/',
  requirePermission('MODERATE_REVIEWS'),
  validate({ query: schema.listReviewsSchema }),
  asyncHandler(async (req, res) => {
    const { items, pagination } = await service.listAll(req.query);
    paginated(res, items, pagination);
  }),
);

router.put(
  '/:id',
  validate({ params: schema.idParam, body: schema.moderateReviewSchema }),
  asyncHandler(async (req, res) => {
    const review = await service.update(req.params.id, req.body, req.user);
    if (req.body.status) {
      await audit.record(req, {
        action: 'REVIEW_MODERATED',
        entityType: 'review',
        entityId: review.id,
        newValue: { status: review.status },
      });
    }
    ok(res, review);
  }),
);

router.delete(
  '/:id',
  validate({ params: schema.idParam }),
  asyncHandler(async (req, res) => {
    const removed = await service.remove(req.params.id, req.user);
    await audit.record(req, {
      action: 'REVIEW_DELETED',
      entityType: 'review',
      entityId: Number(req.params.id),
      oldValue: audit.sanitize(removed),
    });
    noContent(res);
  }),
);

module.exports = router;
