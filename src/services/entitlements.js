'use strict';

const ApiError = require('../utils/ApiError');
const plans = require('../config/plans');
const catalogue = require('../config/featureCatalogue');
const subscriptions = require('../modules/subscriptions/subscription.service');
const overrides = require('../modules/featureOverrides/featureOverride.service');

/**
 * Subscription enforcement (V3 §30) and effective entitlement resolution
 * (payments §11B, §11K).
 *
 *   authenticated user -> merchant -> subscription plan
 *                                  -> Super Admin overrides
 *                                  -> effective entitlements
 *                                  -> usage limit -> allow / reject
 *
 * Subscription and overrides are two independent sources that are unioned, per
 * §11B: a feature is available when *either* grants it. An override never
 * touches the subscription, and a subscription never touches an override.
 *
 * These are the checks themselves, with no knowledge of Express, so services
 * can call them at the point a rule actually applies rather than only at the
 * edge. `middleware/subscription.js` wraps them for route-level gating.
 *
 * Every refusal carries the plan the merchant would need, so the UI can render
 * the contextual upgrade prompt from §31 without hard-coding the ladder.
 *
 * This module is the security boundary. What the frontend does with the
 * resolved set is presentation (§11K).
 */

const rupees = (amount) => `₹${amount.toLocaleString('en-IN')}`;

/** A 403 that means "your plan does not include this", not "you may not". */
function upgradeRequired(message, requiredPlan, extra = {}) {
  const error = new ApiError(403, message, undefined, 'PLAN_UPGRADE_REQUIRED');
  error.details = {
    requiredPlan: requiredPlan.key,
    requiredPlanName: requiredPlan.name,
    requiredPlanPrice: requiredPlan.price,
    ...extra,
  };
  return error;
}

/** The refusal for a feature neither the plan nor an override grants. */
function featureRefusal(feature, currentPlan) {
  const required = plans.minimumPlanFor(feature);
  return upgradeRequired(
    `${plans.FEATURE_LABELS[feature] ?? feature} is available with the ${rupees(required.price)} ${required.name} plan.`,
    required,
    { feature, currentPlan },
  );
}

// ---------------------------------------------------------------------------
// Effective entitlements (§11K)

/**
 * Resolves a shop's effective feature set and limits: what the plan gives,
 * plus what a Super Admin has granted on top.
 *
 * Both sources are reported separately as well as merged, so the UI can say
 * *why* a feature is on - "Premium Plan", "Super Admin Grant", or both (§11G).
 */
async function resolve(shopId) {
  const [planKey, overrideKeys] = await Promise.all([
    subscriptions.planKeyForShop(shopId),
    overrides.activeKeysForShop(shopId),
  ]);

  const plan = plans.planFor(planKey);
  const planFeatures = plan.features;

  // A granted key is either a feature flag or a limit lift; only the former
  // belongs in the feature set.
  const overrideFeatures = overrideKeys.filter((key) => !catalogue.limitOverrideFor(key));
  const limitKeys = overrideKeys.filter((key) => catalogue.limitOverrideFor(key));

  const limits = { ...plan.limits };
  for (const key of limitKeys) {
    const entry = catalogue.limitOverrideFor(key);
    // Only ever loosens: an override must not make a paid plan more restrictive.
    if (entry.value === null || limits[entry.limitKey] === null) limits[entry.limitKey] = null;
    else limits[entry.limitKey] = Math.max(limits[entry.limitKey], entry.value);
  }

  return {
    planKey,
    plan,
    planFeatures,
    overrideFeatures,
    overrideLimitKeys: limitKeys,
    features: [...new Set([...planFeatures, ...overrideFeatures])],
    limits,
  };
}

/** Where a feature's availability comes from, for the §11G "Access:" line. */
function accessSourceFor(feature, resolved) {
  const fromPlan = resolved.planFeatures.includes(feature);
  const fromOverride = resolved.overrideFeatures.includes(feature);
  if (fromPlan && fromOverride) return 'plan+override';
  if (fromPlan) return 'plan';
  if (fromOverride) return 'override';
  return null;
}

/** Throws unless the shop is entitled to `feature` by plan or by override. */
async function assertFeature(shopId, feature) {
  const resolved = await resolve(shopId);
  if (resolved.features.includes(feature)) return resolved.planKey;
  throw featureRefusal(feature, resolved.planKey);
}

/** True/false variant, for endpoints that degrade rather than refuse. */
async function hasFeature(shopId, feature) {
  const resolved = await resolve(shopId);
  return resolved.features.includes(feature);
}

/**
 * How each limit is worded in a refusal. Both forms are spelled out rather than
 * derived, because "1 categories" and "1 branchs" are both wrong and there is
 * no rule that gets every noun right.
 */
const LIMIT_LABELS = {
  offersPerMonth: { one: 'one published offer per month', many: 'published offers per month' },
  servicesPerMonth: { one: 'one published service per month', many: 'published services per month' },
  branches: { one: 'a single branch', many: 'branches' },
  categories: { one: 'a single category', many: 'categories' },
  banners: { one: 'one featured banner', many: 'featured banners' },
  exportsPerMonth: { one: 'one export per month', many: 'exports per month' },
};

/** "1 category" / "5 categories" / "no featured banners". */
function allowanceText(limitKey, limit) {
  const label = LIMIT_LABELS[limitKey] ?? { one: limitKey, many: limitKey };
  if (limit === 0) return `no ${label.many}`;
  if (limit === 1) return label.one;
  return `${limit} ${label.many}`;
}

/**
 * Throws when adding one more of `limitKey` would exceed the effective limit.
 * `current` is the count as it stands; the check is for `current + 1`.
 */
async function assertWithinLimit(shopId, limitKey, current) {
  const resolved = await resolve(shopId);
  const limit = resolved.limits[limitKey];
  if (limit === null || current < limit) return;

  const required = plans.minimumPlanForLimit(limitKey, current + 1);
  throw upgradeRequired(
    `Your ${resolved.plan.name} plan includes ${allowanceText(limitKey, limit)}. Upgrade to ${required.name} for more.`,
    required,
    { limit, used: current, limitKey, currentPlan: resolved.planKey },
  );
}

/** Reads the live usage, then checks a limit against it. */
async function assertUsageWithinLimit(shopId, limitKey, usageKey) {
  const usage = await subscriptions.usageForShop(shopId);
  await assertWithinLimit(shopId, limitKey, usage[usageKey]);
}

/** Shop ids among `shopIds` entitled to `feature`, by plan or by override. */
async function filterShopsWithFeature(shopIds, feature) {
  if (!shopIds.length) return [];
  const [planKeys, overrideKeys] = await Promise.all([
    subscriptions.planKeysForShops(shopIds),
    overrides.activeKeysForShops(shopIds),
  ]);

  return shopIds.filter((shopId) => {
    const id = Number(shopId);
    const planFeatures = plans.planFor(planKeys.get(id) ?? 'FREE').features;
    return planFeatures.includes(feature) || (overrideKeys.get(id) ?? []).includes(feature);
  });
}

module.exports = {
  upgradeRequired,
  featureRefusal,
  resolve,
  accessSourceFor,
  assertFeature,
  hasFeature,
  assertWithinLimit,
  assertUsageWithinLimit,
  allowanceText,
  filterShopsWithFeature,
};
