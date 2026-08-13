'use strict';

const service = require('./preferences.service');
const analyticsEvents = require('../../services/analyticsEvents');
const { ok } = require('../../utils/respond');

exports.get = async (req, res) => {
  ok(res, await service.getPreferences(req.user.id));
};

exports.status = async (req, res) => {
  ok(res, await service.getStatus(req.user.id));
};

exports.set = async (req, res) => {
  const wasCompleted = (await service.getStatus(req.user.id)).preferencesCompleted;
  const preferences = await service.setPreferences(req.user.id, req.body);

  analyticsEvents.record(
    wasCompleted ? analyticsEvents.EVENT_TYPES.PREFERENCE_UPDATED : analyticsEvents.EVENT_TYPES.PREFERENCE_ONBOARDING_COMPLETED,
    { userId: req.user.id },
  );

  ok(res, preferences);
};
