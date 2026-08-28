'use strict';

const express = require('express');
const { z } = require('zod');
const { rawQuery } = require('../../db/pool');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate } = require('../../middleware/auth');
const { requireSuperAdmin } = require('../../middleware/authorize');
const { ok } = require('../../utils/respond');
const { DATE_PRESETS, resolvePresetRange } = require('../../utils/dateRange');
const plans = require('../../config/plans');
const metrics = require('../../config/businessMetrics');
const business = require('./business.service');
const revenue = require('./revenue.service');
const { kpi, per, percent } = require('./business.scope');
const platformHealth = require('../../services/platformHealth');
const failureLog = require('../../services/failureLog');

/**
 * The Business Dashboard API (Business §2-§34, §55, §59).
 *
 * Super Admin only, and enforced in one place rather than per route: the guard
 * pair below sits above every handler in this file, so a route added later is
 * protected by default rather than by remembering to protect it. §1 frames the
 * whole document as "the Business Dashboard for the Offers App platform owner /
 * Super Admin", and §55 adds that technical detail may be shown "only to
 * authorized administrators" - there is no merchant-visible subset of this
 * router, and there must never be one.
 *
 * Note what is *not* here: no permission variant, no shop scoping, no
 * subscription gate. A Super Admin administers the platform rather than
 * subscribes to it, and giving this router a permission name would invite
 * someone to grant that permission to a merchant role.
 */

const router = express.Router();

// ---------------------------------------------------------------------------
// Shared query contract (§32)
// ---------------------------------------------------------------------------

const filterQuery = z.object({
  preset: z.enum(DATE_PRESETS).default('last30'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),

  city: z.string().trim().max(120).optional(),
  area: z.string().trim().max(160).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  listingType: z.enum(['all', 'offer', 'service']).default('all'),
  plan: z.enum(plans.PLAN_KEYS).optional(),
  shopId: z.coerce.number().int().positive().optional(),
  offerId: z.coerce.number().int().positive().optional(),
  serviceId: z.coerce.number().int().positive().optional(),
  branchId: z.coerce.number().int().positive().optional(),
  acquisitionChannel: z.string().trim().max(60).optional(),

  limit: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['views', 'claims', 'redemptions', 'conversion']).default('views'),
});

function filtersFrom(query) {
  return {
    city: query.city,
    area: query.area,
    categoryId: query.categoryId,
    listingType: query.listingType,
    plan: query.plan,
    shopId: query.shopId,
    offerId: query.offerId,
    serviceId: query.serviceId,
    branchId: query.branchId,
    acquisitionChannel: query.acquisitionChannel,
  };
}

/** The context every metric function takes. */
function contextFrom(req) {
  return { range: resolvePresetRange(req.query), filters: filtersFrom(req.query) };
}

/** Wires up one dashboard endpoint. */
function dashboard(path, handler, schema = filterQuery) {
  router.get(
    path,
    validate({ query: schema }),
    asyncHandler(async (req, res) => ok(res, await handler(contextFrom(req), req))),
  );
}

router.use(authenticate);
router.use(requireSuperAdmin);

// ---------------------------------------------------------------------------
// §4 Executive overview
// ---------------------------------------------------------------------------

/**
 * The eleven KPI cards §4 lists, assembled from the same functions the detail
 * pages use. Building the overview out of the detail queries rather than its
 * own is what stops the headline MRR from disagreeing with the Revenue page.
 */
