'use strict';

const { rawQuery } = require('../../db/pool');
const metrics = require('../../config/businessMetrics');
const plans = require('../../config/plans');
const scope = require('./business.scope');
const business = require('./business.service');

/**
 * Monetisation metrics for the Business Dashboard (Business §18-§27).
 *
 * Kept apart from `business.service.js` because the two read different worlds.
 * Everything there is derived from behaviour - events, claims, listings.
 * Everything here is derived from the subscription and payment records, and
 * §22 is emphatic about which of those count: not one-time fees, not failed
 * payments, not refunds, not cancelled subscriptions with nothing left to
 * renew. Mixing the two files would make it far too easy for an engagement
 * query's looser filters to leak into a revenue figure.
 *
 * MRR is normalised per §22: a yearly subscription contributes a twelfth of its
 * price each month, so an annual renewal is not a one-month spike.
 */

const { num, percent, kpi, shopFilter } = scope;

/** `price_amount / 12` for yearly, `/ 1` for monthly. */
const MONTHLY_AMOUNT = `(sub.price_amount / CASE sub.billing_cycle WHEN 'yearly' THEN 12 ELSE 1 END)`;

const rupees = (value) => Math.round(num(value));

// ---------------------------------------------------------------------------
// §21, §22 - the current book
// ---------------------------------------------------------------------------

/**
 * MRR and the subscriber counts behind it, as of now.
 *
 * `price_amount` on the subscription row is used rather than the plan
 * catalogue price, because it is what the merchant was actually charged - a
 * discounted or grandfathered subscription must contribute what it earns, not
 * what the price list says. A paid plan with a zero amount is a data problem
 * rather than free revenue, so it falls back to the catalogue and is counted in
 * `unpricedSubscriptions` so the discrepancy is visible instead of silent.
 *
 * Comped shops are the one case that must not reach that fallback. A Super
 * Admin grant is a real Business/Premium subscription that nobody paid for -
 * during the free launch, every merchant is one - and it is marked
 * `payment_status = 'not_required'`. Left in, each would have added its full
 * list price to MRR and counted itself as a paying merchant in ARPM's
 * denominator, reporting revenue that does not exist. Their entitlements are
 * unaffected; only the money is. Free-plan rows carry the same payment status
 * and are already excluded by `plan <> 'FREE'`.
 */
async function currentBook(filters = {}) {
  const filter = shopFilter(filters, 'sub.shop_id');
  const active = metrics.MRR_ACTIVE_STATUSES.map(() => '?').join(',');
  const atRisk = metrics.MRR_AT_RISK_STATUSES.map(() => '?').join(',');

  const rows = await rawQuery(
    `SELECT sub.plan AS plan,
            COUNT(*) AS merchants,
            COALESCE(SUM(${MONTHLY_AMOUNT}), 0) AS mrr,
            COALESCE(SUM(sub.status IN (${atRisk})), 0) AS at_risk_merchants,
            COALESCE(SUM(CASE WHEN sub.status IN (${atRisk}) THEN ${MONTHLY_AMOUNT} ELSE 0 END), 0) AS at_risk_mrr,
            COALESCE(SUM(sub.price_amount = 0), 0) AS unpriced
       FROM shop_subscriptions sub
       JOIN shops s ON s.id = sub.shop_id AND s.status = 'active'
      WHERE sub.plan <> 'FREE' AND sub.status IN (${active})
        AND sub.payment_status <> 'not_required'${filter.sql}
      GROUP BY sub.plan`,
    [...metrics.MRR_AT_RISK_STATUSES, ...metrics.MRR_AT_RISK_STATUSES, ...metrics.MRR_ACTIVE_STATUSES, ...filter.params],
  );

  // The Free tier has no revenue but is the denominator for §21's distribution
  // and for the "all active merchants" flavour of ARPM (§26).
  const freeRows = await rawQuery(
    `SELECT COUNT(*) AS merchants FROM shop_subscriptions sub
       JOIN shops s ON s.id = sub.shop_id AND s.status = 'active'
      WHERE sub.plan = 'FREE'${filter.sql}`,
    filter.params,
  );

  const byPlan = new Map(rows.map((row) => [row.plan, row]));
  const planRows = plans.PLAN_KEYS.map((key) => {
    const catalogue = plans.PLANS[key];
    if (key === 'FREE') {
      return {
        plan: key,
        name: catalogue.name,
        price: catalogue.price,
        merchants: num(freeRows[0]?.merchants),
        mrr: 0,
        atRiskMerchants: 0,
        atRiskMrr: 0,
      };
    }
    const row = byPlan.get(key);
    const merchants = num(row?.merchants);
    const unpriced = num(row?.unpriced);
    // Fall back for the rows that carry no price at all.
    const mrr = rupees(num(row?.mrr)) + unpriced * catalogue.price;

    return {
      plan: key,
      name: catalogue.name,
      price: catalogue.price,
      merchants,
      mrr,
      atRiskMerchants: num(row?.at_risk_merchants),
      atRiskMrr: rupees(num(row?.at_risk_mrr)),
      unpricedSubscriptions: unpriced,
    };
  });

  const paying = planRows.filter((row) => row.plan !== 'FREE');
  const totalMerchants = planRows.reduce((sum, row) => sum + row.merchants, 0);

  return {
    mrr: paying.reduce((sum, row) => sum + row.mrr, 0),
    atRiskMrr: paying.reduce((sum, row) => sum + row.atRiskMrr, 0),
    payingMerchants: paying.reduce((sum, row) => sum + row.merchants, 0),
    totalMerchants,
    plans: planRows.map((row) => ({ ...row, share: percent(row.merchants, totalMerchants) })),
  };
}

