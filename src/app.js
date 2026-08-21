'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const env = require('./config/env');
const routes = require('./routes');
const { healthCheck } = require('./db/pool');
const mailer = require('./utils/mailer');
const { apiLimiter } = require('./middleware/rateLimit');
const cachePolicy = require('./middleware/cachePolicy');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

// Behind a reverse proxy (nginx / load balancer) so req.ip and the rate limiter
// see the real client address rather than the proxy's.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    // Uploaded images are served from this origin and embedded by the SPA on
    // another one, so the default same-origin policy has to be relaxed.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: env.isProduction ? undefined : false,
  }),
);

app.use(
  cors({
    origin(origin, callback) {
      // Requests without an Origin header (curl, server-to-server) are allowed;
      // browsers always send one, and those must be on the allow list.
      if (!origin || env.corsOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
  }),
);

app.use(compression());
app.use(
  express.json({
    limit: '1mb',
    // The Razorpay webhook signature is an HMAC over the exact bytes sent
    // (§8.1). Re-serialising the parsed object would reorder keys and change
    // whitespace, so the raw buffer is kept for that one verification.
    verify: (req, _res, buffer) => {
      if (buffer?.length) req.rawBody = buffer;
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

if (env.nodeEnv !== 'test') {
  app.use(morgan(env.isProduction ? 'combined' : 'dev'));
}

// Processed images. `immutable` is safe because filenames are content-unique.
app.use(
  '/uploads',
  express.static(env.storage.uploadDir, { maxAge: '30d', immutable: true, fallthrough: true }),
);

app.get('/health', async (_req, res) => {
  const database = await healthCheck().catch(() => false);
  res.status(database ? 200 : 503).json({
    success: database,
    data: {
      status: database ? 'ok' : 'degraded',
      database,
      // Surfaced so "why did no email arrive?" is answerable without log access.
      email: mailer.isConfigured ? 'smtp' : 'not-configured',
      uptime: process.uptime(),
    },
  });
});

// Guest/authenticated cache separation (§26). Sits ahead of the router so it
// applies to every API response, including error responses.
app.use(env.apiPrefix, apiLimiter, cachePolicy, routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
