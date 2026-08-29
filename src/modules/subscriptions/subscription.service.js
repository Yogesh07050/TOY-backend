'use strict';

const { query, queryOne, execute, rawQuery } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const plans = require('../../config/plans');
const env = require('../../config/env');

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

/**
 * Whether the row's *billing* state still entitles the shop to its paid plan.
 *
 * Three states keep the features on (§10, §13):
 *   active               - paid and current
 *   past_due, in grace   - a renewal failed but the grace window is open
 *   cancelled, period    - cancelled, but the period already paid for runs on
 *                          remaining
 */
function isEntitled(row) {
  if (!row) return false;
  const now = new Date();
  if (row.status === 'active') return true;
  if (row.status === 'past_due') return Boolean(row.grace_until) && new Date(row.grace_until) > now;
  if (row.status === 'cancelled') {
    const until = row.current_period_end ?? row.renews_at;
    return Boolean(until) && new Date(until) > now;
  }
  return false;
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
    // ---- Gateway / billing state (§14) ----
    gateway: row.gateway ?? null,
    gatewaySubscriptionId: row.gateway_subscription_id ?? null,
    gatewayCustomerId: row.gateway_customer_id ?? null,
    currentPeriodStart: row.current_period_start ?? null,
    currentPeriodEnd: row.current_period_end ?? null,
    nextBillingDate: row.renews_at ?? null,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    /** Plan that takes effect when the current paid period ends (§12). */
    pendingPlan: row.pending_plan ?? null,
    /** Plan a checkout is in flight for; applied only once payment lands (§7). */
    checkoutPlan: row.checkout_plan ?? null,
    graceUntil: row.grace_until ?? null,
    autopayEnabled: Boolean(row.autopay_enabled),
    paymentMethod: row.payment_method ?? null,
    lastPaymentAt: row.last_payment_at ?? null,
    lastFailureReason: row.last_failure_reason ?? null,
    /** True when the paid features are currently in force. */
    entitled: isEntitled(row),
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
  const row = await queryOne(
    `SELECT plan, status, grace_until, current_period_end, renews_at
       FROM shop_subscriptions WHERE shop_id = ?`,
    [shopId],
  );
  if (!row) return 'FREE';
  // A lapsed subscription falls back to Free rather than keeping paid features;
  // a failed payment inside its grace window, or a cancellation with paid time
  // left on it, does not (§10, §13).
  return isEntitled(row) ? row.plan : 'FREE';
}

/**
 * The per-period usage counters that gate a create, and the query behind each.
 *
 * Kept as a map rather than inlined into `usageForShop` so the same count can
 * be re-run on a transaction's own connection - which is what stops two
 * simultaneous creates from both passing a one-per-month limit (§24).
 */
const MONTHLY_USAGE_SQL = {
  offersThisMonth: `SELECT COUNT(*) AS count FROM offers
                     WHERE shop_id = ? AND status <> 'draft' AND created_at >= ? AND created_at < ?`,
  servicesThisMonth: `SELECT COUNT(*) AS count FROM services
                       WHERE shop_id = ? AND status <> 'draft' AND created_at >= ? AND created_at < ?`,
};

/**
 * One monthly usage counter, read on a caller-supplied connection.
 *
 * `usageForShop` reads through the pool, which is right for a dashboard but
 * wrong for a limit check: a count taken on another connection cannot see the
 * uncommitted row of the transaction it is meant to be guarding. Callers pass
 * their own transaction connection here so the count and the insert it gates
 * are the same unit of work (§24).
 */