// ---------------------------------------------------------------------------
// §23 - MRR movement
// ---------------------------------------------------------------------------

/**
 * The MRR bridge: new, expansion, contraction, churned and reactivation.
 *
 * Read from `subscription_events`, which is the plan-change ledger - the
 * subscription row itself only knows where a shop ended up, not how it got
 * there, and a merchant who upgraded and then downgraded inside one month
 * looks identical to one who never moved.
 *
 * Each movement is valued at the monthly price difference between the plans,
 * which is what makes the parts sum to the change in MRR.
 */
async function mrrMovement(from, to, filters = {}) {
  const filter = shopFilter(filters, 'e.shop_id');
  const events = await rawQuery(
    `SELECT e.action, e.from_plan, e.to_plan, COUNT(*) AS events
       FROM subscription_events e
      WHERE e.created_at BETWEEN ? AND ?${filter.sql}
      GROUP BY e.action, e.from_plan, e.to_plan`,
    [from, to, ...filter.params],
  );

  const priceOf = (plan) => plans.planFor(plan ?? 'FREE').price;

  const movement = {
    newMrr: 0,
    expansionMrr: 0,
    contractionMrr: 0,
    churnedMrr: 0,
    reactivationMrr: 0,
    newMerchants: 0,
    upgrades: 0,
    downgrades: 0,
    cancellations: 0,
    reactivations: 0,
  };

  for (const row of events) {
    const count = num(row.events);
    const before = priceOf(row.from_plan);
    const after = priceOf(row.to_plan);
    const delta = (after - before) * count;

    switch (row.action) {
      case 'created':
        // A shop starting life on a paid plan is new revenue; one starting on
        // Free contributes nothing until it upgrades.
        movement.newMrr += after * count;
        movement.newMerchants += after > 0 ? count : 0;
        break;
      case 'upgraded':
        // An upgrade *out of Free* is a first sale, not an expansion of an
        // existing one - §23 lists those separately and conflating them makes
        // New MRR permanently zero for a freemium product.
        if (before === 0) {
          movement.newMrr += delta;
          movement.newMerchants += count;
        } else {
          movement.expansionMrr += delta;
        }
        movement.upgrades += count;
        break;
      case 'downgraded':
        if (after === 0) {
          movement.churnedMrr += Math.abs(delta);
          movement.cancellations += count;
        } else {
          movement.contractionMrr += Math.abs(delta);
        }
        movement.downgrades += count;
        break;
      case 'cancelled':
      case 'expired':
        movement.churnedMrr += before * count;
        movement.cancellations += count;
        break;
      case 'reactivated':
        movement.reactivationMrr += after * count;
        movement.reactivations += count;
        break;
      // 'renewed', 'payment_failed', 'past_due' and 'grace_started' move no
      // money: a renewal is the same subscription continuing, and a failed
      // payment has not yet become churn (§39's PAST_DUE -> grace -> retry).
      default:
        break;
    }
  }

  movement.netMrr =
    movement.newMrr + movement.expansionMrr + movement.reactivationMrr -
    movement.contractionMrr - movement.churnedMrr;

  return movement;
}

