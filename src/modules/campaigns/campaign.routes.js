'use strict';

const express = require('express');
const { z } = require('zod');
const { query, queryOne, execute, rawQuery, transaction } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const audit = require('../../utils/audit');
const { authenticate } = require('../../middleware/auth');
const { requirePermission, requireShopScope } = require('../../middleware/authorize');
const accessControl = require('../../services/accessControl');
const entitlements = require('../../services/entitlements');
const plans = require('../../config/plans');
const { ok, created, noContent } = require('../../utils/respond');

const router = express.Router();

/**
 * Campaigns (V3 §15, §25). A campaign groups banners and offers so their
 * combined performance - and, when the merchant supplies the figures, their
 * estimated ROI - can be reported on.
 *
 * Campaigns are a Premium feature, enforced on write. Reading is left to the
 * ordinary shop scope so a downgraded merchant can still see their history.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() });

const campaignFields = z.object({
  shopId: z.coerce.number().int().positive(),
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(500).optional().nullable(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  cost: z.coerce.number().min(0).max(99999999).optional().nullable(),
  averageOrderValue: z.coerce.number().min(0).max(99999999).optional().nullable(),
  averageMarginPercent: z.coerce.number().min(0).max(100).optional().nullable(),
  status: z.enum(['draft', 'running', 'completed', 'archived']).default('running'),
  offerIds: z.array(z.coerce.number().int().positive()).max(100).default([]),
});

const createSchema = campaignFields.refine((data) => data.endDate > data.startDate, {
  message: 'End date must be after the start date',
  path: ['endDate'],
});

const updateSchema = campaignFields
  .omit({ shopId: true })
  .partial()
  .refine((data) => !data.startDate || !data.endDate || data.endDate > data.startDate, {
    message: 'End date must be after the start date',
    path: ['endDate'],
  });

const mapCampaign = (row) => ({
  id: Number(row.id),
  shopId: Number(row.shop_id),
  shopName: row.shop_name ?? null,
  name: row.name,
  description: row.description,
  startDate: row.start_date,
  endDate: row.end_date,
  cost: row.cost === null ? null : Number(row.cost),
  averageOrderValue: row.avg_order_value === null ? null : Number(row.avg_order_value),
  averageMarginPercent: row.avg_margin_percent === null ? null : Number(row.avg_margin_percent),
  status: row.status,
  offerCount: Number(row.offer_count ?? 0),
  bannerCount: Number(row.banner_count ?? 0),
  createdAt: row.created_at,
});

router.use(authenticate);

/** Campaigns for the shops the caller manages. */
router.get(
  '/',
  validate({
    query: z.object({
      shopId: z.coerce.number().int().positive().optional(),
      status: z.enum(['draft', 'running', 'completed', 'archived']).optional(),
    }),
  }),
  requirePermission('MANAGE_CAMPAIGNS'),
  asyncHandler(async (req, res) => {
    const scope = accessControl.shopScopeFor(req.user, 'MANAGE_CAMPAIGNS');
    const where = ['1 = 1'];
    const params = [];

    if (scope !== null) {
      if (scope.length === 0) throw ApiError.forbidden('You are not assigned to any shop');
      where.push(`c.shop_id IN (${scope.map(() => '?').join(',')})`);
      params.push(...scope);
    }
    if (req.query.shopId) {
      where.push('c.shop_id = ?');
      params.push(req.query.shopId);
    }
    if (req.query.status) {
      where.push('c.status = ?');
      params.push(req.query.status);
    }

    const rows = await rawQuery(
      `SELECT c.*, s.name AS shop_name,
              (SELECT COUNT(*) FROM campaign_offers co WHERE co.campaign_id = c.id) AS offer_count,
              (SELECT COUNT(*) FROM banners b WHERE b.campaign_id = c.id) AS banner_count
         FROM campaigns c JOIN shops s ON s.id = c.shop_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.start_date DESC
        LIMIT 100`,
      params,
    );

    ok(res, rows.map(mapCampaign));
  }),
);

router.get(
  '/:id',
  validate({ params: idParam }),
  requirePermission('MANAGE_CAMPAIGNS'),
  asyncHandler(async (req, res) => {
    const row = await queryOne(
      `SELECT c.*, s.name AS shop_name,
              (SELECT COUNT(*) FROM campaign_offers co WHERE co.campaign_id = c.id) AS offer_count,
              (SELECT COUNT(*) FROM banners b WHERE b.campaign_id = c.id) AS banner_count
         FROM campaigns c JOIN shops s ON s.id = c.shop_id WHERE c.id = ?`,
      [req.params.id],
    );
    if (!row) throw ApiError.notFound('Campaign not found');
    if (!accessControl.hasShopPermission(req.user, row.shop_id, 'MANAGE_CAMPAIGNS')) {
      throw ApiError.forbidden('This campaign belongs to another shop');
    }

    const offers = await query(
      `SELECT o.id, o.title, o.status, o.end_date FROM campaign_offers co
         JOIN offers o ON o.id = co.offer_id WHERE co.campaign_id = ?`,
      [req.params.id],
    );

    ok(res, {
      ...mapCampaign(row),
      offers: offers.map((offer) => ({
        id: Number(offer.id),
        title: offer.title,
        status: offer.status,
        endDate: offer.end_date,
      })),
    });
  }),
);

