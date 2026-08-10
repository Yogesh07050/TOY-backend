'use strict';

const express = require('express');
const controller = require('./auth.controller');
const schema = require('./auth.schema');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate, optionalAuth } = require('../../middleware/auth');
const { authLimiter, emailLimiter } = require('../../middleware/rateLimit');

const router = express.Router();

router.post(
  '/register',
  authLimiter,
  validate({ body: schema.registerSchema }),
  asyncHandler(controller.register),
);

router.post('/login', authLimiter, validate({ body: schema.loginSchema }), asyncHandler(controller.login));

router.post('/refresh-token', validate({ body: schema.refreshSchema }), asyncHandler(controller.refresh));

router.post('/logout', optionalAuth, asyncHandler(controller.logout));

router.post(
  '/forgot-password',
  emailLimiter,
  validate({ body: schema.forgotPasswordSchema }),
  asyncHandler(controller.forgotPassword),
);

router.post(
  '/reset-password',
  authLimiter,
  validate({ body: schema.resetPasswordSchema }),
  asyncHandler(controller.resetPassword),
);

router.post(
  '/verify-email',
  validate({ body: schema.verifyEmailSchema }),
  asyncHandler(controller.verifyEmail),
);

router.post(
  '/resend-verification',
  emailLimiter,
  validate({ body: schema.resendVerificationSchema }),
  asyncHandler(controller.resendVerification),
);

router.post(
  '/change-password',
  authenticate,
  validate({ body: schema.changePasswordSchema }),
  asyncHandler(controller.changePassword),
);

router.get('/me', authenticate, asyncHandler(controller.me));

module.exports = router;
