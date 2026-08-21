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
const ApiError = require('./utils/ApiError');
const { healthCheck } = require('./db/pool');
const mailer = require('./utils/mailer');
const { apiLimiter } = require('./middleware/rateLimit');
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

/**
 * Any localhost origin is acceptable while developing. The dev server does not
 * always get the port it asks for - if 4200 is taken it moves to 4201 - and a
 * fixed allow list turns that into an unexplained login failure. Production is
 * unaffected: there, only CORS_ORIGINS is honoured.
 */
const isLocalDevOrigin = (origin) =>
  !env.isProduction && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

app.use(
  cors({
    origin(origin, callback) {
      // Requests without an Origin header (curl, server-to-server) are allowed;
      // browsers always send one on POST, and those must be on the allow list.
      if (!origin || env.corsOrigins.includes(origin) || isLocalDevOrigin(origin)) {
        return callback(null, true);
      }
      // A disallowed origin is the caller's problem, not a server fault, so it
      // must not surface as a 500 "something went wrong on our side".
      callback(ApiError.forbidden(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
  }),
);

app.use(compression());
app.use(express.json({ limit: '1mb' }));
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

app.use(env.apiPrefix, apiLimiter, routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