// ---------------------------------------------------------------------------
// §24, §25 - churn
// ---------------------------------------------------------------------------

/**
 * Merchant churn and MRR churn, which §25 insists on keeping apart: losing one
 * Premium merchant and twenty Free-to-Business trials are the same headcount
 * story and very different revenue stories.
 *
 * The denominator is the paying base at the *start* of the period, per §24.
 * That has to be reconstructed - the subscription table only holds today - so
 * it is derived from the current base and the ledger: whoever is paying now,
 * minus everyone who started paying during the period, plus everyone who
 * stopped.
 */
async function churn(from, to, filters = {}) {
  const filter = shopFilter(filters, 'e.shop_id');
  const book = await currentBook(filters);

  const rows = await rawQuery(
    `SELECT e.action, e.from_plan, e.to_plan, COUNT(*) AS events, COUNT(DISTINCT e.shop_id) AS merchants
       FROM subscription_events e
      WHERE e.created_at BETWEEN ? AND ?${filter.sql}
      GROUP BY e.action, e.from_plan, e.to_plan`,
    [from, to, ...filter.params],
  );

  const priceOf = (plan) => plans.planFor(plan ?? 'FREE').price;

  let started = 0;
  let stopped = 0;
  let lostMerchants = 0;
  let lostMrr = 0;
  let startingMrrDelta = 0;

  for (const row of rows) {
    const count = num(row.events);
    const before = priceOf(row.from_plan);
    const after = priceOf(row.to_plan);

    const becamePaying = before === 0 && after > 0;
    const stoppedPaying = before > 0 && after === 0;
    const cancelled = row.action === 'cancelled' || row.action === 'expired';

    if (becamePaying) {
      started += count;
      startingMrrDelta += after * count;
    }
    if (stoppedPaying || cancelled) {
      stopped += count;
      lostMerchants += count;
      lostMrr += (stoppedPaying ? before : priceOf(row.from_plan)) * count;
      startingMrrDelta -= (stoppedPaying ? before : priceOf(row.from_plan)) * count;
    }
    // A downgrade that stays paid is revenue churn without merchant churn -
    // exactly the distinction §25 exists to draw.
    if (before > 0 && after > 0 && after < before) {
      lostMrr += (before - after) * count;
      startingMrrDelta -= (before - after) * count;
    }
    if (before > 0 && after > before) {
      startingMrrDelta += (after - before) * count;
    }
  }

  const startingPaying = Math.max(book.payingMerchants - started + stopped, 0);
  const startingMrr = Math.max(book.mrr - startingMrrDelta, 0);

  return {
    startingPayingMerchants: startingPaying,
    endingPayingMerchants: book.payingMerchants,
    churnedMerchants: lostMerchants,
    merchantChurnRate: percent(lostMerchants, startingPaying),
    startingMrr: rupees(startingMrr),
    churnedMrr: rupees(lostMrr),
    mrrChurnRate: percent(lostMrr, startingMrr),
  };
}

// ---------------------------------------------------------------------------
// §18, §19, §20 - the subscription conversion funnel
// ---------------------------------------------------------------------------

/**
 * Free -> Business -> Premium, with counts and rates.
 *
 * "Eligible" is the load-bearing word in both §19 and §20, and
 * `CONVERSION_ELIGIBILITY` in the metric config is what it means: a merchant
 * counts in the denominator only if they had a real chance to convert during
 * the period. A shop that signed up on the last day of the month has not
 * declined to upgrade; it simply has not been asked yet.
 */
