'use strict';

const express = require('express');
const { z } = require('zod');
const { queryOne, execute, rawQuery } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate } = require('../../middleware/auth');
const analyticsEvents = require('../../services/analyticsEvents');
const notifications = require('../../services/notifications');
const { limitOffset, paginationSchema } = require('../../utils/pagination');
const { ok, created, paginated } = require('../../utils/respond');
const claims = require('../claims/claim.service');
const { idempotent } = require('../../middleware/idempotency');

const router = express.Router();

/**
 * The customer's half of the service-offer claim workflow (§22).
 *
 * Structurally the twin of modules/claims/claim.routes.js, and deliberately
 * thin: every rule that decides whether a code may be issued or used lives in
 * claim.service.js and is shared with product offers. §22 says the mechanism is
 * the same, and the only way to keep that true is for there to be one copy of
 * it - a second implementation would drift the first time either was fixed.
 *
 * Redeeming is absent here for the same reason it is absent from the product
 * version: no route a customer can reach may write `redeemed` (§25). That
 * lives in the merchant's redemption router, which serves both kinds.
 */

const KIND = 'service_offer';

const serviceOfferIdParam = z.object({ serviceOfferId: z.coerce.number().int().positive() });
const claimIdParam = z.object({ claimId: z.coerce.number().int().positive() });

const listQuery = z.object({
  ...paginationSchema,
  status: z.enum(['claimed', 'redeemed', 'expired', 'cancelled', 'revoked', 'active', 'all']).optional(),
  serviceOfferId: z.coerce.number().int().positive().optional(),
});

router.use(authenticate);

/** The signed-in customer's own service claims. */
router.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { limit, page, offset } = limitOffset(req.query);
    const where = ['c.user_id = ?'];
    const params = [req.user.id];

    if (req.query.status && req.query.status !== 'all') {
      if (req.query.status === 'active') {
        where.push("c.status = 'claimed' AND c.expires_at >= NOW()");
      } else {
        where.push('c.status = ?');
        params.push(req.query.status);
      }
    }
    if (req.query.serviceOfferId) {
      where.push('c.service_offer_id = ?');
      params.push(req.query.serviceOfferId);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const [rows, countRows] = await Promise.all([
      rawQuery(
        `${claims.SERVICE_CLAIM_SELECT} ${whereSql} ORDER BY c.claimed_at DESC LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      rawQuery(`SELECT COUNT(*) AS total FROM service_offer_claims c ${whereSql}`, params),
    ]);

    paginated(
      res,
      rows.map((row) => claims.mapClaim(row, 'customer', KIND)),
      { page, limit, total: Number(countRows[0].total) },
    );
  }),
);

/** One claim, with its code and QR. Owner-only. */
router.get(
  '/:claimId(\\d+)',
  validate({ params: claimIdParam }),
  asyncHandler(async (req, res) => {
    const row = await claims.findById(req.params.claimId, KIND);
    if (!row || Number(row.user_id) !== req.user.id) throw ApiError.notFound('Claim not found');
    ok(res, claims.mapClaim(row, 'customer', KIND));
  }),
);

/**
 * Claims a service offer. Idempotent while the customer holds a live code, and
 * subject to the same per-customer, total and validity rules as a product
 * offer - all enforced in the shared service.
 */
router.post(
  '/:serviceOfferId(\\d+)',
  validate({ params: serviceOfferIdParam }),
  idempotent(),
  asyncHandler(async (req, res) => {
    const { claimId, isNew, offer } = await claims.issue(
      req.params.serviceOfferId,
      req.user.id,
      KIND,
    );

    if (isNew) {
      // The denormalised counter the service offer carries for its own list
      // views; the funnel is measured from analytics_events, not from this.
      await execute('UPDATE service_offers SET claim_count = claim_count + 1 WHERE id = ?', [
        req.params.serviceOfferId,
      ]);
      await analyticsEvents.touchShopCustomer(offer.shop_id, req.user.id, 'claim');
      await analyticsEvents.record(analyticsEvents.EVENT_TYPES.SERVICE_OFFER_CLAIM, {
        shopId: offer.shop_id,
        userId: req.user.id,
      });

      notifications
        .notifyServiceOfferClaimed(claimId)
        .catch((error) =>
          console.error('[notifications] service claim confirmation failed: %s', error.message),
        );
    }

    const body = claims.mapClaim(await claims.findById(claimId, KIND), 'customer', KIND);
    if (isNew) created(res, body);
    else ok(res, body);
  }),
);

/** The customer gives a claim back (§12), freeing it against the offer's limit. */
router.post(
  '/:claimId(\\d+)/cancel',
  validate({ params: claimIdParam }),
  asyncHandler(async (req, res) => {
    const row = await queryOne(
      'SELECT id, user_id, status FROM service_offer_claims WHERE id = ?',
      [req.params.claimId],
    );
    if (!row || Number(row.user_id) !== req.user.id) throw ApiError.notFound('Claim not found');
    if (row.status === 'redeemed') throw ApiError.conflict('This claim has already been redeemed');
    if (row.status !== 'claimed') throw ApiError.badRequest('This claim is no longer active');

    await execute("UPDATE service_offer_claims SET status = 'cancelled' WHERE id = ?", [row.id]);
    ok(res, claims.mapClaim(await claims.findById(row.id, KIND), 'customer', KIND));
  }),
);

/** Resolves a QR the customer scanned off their own code. */
router.get(
  '/scan/:token',
  validate({ params: z.object({ token: z.string().min(10).max(512) }) }),
  asyncHandler(async (req, res) => {
    const scanned = claims.readQrPayload(req.params.token);
    if (!scanned || scanned.kind !== KIND) {
      throw ApiError.badRequest('That QR code could not be read');
    }

    const row = await claims.findByCode(scanned.code, KIND);
    if (!row || Number(row.user_id) !== req.user.id) throw ApiError.notFound('Claim not found');

    await analyticsEvents.record(analyticsEvents.EVENT_TYPES.CLAIM_QR_VIEW, {
      shopId: Number(row.shop_id),
      userId: req.user.id,
    });
    ok(res, claims.mapClaim(row, 'customer', KIND));
  }),
);

module.exports = router;
