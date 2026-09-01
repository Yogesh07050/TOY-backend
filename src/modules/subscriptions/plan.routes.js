'use strict';

const express = require('express');
const { z } = require('zod');

const { execute } = require('../../db/pool');
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
 * AI plan entitlements (§3), mounted at `/api/subscription-plans`.
 *
 * Deliberately separate from `/api/subscriptions`, which owns billing - what a
 * shop pays, when it renews, and what Razorpay says about it. This module owns
 * the other half: what each plan *code* unlocks in the AI layer and how much of
 * it a shop may use per month.
 *
 * Reading is open to any signed-in user - the pricing table is not a secret and
 * the Angular upgrade prompt needs it. Editing limits is Super Admin only,
 * which is what "the exact limit should be configurable by the Super Admin"
 * requires.
 *
 * Moving a shop onto a different plan is *not* here: that can start a charge,
 * so it stays in the billing module at `PUT /api/subscriptions/shops/:shopId`.
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
    // Membership, not permission. VIEW_SHOP and USE_AI_CONTENT are both held
    // globally by roles outside this shop - VIEW_SHOP by every CUSTOMER - and
    // `hasShopPermission` grants on a global hold before it checks membership,
    // so either test let any signed-in user read this shop's plan and price.
    // See the same fix on `canReadShop` in subscription.routes.js.
    if (!req.user.isSuperAdmin && !req.user.shopIds?.includes(shopId)) {
      throw ApiError.forbidden('You do not have access to this shop');
    }
    ok(res, await subscriptions.getShopSubscription(shopId));
  }),
);

module.exports = router;