async function countMonthlyUsage(connection, shopId, usageKey, period = currentPeriod()) {
  const sql = MONTHLY_USAGE_SQL[usageKey];
  if (!sql) throw new Error(`No monthly usage query defined for "${usageKey}"`);
  const [start, end] = periodBounds(period);
  const [rows] = await connection.execute(sql, [shopId, start, end]);
  return Number(rows[0]?.count ?? 0);
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
 * Everything a client needs to render plan-aware UI in one call: the plan, the
 * *effective* feature list and limits (plan + Super Admin overrides), and how
 * much of each allowance has been used.
 *
 * `features` is the merged set the server enforces (§11K); `planFeatures` and
 * `specialAccess` are reported alongside it so the merchant UI can explain why
 * a feature is available and when a grant expires (§11G, §11N).
 *
 * The resolver is required lazily: it reads subscriptions, so requiring it at
 * module load would close a cycle back into this file.
 */
async function entitlements(shopId) {
  // eslint-disable-next-line global-require
  const resolver = require('../../services/entitlements');
  const overrides = require('../featureOverrides/featureOverride.service');

  const [subscription, usage, resolved, specialAccess] = await Promise.all([
    getForShop(shopId),
    usageForShop(shopId),
    resolver.resolve(shopId),
    overrides.activeForShop(shopId),
  ]);

  const limits = resolved.limits;
  const remaining = (limit, used) => (limit === null ? null : Math.max(limit - used, 0));

  return {
    ...subscription,
    // Effective, not plan-only: an override widens both of these.
    features: resolved.features,
    limits,
    planFeatures: resolved.planFeatures,
    overrideFeatures: resolved.overrideFeatures,
    /** Active Super Admin grants, with their expiry, for the §11N panel. */
    specialAccess,
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
 * Moves a shop onto a different plan (§31, §12).
 *
 * This records the *intent*. A paid plan lands in `created`/`pending` and
 * unlocks nothing: only a verified gateway event may set it `active` (§7).
 * `activate()` below is the sole path to that, and it is reachable only from
 * the webhook handler.
 */
async function changePlan(shopId, planKey, user, { billingCycle = 'monthly', note } = {}) {
  if (!plans.PLAN_KEYS.includes(planKey)) throw ApiError.badRequest('Unknown subscription plan');

  const current = await getForShop(shopId);
  if (current.plan === planKey && current.status === 'active') return entitlements(shopId);

  const target = plans.planFor(planKey);
  const action =
    current.plan === planKey
      ? 'reactivated'
      : target.rank > plans.planFor(current.plan).rank
        ? 'upgraded'
        : 'downgraded';

  const paid = target.price > 0;

  const interval = billingCycle === 'yearly' ? 'INTERVAL 1 YEAR' : 'INTERVAL 1 MONTH';

  await execute(
    `UPDATE shop_subscriptions
        SET plan = ?, status = ?, billing_cycle = ?, price_amount = ?,
            payment_status = ?, started_at = NOW(),
            renews_at = ${paid ? `DATE_ADD(NOW(), ${interval})` : 'NULL'},
            cancelled_at = NULL, pending_plan = NULL, checkout_plan = NULL,
            cancel_at_period_end = 0, grace_until = NULL, last_failure_reason = NULL
      WHERE shop_id = ?`,
    [
      planKey,
      // §7: a paid plan is not active until the gateway says it is paid.
      paid ? 'created' : 'active',
      billingCycle,
      target.price,
      paid ? 'pending' : 'not_required',
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

/**
 * Schedules a downgrade for the end of the paid period (§12).
 *
 * The merchant keeps what they paid for until the period ends; a nightly job
 * applies the pending plan once `current_period_end` passes. Dropping to Free
 * immediately would take away time already bought.
 */
async function scheduleDowngrade(shopId, planKey, user, note) {
  if (!plans.PLAN_KEYS.includes(planKey)) throw ApiError.badRequest('Unknown subscription plan');

  const current = await getForShop(shopId);
  if (plans.planFor(planKey).rank >= plans.planFor(current.plan).rank) {
    throw ApiError.badRequest('That is not a downgrade. Use checkout to move to a higher plan.');
  }

  const periodEnd = current.currentPeriodEnd ?? current.renewsAt;
  const hasPaidTimeLeft = current.entitled && periodEnd && new Date(periodEnd) > new Date();

  if (!hasPaidTimeLeft) return changePlan(shopId, planKey, user, { note });

  await execute(
    `UPDATE shop_subscriptions SET cancel_at_period_end = 1, pending_plan = ? WHERE shop_id = ?`,
    [planKey, shopId],
  );
  await execute(
    `INSERT INTO subscription_events (shop_id, from_plan, to_plan, action, amount, actor_id, note)
     VALUES (?, ?, ?, 'downgraded', 0, ?, ?)`,
    [shopId, current.plan, planKey, user?.id ?? null, note ?? `Scheduled for ${periodEnd}`],
  );

  return entitlements(shopId);
}

/**
 * Records that a purchase is in flight, without touching entitlements (§12).
 *
 * The target plan is parked in `checkout_plan`; `activate()` applies it when
 * the gateway confirms payment (§7). Writing it straight to `plan` would drop
 * the merchant onto an unpaid `created` row and revoke the plan they are
 * currently paying for the moment they opened checkout.
 *
 * A shop with no live paid plan has nothing to lose, so it is additionally
 * moved to `created`/`pending` - that is what lets the UI show the purchase as
 * in flight. Either way no feature is unlocked before payment.
 */
async function recordCheckoutIntent(shopId, planKey, { billingCycle = 'monthly' } = {}) {
  if (!plans.PLAN_KEYS.includes(planKey)) throw ApiError.badRequest('Unknown subscription plan');

  const current = await getForShop(shopId);
  const keepCurrent = current.entitled && current.price > 0;

  await execute(
    `UPDATE shop_subscriptions
        SET checkout_plan = ?, billing_cycle = ?
            ${keepCurrent ? '' : ", status = 'created', payment_status = 'pending'"}
      WHERE shop_id = ?`,
    [planKey, billingCycle, shopId],
  );

  return getForShop(shopId);
}

/** Records the gateway identifiers a checkout produced, before any money moves. */
async function attachGateway(shopId, { gateway = 'razorpay', customerId, subscriptionId, planId }) {
  await execute(
    `UPDATE shop_subscriptions
        SET gateway = ?, gateway_customer_id = COALESCE(?, gateway_customer_id),
            gateway_subscription_id = COALESCE(?, gateway_subscription_id),
            gateway_plan_id = COALESCE(?, gateway_plan_id)
      WHERE shop_id = ?`,
    [gateway, customerId ?? null, subscriptionId ?? null, planId ?? null, shopId],
  );
}

/** The shop a gateway subscription belongs to, for webhook routing. */
async function findByGatewaySubscriptionId(subscriptionId) {
  const row = await queryOne('SELECT * FROM shop_subscriptions WHERE gateway_subscription_id = ?', [
    subscriptionId,
  ]);
  return row ? mapSubscription(row) : null;
}

/**
 * Activates (or renews) a subscription. **Only the verified webhook handler
 * may call this** - it is the single write that turns paid features on (§7).
 */
async function activate(
  shopId,
  {
    periodStart,
    periodEnd,
    paymentMethod,
    autopay,
    amount,
    // A Super Admin grant reaches this through `grantPlan` rather than a
    // webhook, and the history should say so: who did it, why, and that no
    // payment was taken. Webhook callers pass none of these and behave exactly
    // as before.
    actorId = null,
    note = null,
    paymentStatus = 'paid',
  } = {},
) {
  const subscription = await getForShop(shopId);
  // The plan a checkout was started for is applied *here*, on confirmed
  // payment, and nowhere else (§7). Without one in flight this is a renewal of
  // the plan already held.
  const targetPlan = subscription.checkoutPlan ?? subscription.plan;
  const target = plans.planFor(targetPlan);
  const isUpgrade = targetPlan !== subscription.plan;

  // Razorpay tells us the period when it knows it. When it does not, the
  // database stamps it: every "is this still current" check compares against
  // NOW(), so the two dates have to come from the same clock.
  const interval = subscription.billingCycle === 'yearly' ? 'INTERVAL 1 YEAR' : 'INTERVAL 1 MONTH';

  await execute(
    `UPDATE shop_subscriptions
        SET plan = ?, price_amount = ?, checkout_plan = NULL,
            status = 'active', payment_status = ?,
            current_period_start = COALESCE(?, NOW()),
            current_period_end = COALESCE(?, DATE_ADD(NOW(), ${interval})),
            renews_at = COALESCE(?, DATE_ADD(NOW(), ${interval})),
            grace_until = NULL, last_failure_reason = NULL, last_payment_at = NOW(),
            cancelled_at = NULL, cancel_at_period_end = 0, pending_plan = NULL,
            payment_method = COALESCE(?, payment_method),
            autopay_enabled = COALESCE(?, autopay_enabled)
      WHERE shop_id = ?`,
    [
      targetPlan,
      target.price,
      paymentStatus,
      periodStart ?? null,
      periodEnd ?? null,
      periodEnd ?? null,
      paymentMethod ?? null,
      autopay === undefined ? null : autopay ? 1 : 0,
      shopId,
    ],
  );

  await execute(
    `INSERT INTO subscription_events (shop_id, from_plan, to_plan, action, amount, actor_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      shopId,
      subscription.plan,
      targetPlan,
      isUpgrade ? 'upgraded' : 'renewed',
      amount ?? target.price,
      actorId,
      note,
    ],
  );

  return getForShop(shopId);
}

/**
 * Puts a shop on a paid plan without a payment. **Super Admin only** - the
 * route enforces that.
 *
 * This exists because every other way onto a paid plan runs through Razorpay:
 * `startCheckout` refuses when no credentials are configured, and `activate`
 * only ever applies a plan a checkout already put in flight. On a staging box,
 * a fresh clone, or any deployment without live keys, that left no way at all
 * to provision Business or Premium - including for the AI entitlements, which
 * read the plan code and nothing else.
 *
 * It deliberately reuses the normal activation path rather than writing the
 * plan directly, so a granted subscription is shaped exactly like a purchased
 * one: same period dates, same status, same history row. The only differences
 * are the ones that would be a lie otherwise - the amount is zero, the payment
 * status is `not_required` rather than `paid`, and the event carries the
 * Super Admin who did it and their reason.
 *
 * Downgrades to Free are not handled here; they belong to `scheduleDowngrade`,
 * which honours the period the merchant already paid for (§12).
 */
async function grantPlan(shopId, planKey, user, { billingCycle = 'monthly', note } = {}) {
  if (!plans.PLAN_KEYS.includes(planKey)) throw ApiError.badRequest('Unknown subscription plan');

  const plan = plans.planFor(planKey);
  if (plan.price <= 0) {
    throw ApiError.badRequest('Use the plan change endpoint to move a shop to Free.');
  }

  // Park the target on the row the way a checkout would, so `activate` applies
  // it through its normal "the plan a checkout was started for" path.
  await recordCheckoutIntent(shopId, planKey, { billingCycle });

  return activate(shopId, {
    amount: 0,
    paymentMethod: 'manual-grant',
    autopay: false,
    paymentStatus: 'not_required',
    actorId: user?.id ?? null,
    note: note ?? `Granted by ${user?.name ?? 'a Super Admin'} without a charge`,
  });
}

/**
 * A renewal failed (§10). The plan is not taken away: the shop goes PAST_DUE
 * with a configurable grace window, and only stays there until the retry
 * succeeds or the window closes.
 */
async function markPastDue(shopId, { reason = null, graceDays = env.billing.graceDays } = {}) {
  const subscription = await getForShop(shopId);
  const days = Number.isFinite(Number(graceDays)) ? Math.max(0, Math.trunc(graceDays)) : 5;

  await execute(
    `UPDATE shop_subscriptions
        SET status = 'past_due', payment_status = 'failed',
            grace_until = COALESCE(grace_until, DATE_ADD(NOW(), INTERVAL ${days} DAY)),
            last_failure_reason = ?
      WHERE shop_id = ?`,
    [reason ? String(reason).slice(0, 255) : null, shopId],
  );
  await execute(
    `INSERT INTO subscription_events (shop_id, from_plan, to_plan, action, amount, note)
     VALUES (?, ?, ?, 'payment_failed', 0, ?)`,
    [shopId, subscription.plan, subscription.plan, reason ? String(reason).slice(0, 255) : null],
  );

  return getForShop(shopId);
}

/** Razorpay paused or resumed the mandate. */
async function setStatus(shopId, status) {
  await execute('UPDATE shop_subscriptions SET status = ? WHERE shop_id = ?', [status, shopId]);
  return getForShop(shopId);
}

/**
 * Drops a shop to Free, keeping every row of its data (§10, §11).
 * Called when a grace window closes or a cancelled period finally ends.
 */
async function downgradeToFree(shopId, note) {
  const subscription = await getForShop(shopId);
  const target = subscription.pendingPlan ?? 'FREE';
  if (subscription.plan === target) return getForShop(shopId);

  const plan = plans.planFor(target);
  const paid = plan.price > 0;

  // A paid target still has to be paid for: the old mandate is gone, so it
  // lands in `created`/`pending` and unlocks nothing until a new checkout
  // completes. Only Free is entitled the moment it is applied.
  await execute(
    `UPDATE shop_subscriptions
        SET plan = ?, status = ?, price_amount = ?,
            payment_status = ?, renews_at = NULL, grace_until = NULL,
            cancel_at_period_end = 0, pending_plan = NULL, checkout_plan = NULL,
            current_period_start = NULL, current_period_end = NULL,
            gateway_subscription_id = NULL, autopay_enabled = 0
      WHERE shop_id = ?`,
    [target, paid ? 'created' : 'active', plan.price, paid ? 'pending' : 'not_required', shopId],
  );
  await execute(
    `INSERT INTO subscription_events (shop_id, from_plan, to_plan, action, amount, note)
     VALUES (?, ?, ?, 'downgraded', 0, ?)`,
    [shopId, subscription.plan, target, note ?? null],
  );

  return getForShop(shopId);
}

/** Marks the current billing period as paid - the hook a provider webhook calls. */
async function markPaid(shopId, { provider = null, providerRef = null } = {}) {
  const subscription = await getForShop(shopId);
  await execute(
    `UPDATE shop_subscriptions SET provider = ?, provider_ref = ? WHERE shop_id = ?`,
    [provider, providerRef, shopId],
  );
  return activate(shopId, { amount: subscription.price, paymentMethod: provider });
}

/**
 * Cancels at the end of the paid period (§13). Future billing stops; the
 * merchant keeps their benefits until the period they paid for runs out, and
 * no historical payment record is touched.
 */
async function cancel(shopId, user, note) {
  const subscription = await getForShop(shopId);
  if (subscription.plan === 'FREE') throw ApiError.badRequest('The Free plan cannot be cancelled');

  const periodEnd = subscription.currentPeriodEnd ?? subscription.renewsAt;

  await execute(
    `UPDATE shop_subscriptions
        SET status = 'cancelled', cancelled_at = NOW(), cancel_at_period_end = 1,
            autopay_enabled = 0, checkout_plan = NULL
      WHERE shop_id = ?`,
    [shopId],
  );
  await execute(
    `INSERT INTO subscription_events (shop_id, from_plan, to_plan, action, amount, actor_id, note)
     VALUES (?, ?, 'FREE', 'cancelled', 0, ?, ?)`,
    [shopId, subscription.plan, user?.id ?? null, note ?? null],
  );

  return { ...(await entitlements(shopId)), activeUntil: periodEnd };
}

/**
 * Nightly sweep (§10, §11, §12): closes grace windows and applies downgrades
 * whose paid period has ended. Idempotent - a shop already on its target plan
 * is skipped.
 */
async function sweepLapsed() {
  const lapsed = await query(
    `SELECT shop_id, plan, status FROM shop_subscriptions
      WHERE plan <> 'FREE'
        AND ((status = 'past_due' AND grace_until IS NOT NULL AND grace_until <= NOW())
          OR (status = 'cancelled' AND COALESCE(current_period_end, renews_at) IS NOT NULL
              AND COALESCE(current_period_end, renews_at) <= NOW())
          OR (cancel_at_period_end = 1 AND COALESCE(current_period_end, renews_at) IS NOT NULL
              AND COALESCE(current_period_end, renews_at) <= NOW()))`,
  );

  for (const row of lapsed) {
    await downgradeToFree(
      Number(row.shop_id),
      row.status === 'past_due' ? 'Grace period ended without payment' : 'Billing period ended',
    );
  }
  return lapsed.length;
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
    `SELECT shop_id, plan, status, grace_until, current_period_end, renews_at
       FROM shop_subscriptions
      WHERE shop_id IN (${shopIds.map(() => '?').join(',')})`,
    shopIds,
  );
  return new Map(rows.map((row) => [Number(row.shop_id), isEntitled(row) ? row.plan : 'FREE']));
}

module.exports = {
  currentPeriod,
  getForShop,
  planKeyForShop,
  planKeysForShops,
  usageForShop,
  countMonthlyUsage,
  recordUsage,
  entitlements,
  isEntitled,
  changePlan,
  scheduleDowngrade,
  recordCheckoutIntent,
  grantPlan,
  attachGateway,
  findByGatewaySubscriptionId,
  activate,
  markPastDue,
  setStatus,
  downgradeToFree,
  sweepLapsed,
  markPaid,
  cancel,
  history,
  invoices,
};
