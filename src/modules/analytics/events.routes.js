'use strict';

const express = require('express');
const { z } = require('zod');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { optionalAuth } = require('../../middleware/auth');
const { noContent, ok } = require('../../utils/respond');
const events = require('../../services/analyticsEvents');

const router = express.Router();

/**
 * Client-side analytics ingest (V3 §28).
 *
 * Only the discovery events a browser is the sole witness to are accepted here
 * - impressions, searches, category and shop views. Anything that changes a
 * counter a merchant is billed against (claims, redemptions) stays server-side
 * on its own route, so it cannot be fabricated from a console.
 */
const eventBody = z.object({
  event: z.enum(events.CLIENT_EVENT_TYPES),
  shopId: z.coerce.number().int().positive().optional(),
  offerId: z.coerce.number().int().positive().optional(),
  bannerId: z.coerce.number().int().positive().optional(),
  branchId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  city: z.string().trim().max(120).optional(),
  pincode: z.string().trim().max(20).optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  term: z.string().trim().max(160).optional(),
});

/** Batches keep an impression-heavy listing page to one request per screen. */
const batchBody = z.object({ events: z.array(eventBody).min(1).max(50) });

async function ingest(payload, user) {
  const context = payload.offerId ? await events.shopContextForOffer(payload.offerId) : null;

  await events.record(payload.event, {
    ...payload,
    userId: user?.id ?? null,
    shopId: payload.shopId ?? context?.shopId ?? null,
    categoryId: payload.categoryId ?? context?.categoryId ?? null,
    city: payload.city ?? context?.city ?? null,
  });

  // An impression or a shop view is an engagement, which is what makes a
  // customer "reached" for the new-vs-returning split (§14).
  const shopId = payload.shopId ?? context?.shopId ?? null;
  if (user && shopId) await events.touchShopCustomer(shopId, user.id);
}

router.post(
  '/',
  optionalAuth,
  validate({ body: eventBody }),
  asyncHandler(async (req, res) => {
    await ingest(req.body, req.user);
    noContent(res);
  }),
);

router.post(
  '/batch',
  optionalAuth,
  validate({ body: batchBody }),
  asyncHandler(async (req, res) => {
    for (const event of req.body.events) await ingest(event, req.user);
    ok(res, { accepted: req.body.events.length });
  }),
);

/** The event vocabulary, so a client never has to hard-code the names. */
router.get('/types', (_req, res) => ok(res, { all: events.EVENT_TYPE_NAMES, client: events.CLIENT_EVENT_TYPES }));

module.exports = router;
