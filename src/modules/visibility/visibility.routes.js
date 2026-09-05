'use strict';

const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../../utils/asyncHandler');
const validate = require('../../middleware/validate');
const { optionalAuth } = require('../../middleware/auth');
const { searchLimiter } = require('../../middleware/rateLimit');
const { ok, noContent } = require('../../utils/respond');
const { paginationSchema } = require('../../utils/pagination');
const env = require('../../config/env');
const vis = require('../../config/visibility');
const visibility = require('../../services/visibility/visibility.service');
const featuredPlacements = require('../../services/visibility/featuredPlacement.service');
const analytics = require('../../services/visibility/visibilityAnalytics.service');
const config = require('../../services/visibility/config');

const router = express.Router();

/**
 * Customer-facing discovery, ranked (§13, §14, §29).
 *
 * Every endpoint here is anonymous-friendly: `optionalAuth` personalises a
 * response when a token is present and never demands one, because §4 gives
 * guests contextual ranking rather than none, and a customer must be able to
 * browse before signing up.
 *
 * These sit alongside `/discovery` rather than replacing it. `/discovery`
 * remains the simple, sorted listing API the existing clients call; this is the
 * ranked one, and running both means a client migrates when it is ready
 * instead of on the day this deploys.
 */
router.use(optionalAuth);

const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);

const positionQuery = {
  latitude: latitude.optional(),
  longitude: longitude.optional(),
  city: z.string().trim().max(120).optional(),
};

const feedQuery = z.object({
  ...paginationSchema,
  ...positionQuery,
  categoryId: z.coerce.number().int().positive().optional(),
  shopId: z.coerce.number().int().positive().optional(),
  type: z.enum(['all', 'product', 'service']).default('all'),
  radiusKm: z.coerce.number().min(0.1).max(500).optional(),
  featuredLimit: z.coerce.number().int().min(0).max(10).default(5),
});

const nearMeQuery = feedQuery.extend({
  radiusKm: z.coerce.number().min(0.1).max(500).default(env.discovery.defaultRadiusKm),
}).refine((data) => data.latitude !== undefined && data.longitude !== undefined, {
  message: 'latitude and longitude are required for Near Me',
  path: ['latitude'],
});

const searchQuery = feedQuery.extend({ q: z.string().trim().min(1).max(120) });

const endingSoonQuery = feedQuery.extend({
  withinHours: z.coerce.number().int().min(1).max(720).default(env.discovery.endingSoonHours),
});

/**
 * Runs one surface and answers with it.
 *
 * Every surface differs only in its parameters, so they share this - which is
 * also what guarantees they all record impressions the same way. A surface that
 * forgot to call `trackServed` would silently stop feeding both the merchant's
 * dashboard and the ranking's own engagement signal.
 */
async function serveSurface(req, { surface, placementType, params }) {
  const identity = analytics.identityFor(req);

  const result = await visibility.discoverWithFeatured(
    { surface, placementType, ...params },
    req.user,
    { identity },
  );

  visibility.trackServed(
    { organic: result.items, featured: result.featured },
    {
      surface,
      identity,
      city: params.city ?? null,
      latitude: params.latitude ?? null,
      longitude: params.longitude ?? null,
      term: params.search ?? null,
    },
  );

  return { result, identity };
}

/** §11's Home Featured plus the ranked organic feed beneath it (§29). */
router.get(
  '/feed',
  validate({ query: feedQuery }),
  asyncHandler(async (req, res) => {
    const { result } = await serveSurface(req, {
      surface: vis.SURFACES.HOME,
      placementType: vis.PLACEMENT_TYPES.HOME_FEATURED,
      params: req.query,
    });

    ok(
      res,
      { featured: result.featured, items: result.items },
      { ...result.pagination, surface: result.surface },
    );
  }),
);

/** §14's Near Me flow, end to end. */
router.get(
  '/near-me',
  validate({ query: nearMeQuery }),
  asyncHandler(async (req, res) => {
    const { result } = await serveSurface(req, {
      surface: vis.SURFACES.NEAR_ME,
      placementType: vis.PLACEMENT_TYPES.NEAR_ME_FEATURED,
      params: req.query,
    });

    ok(
      res,
      { featured: result.featured, items: result.items },
      { ...result.pagination, surface: result.surface },
    );
  }),
);

/** §13's search ranking: relevance first, subscription seventh. */
router.get(
  '/search',
  searchLimiter,
  validate({ query: searchQuery }),
  asyncHandler(async (req, res) => {
    const { result } = await serveSurface(req, {
      surface: vis.SURFACES.SEARCH,
      placementType: null,
      params: { ...req.query, search: req.query.q },
    });

    ok(
      res,
      { query: req.query.q, items: result.items },
      { ...result.pagination, surface: result.surface },
    );
  }),
);

/** §11's Category Featured, over a category-filtered ranked list. */
router.get(
  '/category/:categoryId',
  validate({
    params: z.object({ categoryId: z.coerce.number().int().positive() }),
    query: feedQuery,
  }),
  asyncHandler(async (req, res) => {
    const { result } = await serveSurface(req, {
      surface: vis.SURFACES.CATEGORY,
      placementType: vis.PLACEMENT_TYPES.CATEGORY_FEATURED,
      params: { ...req.query, categoryId: req.params.categoryId },
    });

    ok(
      res,
      { featured: result.featured, items: result.items },
      { ...result.pagination, surface: result.surface },
    );
  }),
);

