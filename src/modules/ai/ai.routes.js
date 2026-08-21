'use strict';

const express = require('express');
const { z } = require('zod');

const controller = require('./ai.controller');
const schema = require('./ai.schema');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate } = require('../../middleware/auth');
const { requirePermission, requireSuperAdmin } = require('../../middleware/authorize');
const { aiLimiter } = require('../../middleware/rateLimit');

/**
 * AI endpoints (§41). Every one of them is authenticated, permission-checked,
 * rate-limited (§40) and, inside the service, checked against the shop's
 * subscription plan before a single token is spent.
 *
 * There is deliberately no endpoint here that writes an offer. §10: the AI must
 * never publish. Creating the offer stays with POST /api/offers, submitted by
 * the admin after they have reviewed and edited the suggestion.
 */

const router = express.Router();

router.use(authenticate);

/**
 * The tight limiter guards *generation* only - each of those calls costs a
 * provider request. It is deliberately not applied to the whole router: the UI
 * reads /capabilities on load and again after every generation, and charging
 * those reads against the generation budget produced a "you are generating a
 * lot at once" error for someone who had generated nothing. The reads are still
 * covered by the global API limiter.
 */

// ---- AI Offer Assistant (§4-§13) -------------------------------------------
router.post(
  '/offer-assistant/recommend',
  aiLimiter,
  requirePermission('USE_AI_ASSISTANT'),
  validate({ body: schema.recommendSchema }),
  asyncHandler(controller.recommend),
);

router.post(
  '/offer-assistant/regenerate',
  aiLimiter,
  requirePermission('USE_AI_ASSISTANT'),
  validate({ body: schema.regenerateRecommendationSchema }),
  asyncHandler(controller.regenerateRecommendation),
);

// ---- AI Content Generator (§15-§22, §34) -----------------------------------
router.post(
  '/content/generate',
  aiLimiter,
  requirePermission('USE_AI_CONTENT'),
  validate({ body: schema.generateContentSchema }),
  asyncHandler(controller.generateContent),
);

router.post(
  '/content/regenerate',
  aiLimiter,
  requirePermission('USE_AI_CONTENT'),
  validate({ body: schema.regenerateContentSchema }),
  asyncHandler(controller.regenerateContent),
);

// ---- Improve an existing offer (§14) ---------------------------------------
router.post(
  '/offer/improve',
  aiLimiter,
  requirePermission('USE_AI_CONTENT'),
  validate({ body: schema.improveSchema }),
  asyncHandler(controller.improveOffer),
);

// ---- Entitlements, usage and history ---------------------------------------
router.get('/shops', asyncHandler(controller.shops));

router.get(
  '/capabilities/:shopId',
  validate({ params: z.object({ shopId: z.coerce.number().int().positive() }) }),
  asyncHandler(controller.capabilities),
);

router.get(
  '/usage',
  validate({ query: schema.usageQuerySchema }),
  asyncHandler(controller.usage),
);

router.get(
  '/history',
  validate({ query: schema.historyQuerySchema }),
  asyncHandler(controller.history),
);

router.get(
  '/history/:id',
  validate({ params: schema.idParam }),
  asyncHandler(controller.historyDetail),
);

router.patch(
  '/history/:id',
  validate({ params: schema.idParam, body: schema.historyOutcomeSchema }),
  asyncHandler(controller.setHistoryOutcome),
);

// ---- Diagnostics -----------------------------------------------------------
router.get('/status', requireSuperAdmin, asyncHandler(controller.status));

module.exports = router;
