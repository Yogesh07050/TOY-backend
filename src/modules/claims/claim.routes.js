'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { z } = require('zod');
const { queryOne, execute, rawQuery } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const audit = require('../../utils/audit');
const { authenticate } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/authorize');
const accessControl = require('../../services/accessControl');
const analyticsEvents = require('../../services/analyticsEvents');
const { limitOffset, paginationSchema } = require('../../utils/pagination');
const { ok, created, paginated } = require('../../utils/respond');

const router = express.Router();

/**
 * Offer claims and redemptions.
 *
 * A claim is the customer reserving an offer; redemption is shop staff marking
 * it used. Together they close the funnel in §24
 * (impressions → views → saves → claims → redemptions) and give the mobile app
 * (§26) its QR flow: the code below is what a scan resolves to.
 */

const offerIdParam = z.object({ offerId: z.coerce.number().int().positive() });
const codeParam = z.object({ code: z.string().trim().min(6).max(24) });
const listQuery = z.object({
  ...paginationSchema,
  status: z.enum(['claimed', 'redeemed', 'expired', 'cancelled', 'all']).optional(),
  offerId: z.coerce.number().int().positive().optional(),
});

/** Short, unambiguous code: no O/0/I/1 so it survives being read aloud. */
function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

const mapClaim = (row) => ({
  id: Number(row.id),
  code: row.code,
  status: row.status,
  claimedAt: row.claimed_at,
  redeemedAt: row.redeemed_at,
  offer: {
    id: Number(row.offer_id),
    title: row.offer_title,
    offerText: row.offer_text,
    endDate: row.offer_end_date,
    imageUrl: row.image_url ?? null,
  },
  shop: { id: Number(row.shop_id), name: row.shop_name },
  branch: row.branch_id ? { id: Number(row.branch_id), name: row.branch_name } : null,
  customer: row.customer_name ? { id: Number(row.user_id), name: row.customer_name } : undefined,
});

const CLAIM_SELECT = `
  SELECT c.*, o.title AS offer_title, o.offer_text, o.end_date AS offer_end_date,
         o.shop_id, s.name AS shop_name, b.branch_name, u.name AS customer_name,
         (SELECT oi.image_url FROM offer_images oi
           WHERE oi.offer_id = o.id ORDER BY oi.display_order, oi.id LIMIT 1) AS image_url
    FROM offer_claims c
    JOIN offers o ON o.id = c.offer_id
    JOIN shops  s ON s.id = o.shop_id
    JOIN users  u ON u.id = c.user_id
    LEFT JOIN shop_branches b ON b.id = c.branch_id`;

router.use(authenticate);

