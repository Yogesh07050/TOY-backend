'use strict';

const pino = require('pino');
const env = require('../config/env');

/**
 * The application's structured logger (§6, §7, §34, §40, §43).
 *
 * Everything the process has to say goes through here. That is the point of
 * §6 - a log line is a record with fields, not a sentence - and it is what
 * makes §28's dashboard and §30's grouping possible at all. `console.log`
 * produces something a human can read once and nothing can filter, group or
 * alert on.
 *
 * ## Field names
 *
 * §6 specifies snake_case keys (`request_id`, `status_code`, `duration_ms`).
 * Pino's own defaults differ - a numeric `level`, an epoch `time` - so both are
 * reformatted here rather than left for the log aggregator to normalise. A
 * field name is part of the contract with whatever queries these logs; it
 * should be decided once, here, and not depend on which shipper is in front of
 * it.
 *
 * ## What is always present
 *
 * `service`, `environment`, `application_version` and `deployment_id` are on
 * every line by way of `base`. §34 requires the environment on every log so
 * production and staging can never be read as one stream, and §40 requires the
 * version so "did this start after Tuesday's release?" is answerable by
 * filtering rather than by memory.
 *
 * ## What can never be present
 *
 * The `redact` list is the enforcement of §37's "do not log" column, and it is
 * deliberately a property of the logger rather than a rule contributors have to
 * remember. Anyone can write `log.info({ user })` without first checking
 * whether a user object happens to carry `password_hash` - the logger removes
 * it on the way out. Paths are listed in every casing and nesting the codebase
 * actually produces, because redaction that misses `passwordHash` while
 * catching `password_hash` provides only the feeling of safety.
 */

/** §37: values that must never reach a log line, wherever they appear. */
const REDACTED_PATHS = [
  'password',
  'passwordHash',
  'password_hash',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'refresh_token',
  'token_hash',
  'tokenHash',
  'authorization',
  'cookie',
  'apiKey',
  'api_key',
  'secret',
  'keySecret',
  'webhookSecret',
  'signature',
  'cvv',
  'pin',
  'upiPin',
  'cardNumber',
  'card_number',
  // The same keys one level down, which is where they actually turn up: a
  // caught error's `config.headers`, a request context object, a payload echo.
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.refresh_token',
  '*.authorization',
  '*.secret',
  '*.cvv',
  '*.pin',
];

/**
 * Pretty output for a terminal, JSON lines for anything that ships logs.
 *
 * Wrapped in a try: `pino-pretty` is a devDependency, so a production install
 * (`npm ci --omit=dev`) will not have it. Falling back to JSON is strictly
 * better than refusing to boot over log formatting, and JSON is what production
 * wants anyway - this only matters if someone sets LOG_PRETTY there.
 */
function transport() {
  if (!env.logging.pretty) return undefined;
  try {
    require.resolve('pino-pretty');
    return {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        // `singleLine` keeps a request to one terminal line, as the morgan
        // format this replaced did. Expanded over ten lines, a normal request
        // pushes the previous one off the screen and the log stops being
        // readable at exactly the moment you are watching it.
        singleLine: true,
        // Constant on every line, and noise in a terminal where you already
        // know which service and environment you are running.
        ignore: 'pid,hostname,service,environment,application_version,deployment_id',
      },
    };
  } catch {
    return undefined;
  }
}

const logger = pino({
  level: env.logging.level,
  base: {
    // §6, §34, §40. Present on every line, including ones written by libraries
    // through a child logger.
    service: env.logging.service,
    environment: env.nodeEnv,
    application_version: env.logging.version,
    ...(env.logging.deploymentId ? { deployment_id: env.logging.deploymentId } : {}),
  },
  formatters: {
    // §6 and §7 both write levels in upper case; pino defaults to a number.
    level: (label) => ({ level: label.toUpperCase() }),
  },
  // §6's example is ISO-8601 under the key `timestamp`, not epoch under `time`.
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  messageKey: 'message',
  errorKey: 'error',
  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  transport: transport(),
});

/**
 * A logger bound to one request's context (§4, §31).
 *
 * Every line written through the returned child carries the request id, so the
 * §5 trace - controller, service, dependency - assembles itself by filtering on
 * one value. Fields are only attached when they are known: an anonymous request
 * has no `user_id`, and emitting a null for it would make "requests with no
 * user" and "requests we forgot to attribute" indistinguishable.
 *
 * `role` is the caller's highest role rather than the full list. §6 asks for
 * one value and it is a filter, not an audit record - the audit log already
 * holds the authoritative answer.
 */
function forRequest(req) {
  const context = { request_id: req.id };
  if (req.user?.id) context.user_id = String(req.user.id);
  if (req.user?.isSuperAdmin) context.role = 'SUPER_ADMIN';
  else if (req.user?.roleNames?.length) context.role = req.user.roleNames[0];
  const shopId = req.shopId ?? req.shop?.id;
  if (shopId) context.shop_id = String(shopId);
  return logger.child(context);
}

/**
 * The logger for a background job run (§24).
 *
 * A job has no request to correlate against, so its own id takes that role -
 * `JOB-EXPIRY-8271` is to a cron run what `REQ-8F29A1` is to a request.
 */
const forJob = (jobId, name) => logger.child({ job_id: jobId, job: name });

module.exports = logger;
module.exports.forRequest = forRequest;
module.exports.forJob = forJob;
module.exports.REDACTED_PATHS = REDACTED_PATHS;
