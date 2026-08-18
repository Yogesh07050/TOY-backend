'use strict';

const express = require('express');
const { z } = require('zod');
const service = require('./payment.service');
const webhook = require('./payment.webhook');
const razorpay = require('../../services/razorpay');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate } = require('../../middleware/auth');
const { requireSuperAdmin } = require('../../middleware/authorize');
const { limitOffset, paginationSchema } = require('../../utils/pagination');
const { ok, paginated } = require('../../utils/respond');

const router = express.Router();

/**
 * Payment gateway endpoints (§8, §18).
 *
 * The webhook is deliberately unauthenticated and un-rate-limited by user: the
 * caller is Razorpay, and its HMAC signature is the credential.
 */
router.post(
  '/razorpay/webhook',
  asyncHandler(async (req, res) => {
    const result = await webhook.process(req);
    res.status(result.status).json(result.body);
  }),
);

/**
 * What the client needs to open Checkout. The key *id* is public by design -
 * it identifies the merchant account; the key secret never leaves the server.
 */
router.get(
  '/config',
  asyncHandler(async (_req, res) => {
    ok(res, {
      gateway: 'razorpay',
      enabled: razorpay.isConfigured,
      keyId: razorpay.isConfigured ? razorpay.keyId : null,
      currency: 'INR',
      methods: ['card', 'upi', 'netbanking', 'wallet'],
      supportsAutopay: true,
    });
  }),
);

router.use(authenticate);

/** Platform-wide payment ledger, Super Admin only (§31). */
router.get(
  '/transactions',
  requireSuperAdmin,
  validate({
    query: z.object({
      ...paginationSchema,
      status: z
        .enum([
          'CREATED',
          'PENDING',
          'AUTHORIZED',
          'CAPTURED',
          'FAILED',
          'REFUNDED',
          'PARTIALLY_REFUNDED',
          'CANCELLED',
        ])
        .optional(),
      shopId: z.coerce.number().int().positive().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { limit, offset, page } = limitOffset(req.query);
    const { items, total } = await service.allTransactions({
      limit,
      offset,
      status: req.query.status,
      shopId: req.query.shopId,
    });
    paginated(res, items, { page, limit, total });
  }),
);

module.exports = router;
