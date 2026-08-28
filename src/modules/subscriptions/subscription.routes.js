'use strict';

const express = require('express');
const { z } = require('zod');
const service = require('./subscription.service');
const payments = require('../payments/payment.service');
const razorpay = require('../../services/razorpay');
const plans = require('../../config/plans');
const audit = require('../../utils/audit');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate, optionalAuth } = require('../../middleware/auth');
const { requireShopScope, requireSuperAdmin } = require('../../middleware/authorize');
const accessControl = require('../../services/accessControl');
const ApiError = require('../../utils/ApiError');
const { ok } = require('../../utils/respond');
const { idempotent } = require('../../middleware/idempotency');

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
      /** So the pricing page can say whether checkout is available at all. */
      payment: {
        gateway: 'razorpay',
        enabled: razorpay.isConfigured,
        keyId: razorpay.isConfigured ? razorpay.keyId : null,
        supportsAutopay: true,
        methods: ['card', 'upi', 'netbanking', 'wallet'],
      },
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
 * §18 `GET /subscriptions/current`: the entitlement in force for the caller.
 * Resolves to the shop they administer, or the highest-ranked when they manage
 * several - the client narrows with `/shops/:shopId` when it knows the shop.
 */
router.get(
  '/current',
  asyncHandler(async (req, res) => {
    const shopIds = req.user.shops.map((shop) => shop.shopId);
    if (!shopIds.length) return ok(res, null);

    const all = await Promise.all(shopIds.map((shopId) => service.entitlements(shopId)));
    const best = all.sort(
      (a, b) => plans.planFor(b.plan).rank - plans.planFor(a.plan).rank,
    )[0];
    ok(res, best);
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

/** Payment ledger for the Billing screen (§15). */
router.get(
  '/shops/:shopId/billing-history',
  validate({ params: shopIdParam }),
  requireShopScope('MANAGE_SUBSCRIPTION'),
  asyncHandler(async (req, res) => {
    ok(res, await payments.billingHistory(Number(req.params.shopId)));
  }),
);

router.get(
  '/shops/:shopId/invoices',
  validate({ params: shopIdParam }),
  requireShopScope('MANAGE_SUBSCRIPTION'),
  asyncHandler(async (req, res) => {
    ok(res, await payments.invoices(Number(req.params.shopId)));
  }),
);

router.get(
  '/shops/:shopId/invoices/:invoiceId',
  validate({ params: shopIdParam.extend({ invoiceId: z.coerce.number().int().positive() }) }),
  requireShopScope('MANAGE_SUBSCRIPTION'),
  asyncHandler(async (req, res) => {
    ok(res, await payments.invoice(Number(req.params.shopId), Number(req.params.invoiceId)));
  }),
);

/**
 * Starts a paid-plan purchase (§3, §18).
 *
 * Returns what Checkout needs; it does **not** change the shop's entitlements.
 * The plan is left pending until the Razorpay webhook confirms payment (§7),
 * so a client that fakes a success response gains nothing.
 */
router.post(
  '/shops/:shopId/checkout',
  validate({
    params: shopIdParam,
    body: z.object({
      plan: z.enum(['BUSINESS', 'PREMIUM']),
      billingCycle: z.enum(['monthly', 'yearly']).default('monthly'),
      note: z.string().trim().max(255).optional(),
    }),
  }),
  requireShopScope('MANAGE_SUBSCRIPTION'),
  // §51 puts Payment first on the list. A merchant who taps Upgrade twice must
  // not end up with two Razorpay orders against one intent - and after §50's
  // timeout, the retry has to be handed the original order rather than opening
  // a second checkout for the same month.
  idempotent(),
  asyncHandler(async (req, res) => {
    const shopId = Number(req.params.shopId);
    const checkout = await payments.startCheckout(shopId, req.body.plan, req.user, {
      billingCycle: req.body.billingCycle,
      note: req.body.note,
    });

    await audit.record(req, {
      action: 'SUBSCRIPTION_CHECKOUT_STARTED',
      entityType: 'shop',
      entityId: shopId,
      newValue: { plan: req.body.plan, gatewaySubscriptionId: checkout.subscriptionId },
    });

    ok(res, checkout);
  }),
);

/**
 * The handshake the client makes when Checkout closes successfully (§7).
 *
 * Its signature is verified, but the answer is deliberately "payment received,
 * activation pending" - only the webhook activates a plan.
 */
router.post(
  '/shops/:shopId/checkout/verify',
  validate({
    params: shopIdParam,
    body: z.object({
      paymentId: z.string().trim().min(4).max(120),
      subscriptionId: z.string().trim().max(120).optional(),
      orderId: z.string().trim().max(120).optional(),
      signature: z.string().trim().min(16).max(200),
    }),
  }),
  requireShopScope('MANAGE_SUBSCRIPTION'),
  asyncHandler(async (req, res) => {
    ok(res, await payments.acknowledgeCheckout(Number(req.params.shopId), req.body));
  }),
);

/**
 * Upgrade (§12). Paid targets go through checkout, so this only points there -
 * the frontend must never be able to set a plan directly.
 */
router.post(
  '/shops/:shopId/upgrade',
  validate({
    params: shopIdParam,
    body: z.object({
      plan: z.enum(['BUSINESS', 'PREMIUM']),
      billingCycle: z.enum(['monthly', 'yearly']).default('monthly'),
    }),
  }),
  requireShopScope('MANAGE_SUBSCRIPTION'),
  asyncHandler(async (req, res) => {
    const shopId = Number(req.params.shopId);
    const checkout = await payments.startCheckout(shopId, req.body.plan, req.user, {
      billingCycle: req.body.billingCycle,
    });
    await audit.record(req, {
      action: 'SUBSCRIPTION_CHECKOUT_STARTED',
      entityType: 'shop',
      entityId: shopId,
      newValue: { plan: req.body.plan, via: 'upgrade' },
    });
    ok(res, checkout);
  }),
);

/**
 * Downgrade (§12). Takes effect at the end of the period already paid for, so
 * the merchant keeps the benefits they bought.
 */
router.post(
  '/shops/:shopId/downgrade',
  validate({
    params: shopIdParam,
    body: z.object({
      plan: z.enum(['FREE', 'BUSINESS']),
      note: z.string().trim().max(255).optional(),
    }),
  }),
  requireShopScope('MANAGE_SUBSCRIPTION'),
  asyncHandler(async (req, res) => {
    const shopId = Number(req.params.shopId);
    const before = await service.getForShop(shopId);
    const entitlements = await service.scheduleDowngrade(shopId, req.body.plan, req.user, req.body.note);

    await audit.record(req, {
      action: 'SUBSCRIPTION_DOWNGRADED',
      entityType: 'shop',
      entityId: shopId,
      oldValue: { plan: before.plan },
      newValue: { plan: req.body.plan, effectiveAt: entitlements.currentPeriodEnd ?? 'immediately' },
    });

    ok(res, entitlements);
  }),
);

/**
 * Plan switch (§31). Only Free is settable this way: moving onto a paid plan
 * has to go through checkout so that money changes hands before features do
 * (§7, §31 "Admin cannot manually modify subscription status").
 */
router.put(
  '/shops/:shopId',
  validate({ params: shopIdParam, body: planBody }),
  requireShopScope('MANAGE_SUBSCRIPTION'),
  asyncHandler(async (req, res) => {
    const shopId = Number(req.params.shopId);
    if (req.body.plan !== 'FREE') {
      throw new ApiError(
        400,
        'Paid plans must be purchased through checkout.',
        undefined,
        'CHECKOUT_REQUIRED',
      );
    }

    const before = await service.getForShop(shopId);
    const entitlements = await service.scheduleDowngrade(shopId, 'FREE', req.user, req.body.note);

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
 * Put a shop on a paid plan without taking a payment. **Super Admin only.**
 *
 * The merchant-facing `PUT /shops/:shopId` deliberately refuses anything but
 * Free, because §31 says a merchant must not be able to move their own
 * subscription into a paid state. That rule is about merchants, not about
 * support: comping a shop, fixing a botched migration, or standing up a
 * staging environment with no Razorpay credentials all need a way in, and
 * without one there was none.
 *
 * The grant is recorded as a grant - zero amount, `not_required` payment
 * status, and an audit trail naming the Super Admin - so it never reads as a
 * payment that was never taken.
 */
router.post(
  '/shops/:shopId/grant',
  validate({
    params: shopIdParam,
    body: z.object({
      plan: z.enum(['BUSINESS', 'PREMIUM']),
      billingCycle: z.enum(['monthly', 'yearly']).default('monthly'),
      note: z.string().trim().max(255).optional(),
    }),
  }),
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const shopId = Number(req.params.shopId);
    const before = await service.getForShop(shopId);
    const subscription = await service.grantPlan(shopId, req.body.plan, req.user, {
      billingCycle: req.body.billingCycle,
      note: req.body.note,
    });

    await audit.record(req, {
      action: 'SUBSCRIPTION_GRANTED',
      entityType: 'shop',
      entityId: shopId,
      oldValue: { plan: before.plan },
      newValue: { plan: subscription.plan, amount: 0, granted: true, note: req.body.note ?? null },
    });

    ok(res, subscription);
  }),
);

/**
 * Manual payment confirmation, **Super Admin only**.
 *
 * Kept as a support tool for reconciling a payment the webhook never delivered,
 * and for exercising paid plans on an environment with no Razorpay credentials.
 * A merchant Admin cannot reach it: §31 requires that they not be able to move
 * their own subscription into a paid state from the frontend.
 */
router.post(
  '/shops/:shopId/confirm-payment',
  validate({
    params: shopIdParam,
    body: z.object({ provider: z.string().max(40).optional(), reference: z.string().max(120).optional() }),
  }),
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const shopId = Number(req.params.shopId);
    const subscription = await service.markPaid(shopId, {
      provider: req.body.provider ?? 'manual',
      providerRef: req.body.reference ?? null,
    });
    await audit.record(req, {
      action: 'SUBSCRIPTION_PAYMENT_CONFIRMED',
      entityType: 'shop',
      entityId: shopId,
      newValue: { plan: subscription.plan, amount: subscription.price, manual: true },
    });
    ok(res, subscription);
  }),
);

/**
 * Cancels future billing (§13). The mandate is cancelled at Razorpay, the plan
 * stays live until the paid period ends, and no payment record is deleted.
 */
router.post(
  '/shops/:shopId/cancel',
  validate({ params: shopIdParam, body: z.object({ note: z.string().max(255).optional() }) }),
  requireShopScope('MANAGE_SUBSCRIPTION'),
  asyncHandler(async (req, res) => {
    const shopId = Number(req.params.shopId);
    const entitlements = await payments.cancelSubscription(shopId, req.user, req.body.note);
    await audit.record(req, {
      action: 'SUBSCRIPTION_CANCELLED',
      entityType: 'shop',
      entityId: shopId,
      newValue: { note: req.body.note ?? null, activeUntil: entitlements.activeUntil ?? null },
    });
    ok(res, entitlements);
  }),
);

module.exports = router;
