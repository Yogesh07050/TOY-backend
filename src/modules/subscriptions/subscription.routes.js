'use strict';

const express = require('express');
const { z } = require('zod');
const service = require('./subscription.service');
const plans = require('../../config/plans');
const audit = require('../../utils/audit');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate, optionalAuth } = require('../../middleware/auth');
const { requireShopScope } = require('../../middleware/authorize');
const accessControl = require('../../services/accessControl');
const ApiError = require('../../utils/ApiError');
const { ok } = require('../../utils/respond');

const router = express.Router();

const shopIdParam = z.object({ shopId: z.coerce.number().int().positive() });
const planBody = z.object({
  plan: z.enum(['FREE', 'BUSINESS', 'PREMIUM']),
  billingCycle: z.enum(['monthly', 'yearly']).default('monthly'),
  note: z.string().trim().max(255).optional(),
});

/**
 * Public plan catalogue (§3). Served from `config/plans.js` so the pricing page,
 * the upgrade prompts and the server-side checks all read the same definition.
 */
router.get(
  '/plans',
  optionalAuth,
  asyncHandler(async (_req, res) => {
    ok(res, {
      plans: plans.PLAN_KEYS.map((key) => {
        const plan = plans.PLANS[key];
        return {
          key: plan.key,
          name: plan.name,
          tagline: plan.tagline,
          description: plan.description,
          price: plan.price,
          currency: plan.currency,
          rank: plan.rank,
          limits: plan.limits,
          features: plan.features,
          profile: plan.profile,
          visibility: plan.visibility,
        };
      }),
      featureLabels: plans.FEATURE_LABELS,
      comparison: plans.COMPARISON_MATRIX,
    });
  }),
);

router.use(authenticate);

/** Entitlements for every shop the caller manages - what the shell loads once. */
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const shopIds = req.user.shops.map((shop) => shop.shopId);
    const entitlements = await Promise.all(shopIds.map((shopId) => service.entitlements(shopId)));
    ok(res, entitlements);
  }),
);

/**
 * Reading a shop's plan needs any shop-level right; VIEW_SHOP is held by every
 * member, which is the level at which "what plan am I on" is safe to expose.
 */
const canReadShop = (req, _res, next) => {
  const shopId = Number(req.params.shopId);
  if (accessControl.hasShopPermission(req.user, shopId, 'VIEW_SHOP')) return next();
  next(ApiError.forbidden('You do not have access to this shop'));
};

router.get(
  '/shops/:shopId',
  validate({ params: shopIdParam }),
  canReadShop,
  asyncHandler(async (req, res) => {
    ok(res, await service.entitlements(Number(req.params.shopId)));
  }),
);

router.get(
  '/shops/:shopId/usage',
  validate({ params: shopIdParam }),
  canReadShop,
  asyncHandler(async (req, res) => {
    ok(res, await service.usageForShop(Number(req.params.shopId)));
  }),
);

router.get(
  '/shops/:shopId/history',
  validate({ params: shopIdParam }),
  requireShopScope('MANAGE_SUBSCRIPTION'),
  asyncHandler(async (req, res) => {
    ok(res, await service.history(Number(req.params.shopId)));
  }),
);

router.get(
  '/shops/:shopId/invoices',
  validate({ params: shopIdParam }),
  requireShopScope('MANAGE_SUBSCRIPTION'),
  asyncHandler(async (req, res) => {
    ok(res, await service.invoices(Number(req.params.shopId)));
  }),
);

/** Upgrade or downgrade. Payment capture itself belongs to the provider (§38). */
router.put(
  '/shops/:shopId',
  validate({ params: shopIdParam, body: planBody }),
  requireShopScope('MANAGE_SUBSCRIPTION'),
  asyncHandler(async (req, res) => {
    const shopId = Number(req.params.shopId);
    const before = await service.getForShop(shopId);
    const entitlements = await service.changePlan(shopId, req.body.plan, req.user, {
      billingCycle: req.body.billingCycle,
      note: req.body.note,
    });

    await audit.record(req, {
      action: 'SUBSCRIPTION_CHANGED',
      entityType: 'shop',
      entityId: shopId,
      oldValue: { plan: before.plan },
      newValue: { plan: entitlements.plan, billingCycle: entitlements.billingCycle },
    });

    ok(res, entitlements);
  }),
);

/**
 * Confirms payment for the current period. Left as an authenticated admin
 * action rather than an open webhook until a provider is chosen - the provider
 * integration should call `service.markPaid` from its own verified handler.
 */
router.post(
  '/shops/:shopId/confirm-payment',
  validate({
    params: shopIdParam,
    body: z.object({ provider: z.string().max(40).optional(), reference: z.string().max(120).optional() }),
  }),
  requireShopScope('MANAGE_SUBSCRIPTION'),
  asyncHandler(async (req, res) => {
    const shopId = Number(req.params.shopId);
    const subscription = await service.markPaid(shopId, {
      provider: req.body.provider ?? null,
      providerRef: req.body.reference ?? null,
    });
    await audit.record(req, {
      action: 'SUBSCRIPTION_PAYMENT_CONFIRMED',
      entityType: 'shop',
      entityId: shopId,
      newValue: { plan: subscription.plan, amount: subscription.price },
    });
    ok(res, subscription);
  }),
);

router.post(
  '/shops/:shopId/cancel',
  validate({ params: shopIdParam, body: z.object({ note: z.string().max(255).optional() }) }),
  requireShopScope('MANAGE_SUBSCRIPTION'),
  asyncHandler(async (req, res) => {
    const shopId = Number(req.params.shopId);
    const entitlements = await service.cancel(shopId, req.user, req.body.note);
    await audit.record(req, {
      action: 'SUBSCRIPTION_CANCELLED',
      entityType: 'shop',
      entityId: shopId,
      newValue: { note: req.body.note ?? null },
    });
    ok(res, entitlements);
  }),
);

module.exports = router;
