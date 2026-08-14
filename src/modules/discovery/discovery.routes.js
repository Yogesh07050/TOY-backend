'use strict';

const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../../utils/asyncHandler');
const validate = require('../../middleware/validate');
const { optionalAuth } = require('../../middleware/auth');
const { ok, noContent, paginated } = require('../../utils/respond');
const bannerService = require('../banners/banner.service');
const offerService = require('../offers/offer.service');
const offerDiscovery = require('../../services/offerDiscovery');
const recommendations = require('../../services/recommendations');
const analyticsEvents = require('../../services/analyticsEvents');
const { paginationSchema } = require('../../utils/pagination');
const env = require('../../config/env');

const router = express.Router();

const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);

const positionQuery = {
  latitude: latitude.optional(),
  longitude: longitude.optional(),
  limit: z.coerce.number().int().min(1).max(24).default(8),
};

const nearbyQuery = z
  .object({
    ...positionQuery,
    radius: z.coerce.number().min(0.1).max(500).default(env.discovery.defaultRadiusKm),
  })
  .refine((data) => data.latitude !== undefined && data.longitude !== undefined, {
    message: 'latitude and longitude are required for nearby offers',
    path: ['latitude'],
  });

const endingSoonQuery = z.object({
  ...positionQuery,
  withinHours: z.coerce.number().int().min(1).max(720).default(env.discovery.endingSoonHours),
});

const featuredQuery = z.object({ limit: z.coerce.number().int().min(1).max(20).default(8) });
const trackParams = z.object({ id: z.coerce.number().int().positive() });
const trackBody = z.object({ event: z.enum(['impression', 'click']).default('impression') });

/** "View Offers" (§8, §14): product offers and service offers, unioned. */
const allOffersQuery = z.object({
  ...paginationSchema,
  search: z.string().trim().max(120).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  shopId: z.coerce.number().int().positive().optional(),
  city: z.string().trim().max(120).optional(),
  latitude: latitude.optional(),
  longitude: longitude.optional(),
  type: z.enum(['all', 'product', 'service']).default('all'),
  sort: z.enum(['newest', 'endingSoon', 'mostViewed', 'nearest']).default('newest'),
});

/**
 * Customer-facing discovery (§14, §16, §18, §20).
 *
 * Everything here is read-only and anonymous-friendly - `optionalAuth`
 * personalises the response when a token is present but never demands one, so
 * the future mobile app (§26) can call the same endpoints before login.
 */
router.use(optionalAuth);

/**
 * Featured banners. Returns only banners that are currently eligible: the
 * service applies the offer's validity on top of the banner's own, so an
 * expired or deactivated offer removes its banner automatically (§10).
 */
router.get(
  '/featured',
  validate({ query: featuredQuery }),
  asyncHandler(async (req, res) => {
    ok(res, await bannerService.listLive({ limit: req.query.limit }));
  }),
);

/** Banner impressions and clicks (§12). Anonymous visitors count too. */
router.post(
  '/featured/:id/track',
  validate({ params: trackParams, body: trackBody }),
  asyncHandler(async (req, res) => {
    await bannerService.track(req.params.id, req.body.event, req.user, req.ip);
    noContent(res);
  }),
);

/**
 * Offers closest to expiry (§16, §17). Ranked by expiry first, then the
 * secondary signals; the bucket label is computed server-side so every client
 * describes urgency the same way.
 */
router.get(
  '/ending-soon',
  validate({ query: endingSoonQuery }),
  asyncHandler(async (req, res) => {
    const position =
      req.query.latitude !== undefined && req.query.longitude !== undefined
        ? { latitude: req.query.latitude, longitude: req.query.longitude }
        : null;

    const { items } = await offerService.list(
      {
        page: 1,
        limit: req.query.limit,
        sort: 'endingSoon',
        expiringInHours: req.query.withinHours,
        latitude: position?.latitude,
        longitude: position?.longitude,
        // V3 §3: Ending Soon is a Business and Premium placement.
        minPlanRank: 1,
      },
      req.user,
    );

    ok(
      res,
      items.map((offer) => ({ ...offer, endingBucket: bucketFor(offer.endDate) })),
    );
  }),
);

/** Offers near a position, ranked by distance (§18, §19). */
router.get(
  '/nearby',
  validate({ query: nearbyQuery }),
  asyncHandler(async (req, res) => {
    const { items } = await offerService.list(
      {
        page: 1,
        limit: req.query.limit,
        sort: 'nearest',
        latitude: req.query.latitude,
        longitude: req.query.longitude,
        radius: req.query.radius,
      },
      req.user,
    );

    // §28: a nearby lookup is the location signal behind the radius analysis in
    // §11, so the position is recorded once per request rather than per result.
    analyticsEvents.record(analyticsEvents.EVENT_TYPES.NEARBY_OFFER_VIEW, {
      userId: req.user?.id ?? null,
      latitude: req.query.latitude,
      longitude: req.query.longitude,
    });

    ok(res, items);
  }),
);

/**
 * "View Offers" (§8): every listing - product or service - with an active
 * offer, unioned server-side so pagination stays correct across both.
 */
router.get(
  '/offers',
  validate({ query: allOffersQuery }),
  asyncHandler(async (req, res) => {
    const { items, pagination } = await offerDiscovery.listAllOffers(req.query, req.user);
    paginated(res, items, pagination);
  }),
);

/** Mild rule-based personalisation (§20, §21). */
router.get(
  '/recommended',
  validate({ query: z.object({ ...positionQuery, radius: z.coerce.number().min(0.1).max(500).optional() }) }),
  asyncHandler(async (req, res) => {
    const position =
      req.query.latitude !== undefined && req.query.longitude !== undefined
        ? { latitude: req.query.latitude, longitude: req.query.longitude }
        : null;

    ok(
      res,
      await recommendations.recommend(req.user, {
        position,
        radiusKm: req.query.radius ?? env.discovery.defaultRadiusKm,
        limit: req.query.limit,
      }),
    );
  }),
);

/**
 * Urgency buckets from §16. Thresholds are configurable rather than literals
 * so the wording can be tuned without a code change.
 */
function bucketFor(endDate) {
  const hours = (new Date(endDate).getTime() - Date.now()) / 3600000;
  const { urgentHours } = env.discovery;

  if (hours <= urgentHours) return { key: 'urgent', label: `Less than ${urgentHours} hours` };
  if (isSameDay(endDate)) return { key: 'today', label: 'Ends today' };
  if (isTomorrow(endDate)) return { key: 'tomorrow', label: 'Ends tomorrow' };
  if (hours <= 72) return { key: 'three-days', label: 'Ends within 3 days' };
  return { key: 'soon', label: 'Ending soon' };
}

const isSameDay = (value) => {
  const date = new Date(value);
  const now = new Date();
  return date.toDateString() === now.toDateString();
};

const isTomorrow = (value) => {
  const date = new Date(value);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return date.toDateString() === tomorrow.toDateString();
};

module.exports = router;
