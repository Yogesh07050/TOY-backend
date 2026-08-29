'use strict';

const multer = require('multer');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const failureLog = require('../services/failureLog');
const logger = require('../utils/logger');
const { internalCodeFor, categoryFor } = require('../config/errorCodes');
const endpointFor = require('../utils/endpoint');

const notFoundHandler = (req, _res, next) => {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
};

/** Maps driver-level errors onto friendly messages without leaking internals. */
function translate(error) {
  if (error instanceof ApiError) return error;

  if (error instanceof multer.MulterError) {
    // §49: an unusable image is explained in terms of what to do about it.
    if (error.code === 'LIMIT_FILE_SIZE') {
      return ApiError.badRequest(
        'This image can’t be uploaded. Please choose a supported image format within the allowed size.',
        { reason: 'TOO_LARGE', maxSizeMb: Math.round(env.storage.maxUploadBytes / (1024 * 1024)) },
      );
    }
    if (error.code === 'LIMIT_FILE_COUNT') return ApiError.badRequest('Too many files uploaded');
    return ApiError.badRequest(`Upload error: ${error.message}`);
  }

  switch (error.code) {
    case 'ER_DUP_ENTRY':
      return ApiError.conflict('A record with these details already exists');
    case 'ER_NO_REFERENCED_ROW':
    case 'ER_NO_REFERENCED_ROW_2':
      return ApiError.badRequest('Referenced record does not exist');
    case 'ER_ROW_IS_REFERENCED':
    case 'ER_ROW_IS_REFERENCED_2':
      return ApiError.conflict('This record is still referenced by other data');
    // §38: a database failure is ours to own, and the user is told nothing
    // about it beyond that we know. "Database is unavailable" named the
    // component, which is exactly what §38 says never to expose.
    case 'ECONNREFUSED':
    case 'PROTOCOL_CONNECTION_LOST':
    case 'ER_CON_COUNT_ERROR':
    case 'ETIMEDOUT':
      return ApiError.serviceUnavailable();
    case 'ER_LOCK_WAIT_TIMEOUT':
    case 'ER_LOCK_DEADLOCK':
      // A contended write that gave up. Safe to repeat, unlike a timeout on an
      // operation that may have committed, so the client is told to retry.
      return new ApiError(
        503,
        'This is taking longer than expected. Please try again.',
        undefined,
        'RETRYABLE',
      );
    default:
      break;
  }

  if (error.type === 'entity.parse.failed') return ApiError.badRequest('Malformed JSON body');
  return null;
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity
function errorHandler(error, req, res, _next) {
  const apiError = translate(error) || ApiError.internal();

  /**
   * The developer's half of §3: everything the response is not allowed to say.
   *
   * `error_code` is the specific internal one (`DB_QUERY_TIMEOUT`), not the
   * generic code the caller receives - that split is what lets §28 filter by
   * failure mode while §3 keeps the customer's message empty of detail. The
   * stack goes here and only here; §12 keeps it out of the retained
   * `error_logs` table, where it would sit next to a user id for ninety days.
   *
   * Server faults are ERROR. Everything else is a refusal the system issued on
   * purpose - a validation failure, a wrong password, a plan limit - and
   * logging those at ERROR is how an error dashboard becomes unreadable. They
   * are kept at DEBUG so the trace for one request is still complete when
   * somebody goes looking for it by reference.
   */
  const internalCode = internalCodeFor(error, apiError.code);
  const log = req.log ?? logger.forRequest(req);
  const fields = {
    event: 'REQUEST_FAILED',
    endpoint: endpointFor(req),
    http_method: req.method,
    status_code: apiError.status,
    error_code: internalCode,
    category: categoryFor(internalCode),
    dependency: failureLog.dependencyFor(error, req),
  };

  if (apiError.status >= 500) {
    log.error({ ...fields, stack: error.stack, err_message: error.message }, apiError.message);
  } else {
    log.debug(fields, apiError.message);
  }

  // §19: an authorization refusal is a security signal, not just a 403. Logged
  // at WARN with the resource and action attached so a merchant probing another
  // shop's data is visible without reading every debug line.
  if (apiError.status === 403 || apiError.status === 401) {
    log.warn(
      { ...fields, event: 'AUTHORIZATION_DENIED', result: 'DENIED' },
      `${apiError.status === 401 ? 'Unauthenticated' : 'Unauthorized'} ${req.method} ${fields.endpoint}`,
    );
  }

  // §56. Fire-and-forget: the response must not wait on a log write, and a
  // failing log must not turn a 503 into a hang.
  if (failureLog.isWorthLogging(apiError)) {
    void failureLog.record(error, req, apiError);
  }

  const body = {
    success: false,
    error: {
      code: apiError.code || 'INTERNAL_ERROR',
      message: apiError.message,
    },
  };
  if (apiError.details) body.error.details = apiError.details;

  // §57: the reference is only offered where it is useful - on a failure the
  // user might have to report. Attaching it to every validation error trains
  // people to ignore it.
  if (apiError.status >= 500 && req.id) body.error.requestId = req.id;

  // §37 lists what must never reach a response body: "500 Internal Server
  // Error", "ECONNREFUSED", "Stack trace". Nothing is added here in
  // development either - a developer already has the full stack on stderr, and
  // an environment-dependent body is how a driver code ends up in a screenshot
  // from staging. The request id above is the only handle a user is given, and
  // it resolves to the detail through the failure log (§57).

  res.status(apiError.status).json(body);
}

module.exports = { notFoundHandler, errorHandler };
