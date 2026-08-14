'use strict';

const express = require('express');
const { z } = require('zod');
const { queryOne, execute } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate } = require('../../middleware/auth');
const serviceModule = require('../services/service.service');
const analyticsEvents = require('../../services/analyticsEvents');
const { listServicesSchema } = require('../services/service.schema');
const { ok, created, noContent, paginated } = require('../../utils/respond');

const router = express.Router();
const serviceIdParam = z.object({ serviceId: z.coerce.number().int().positive() });

router.use(authenticate);

/** Saved services reuse the discovery pipeline so cards look identical (§9, §37). */
router.get(
  '/',
  validate({ query: listServicesSchema }),
  asyncHandler(async (req, res) => {
    const { items, pagination } = await serviceModule.list(
      { ...req.query, saved: true, manage: false },
      req.user,
    );
    paginated(res, items, pagination);
  }),
);

router.post(
  '/:serviceId',
  validate({ params: serviceIdParam }),
  asyncHandler(async (req, res) => {
    const service = await queryOne('SELECT id, shop_id FROM services WHERE id = ?', [req.params.serviceId]);
    if (!service) throw ApiError.notFound('Service not found');

    const result = await execute(
      'INSERT IGNORE INTO saved_services (user_id, service_id) VALUES (?, ?)',
      [req.user.id, req.params.serviceId],
    );
    if (result.affectedRows) {
      await execute('UPDATE services SET save_count = save_count + 1 WHERE id = ?', [req.params.serviceId]);
      await analyticsEvents.touchShopCustomer(service.shop_id, req.user.id, 'save');
      await analyticsEvents.record(analyticsEvents.EVENT_TYPES.SERVICE_SAVE, {
        shopId: service.shop_id,
        serviceId: Number(req.params.serviceId),
        userId: req.user.id,
      });
    }
    created(res, { serviceId: Number(req.params.serviceId), isSaved: true });
  }),
);

router.delete(
  '/:serviceId',
  validate({ params: serviceIdParam }),
  asyncHandler(async (req, res) => {
    const result = await execute('DELETE FROM saved_services WHERE user_id = ? AND service_id = ?', [
      req.user.id,
      req.params.serviceId,
    ]);
    if (result.affectedRows) {
      await execute('UPDATE services SET save_count = GREATEST(save_count - 1, 0) WHERE id = ?', [
        req.params.serviceId,
      ]);
    }
    noContent(res);
  }),
);

module.exports = router;
