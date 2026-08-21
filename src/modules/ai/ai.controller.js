'use strict';

const service = require('./ai.service');
const aiClient = require('../../services/aiClient');
const audit = require('../../utils/audit');
const { ok, paginated } = require('../../utils/respond');

/**
 * Audit note: AI calls are metered in `ai_usage` and kept in `ai_generations`,
 * so only the acts with a lasting effect - accepting or rejecting a suggestion -
 * are also written to the audit trail.
 */

exports.recommend = async (req, res) => {
  ok(res, await service.recommend(req.body, req.user));
};

exports.regenerateRecommendation = async (req, res) => {
  ok(res, await service.recommend(req.body, req.user, { regenerate: true }));
};

exports.generateContent = async (req, res) => {
  ok(res, await service.generateContent(req.body, req.user));
};

exports.regenerateContent = async (req, res) => {
  ok(res, await service.generateContent(req.body, req.user, { regenerate: true }));
};

exports.improveOffer = async (req, res) => {
  ok(res, await service.improveOffer(req.body, req.user));
};

exports.capabilities = async (req, res) => {
  ok(res, await service.capabilities(req.params.shopId, req.user));
};

exports.shops = async (req, res) => {
  ok(res, await service.assistantShops(req.user));
};

exports.usage = async (req, res) => {
  ok(res, await service.usage(req.query, req.user));
};

exports.history = async (req, res) => {
  const { items, pagination } = await service.history(req.query, req.user);
  paginated(res, items, pagination);
};

exports.historyDetail = async (req, res) => {
  ok(res, await service.historyDetail(req.params.id, req.user));
};

exports.setHistoryOutcome = async (req, res) => {
  const result = await service.setHistoryOutcome(req.params.id, req.body, req.user);
  await audit.record(req, {
    action: result.outcome === 'accepted' ? 'AI_SUGGESTION_ACCEPTED' : 'AI_SUGGESTION_REJECTED',
    entityType: 'ai_generation',
    entityId: result.id,
    newValue: { outcome: result.outcome, offerId: req.body.offerId ?? null },
  });
  ok(res, result);
};

/** Super Admin only: is the Python AI service reachable, and on which model. */
exports.status = async (_req, res) => {
  ok(res, await aiClient.health());
};