/** Offers must belong to the campaign's shop, or a campaign could borrow them. */
async function assertOffersBelongToShop(connection, shopId, offerIds) {
  if (!offerIds.length) return;
  const [rows] = await connection.query(
    `SELECT id FROM offers WHERE shop_id = ? AND id IN (${offerIds.map(() => '?').join(',')})`,
    [shopId, ...offerIds],
  );
  if (rows.length !== offerIds.length) {
    throw ApiError.badRequest('One or more selected offers do not belong to this shop');
  }
}

router.post(
  '/',
  validate({ body: createSchema }),
  requirePermission('MANAGE_CAMPAIGNS'),
  requireShopScope('MANAGE_CAMPAIGNS', 'shopId'),
  asyncHandler(async (req, res) => {
    await entitlements.assertFeature(req.shopId, plans.FEATURES.CAMPAIGNS);
    const payload = req.body;

    const campaignId = await transaction(async (connection) => {
      await assertOffersBelongToShop(connection, payload.shopId, payload.offerIds);

      const [result] = await connection.execute(
        `INSERT INTO campaigns (shop_id, name, description, start_date, end_date, cost,
                                avg_order_value, avg_margin_percent, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          payload.shopId,
          payload.name,
          payload.description ?? null,
          payload.startDate,
          payload.endDate,
          payload.cost ?? null,
          payload.averageOrderValue ?? null,
          payload.averageMarginPercent ?? null,
          payload.status,
          req.user.id,
        ],
      );

      for (const offerId of payload.offerIds) {
        await connection.execute(
          'INSERT IGNORE INTO campaign_offers (campaign_id, offer_id) VALUES (?, ?)',
          [result.insertId, offerId],
        );
      }
      return result.insertId;
    });

    await audit.record(req, {
      action: 'CAMPAIGN_CREATED',
      entityType: 'campaign',
      entityId: campaignId,
      newValue: { name: payload.name, shopId: payload.shopId },
    });

    const row = await queryOne('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
    created(res, mapCampaign(row));
  }),
);

router.put(
  '/:id',
  validate({ params: idParam, body: updateSchema }),
  requirePermission('MANAGE_CAMPAIGNS'),
  asyncHandler(async (req, res) => {
    const existing = await queryOne('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
    if (!existing) throw ApiError.notFound('Campaign not found');
    if (!accessControl.hasShopPermission(req.user, existing.shop_id, 'MANAGE_CAMPAIGNS')) {
      throw ApiError.forbidden('This campaign belongs to another shop');
    }
    await entitlements.assertFeature(existing.shop_id, plans.FEATURES.CAMPAIGNS);

    const payload = req.body;
    // `undefined` means "not sent"; an explicit null clears an optional figure.
    const keep = (value, current) => (value !== undefined ? value : current);

    await transaction(async (connection) => {
      if (payload.offerIds) {
        await assertOffersBelongToShop(connection, existing.shop_id, payload.offerIds);
      }

      await connection.execute(
        `UPDATE campaigns SET name = ?, description = ?, start_date = ?, end_date = ?, cost = ?,
                avg_order_value = ?, avg_margin_percent = ?, status = ?
          WHERE id = ?`,
        [
          keep(payload.name, existing.name),
          keep(payload.description, existing.description),
          keep(payload.startDate, existing.start_date),
          keep(payload.endDate, existing.end_date),
          keep(payload.cost, existing.cost),
          keep(payload.averageOrderValue, existing.avg_order_value),
          keep(payload.averageMarginPercent, existing.avg_margin_percent),
          keep(payload.status, existing.status),
          req.params.id,
        ],
      );

      if (payload.offerIds) {
        await connection.execute('DELETE FROM campaign_offers WHERE campaign_id = ?', [req.params.id]);
        for (const offerId of payload.offerIds) {
          await connection.execute(
            'INSERT IGNORE INTO campaign_offers (campaign_id, offer_id) VALUES (?, ?)',
            [req.params.id, offerId],
          );
        }
      }
    });

    await audit.record(req, {
      action: 'CAMPAIGN_UPDATED',
      entityType: 'campaign',
      entityId: Number(req.params.id),
      newValue: { name: payload.name ?? existing.name },
    });

    const row = await queryOne('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
    ok(res, mapCampaign(row));
  }),
);

router.delete(
  '/:id',
  validate({ params: idParam }),
  requirePermission('MANAGE_CAMPAIGNS'),
  asyncHandler(async (req, res) => {
    const existing = await queryOne('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
    if (!existing) throw ApiError.notFound('Campaign not found');
    if (!accessControl.hasShopPermission(req.user, existing.shop_id, 'MANAGE_CAMPAIGNS')) {
      throw ApiError.forbidden('This campaign belongs to another shop');
    }

    await execute('DELETE FROM campaigns WHERE id = ?', [req.params.id]);
    await audit.record(req, {
      action: 'CAMPAIGN_DELETED',
      entityType: 'campaign',
      entityId: Number(req.params.id),
      oldValue: { name: existing.name },
    });
    noContent(res);
  }),
);

module.exports = router;