/** The signed-in customer's own claims. */
router.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { limit, page, offset } = limitOffset(req.query);
    const where = ['c.user_id = ?'];
    const params = [req.user.id];

    if (req.query.status && req.query.status !== 'all') {
      where.push('c.status = ?');
      params.push(req.query.status);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const [rows, countRows] = await Promise.all([
      rawQuery(`${CLAIM_SELECT} ${whereSql} ORDER BY c.claimed_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
      rawQuery(`SELECT COUNT(*) AS total FROM offer_claims c ${whereSql}`, params),
    ]);

    paginated(res, rows.map(mapClaim), { page, limit, total: Number(countRows[0].total) });
  }),
);

/**
 * Claims an offer. Idempotent: claiming twice returns the existing code rather
 * than issuing a second one, which is what the unique (user, offer) key enforces.
 */
router.post(
  '/:offerId',
  validate({ params: offerIdParam }),
  asyncHandler(async (req, res) => {
    const offer = await queryOne(
      `SELECT o.id, o.shop_id, o.status, o.end_date, o.start_date, s.status AS shop_status
         FROM offers o JOIN shops s ON s.id = o.shop_id WHERE o.id = ?`,
      [req.params.offerId],
    );
    if (!offer) throw ApiError.notFound('Offer not found');

    // Only a live offer can be claimed - otherwise the code would be worthless
    // at the counter.
    const live =
      offer.status === 'active' &&
      offer.shop_status === 'active' &&
      new Date(offer.end_date) >= new Date() &&
      new Date(offer.start_date) <= new Date();
    if (!live) throw ApiError.badRequest('This offer is not available to claim');

    const existing = await queryOne(
      'SELECT id FROM offer_claims WHERE user_id = ? AND offer_id = ?',
      [req.user.id, req.params.offerId],
    );

    let claimId = existing?.id;
    if (!claimId) {
      const result = await execute(
        'INSERT INTO offer_claims (offer_id, user_id, code) VALUES (?, ?, ?)',
        [req.params.offerId, req.user.id, generateCode()],
      );
      claimId = result.insertId;

      // Only a genuinely new claim counts - re-claiming returns the same code
      // and must not inflate the funnel (§10) or the frequent-claimer segment.
      await analyticsEvents.touchShopCustomer(offer.shop_id, req.user.id, 'claim');
      await analyticsEvents.record(analyticsEvents.EVENT_TYPES.OFFER_CLAIM, {
        shopId: offer.shop_id,
        offerId: Number(req.params.offerId),
        userId: req.user.id,
      });
    }

    const rows = await rawQuery(`${CLAIM_SELECT} WHERE c.id = ?`, [claimId]);
    created(res, mapClaim(rows[0]));
  }),
);

/** Looks a claim up by code, for the staff redemption screen / QR scan. */
router.get(
  '/lookup/:code',
  requirePermission('REDEEM_CLAIM'),
  validate({ params: codeParam }),
  asyncHandler(async (req, res) => {
    const rows = await rawQuery(`${CLAIM_SELECT} WHERE c.code = ?`, [req.params.code.toUpperCase()]);
    if (!rows.length) throw ApiError.notFound('No claim found for that code');

    // Staff may only look up claims for offers belonging to their own shop.
    if (!accessControl.hasShopPermission(req.user, rows[0].shop_id, 'REDEEM_CLAIM')) {
      throw ApiError.forbidden('That claim belongs to another shop');
    }
    ok(res, mapClaim(rows[0]));
  }),
);

/** Marks a claim redeemed. Shop-scoped, and refuses to double-redeem. */
router.post(
  '/lookup/:code/redeem',
  requirePermission('REDEEM_CLAIM'),
  validate({ params: codeParam }),
  asyncHandler(async (req, res) => {
    const claim = await queryOne(
      `SELECT c.*, o.shop_id, o.end_date FROM offer_claims c
         JOIN offers o ON o.id = c.offer_id WHERE c.code = ?`,
      [req.params.code.toUpperCase()],
    );
    if (!claim) throw ApiError.notFound('No claim found for that code');
    if (!accessControl.hasShopPermission(req.user, claim.shop_id, 'REDEEM_CLAIM')) {
      throw ApiError.forbidden('That claim belongs to another shop');
    }
    if (claim.status === 'redeemed') throw ApiError.conflict('This claim was already redeemed');
    if (new Date(claim.end_date) < new Date()) throw ApiError.badRequest('The offer has expired');

    await execute(
      `UPDATE offer_claims SET status = 'redeemed', redeemed_at = NOW(), redeemed_by = ?
        WHERE id = ?`,
      [req.user.id, claim.id],
    );
    await analyticsEvents.touchShopCustomer(claim.shop_id, Number(claim.user_id), 'redeem');
    await analyticsEvents.record(analyticsEvents.EVENT_TYPES.OFFER_REDEMPTION, {
      shopId: claim.shop_id,
      offerId: Number(claim.offer_id),
      userId: Number(claim.user_id),
      branchId: claim.branch_id === null ? null : Number(claim.branch_id),
    });

    await audit.record(req, {
      action: 'CLAIM_REDEEMED',
      entityType: 'offer_claim',
      entityId: Number(claim.id),
      newValue: { offerId: Number(claim.offer_id), code: claim.code },
    });

    const rows = await rawQuery(`${CLAIM_SELECT} WHERE c.id = ?`, [claim.id]);
    ok(res, mapClaim(rows[0]));
  }),
);

module.exports = router;
