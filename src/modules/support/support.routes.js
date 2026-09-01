'use strict';

const express = require('express');
const service = require('./support.service');
const schema = require('./support.schema');
const env = require('../../config/env');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const audit = require('../../utils/audit');
const { authenticate, optionalAuth } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/authorize');
const { supportLimiter } = require('../../middleware/rateLimit');
const { ok, created, paginated } = require('../../utils/respond');

const router = express.Router();

/**
 * Contact details and the category list, for the Support and Privacy pages.
 *
 * Public, and served rather than baked into the client so the number a customer
 * calls can be changed without shipping a new bundle - the web app and the
 * mobile app then read the same one, which is the whole point of it being here.
 */
router.get('/contact', (_req, res) => {
  ok(res, {
    email: env.support.email,
    phones: env.support.phones,
    categories: schema.CATEGORIES,
  });
});

/**
 * Raise a support request.
 *
 * `optionalAuth` rather than `authenticate`: browsing needs no account (§3), so
 * neither can asking for help - and "I can't sign in" is a support request that
 * by definition cannot be filed from behind a login. A signed-in caller is
 * recognised and the ticket is attached to their account, which is what makes
 * it show up under their own requests later.
 */
router.post(
  '/tickets',
  supportLimiter,
  optionalAuth,
  validate({ body: schema.createTicketSchema }),
  asyncHandler(async (req, res) => {
    const ticket = await service.create(req.body, req.user);
    created(res, ticket);
  }),
);

/**
 * The support queue. Ahead of `/tickets/:id` so `mine` is not read as an id.
 */
router.get(
  '/tickets',
  authenticate,
  requirePermission('VIEW_SUPPORT_TICKETS'),
  validate({ query: schema.listTicketsSchema }),
  asyncHandler(async (req, res) => {
    const { items, pagination } = await service.listAll(req.query);
    paginated(res, items, pagination);
  }),
);

router.get(
  '/tickets/count',
  authenticate,
  requirePermission('VIEW_SUPPORT_TICKETS'),
  asyncHandler(async (_req, res) => ok(res, await service.openCount())),
);

/** The caller's own requests. Any signed-in user, no permission needed. */
router.get(
  '/tickets/mine',
  authenticate,
  validate({ query: schema.myTicketsSchema }),
  asyncHandler(async (req, res) => {
    const { items, pagination } = await service.listMine(req.query, req.user);
    paginated(res, items, pagination);
  }),
);

/** Owner or support only - the service decides which, and refuses as a 404. */
router.get(
  '/tickets/:id',
  authenticate,
  validate({ params: schema.idParam }),
  asyncHandler(async (req, res) => ok(res, await service.getForUser(req.params.id, req.user))),
);

router.post(
  '/tickets/:id/messages',
  authenticate,
  validate({ params: schema.idParam, body: schema.addMessageSchema }),
  asyncHandler(async (req, res) => {
    created(res, await service.addMessage(req.params.id, req.body, req.user));
  }),
);

router.patch(
  '/tickets/:id',
  authenticate,
  requirePermission('MANAGE_SUPPORT_TICKETS'),
  validate({ params: schema.idParam, body: schema.updateTicketSchema }),
  asyncHandler(async (req, res) => {
    const ticket = await service.update(req.params.id, req.body, req.user);
    // Who closed a complaint, and when, is exactly the kind of thing a dispute
    // asks about later (§50).
    await audit.record(req, {
      action: 'SUPPORT_TICKET_UPDATED',
      entityType: 'support_ticket',
      entityId: ticket.id,
      newValue: { status: ticket.status, priority: ticket.priority, assignedTo: ticket.assignedTo },
    });
    ok(res, ticket);
  }),
);

module.exports = router;
