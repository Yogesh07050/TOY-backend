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
const notifications = require('../../services/notifications');
const { limitOffset, paginationSchema } = require('../../utils/pagination');
const { ok, created, paginated } = require('../../utils/respond');

/**
 * Claims and redemptions for service offers - structural mirror of
 * modules/claims/claim.routes.js against service_offers/service_offer_claims.
 */

const router = express.Router();

const serviceOfferIdParam = z.object({ serviceOfferId: z.coerce.number().int().positive() });
const codeParam = z.object({ code: z.string().trim().min(6).max(24) });
const listQuery = z.object({
  ...paginationSchema,
  status: z.enum(['claimed', 'redeemed', 'expired', 'cancelled', 'all']).optional(),
});

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
  serviceOffer: {
    id: Number(row.service_offer_id),
    offerText: row.offer_text,
    endDate: row.offer_end_date,
  },
  service: { id: Number(row.service_id), name: row.service_name },
  shop: { id: Number(row.shop_id), name: row.shop_name },
  branch: row.branch_id ? { id: Number(row.branch_id), name: row.branch_name } : null,
  customer: row.customer_name ? { id: Number(row.user_id), name: row.customer_name } : undefined,
});

const CLAIM_SELECT = `
  SELECT c.*, so.offer_text, so.end_date AS offer_end_date, so.service_id,
         sv.name AS service_name, sv.shop_id, s.name AS shop_name,
         b.branch_name, u.name AS customer_name
    FROM service_offer_claims c
    JOIN service_offers so ON so.id = c.service_offer_id
    JOIN services sv ON sv.id = so.service_id
    JOIN shops s ON s.id = sv.shop_id
    JOIN users u ON u.id = c.user_id
    LEFT JOIN shop_branches b ON b.id = c.branch_id`;

router.use(authenticate);

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
      rawQuery(`SELECT COUNT(*) AS total FROM service_offer_claims c ${whereSql}`, params),
    ]);

    paginated(res, rows.map(mapClaim), { page, limit, total: Number(countRows[0].total) });
  }),
);

router.post(
  '/:serviceOfferId',
  validate({ params: serviceOfferIdParam }),
  asyncHandler(async (req, res) => {
    const offer = await queryOne(
      `SELECT so.id, so.status, so.end_date, so.start_date, sv.shop_id, s.status AS shop_status
         FROM service_offers so
         JOIN services sv ON sv.id = so.service_id
         JOIN shops s ON s.id = sv.shop_id
        WHERE so.id = ?`,
      [req.params.serviceOfferId],
    );
    if (!offer) throw ApiError.notFound('Service offer not found');

    const live =
      offer.status === 'active' &&
      offer.shop_status === 'active' &&
      new Date(offer.end_date) >= new Date() &&
      new Date(offer.start_date) <= new Date();
    if (!live) throw ApiError.badRequest('This service offer is not available to claim');

    const existing = await queryOne(
      'SELECT id FROM service_offer_claims WHERE user_id = ? AND service_offer_id = ?',
      [req.user.id, req.params.serviceOfferId],
    );

    let claimId = existing?.id;
    if (!claimId) {
      const result = await execute(
        'INSERT INTO service_offer_claims (service_offer_id, user_id, code) VALUES (?, ?, ?)',
        [req.params.serviceOfferId, req.user.id, generateCode()],
      );
      claimId = result.insertId;

      await execute('UPDATE service_offers SET claim_count = claim_count + 1 WHERE id = ?', [
        req.params.serviceOfferId,
      ]);
      await analyticsEvents.touchShopCustomer(offer.shop_id, req.user.id, 'claim');
      await analyticsEvents.record(analyticsEvents.EVENT_TYPES.SERVICE_OFFER_CLAIM, {
        shopId: offer.shop_id,
        userId: req.user.id,
      });

      // Same confirmation as a product-offer claim (Push §16), for the
      // parallel services domain.
      notifications
        .notifyServiceOfferClaimed(claimId)
        .catch((error) => console.error('[notifications] service claim confirmation failed: %s', error.message));
    }

    const rows = await rawQuery(`${CLAIM_SELECT} WHERE c.id = ?`, [claimId]);
    created(res, mapClaim(rows[0]));
  }),
);

router.get(
  '/lookup/:code',
  requirePermission('REDEEM_OFFER'),
  validate({ params: codeParam }),
  asyncHandler(async (req, res) => {
    const rows = await rawQuery(`${CLAIM_SELECT} WHERE c.code = ?`, [req.params.code.toUpperCase()]);
    if (!rows.length) throw ApiError.notFound('No claim found for that code');

    if (!accessControl.hasShopPermission(req.user, rows[0].shop_id, 'REDEEM_OFFER')) {
      throw ApiError.forbidden('That claim belongs to another shop');
    }
    ok(res, mapClaim(rows[0]));
  }),
);

router.post(
  '/lookup/:code/redeem',
  requirePermission('REDEEM_OFFER'),
  validate({ params: codeParam }),
  asyncHandler(async (req, res) => {
    const claim = await queryOne(
      `SELECT c.*, sv.shop_id, so.end_date FROM service_offer_claims c
         JOIN service_offers so ON so.id = c.service_offer_id
         JOIN services sv ON sv.id = so.service_id
        WHERE c.code = ?`,
      [req.params.code.toUpperCase()],
    );
    if (!claim) throw ApiError.notFound('No claim found for that code');
    if (!accessControl.hasShopPermission(req.user, claim.shop_id, 'REDEEM_OFFER')) {
      throw ApiError.forbidden('That claim belongs to another shop');
    }
    if (claim.status === 'redeemed') throw ApiError.conflict('This claim was already redeemed');
    if (new Date(claim.end_date) < new Date()) throw ApiError.badRequest('The service offer has expired');

    await execute(
      `UPDATE service_offer_claims SET status = 'redeemed', redeemed_at = NOW(), redeemed_by = ?
        WHERE id = ?`,
      [req.user.id, claim.id],
    );
    await analyticsEvents.touchShopCustomer(claim.shop_id, Number(claim.user_id), 'redeem');
    await analyticsEvents.record(analyticsEvents.EVENT_TYPES.SERVICE_OFFER_REDEEM, {
      shopId: claim.shop_id,
      userId: Number(claim.user_id),
      branchId: claim.branch_id === null ? null : Number(claim.branch_id),
    });

    await audit.record(req, {
      action: 'SERVICE_OFFER_CLAIM_REDEEMED',
      entityType: 'service_offer_claim',
      entityId: Number(claim.id),
      newValue: { serviceOfferId: Number(claim.service_offer_id), code: claim.code },
    });

    notifications
      .notifyServiceOfferRedeemed(claim.id)
      .catch((error) => console.error('[notifications] service redemption notice failed: %s', error.message));

    const rows = await rawQuery(`${CLAIM_SELECT} WHERE c.id = ?`, [claim.id]);
    ok(res, mapClaim(rows[0]));
  }),
);

module.exports = router;
