'use strict';

const { query, queryOne } = require('../db/pool');
const ApiError = require('../utils/ApiError');
const billing = require('../modules/subscriptions/subscription.service');
const {
  AI_FEATURES,
  FEATURE_COLUMNS,
  FREE_PLAN_CODE,
  PREMIUM_ONLY_SECTIONS,
} = require('../config/aiFeatures');

/**
 * Subscription resolution and AI quota enforcement (§3, §32).
 *
 * Every check here runs on the server. The Angular app asks for the same
 * information to decide what to show, but showing a button has never been the
 * access decision - `assertFeatureAllowed` is.
 */

const mapPlan = (row) => ({
  id: Number(row.id),
  code: row.code,
  name: row.name,
  description: row.description,
  priceMonthly: Number(row.price_monthly),
  currency: row.currency,
  aiAssistantEnabled: Boolean(row.ai_assistant_enabled),
  aiContentEnabled: Boolean(row.ai_content_enabled),
  aiOptimizerEnabled: Boolean(row.ai_optimizer_enabled),
  historicalInsights: Boolean(row.historical_insights),
  locationInsights: Boolean(row.location_insights),
  timingInsights: Boolean(row.timing_insights),
  socialCaptionEnabled: Boolean(row.social_caption_enabled),
  // NULL survives as null all the way to the client, where it reads "unlimited".
  aiAssistantMonthlyLimit: row.ai_assistant_monthly_limit === null ? null : Number(row.ai_assistant_monthly_limit),
  aiContentMonthlyLimit: row.ai_content_monthly_limit === null ? null : Number(row.ai_content_monthly_limit),
  aiOptimizerMonthlyLimit: row.ai_optimizer_monthly_limit === null ? null : Number(row.ai_optimizer_monthly_limit),
  displayOrder: Number(row.display_order),
  isSystem: Boolean(row.is_system),
  status: row.status,
});

async function listPlans({ includeInactive = false } = {}) {
  const rows = await query(
    `SELECT * FROM subscription_plans
      ${includeInactive ? '' : "WHERE status = 'active'"}
      ORDER BY display_order, price_monthly`,
  );
  return rows.map(mapPlan);
}

async function getPlanById(id) {
  const row = await queryOne('SELECT * FROM subscription_plans WHERE id = ?', [id]);
  return row ? mapPlan(row) : null;
}

async function getPlanByCode(code) {
  const row = await queryOne('SELECT * FROM subscription_plans WHERE code = ?', [code]);
  return row ? mapPlan(row) : null;
}

/**
 * The plan a shop is actually on right now, and what it unlocks in the AI layer.
 *
 * Which plan a shop is on is *not* decided here. `shop_subscriptions` is the
 * billing record - it carries the Razorpay state, the grace window and the
 * period boundaries - and `subscription.service.planKeyForShop` is what reads
 * it, applying the entitlement rules from §10 and §13 (a failed payment inside
 * its grace window keeps its features; a lapsed one does not). Reimplementing
 * that here would give the AI layer a second, quietly different answer to
 * "what is this shop paying for".
 *
 * So this asks that question of the billing module and only then looks up what
 * the resulting plan *code* unlocks, joining `subscription_plans` on `code`
 * rather than by foreign key. The two tables stay independent: a Super Admin
 * can retune AI limits without touching a subscription, and a plan change made
 * through billing is reflected here on the next call with nothing to sync.
 */
async function resolveShopPlan(shopId) {
  const planKey = await billing.planKeyForShop(shopId);

  const plan = await getPlanByCode(planKey);
  if (plan) {
    return {
      plan,
      source: planKey === FREE_PLAN_CODE ? 'default' : 'subscription',
      startedAt: null,
      expiresAt: null,
    };
  }

  // The billing module named a plan that has no AI entitlement row. Fail closed
  // on Free rather than open on whatever the caller asked for.
  const free = await getPlanByCode(FREE_PLAN_CODE);
  if (!free) {
    // Only reachable if the seeder never ran; fail closed rather than open.
    throw ApiError.badRequest(
      'No subscription plans are configured. Run the database seeder.',
    );
  }
  return { plan: free, source: 'default', startedAt: null, expiresAt: null };
}

async function getShopSubscription(shopId) {
  const resolved = await resolveShopPlan(shopId);
  const shop = await queryOne('SELECT id, name, slug FROM shops WHERE id = ?', [shopId]);
  return {
    shop: shop ? { id: Number(shop.id), name: shop.name, slug: shop.slug } : null,
    plan: resolved.plan,
    source: resolved.source,
    startedAt: resolved.startedAt,
    expiresAt: resolved.expiresAt,
  };
}

