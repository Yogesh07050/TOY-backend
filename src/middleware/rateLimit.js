'use strict';

const rateLimit = require('express-rate-limit');
const env = require('../config/env');

const message = (text) => ({
  success: false,
  error: { code: 'RATE_LIMITED', message: text },
});

const base = {
  standardHeaders: true,
  legacyHeaders: false,
  // Disabling limits in tests keeps the suite from flaking on repeated calls.
  skip: () => env.nodeEnv === 'test',
};

/** Broad limiter applied to the whole API surface. */
const apiLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  message: message('Too many requests. Please slow down and try again shortly.'),
});

/** Tight limiter for credential endpoints (login, register, reset). */
const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 20,
  // Count failed attempts only, so a legitimate user is never locked out.
  skipSuccessfulRequests: true,
  message: message('Too many authentication attempts. Try again in 15 minutes.'),
});

/** Limiter for endpoints that trigger outbound email. */
const emailLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: message('Too many email requests. Try again in an hour.'),
});

/** Limiter for uploads. */
const uploadLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 100,
  message: message('Too many uploads. Try again shortly.'),
});

/**
 * Limiter for AI generation (§40). Each call costs a provider request, so this
 * sits well below the general API limit. The subscription quota is the real
 * budget; this only stops a stuck client from burning a month's allowance in a
 * few seconds.
 */
const aiLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: 12,
  // Per user rather than per IP: a shop's staff often share an office address.
  keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}` : req.ip),
  message: message('You are generating a lot at once. Please wait a moment and try again.'),
});

module.exports = { apiLimiter, authLimiter, emailLimiter, uploadLimiter, aiLimiter };
