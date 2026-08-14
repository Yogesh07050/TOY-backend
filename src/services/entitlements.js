'use strict';

const ApiError = require('../utils/ApiError');
const plans = require('../config/plans');
const subscriptions = require('../modules/subscriptions/subscription.service');

/**
 * Subscription enforcement (V3 §30).
 *
 *   authenticated user -> merchant -> subscription plan -> feature permission
 *   -> usage limit -> allow / reject
 *
 * These are the checks themselves, with no knowledge of Express, so services
 * can call them at the point a rule actually applies rather than only at the
 * edge. `middleware/subscription.js` wraps them for route-level gating.
 *
 * Every refusal carries the plan the merchant would need, so the UI can render
 * the contextual upgrade prompt from §31 without hard-coding the ladder.
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

/** The refusal for a feature the plan does not include. */
function featureRefusal(feature, currentPlan) {
  const required = plans.minimumPlanFor(feature);
  return upgradeRequired(
    `${plans.FEATURE_LABELS[feature] ?? feature} is available with the ${rupees(required.price)} ${required.name} plan.`,
    required,
    { feature, currentPlan },
  );
}

/** Throws unless the shop's plan includes `feature`. */
async function assertFeature(shopId, feature) {
  const planKey = await subscriptions.planKeyForShop(shopId);
  if (plans.planFor(planKey).features.includes(feature)) return planKey;
  throw featureRefusal(feature, planKey);
}

/** True/false variant, for endpoints that degrade rather than refuse. */
async function hasFeature(shopId, feature) {
  const planKey = await subscriptions.planKeyForShop(shopId);
  return plans.planFor(planKey).features.includes(feature);
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
 * Throws when adding one more of `limitKey` would exceed the plan.
 * `current` is the count as it stands; the check is for `current + 1`.
 */
async function assertWithinLimit(shopId, limitKey, current) {
  const planKey = await subscriptions.planKeyForShop(shopId);
  const plan = plans.planFor(planKey);
  const limit = plan.limits[limitKey];
  if (limit === null || current < limit) return;

  const required = plans.minimumPlanForLimit(limitKey, current + 1);
  throw upgradeRequired(
    `Your ${plan.name} plan includes ${allowanceText(limitKey, limit)}. Upgrade to ${required.name} for more.`,
    required,
    { limit, used: current, limitKey, currentPlan: planKey },
  );
}

/** Reads the live usage, then checks a limit against it. */
async function assertUsageWithinLimit(shopId, limitKey, usageKey) {
  const usage = await subscriptions.usageForShop(shopId);
  await assertWithinLimit(shopId, limitKey, usage[usageKey]);
}

/** Shop ids among `shopIds` whose plan includes `feature`. */
async function filterShopsWithFeature(shopIds, feature) {
  const planKeys = await subscriptions.planKeysForShops(shopIds);
  return shopIds.filter((shopId) =>
    plans.planFor(planKeys.get(Number(shopId)) ?? 'FREE').features.includes(feature),
  );
}

module.exports = {
  upgradeRequired,
  featureRefusal,
  assertFeature,
  hasFeature,
  assertWithinLimit,
  assertUsageWithinLimit,
  allowanceText,
  filterShopsWithFeature,
};
