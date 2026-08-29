'use strict';

const logger = require('../utils/logger');
const env = require('../config/env');
const endpointFor = require('../utils/endpoint');
const requestContext = require('../utils/requestContext');

/**
 * Request completion logging and performance banding (§6, §10, §11).
 *
 * One structured line per request, written when the response finishes, with
 * the fields §6 names. This replaces morgan, whose output is a formatted
 * string: readable in a terminal, useless to anything that wants to ask "which
 * endpoints were slow between 10:12 and 10:42".
 *
 * ## Verbosity (§10)
 *
 * §10 is explicit that not every request deserves the same attention: "do not
 * necessarily log every stage for every low-value public GET request". A
 * successful public read is the overwhelming majority of traffic and the least
 * interesting, so it goes to DEBUG and disappears in production. Anything that
 * changed state, failed, or took too long is kept.
 *
 * ## Bands (§11)
 *
 * A slow request is not an error, and logging it as one would train people to
 * ignore errors. It is logged at WARN with an explicit `performance` band, so a
 * dashboard can chart slowness separately from failure - which is the
 * distinction §11 is drawing when it says slow requests "should be visible for
 * performance investigation".
 *
 * The two signals combine by taking the more severe: a 500 that also took three
 * seconds is an error line carrying `performance: VERY_SLOW`, not two lines or
 * a warning that buries the failure.
 */

/** §11's bands. Thresholds are configurable; the names are not. */
function performanceBand(durationMs) {
  if (durationMs >= env.logging.verySlowRequestMs) return 'VERY_SLOW';
  if (durationMs >= env.logging.slowRequestMs) return 'SLOW';
  return 'NORMAL';
}

const isPublicRead = (req, statusCode) => req.method === 'GET' && statusCode < 400;

function httpLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();

  /**
   * The request-scoped logger every downstream layer should use (§4).
   *
   * Lazy, and cached once built: at this point in the chain `req.user` does not
   * exist yet, and a child bound now would carry a null user id for the whole
   * request. Building on first use means a service that logs after
   * authentication gets the user and shop for free, which is most of what §31's
   * context list asks for.
   */
  let bound;
  Object.defineProperty(req, 'log', {
    configurable: true,
    get() {
      if (!bound) bound = logger.forRequest(req);
      return bound;
    },
  });

  /**
   * Everything downstream of here runs inside the request's context, so the
   * database layer can stamp `request_id` on a slow-query or transaction line
   * without the id being passed to it (§4, §12).
   */
  requestContext.run({ requestId: req.id }, () => {
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const rounded = Math.round(durationMs);
      const band = performanceBand(rounded);

      const fields = {
        event: 'REQUEST_COMPLETED',
        endpoint: endpointFor(req),
        http_method: req.method,
        status_code: res.statusCode,
        duration_ms: rounded,
        performance: band,
      };

      // §32/§33: the client tells us what it is, so a backend log line and a
      // crash report from the same app version can be lined up.
      const platform = req.get('X-Client-Platform');
      const version = req.get('X-Client-Version');
      if (platform) fields.platform = platform;
      if (version) fields.client_version = version;

      // The detail of a failure is the error handler's to log - it has the error
      // object. This line records only that the request ended badly, so the two
      // are joined by request_id rather than duplicated.
      const level =
        res.statusCode >= 500 ? 'error'
        : band !== 'NORMAL' ? 'warn'
        : isPublicRead(req, res.statusCode) ? 'debug'
        : 'info';

      req.log[level](fields, `${req.method} ${fields.endpoint} ${res.statusCode} ${rounded}ms`);
    });

    next();
  });
}

module.exports = httpLogger;
module.exports.performanceBand = performanceBand;
