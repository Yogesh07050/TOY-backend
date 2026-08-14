'use strict';

const service = require('./service.service');
const analyticsEvents = require('../../services/analyticsEvents');
const audit = require('../../utils/audit');
const { ok, created, noContent, paginated } = require('../../utils/respond');

const positionFrom = (query) =>
  query.latitude !== undefined && query.longitude !== undefined
    ? { latitude: Number(query.latitude), longitude: Number(query.longitude) }
    : null;

exports.list = async (req, res) => {
  const { items, pagination } = await service.list(req.query, req.user);

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
  const record = await service.getById(req.params.id, req.user, { position: positionFrom(req.query) });
  ok(res, record);
};

exports.create = async (req, res) => {
  const record = await service.create(req.body, req.user);
  await audit.record(req, {
    action: 'SERVICE_CREATED',
    entityType: 'service',
    entityId: record.id,
    newValue: { name: record.name, shopId: record.shop.id, status: record.status },
  });
  created(res, record);
};

exports.update = async (req, res) => {
  const record = await service.update(req.params.id, req.body, req.user, req.service);
  await audit.record(req, {
    action: 'SERVICE_UPDATED',
    entityType: 'service',
    entityId: record.id,
    oldValue: audit.sanitize(req.service),
    newValue: { name: record.name, status: record.status },
  });
  ok(res, record);
};

exports.updateStatus = async (req, res) => {
  const record = await service.changeStatus(req.service, req.body.status, req.user);
  await audit.record(req, {
    action: req.body.status === 'deactivated' ? 'SERVICE_DEACTIVATED' : 'SERVICE_STATUS_CHANGED',
    entityType: 'service',
    entityId: record.id,
    oldValue: { status: req.service.status },
    newValue: { status: record.status },
  });
  ok(res, record);
};

exports.duplicate = async (req, res) => {
  const record = await service.duplicate(req.service, req.user);
  await audit.record(req, {
    action: 'SERVICE_DUPLICATED',
    entityType: 'service',
    entityId: record.id,
    newValue: { name: record.name, fromId: req.service.id },
  });
  created(res, record);
};

exports.remove = async (req, res) => {
  await service.remove(req.params.id);
  await audit.record(req, {
    action: 'SERVICE_DELETED',
    entityType: 'service',
    entityId: Number(req.params.id),
    oldValue: audit.sanitize(req.service),
  });
  noContent(res);
};

exports.track = async (req, res) => {
  await service.trackEvent(req.params.id, req.body, req.user, req.ip);
  noContent(res);
};

exports.book = async (req, res) => {
  const booking = await service.createBooking(req.params.id, req.body, req.user);
  created(res, booking);
};

exports.updateBookingStatus = async (req, res) => {
  const booking = await service.updateBookingStatus(req.params.bookingId, req.body.status, req.user);
  await audit.record(req, {
    action: 'SERVICE_BOOKING_STATUS_CHANGED',
    entityType: 'service_booking',
    entityId: Number(req.params.bookingId),
    newValue: { status: booking.status },
  });
  ok(res, booking);
};
