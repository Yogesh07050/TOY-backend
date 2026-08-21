'use strict';

const express = require('express');
const { z } = require('zod');

const { execute, queryOne } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const audit = require('../../utils/audit');
const { ok } = require('../../utils/respond');
const { authenticate } = require('../../middleware/auth');
const { requireSuperAdmin } = require('../../middleware/authorize');
const access = require('../../services/accessControl');
const subscriptions = require('../../services/subscriptions');

/**
 * Subscription plans and shop assignments (§3).
 *
 * Reading a plan is open to any signed-in user - the pricing table is not a
 * secret, and the Angular upgrade prompt needs it. Changing a plan, its AI
 * limits, or which plan a shop is on is Super Admin only, which is what
 * "the exact limit should be configurable by the Super Admin" requires.
 */

const router = express.Router();

router.use(authenticate);

const nullableLimit = z
  .union([z.coerce.number().int().min(0).max(100000), z.null()])
  .optional();

const planUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).nullish(),
  priceMonthly: z.coerce.number().min(0).max(9999999).optional(),

  aiAssistantEnabled: z.coerce.boolean().optional(),
  aiContentEnabled: z.coerce.boolean().optional(),
  aiOptimizerEnabled: z.coerce.boolean().optional(),

  historicalInsights: z.coerce.boolean().optional(),
  locationInsights: z.coerce.boolean().optional(),
  timingInsights: z.coerce.boolean().optional(),
  socialCaptionEnabled: z.coerce.boolean().optional(),

  // null means unlimited, 0 means off.
  aiAssistantMonthlyLimit: nullableLimit,
  aiContentMonthlyLimit: nullableLimit,
  aiOptimizerMonthlyLimit: nullableLimit,

  status: z.enum(['active', 'inactive']).optional(),
});

const assignSchema = z.object({
  planId: z.coerce.number().int().positive(),
  status: z.enum(['active', 'cancelled', 'expired']).default('active'),
  expiresAt: z.coerce.date().nullish(),
  notes: z.string().trim().max(500).nullish(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });
const shopIdParam = z.object({ shopId: z.coerce.number().int().positive() });

/** Column name for each editable field, so the UPDATE stays a whitelist. */
const COLUMNS = {
  name: 'name',
  description: 'description',
  priceMonthly: 'price_monthly',
  aiAssistantEnabled: 'ai_assistant_enabled',
  aiContentEnabled: 'ai_content_enabled',
  aiOptimizerEnabled: 'ai_optimizer_enabled',
  historicalInsights: 'historical_insights',
  locationInsights: 'location_insights',
  timingInsights: 'timing_insights',
  socialCaptionEnabled: 'social_caption_enabled',
  aiAssistantMonthlyLimit: 'ai_assistant_monthly_limit',
  aiContentMonthlyLimit: 'ai_content_monthly_limit',
  aiOptimizerMonthlyLimit: 'ai_optimizer_monthly_limit',
  status: 'status',
};

router.get(
  '/plans',
  asyncHandler(async (req, res) => {
    // Inactive plans are an administrative detail, so only a Super Admin sees them.
    ok(res, await subscriptions.listPlans({ includeInactive: req.user.isSuperAdmin }));
  }),
);

router.put(
  '/plans/:id',
  requireSuperAdmin,
  validate({ params: idParam, body: planUpdateSchema }),
  asyncHandler(async (req, res) => {
    const existing = await subscriptions.getPlanById(req.params.id);
    if (!existing) throw ApiError.notFound('That subscription plan does not exist');

    const assignments = [];
    const values = [];
    for (const [field, column] of Object.entries(COLUMNS)) {
      if (!(field in req.body)) continue;
      assignments.push(`${column} = ?`);
      const value = req.body[field];
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value ?? null);
    }

    if (!assignments.length) throw ApiError.badRequest('Nothing to update');

    await execute(`UPDATE subscription_plans SET ${assignments.join(', ')} WHERE id = ?`, [
      ...values,
      req.params.id,
    ]);

    const updated = await subscriptions.getPlanById(req.params.id);
    await audit.record(req, {
      action: 'SUBSCRIPTION_PLAN_UPDATED',
      entityType: 'subscription_plan',
      entityId: updated.id,
      oldValue: existing,
      newValue: updated,
    });
    ok(res, updated);
  }),
);

/** The plan a shop is on. Readable by anyone who administers that shop. */
router.get(
  '/shops/:shopId',
  validate({ params: shopIdParam }),
  asyncHandler(async (req, res) => {
    const shopId = Number(req.params.shopId);
    if (
      !req.user.isSuperAdmin
      && !access.hasShopPermission(req.user, shopId, 'VIEW_SHOP')
      && !access.hasShopPermission(req.user, shopId, 'USE_AI_CONTENT')
    ) {
      throw ApiError.forbidden('You do not have access to this shop');
    }
    ok(res, await subscriptions.getShopSubscription(shopId));
  }),
);

router.put(
  '/shops/:shopId',
  requireSuperAdmin,
  validate({ params: shopIdParam, body: assignSchema }),
  asyncHandler(async (req, res) => {
    const shop = await queryOne('SELECT id, name FROM shops WHERE id = ?', [req.params.shopId]);
    if (!shop) throw ApiError.notFound('Shop not found');

    const before = await subscriptions.getShopSubscription(shop.id);
    const result = await subscriptions.setShopPlan(
      shop.id,
      {
        planId: req.body.planId,
        status: req.body.status,
        expiresAt: req.body.expiresAt ?? null,
        notes: req.body.notes ?? null,
      },
      req.user.id,
    );

    await audit.record(req, {
      action: 'SHOP_SUBSCRIPTION_CHANGED',
      entityType: 'shop',
      entityId: shop.id,
      oldValue: { plan: before.plan?.code, status: before.source },
      newValue: { plan: result.plan?.code, expiresAt: req.body.expiresAt ?? null },
    });

    ok(res, result);
  }),
);

module.exports = router;
