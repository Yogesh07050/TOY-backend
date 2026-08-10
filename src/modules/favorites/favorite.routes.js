'use strict';

const express = require('express');
const { z } = require('zod');
const { queryOne, execute } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate } = require('../../middleware/auth');
const offerService = require('../offers/offer.service');
const { listOffersSchema } = require('../offers/offer.schema');
const { ok, created, noContent, paginated } = require('../../utils/respond');

const router = express.Router();
const offerIdParam = z.object({ offerId: z.coerce.number().int().positive() });

router.use(authenticate);

/** Saved offers reuse the discovery pipeline so cards look identical (§22). */
router.get(
  '/',
  validate({ query: listOffersSchema }),
  asyncHandler(async (req, res) => {
    const { items, pagination } = await offerService.list(
      { ...req.query, favorites: true, manage: false },
      req.user,
    );
    paginated(res, items, pagination);
  }),
);

router.post(
  '/:offerId',
  validate({ params: offerIdParam }),
  asyncHandler(async (req, res) => {
    const offer = await queryOne('SELECT id FROM offers WHERE id = ?', [req.params.offerId]);
    if (!offer) throw ApiError.notFound('Offer not found');

    const result = await execute(
      'INSERT IGNORE INTO favorites (user_id, offer_id) VALUES (?, ?)',
      [req.user.id, req.params.offerId],
    );
    if (result.affectedRows) {
      await execute('UPDATE offers SET favorite_count = favorite_count + 1 WHERE id = ?', [
        req.params.offerId,
      ]);
    }
    created(res, { offerId: Number(req.params.offerId), isFavorite: true });
  }),
);

router.delete(
  '/:offerId',
  validate({ params: offerIdParam }),
  asyncHandler(async (req, res) => {
    const result = await execute('DELETE FROM favorites WHERE user_id = ? AND offer_id = ?', [
      req.user.id,
      req.params.offerId,
    ]);
    if (result.affectedRows) {
      await execute(
        'UPDATE offers SET favorite_count = GREATEST(favorite_count - 1, 0) WHERE id = ?',
        [req.params.offerId],
      );
    }
    noContent(res);
  }),
);

module.exports = router;
