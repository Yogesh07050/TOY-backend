'use strict';

const service = require('./offer.service');
const reviewService = require('../reviews/review.service');
const analyticsEvents = require('../../services/analyticsEvents');
const audit = require('../../utils/audit');
const { ok, created, noContent, paginated } = require('../../utils/respond');

/** Pulls the caller's position out of the query string, when supplied. */
const positionFrom = (query) =>
  query.latitude !== undefined && query.longitude !== undefined
    ? { latitude: Number(query.latitude), longitude: Number(query.longitude) }
    : null;

exports.list = async (req, res) => {
  const { items, pagination } = await service.list(req.query, req.user);

  // V3 §28. Recorded after the results are in hand so a tracking failure can
  // never cost the customer their search, and awaited nowhere for the same reason.
  if (req.query.search) {
    analyticsEvents.record(analyticsEvents.EVENT_TYPES.SEARCH, {
      userId: req.user?.id ?? null,
      term: req.query.search,
      city: req.query.city ?? null,
      categoryId: req.query.categoryId ?? null,
    });
  }

  paginated(res, items, pagination);
};

exports.detail = async (req, res) => {
  const offer = await service.getById(req.params.id, req.user, { position: positionFrom(req.query) });
  ok(res, offer);
};

exports.create = async (req, res) => {
  const offer = await service.create(req.body, req.user);
  await audit.record(req, {
    action: 'OFFER_CREATED',
    entityType: 'offer',
    entityId: offer.id,
    newValue: { title: offer.title, shopId: offer.shop.id, status: offer.status },
  });
  created(res, offer);
};

exports.update = async (req, res) => {
  const offer = await service.update(req.params.id, req.body, req.user, req.offer);
  await audit.record(req, {
    action: 'OFFER_UPDATED',
    entityType: 'offer',
    entityId: offer.id,
    oldValue: audit.sanitize(req.offer),
    newValue: { title: offer.title, status: offer.status, endDate: offer.endDate },
  });
  ok(res, offer);
};

exports.updateStatus = async (req, res) => {
  const offer = await service.changeStatus(req.offer, req.body.status, req.user);
  await audit.record(req, {
    action: req.body.status === 'deactivated' ? 'OFFER_DEACTIVATED' : 'OFFER_STATUS_CHANGED',
    entityType: 'offer',
    entityId: offer.id,
    oldValue: { status: req.offer.status },
    newValue: { status: offer.status },
  });
  ok(res, offer);
};

exports.remove = async (req, res) => {
  await service.remove(req.params.id);
  await audit.record(req, {
    action: 'OFFER_DELETED',
    entityType: 'offer',
    entityId: Number(req.params.id),
    oldValue: audit.sanitize(req.offer),
  });
  noContent(res);
};

exports.track = async (req, res) => {
  await service.trackEvent(req.params.id, req.body, req.user, req.ip);
  noContent(res);
};

exports.listReviews = async (req, res) => {
  const { items, pagination } = await reviewService.listForOffer(req.params.id, req.query, req.user);
  paginated(res, items, pagination);
};

exports.createReview = async (req, res) => {
  const review = await reviewService.upsertForOffer(req.params.id, req.body, req.user);
  created(res, review);
};