async function conversionFunnel(from, to, filters = {}) {
  const filter = shopFilter(filters, 's.id');
  const eventFilter = shopFilter(filters, 'e.shop_id');
  const minDays = metrics.CONVERSION_ELIGIBILITY.minDaysOnPlan;

  /**
   * Merchants who were on `plan` and had been for long enough. `sub.plan` is
   * where they are *now*, so anyone who converted during the window is added
   * back from the ledger - otherwise every successful conversion would remove
   * itself from its own denominator and the rate could never exceed zero.
   */
  const eligibleOn = async (plan) => {
    const rows = await rawQuery(
      `SELECT COUNT(DISTINCT s.id) AS merchants
         FROM shops s
         JOIN shop_subscriptions sub ON sub.shop_id = s.id
        WHERE s.status = 'active'
          AND s.created_at <= DATE_SUB(?, INTERVAL ? DAY)
          AND (sub.plan = ?
               OR EXISTS (SELECT 1 FROM subscription_events e
                           WHERE e.shop_id = s.id AND e.from_plan = ?
                             AND e.created_at BETWEEN ? AND ?))
          ${filter.sql}`,
      [to, minDays, plan, plan, from, to, ...filter.params],
    );
    return num(rows[0].merchants);
  };

  const convertedFrom = async (fromPlan, toPlan) => {
    const rows = await rawQuery(
      `SELECT COUNT(DISTINCT e.shop_id) AS merchants
         FROM subscription_events e
        WHERE e.created_at BETWEEN ? AND ?
          AND e.from_plan = ? AND e.to_plan = ?
          AND e.action IN ('upgraded', 'created')${eventFilter.sql}`,
      [from, to, fromPlan, toPlan, ...eventFilter.params],
    );
    return num(rows[0].merchants);
  };

  const [eligibleFree, eligibleBusiness, freeToBusiness, businessToPremium, freeToPremium] =
    await Promise.all([
      eligibleOn('FREE'),
      eligibleOn('BUSINESS'),
      convertedFrom('FREE', 'BUSINESS'),
      convertedFrom('BUSINESS', 'PREMIUM'),
      convertedFrom('FREE', 'PREMIUM'),
    ]);

  return {
    steps: [
      {
        key: 'freeToBusiness',
        label: `Free → ₹${plans.PLANS.BUSINESS.price} Business`,
        eligible: eligibleFree,
        // A Free merchant who jumped straight to Premium converted out of Free
        // just as surely as one who stopped at Business.
        converted: freeToBusiness + freeToPremium,
        rate: percent(freeToBusiness + freeToPremium, eligibleFree),
      },
      {
        key: 'businessToPremium',
        label: `₹${plans.PLANS.BUSINESS.price} Business → ₹${plans.PLANS.PREMIUM.price} Premium`,
        eligible: eligibleBusiness,
        converted: businessToPremium,
        rate: percent(businessToPremium, eligibleBusiness),
      },
    ],
    directToPremium: freeToPremium,
    definitions: { eligibility: metrics.CONVERSION_ELIGIBILITY.description },
  };
}

// ---------------------------------------------------------------------------
// §27 - recognised revenue
// ---------------------------------------------------------------------------

/**
 * Money that actually arrived in the period, by plan.
 *
 * Read from captured payments rather than from subscriptions, because §27 says
 * "only recognized revenue should be included" and a subscription row is a
 * promise while a captured payment is a fact. Refunds are subtracted rather
 * than counted as revenue, per §22.
 */