dashboard('/overview', async (context) => {
  const { from, to, previousFrom, previousTo } = context.range;
  const { filters } = context;

  const [
    users,
    previousUsers,
    engagement,
    previousEngagement,
    activeMerchants,
    previousMerchants,
    book,
    churn,
    alerts,
  ] = await Promise.all([
    business.activeUsers(from, to, filters),
    business.activeUsers(previousFrom, previousTo, filters),
    business.engagementTotals(from, to, filters),
    business.engagementTotals(previousFrom, previousTo, filters),
    business.activeMerchantCount(from, to, filters),
    business.activeMerchantCount(previousFrom, previousTo, filters),
    revenue.currentBook(filters),
    revenue.churn(from, to, filters),
    platformHealth.alerts(),
  ]);

  const arpm = book.payingMerchants > 0 ? Math.round(book.mrr / book.payingMerchants) : 0;

  return {
    range: context.range,
    kpis: [
      kpi('dau', 'DAU', users.dau, previousUsers.dau),
      kpi('mau', 'MAU', users.mau, previousUsers.mau),
      kpi('stickiness', 'DAU / MAU', percent(users.averageDau, users.mau) ?? 0, percent(previousUsers.averageDau, previousUsers.mau) ?? 0, {
        format: 'percent',
      }),
      kpi('activeMerchants', 'Active merchants', activeMerchants, previousMerchants),
      kpi('views', 'Offer views', engagement.views, previousEngagement.views),
      kpi('viewsPerUser', 'Offers viewed / user', per(engagement.views, users.mau) ?? 0, per(previousEngagement.views, previousUsers.mau) ?? 0, {
        format: 'decimal',
      }),
      kpi('claimsPerUser', 'Offers claimed / user', per(engagement.claims, users.mau) ?? 0, per(previousEngagement.claims, previousUsers.mau) ?? 0, {
        format: 'decimal',
      }),
      kpi('redemptionRate', 'Coupon redemption rate', engagement.redemptionRate ?? 0, previousEngagement.redemptionRate ?? 0, {
        format: 'percent',
        hint: business.ELIGIBILITY_NOTE,
      }),
      kpi('mrr', 'MRR', book.mrr, churn.startingMrr, { format: 'currency' }),
      kpi('churn', 'Merchant churn', churn.merchantChurnRate ?? 0, 0, {
        format: 'percent',
        invertTrend: true,
      }),
      kpi('arpm', 'ARPM', arpm, 0, {
        format: 'currency',
        hint: metrics.ARPM_BASIS.PAYING.hint,
      }),
    ],
    activity: users.series,
    health: { overall: alerts.overall, alerts: alerts.alerts },
  };
});

// ---------------------------------------------------------------------------
// Detail pages (§5-§31)
// ---------------------------------------------------------------------------

/** §5-§10 Customer metrics. */
dashboard('/customers', (context) => business.customerMetrics(context));

/** §11-§15, §29 Merchant metrics. */
dashboard('/merchants', (context) => business.merchantMetrics(context));

/** §9 Offer performance across the platform. */
dashboard('/offers', (context, req) =>
  business.offerPerformance(context, { limit: req.query.limit, sort: req.query.sort }),
);

/** §28 Customer → merchant funnel. */
dashboard('/funnel', (context) => business.funnel(context));

/** §16, §17 Merchant retention and the cohort chart. */
dashboard(
  '/retention',
  (context, req) => business.retention({ ...context, cohortMonths: req.query.cohortMonths }),
  filterQuery.extend({ cohortMonths: z.coerce.number().int().min(3).max(36).default(12) }),
);

/** §18-§21 Subscription distribution and conversion funnel. */
dashboard('/subscriptions', (context) => revenue.subscriptions(context));

/** §22-§27 MRR, churn, ARPM and recognised revenue. */
dashboard('/revenue', (context) => revenue.revenue(context));

/** §30 City-level dashboard. */
dashboard('/cities', (context) => business.cityBreakdown(context));

/** §31 Category-level dashboard. */
dashboard('/categories', (context) => business.categoryBreakdown(context));

// ---------------------------------------------------------------------------
// §34, §55, §59 Platform health
// ---------------------------------------------------------------------------

/** §34 The dependency status board. */
router.get(
  '/health',
  asyncHandler(async (_req, res) => ok(res, await platformHealth.board())),
);

/** §59 Alerts, polled by the dashboard shell so any page can surface them. */
router.get(
  '/alerts',
  asyncHandler(async (_req, res) => ok(res, await platformHealth.alerts())),
);

/**
 * §56 The failure log itself. §55 permits technical detail here and nowhere
 * else, which is why this endpoint exists rather than asking an administrator
 * to read a log file over someone's shoulder.
 */
router.get(
  '/incidents',
  validate({
    query: z.object({
      windowMinutes: z.coerce.number().int().min(5).max(1440).default(60),
      limit: z.coerce.number().int().min(1).max(50).default(10),
    }),
  }),
  asyncHandler(async (req, res) =>
    ok(res, {
      windowMinutes: req.query.windowMinutes,
      endpoints: await failureLog.topFailingEndpoints({
        windowMinutes: req.query.windowMinutes,
        limit: req.query.limit,
      }),
    }),
  ),
);

