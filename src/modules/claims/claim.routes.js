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
const claims = require('./claim.service');

const router = express.Router();

/**
 * The customer's half of the claim workflow (§3, §5, §34, §36).
 *
 * Everything a customer can do to their own claim lives here: take one out,
 * look at the code and QR, and give it back. Redeeming is deliberately absent -
 * §25 is explicit that a customer must never be able to mark their own claim
 * redeemed, and the way to guarantee that is for no route on this router to be
 * able to write `redeemed` at all. That lives in redemption.routes.js, behind a
 * merchant permission.
 */

const offerIdParam = z.object({ offerId: z.coerce.number().int().positive() });
const claimIdParam = z.object({ claimId: z.coerce.number().int().positive() });

const listQuery = z.object({
  ...paginationSchema,
  status: z.enum(['claimed', 'redeemed', 'expired', 'cancelled', 'revoked', 'active', 'all']).optional(),
  offerId: z.coerce.number().int().positive().optional(),
});

router.use(authenticate);

/**
 * The signed-in customer's own claims - "My Claims" (§5) and, filtered to
 * redeemed, "Redeemed Offers" (§36).
 */
router.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { limit, page, offset } = limitOffset(req.query);
    const where = ['c.user_id = ?'];
    const params = [req.user.id];

    if (req.query.status && req.query.status !== 'all') {
      if (req.query.status === 'active') {
        // What the customer thinks of as "my coupons": still usable right now.
        // Checked on the timestamp rather than the status so a claim that
        // expired since the last sweep does not show up as ready to use.
        where.push("c.status = 'claimed' AND c.expires_at >= NOW()");
      } else {
        where.push('c.status = ?');
        params.push(req.query.status);
      }
    }
    if (req.query.offerId) {
      where.push('c.offer_id = ?');
      params.push(req.query.offerId);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const [rows, countRows] = await Promise.all([
      rawQuery(
        `${claims.CLAIM_SELECT} ${whereSql} ORDER BY c.claimed_at DESC LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      rawQuery(`SELECT COUNT(*) AS total FROM offer_claims c ${whereSql}`, params),
    ]);

    paginated(
      res,
      rows.map((row) => claims.mapClaim(row, 'customer')),
      { page, limit, total: Number(countRows[0].total) },
    );
  }),
);

/**
 * One claim, with its code and QR. Owner-only: a claim id is a small integer,
 * so without this check the QR of every customer in the country would be one
 * `for` loop away.
 */
router.get(
  '/:claimId(\\d+)',
  validate({ params: claimIdParam }),
  asyncHandler(async (req, res) => {
    const row = await claims.findById(req.params.claimId);
    if (!row || Number(row.user_id) !== req.user.id) throw ApiError.notFound('Claim not found');
    ok(res, claims.mapClaim(row, 'customer'));
  }),
);

/**
 * Claims an offer (§3).
 *
 * Idempotent by design: while the customer still holds a live code for this
 * offer, claiming again returns that same code rather than issuing another.
 * That is what makes the button safe to press twice on a flaky connection, and
 * it is also §17 - a customer cannot manufacture extra claims by retrying.
 */
router.post(
  '/:offerId(\\d+)',
  validate({ params: offerIdParam }),
  asyncHandler(async (req, res) => {
    const { claimId, isNew, offer } = await claims.issue(req.params.offerId, req.user.id);

    if (isNew) {
      // Only a genuinely new claim counts. Re-claiming returns the same code
      // and must not inflate the funnel (§19) or the frequent-claimer segment.
      await claims.recordClaimEvents(offer, req.user.id);

      // Confirmation carrying the code (§37). Fire-and-forget: the claim is
      // already issued, and a push outage must not turn a successful claim
      // into a failed request.
      notifications
        .notifyOfferClaimed(claimId)
        .catch((error) => console.error('[notifications] claim confirmation failed: %s', error.message));
    }

    const row = await claims.findById(claimId);
    const body = claims.mapClaim(row, 'customer');
    if (isNew) created(res, body);
    else ok(res, body);
  }),
);

/**
 * The customer gives a claim back (§12 CANCELLED).
 *
 * Only a live claim can be cancelled - a redeemed one is a record of something
 * that physically happened, and nothing a customer does afterwards should be
 * able to erase it. Cancelling frees the claim against the offer's limit, so
 * this is also how someone who claimed by accident gets their one claim back.
 */
router.post(
  '/:claimId(\\d+)/cancel',
  validate({ params: claimIdParam }),
  asyncHandler(async (req, res) => {
    const row = await queryOne('SELECT id, user_id, status FROM offer_claims WHERE id = ?', [
      req.params.claimId,
    ]);
    if (!row || Number(row.user_id) !== req.user.id) throw ApiError.notFound('Claim not found');
    if (row.status === 'redeemed') throw ApiError.conflict('This claim has already been redeemed');
    if (row.status !== 'claimed') throw ApiError.badRequest('This claim is no longer active');

    await execute("UPDATE offer_claims SET status = 'cancelled' WHERE id = ?", [row.id]);
    ok(res, claims.mapClaim(await claims.findById(row.id), 'customer'));
  }),
);

/**
 * Resolves the token inside a scanned QR back to the claim it belongs to, for
 * the customer's own app (§6): a customer who scans their own code from a
 * printout should land on the claim, not on a login wall.
 *
 * Merchants do not come through here - their scan posts to
 * `/redemptions/verify`, which is where the permission and audit trail are.
 */
router.get(
  '/scan/:token',
  validate({ params: z.object({ token: z.string().min(10).max(512) }) }),
  asyncHandler(async (req, res) => {
    const code = claims.readQrPayload(req.params.token);
    if (!code) throw ApiError.badRequest('That QR code could not be read');

    const row = await claims.findByCode(code);
    if (!row || Number(row.user_id) !== req.user.id) throw ApiError.notFound('Claim not found');

    await analyticsEvents.record(analyticsEvents.EVENT_TYPES.CLAIM_QR_VIEW, {
      shopId: Number(row.shop_id),
      offerId: Number(row.offer_id),
      userId: req.user.id,
    });
    ok(res, claims.mapClaim(row, 'customer'));
  }),
);

module.exports = router;