async function revenueBreakdown(from, to, filters = {}) {
  const filter = shopFilter(filters, 't.shop_id');

  const rows = await rawQuery(
    `SELECT t.plan AS plan,
            COUNT(*) AS payments,
            COALESCE(SUM(t.amount), 0)          AS gross,
            COALESCE(SUM(t.amount_refunded), 0) AS refunded
       FROM payment_transactions t
      WHERE t.status IN ('CAPTURED', 'PARTIALLY_REFUNDED')
        AND t.paid_at BETWEEN ? AND ?${filter.sql}
      GROUP BY t.plan`,
    [from, to, ...filter.params],
  );

  const failedRows = await rawQuery(
    `SELECT COUNT(*) AS failures, COALESCE(SUM(t.amount), 0) AS amount
       FROM payment_transactions t
      WHERE t.status = 'FAILED' AND t.created_at BETWEEN ? AND ?${filter.sql}`,
    [from, to, ...filter.params],
  );

  const lines = rows
    .filter((row) => row.plan !== 'FREE')
    .map((row) => ({
      plan: row.plan,
      label: `₹${plans.planFor(row.plan).price} ${plans.planFor(row.plan).name} revenue`,
      payments: num(row.payments),
      gross: rupees(row.gross),
      refunded: rupees(row.refunded),
      net: rupees(num(row.gross) - num(row.refunded)),
    }));

  return {
    lines,
    total: lines.reduce((sum, line) => sum + line.net, 0),
    refunded: lines.reduce((sum, line) => sum + line.refunded, 0),
    /** Not revenue - shown so a collapse in collection is visible next to it. */
    failedPayments: num(failedRows[0].failures),
    failedAmount: rupees(failedRows[0].amount),
    note:
      'Recognised revenue: captured payments only, net of refunds. Failed payments and ' +
      'pending authorisations are excluded.',
  };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** §18-§21 - the Subscriptions page. */
async function subscriptions(context) {
  const { from, to } = context.range;
  const [book, funnel, history] = await Promise.all([
    currentBook(context.filters),
    conversionFunnel(from, to, context.filters),
    planHistory(from, to, context.filters),
  ]);

  return {
    range: context.range,
    distribution: book.plans,
    totalMerchants: book.totalMerchants,
    payingMerchants: book.payingMerchants,
    funnel,
    history,
  };
}

/** Daily plan-change counts, so a conversion push is visible as it happens. */
async function planHistory(from, to, filters) {
  const filter = shopFilter(filters, 'e.shop_id');
  const rows = await rawQuery(
    `SELECT DATE(e.created_at) AS day, e.action, COUNT(*) AS events
       FROM subscription_events e
      WHERE e.created_at BETWEEN ? AND ?
        AND e.action IN ('created','upgraded','downgraded','cancelled','reactivated')${filter.sql}
      GROUP BY day, e.action ORDER BY day`,
    [from, to, ...filter.params],
  );

  return rows.map((row) => ({ day: String(row.day).slice(0, 10), action: row.action, count: num(row.events) }));
}

/** §22-§27 - the Revenue page. */
async function revenue(context) {
  const { from, to, previousFrom, previousTo } = context.range;
  const { filters } = context;

  const [book, movement, previousMovement, churnTotals, breakdown, previousBreakdown, activeMerchants] =
    await Promise.all([
      currentBook(filters),
      mrrMovement(from, to, filters),
      mrrMovement(previousFrom, previousTo, filters),
      churn(from, to, filters),
      revenueBreakdown(from, to, filters),
      revenueBreakdown(previousFrom, previousTo, filters),
      business.activeMerchantCount(from, to, filters),
    ]);

  const arpmPaying = book.payingMerchants > 0 ? Math.round(book.mrr / book.payingMerchants) : 0;
  const arpmAll = activeMerchants > 0 ? Math.round(book.mrr / activeMerchants) : 0;

  return {
    range: context.range,
    kpis: [
      kpi('mrr', 'MRR', book.mrr, churnTotals.startingMrr, {
        format: 'currency',
        hint: 'Normalised monthly recurring revenue from active paid subscriptions.',
      }),
      kpi('netMrr', 'Net MRR growth', movement.netMrr, previousMovement.netMrr, { format: 'currency' }),
      kpi(
        'merchantChurn',
        'Merchant churn',
        churnTotals.merchantChurnRate ?? 0,
        0,
        { format: 'percent', invertTrend: true, hint: 'Paying merchants lost as a share of the base at the start of the period.' },
      ),
      kpi('mrrChurn', 'MRR churn', churnTotals.mrrChurnRate ?? 0, 0, {
        format: 'percent',
        invertTrend: true,
        hint: 'Recurring revenue lost to cancellations and downgrades.',
      }),
      kpi('arpm', metrics.ARPM_BASIS.PAYING.label, arpmPaying, 0, {
        format: 'currency',
        hint: metrics.ARPM_BASIS.PAYING.hint,
      }),
    ],
    mrr: {
      current: book.mrr,
      previous: churnTotals.startingMrr,
      growth: percent(book.mrr - churnTotals.startingMrr, churnTotals.startingMrr),
      atRisk: book.atRiskMrr,
      new: movement.newMrr,
      expansion: movement.expansionMrr,
      contraction: movement.contractionMrr,
      churned: movement.churnedMrr,
      reactivation: movement.reactivationMrr,
      net: movement.netMrr,
    },
    churn: churnTotals,
    // §26: both flavours are given, each labelled, and the UI prints the label
    // rather than inventing one.
    arpm: [
      { ...metrics.ARPM_BASIS.PAYING, value: arpmPaying, denominator: book.payingMerchants },
      { ...metrics.ARPM_BASIS.ALL_ACTIVE, value: arpmAll, denominator: activeMerchants },
    ],
    breakdown,
    previousBreakdownTotal: previousBreakdown.total,
    distribution: book.plans,
  };
}

module.exports = {
  currentBook,
  mrrMovement,
  churn,
  conversionFunnel,
  revenueBreakdown,
  subscriptions,
  revenue,
};