/**
 * §57 Support lookup: "the customer says they got REQ-82917".
 *
 * The reference is matched exactly rather than searched, so this cannot be
 * used to browse the failure log - an administrator has to already have the
 * reference the user read out.
 */
router.get(
  '/incidents/:requestId',
  validate({ params: z.object({ requestId: z.string().trim().min(4).max(40) }) }),
  asyncHandler(async (req, res) => ok(res, await failureLog.findByRequestId(req.params.requestId))),
);

// ---------------------------------------------------------------------------
// §32 Filter options
// ---------------------------------------------------------------------------

/**
 * What the filter bar can offer, read from the data rather than hard-coded, so
 * a city the sales team opened last week appears without a deploy.
 */
router.get(
  '/filters',
  asyncHandler(async (_req, res) => {
    const [cities, areas, categories, channels, shops] = await Promise.all([
      rawQuery(
        `SELECT DISTINCT city FROM shop_branches
          WHERE city IS NOT NULL AND city <> '' AND status = 'active' ORDER BY city`,
      ),
      rawQuery(
        `SELECT DISTINCT area FROM shop_branches
          WHERE area IS NOT NULL AND area <> '' AND status = 'active' ORDER BY area LIMIT 200`,
      ),
      rawQuery("SELECT id, name FROM categories WHERE status = 'active' ORDER BY name"),
      rawQuery(
        `SELECT DISTINCT acquisition_channel AS channel FROM shops
          WHERE acquisition_channel IS NOT NULL AND acquisition_channel <> '' ORDER BY channel`,
      ),
      rawQuery("SELECT id, name FROM shops WHERE status = 'active' ORDER BY name LIMIT 500"),
    ]);

    ok(res, {
      datePresets: DATE_PRESETS,
      cities: cities.map((row) => row.city),
      areas: areas.map((row) => row.area),
      categories: categories.map((row) => ({ id: Number(row.id), name: row.name })),
      plans: plans.PLAN_KEYS.map((key) => ({
        key,
        name: plans.PLANS[key].name,
        price: plans.PLANS[key].price,
      })),
      listingTypes: [
        { key: 'all', label: 'Offers & services' },
        { key: 'offer', label: 'Offers' },
        { key: 'service', label: 'Services' },
      ],
      acquisitionChannels: channels.map((row) => row.channel),
      shops: shops.map((row) => ({ id: Number(row.id), name: row.name })),
    });
  }),
);

/**
 * Every definition behind the dashboard, in one place (§5.1, §10, §11.1, §16,
 * §19, §26). Served so the UI can print what a card counted next to the card,
 * rather than the reader having to trust it.
 */
router.get('/definitions', (_req, res) =>
  ok(res, {
    activeUser: {
      events: metrics.ACTIVE_USER_EVENTS,
      excluded: metrics.EXCLUDED_FROM_ACTIVITY,
      note: 'Automated and background activity is never counted as active-user activity.',
    },
    activeMerchant: {
      activities: metrics.ACTIVE_MERCHANT_ACTIVITIES.map((key) => ({
        key,
        label: metrics.MERCHANT_ACTIVITY_LABELS[key],
      })),
      note: 'A merchant is never counted as active merely because an account exists.',
    },
    claimEligibility: business.ELIGIBILITY_NOTE,
    retention: {
      offsets: metrics.RETENTION_OFFSETS,
      windowDays: metrics.RETENTION_WINDOW_DAYS,
      cohortMonths: metrics.COHORT_MONTHS,
    },
    conversion: metrics.CONVERSION_ELIGIBILITY,
    mrr: {
      activeStatuses: metrics.MRR_ACTIVE_STATUSES,
      atRiskStatuses: metrics.MRR_AT_RISK_STATUSES,
      note:
        'One-time fees, failed payments and refunds are excluded. Yearly subscriptions ' +
        'contribute one twelfth of their price per month.',
    },
    arpm: Object.values(metrics.ARPM_BASIS),
    alerts: metrics.ALERT_RULES,
  }),
);

module.exports = router;