/**
 * §12's Ending Soon.
 *
 * Eligibility is a subscription rule here, unlike everywhere else: §12 opens
 * the section to Business and Premium only. That is a hard gate, so it is
 * applied in the candidate query - a weighted factor could never enforce it,
 * because a Free listing scoring well on everything else would still get in.
 * The PLACEMENT factor still reflects it, but as a ranking signal rather than
 * as the gate.
 */
router.get(
  '/ending-soon',
  validate({ query: endingSoonQuery }),
  asyncHandler(async (req, res) => {
    const { result } = await serveSurface(req, {
      surface: vis.SURFACES.ENDING_SOON,
      placementType: vis.PLACEMENT_TYPES.ENDING_SOON_FEATURED,
      params: req.query,
    });

    ok(
      res,
      {
        featured: result.featured,
        items: result.scored.map((entry) => ({
          ...visibility.mapListing(entry),
          endingBucket: bucketFor(entry.row.end_date),
        })),
      },
      { ...result.pagination, surface: result.surface },
    );
  }),
);

/** One promotional space on its own, for a client that renders rails lazily. */
router.get(
  '/placements/:placementType',
  validate({
    params: z.object({ placementType: z.enum(vis.PLACEMENT_TYPE_KEYS) }),
    query: z.object({
      ...positionQuery,
      categoryId: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(20).default(5),
    }),
  }),
  asyncHandler(async (req, res) => {
    const identity = analytics.identityFor(req);
    const items = await featuredPlacements.serve(
      req.params.placementType,
      {
        categoryId: req.query.categoryId ?? null,
        city: req.query.city ?? null,
        latitude: req.query.latitude,
        longitude: req.query.longitude,
      },
      { limit: req.query.limit },
    );

    featuredPlacements.markServed(items);
    analytics.recordImpressions(items, {
      surface: vis.SURFACE_FOR_PLACEMENT[req.params.placementType],
      identity,
      city: req.query.city ?? null,
      latitude: req.query.latitude ?? null,
      longitude: req.query.longitude ?? null,
    });

    ok(res, items);
  }),
);

// ---------------------------------------------------------------------------
// Event ingest (§32)

const eventBody = z.object({
  event: z.enum(vis.CLIENT_EVENT_TYPES),
  surface: z.enum(vis.SURFACE_KEYS).optional(),
  placementType: z.enum(vis.PLACEMENT_TYPE_KEYS).optional(),
  featuredCampaignId: z.coerce.number().int().positive().optional(),
  slotId: z.coerce.number().int().positive().optional(),
  listingType: z.enum(['offer', 'service_offer', 'shop']).default('offer'),
  listingId: z.coerce.number().int().positive().optional(),
  shopId: z.coerce.number().int().positive().optional(),
  branchId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  position: z.coerce.number().int().min(1).max(500).optional(),
  distanceKm: z.coerce.number().min(0).max(20000).optional(),
  city: z.string().trim().max(120).optional(),
  latitude: latitude.optional(),
  longitude: longitude.optional(),
  term: z.string().trim().max(160).optional(),
});

const batchBody = z.object({ events: z.array(eventBody).min(1).max(100) });

/**
 * §32's client-witnessed events.
 *
 * Only the events a browser is the sole witness to are accepted. SAVE, CLAIM
 * and above are recorded server-side by the flows that perform them - and
 * REDEMPTION most of all, because §2.4 makes a verified redemption the
 * strongest ranking signal on the platform, which is precisely why it must
 * never be postable from a console (§25).
 */
router.post(
  '/events',
  validate({ body: eventBody }),
  asyncHandler(async (req, res) => {
    await analytics.record({
      ...req.body,
      eventType: req.body.event,
      ...analytics.identityFor(req),
    });
    noContent(res);
  }),
);

router.post(
  '/events/batch',
  validate({ body: batchBody }),
  asyncHandler(async (req, res) => {
    const identity = analytics.identityFor(req);
    await analytics.record(
      req.body.events.map((event) => ({ ...event, eventType: event.event, ...identity })),
    );
    ok(res, { accepted: req.body.events.length });
  }),
);

/** The event and placement vocabulary, so no client hard-codes the names. */
router.get(
  '/meta',
  asyncHandler(async (_req, res) => {
    const { rules } = await config.get();
    ok(res, {
      events: { all: vis.EVENT_TYPE_KEYS, client: vis.CLIENT_EVENT_TYPES },
      surfaces: vis.SURFACE_KEYS,
      placementTypes: vis.PLACEMENT_TYPE_KEYS,
      visibilityLevels: Object.values(vis.VISIBILITY_LEVELS).map(({ key, rank, label }) => ({
        key,
        rank,
        label,
      })),
      // §21: the one description of what a plan buys, served from the backend
      // so no screen has to compose its own promise.
      promise: vis.VISIBILITY_PROMISE,
      defaultRadiusKm: rules.defaultRadiusKm,
    });
  }),
);

/** Urgency wording for Ending Soon, matching `/discovery`'s so both agree. */
function bucketFor(endDate) {
  const hours = (new Date(endDate).getTime() - Date.now()) / 3600000;
  const { urgentHours } = env.discovery;
  if (hours <= urgentHours) return { key: 'urgent', label: `Less than ${urgentHours} hours` };
  if (isSameDay(endDate)) return { key: 'today', label: 'Ends today' };
  if (isTomorrow(endDate)) return { key: 'tomorrow', label: 'Ends tomorrow' };
  if (hours <= 72) return { key: 'three-days', label: 'Ends within 3 days' };
  return { key: 'soon', label: 'Ending soon' };
}

const isSameDay = (value) => new Date(value).toDateString() === new Date().toDateString();
const isTomorrow = (value) => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return new Date(value).toDateString() === tomorrow.toDateString();
};

module.exports = router;
