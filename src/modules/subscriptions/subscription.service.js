'use strict';

const { query, queryOne, execute, rawQuery } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const plans = require('../../config/plans');

/**
 * Merchant subscriptions (V3 §2, §38).
 *
 * Every shop has exactly one row in `shop_subscriptions`. It is created lazily
 * on first read so a shop created before V3 - or by a code path that forgot to
 * insert one - still resolves to Free rather than throwing.
 */

/** Billing period key for usage counters, e.g. "2026-08". */
function currentPeriod(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** One month from `from`, which is what "monthly" renewal means here. */
function nextRenewal(from, cycle = 'monthly') {
  const next = new Date(from);
  if (cycle === 'yearly') next.setFullYear(next.getFullYear() + 1);
  else next.setMonth(next.getMonth() + 1);
  return next;
}

function mapSubscription(row) {
  const plan = plans.planFor(row.plan);
  return {
    shopId: Number(row.shop_id),
    plan: plan.key,
    planName: plan.name,
    tagline: plan.tagline,
    price: Number(row.price_amount),
    currency: row.currency,
    status: row.status,
    billingCycle: row.billing_cycle,
    paymentStatus: row.payment_status,
    startedAt: row.started_at,
    renewsAt: row.renews_at,
    cancelledAt: row.cancelled_at,
    limits: plan.limits,
    features: plan.features,
    profile: plan.profile,
    visibility: plan.visibility,
  };
}

/** Reads the shop's subscription, creating the default Free row if absent. */
async function getForShop(shopId) {
  const existing = await queryOne('SELECT * FROM shop_subscriptions WHERE shop_id = ?', [shopId]);
  if (existing) return mapSubscription(existing);

  const shop = await queryOne('SELECT id FROM shops WHERE id = ?', [shopId]);
  if (!shop) throw ApiError.notFound('Shop not found');

  await execute(
    `INSERT INTO shop_subscriptions (shop_id, plan, status, price_amount, payment_status)
     VALUES (?, 'FREE', 'active', 0.00, 'not_required')
     ON DUPLICATE KEY UPDATE shop_id = VALUES(shop_id)`,
    [shopId],
  );
  const created = await queryOne('SELECT * FROM shop_subscriptions WHERE shop_id = ?', [shopId]);
  return mapSubscription(created);
}

/** Plan key only - the hot path for feature checks, so it stays a single row read. */
async function planKeyForShop(shopId) {
  const row = await queryOne('SELECT plan, status FROM shop_subscriptions WHERE shop_id = ?', [shopId]);
  if (!row) return 'FREE';
  // A lapsed subscription falls back to Free rather than keeping paid features.
  return row.status === 'active' ? row.plan : 'FREE';
}

/**
 * Live usage against the plan limits.
 *
 * Offers, branches and categories are counted from the source tables rather
 * than the usage counters, so the limit cannot be bypassed by a counter that
 * drifted. `subscription_usage` remains the audit trail of what was published.
 */
async function usageForShop(shopId, period = currentPeriod()) {
  const [start, end] = periodBounds(period);

  const [offers, services, branches, categories, banners, counters] = await Promise.all([
    queryOne(
      `SELECT COUNT(*) AS count FROM offers
        WHERE shop_id = ? AND status <> 'draft' AND created_at >= ? AND created_at < ?`,
      [shopId, start, end],
    ),
    queryOne(
      `SELECT COUNT(*) AS count FROM services
        WHERE shop_id = ? AND status <> 'draft' AND created_at >= ? AND created_at < ?`,
      [shopId, start, end],
    ),
    queryOne("SELECT COUNT(*) AS count FROM shop_branches WHERE shop_id = ? AND status = 'active'", [
      shopId,
    ]),
    queryOne('SELECT COUNT(*) AS count FROM shop_categories WHERE shop_id = ?', [shopId]),
    queryOne(
      `SELECT COUNT(*) AS count FROM banners b JOIN offers o ON o.id = b.offer_id
        WHERE o.shop_id = ? AND b.status <> 'deactivated'`,
      [shopId],
    ),
    queryOne('SELECT * FROM subscription_usage WHERE shop_id = ? AND period = ?', [shopId, period]),
  ]);

  return {
    period,
    offersThisMonth: Number(offers.count),
    servicesThisMonth: Number(services.count),
    branches: Number(branches.count),
    categories: Number(categories.count),
    banners: Number(banners.count),
    exportsThisMonth: Number(counters?.exports_generated ?? 0),
  };
}

/** [inclusive start, exclusive end) of a "YYYY-MM" period, in UTC. */
function periodBounds(period) {
  const [year, month] = period.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return [start, end];
}

/** Increments a usage counter for the current period. */
async function recordUsage(shopId, column, amount = 1) {
  const allowed = ['offers_published', 'banners_published', 'exports_generated'];
  if (!allowed.includes(column)) throw new Error(`Unknown usage counter: ${column}`);

  await execute(
    `INSERT INTO subscription_usage (shop_id, period, ${column}) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE ${column} = ${column} + VALUES(${column})`,
    [shopId, currentPeriod(), amount],
  );
}

/**
 * Everything a client needs to render plan-aware UI in one call: the plan, its
 * feature list, the limits and how much of each has been used.
 */
async function entitlements(shopId) {
  const [subscription, usage] = await Promise.all([getForShop(shopId), usageForShop(shopId)]);
  const limits = subscription.limits;

  const remaining = (limit, used) => (limit === null ? null : Math.max(limit - used, 0));

  return {
    ...subscription,
    usage,
    remaining: {
      offersThisMonth: remaining(limits.offersPerMonth, usage.offersThisMonth),
      servicesThisMonth: remaining(limits.servicesPerMonth, usage.servicesThisMonth),
      branches: remaining(limits.branches, usage.branches),
      categories: remaining(limits.categories, usage.categories),
      banners: remaining(limits.banners, usage.banners),
    },
  };
}

/**
 * Moves a shop onto a different plan (§31). Billing itself is delegated to the
 * payment provider; this records the intent, the amount and the history so the
 * provider integration only has to flip `payment_status`.
 */
async function changePlan(shopId, planKey, user, { billingCycle = 'monthly', note } = {}) {
  if (!plans.PLAN_KEYS.includes(planKey)) throw ApiError.badRequest('Unknown subscription plan');

  const current = await getForShop(shopId);
  if (current.plan === planKey && current.status === 'active') return entitlements(shopId);

  const target = plans.planFor(planKey);
  const now = new Date();
  const action =
    current.plan === planKey
      ? 'reactivated'
      : target.rank > plans.planFor(current.plan).rank
        ? 'upgraded'
        : 'downgraded';

  await execute(
    `UPDATE shop_subscriptions
        SET plan = ?, status = 'active', billing_cycle = ?, price_amount = ?,
            payment_status = ?, started_at = ?, renews_at = ?, cancelled_at = NULL
      WHERE shop_id = ?`,
    [
      planKey,
      billingCycle,
      target.price,
      // A paid plan starts as pending until the provider confirms; Free needs
      // no payment at all.
      target.price > 0 ? 'pending' : 'not_required',
      now,
      target.price > 0 ? nextRenewal(now, billingCycle) : null,
      shopId,
    ],
  );

  await execute(
    `INSERT INTO subscription_events (shop_id, from_plan, to_plan, action, amount, actor_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [shopId, current.plan, planKey, action, target.price, user?.id ?? null, note ?? null],
  );

  return entitlements(shopId);
}

/** Marks the current billing period as paid - the hook a provider webhook calls. */
async function markPaid(shopId, { provider = null, providerRef = null } = {}) {
  const subscription = await getForShop(shopId);
  await execute(
    `UPDATE shop_subscriptions
        SET payment_status = 'paid', status = 'active', renews_at = ?, provider = ?, provider_ref = ?
      WHERE shop_id = ?`,
    [nextRenewal(new Date(), subscription.billingCycle), provider, providerRef, shopId],
  );
  await execute(
    `INSERT INTO subscription_events (shop_id, from_plan, to_plan, action, amount)
     VALUES (?, ?, ?, 'renewed', ?)`,
    [shopId, subscription.plan, subscription.plan, subscription.price],
  );
  return getForShop(shopId);
}

/** Cancels at the end of the paid period; entitlements drop to Free on expiry. */
async function cancel(shopId, user, note) {
  const subscription = await getForShop(shopId);
  if (subscription.plan === 'FREE') throw ApiError.badRequest('The Free plan cannot be cancelled');

  await execute(
    `UPDATE shop_subscriptions SET status = 'cancelled', cancelled_at = NOW() WHERE shop_id = ?`,
    [shopId],
  );
  await execute(
    `INSERT INTO subscription_events (shop_id, from_plan, to_plan, action, amount, actor_id, note)
     VALUES (?, ?, 'FREE', 'cancelled', 0, ?, ?)`,
    [shopId, subscription.plan, user?.id ?? null, note ?? null],
  );
  return entitlements(shopId);
}

async function history(shopId, limit = 50) {
  const rows = await rawQuery(
    `SELECT e.*, u.name AS actor_name FROM subscription_events e
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.shop_id = ? ORDER BY e.created_at DESC LIMIT ${Number(limit)}`,
    [shopId],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    fromPlan: row.from_plan,
    toPlan: row.to_plan,
    action: row.action,
    amount: Number(row.amount),
    note: row.note,
    actorName: row.actor_name,
    createdAt: row.created_at,
  }));
}

/** Invoice-shaped view of the plan history, for the Billing screen (§32). */
async function invoices(shopId, limit = 24) {
  const rows = await rawQuery(
    `SELECT e.id, e.to_plan, e.action, e.amount, e.created_at
       FROM subscription_events e
      WHERE e.shop_id = ? AND e.amount > 0 AND e.action IN ('upgraded','renewed','reactivated')
      ORDER BY e.created_at DESC LIMIT ${Number(limit)}`,
    [shopId],
  );
  const subscription = await getForShop(shopId);

  return rows.map((row) => ({
    id: Number(row.id),
    reference: `INV-${String(row.id).padStart(6, '0')}`,
    plan: row.to_plan,
    description: `${plans.planFor(row.to_plan).name} plan - ${row.action}`,
    amount: Number(row.amount),
    currency: subscription.currency,
    // The row only exists once the change was applied; payment state lives on
    // the subscription, so a pending payment shows as pending on its invoice.
    status: subscription.paymentStatus === 'paid' ? 'paid' : subscription.paymentStatus,
    issuedAt: row.created_at,
  }));
}

/** Plan keys for many shops at once, used by list endpoints to avoid N+1 reads. */
async function planKeysForShops(shopIds) {
  if (!shopIds.length) return new Map();
  const rows = await query(
    `SELECT shop_id, plan, status FROM shop_subscriptions
      WHERE shop_id IN (${shopIds.map(() => '?').join(',')})`,
    shopIds,
  );
  return new Map(
    rows.map((row) => [Number(row.shop_id), row.status === 'active' ? row.plan : 'FREE']),
  );
}

module.exports = {
  currentPeriod,
  getForShop,
  planKeyForShop,
  planKeysForShops,
  usageForShop,
  recordUsage,
  entitlements,
  changePlan,
  markPaid,
  cancel,
  history,
  invoices,
};