/*
 * `setShopPlan` used to live here and wrote `shop_subscriptions.plan_id`.
 * Assigning a shop to a plan is a billing operation - it can start a charge,
 * schedule a downgrade or end a mandate - so it belongs to
 * `subscriptions/subscription.service.js` and its `/api/subscriptions` routes.
 * Having a second writer here is what would let the two records drift apart.
 */

 // ---------------------------------------------------------------------------
// Quotas
// ---------------------------------------------------------------------------

/** First instant of the current calendar month, in server time. */
function monthStart(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}

/** Successful generations this month. Failures never cost a merchant a credit. */
async function usageThisMonth(shopId, feature) {
  const row = await queryOne(
    `SELECT COUNT(*) AS used FROM ai_usage
      WHERE shop_id = ? AND feature = ? AND status = 'success' AND created_at >= ?`,
    [shopId, feature, monthStart()],
  );
  return Number(row?.used ?? 0);
}

function limitFor(plan, feature) {
  const column = FEATURE_COLUMNS[feature];
  if (!column) return 0;
  const key = {
    ai_assistant_monthly_limit: 'aiAssistantMonthlyLimit',
    ai_content_monthly_limit: 'aiContentMonthlyLimit',
    ai_optimizer_monthly_limit: 'aiOptimizerMonthlyLimit',
  }[column.limit];
  return plan[key];
}

function enabledFor(plan, feature) {
  const column = FEATURE_COLUMNS[feature];
  if (!column) return false;
  const key = {
    ai_assistant_enabled: 'aiAssistantEnabled',
    ai_content_enabled: 'aiContentEnabled',
    ai_optimizer_enabled: 'aiOptimizerEnabled',
  }[column.enabled];
  return Boolean(plan[key]);
}

/**
 * Everything the UI needs to describe one feature's availability, and what
 * `assertFeatureAllowed` decides from.
 */
async function featureStatus(shopId, feature, plan = null) {
  const resolved = plan ?? (await resolveShopPlan(shopId)).plan;
  const limit = limitFor(resolved, feature);
  const enabled = enabledFor(resolved, feature);
  const used = enabled ? await usageThisMonth(shopId, feature) : 0;

  // A limit of 0 is "off", null is "unlimited".
  const unlimited = enabled && limit === null;
  const remaining = unlimited ? null : Math.max(0, (limit ?? 0) - used);

  return {
    feature,
    label: FEATURE_COLUMNS[feature]?.label ?? feature,
    enabled: enabled && (unlimited || (limit ?? 0) > 0),
    limit: unlimited ? null : limit ?? 0,
    used,
    remaining,
    unlimited,
    exhausted: enabled && !unlimited && remaining === 0,
  };
}

/**
 * Throws unless the shop's plan currently allows one more use of `feature`.
 * §40: "Enforce subscription limits server-side."
 */
async function assertFeatureAllowed(shopId, feature) {
  const { plan } = await resolveShopPlan(shopId);
  const status = await featureStatus(shopId, feature, plan);

  if (!status.enabled) {
    throw new ApiError(
      403,
      `${status.label} is not included in your ${plan.name} plan.`,
      { feature, planCode: plan.code, planName: plan.name },
      'PLAN_UPGRADE_REQUIRED',
    );
  }

  if (status.exhausted) {
    throw new ApiError(
      429,
      `You have used all ${status.limit} ${status.label} generations included in your ${plan.name} plan this month.`,
      { feature, planCode: plan.code, limit: status.limit, used: status.used },
      'AI_LIMIT_REACHED',
    );
  }

  return { plan, status };
}

/** Content sections this plan may generate (§22 keeps social captions Premium). */
function allowedSections(plan, requested) {
  return requested.filter(
    (section) => plan.socialCaptionEnabled || !PREMIUM_ONLY_SECTIONS.includes(section),
  );
}

/** The whole AI picture for one shop - what the Angular app reads on load. */
async function capabilitiesFor(shopId) {
  const resolved = await resolveShopPlan(shopId);
  const features = await Promise.all(
    Object.values(AI_FEATURES).map((feature) => featureStatus(shopId, feature, resolved.plan)),
  );

  return {
    shopId: Number(shopId),
    plan: resolved.plan,
    planSource: resolved.source,
    expiresAt: resolved.expiresAt,
    features: Object.fromEntries(features.map((status) => [status.feature, status])),
    insights: {
      historical: resolved.plan.historicalInsights,
      location: resolved.plan.locationInsights,
      timing: resolved.plan.timingInsights,
    },
    sections: {
      socialCaption: resolved.plan.socialCaptionEnabled,
    },
  };
}

module.exports = {
  mapPlan,
  listPlans,
  getPlanById,
  getPlanByCode,
  resolveShopPlan,
  getShopSubscription,
  usageThisMonth,
  featureStatus,
  assertFeatureAllowed,
  allowedSections,
  capabilitiesFor,
  monthStart,
};
