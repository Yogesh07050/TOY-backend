'use strict';

const multer = require('multer');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const failureLog = require('../services/failureLog');

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

  if (apiError.status >= 500) {
    console.error(
      '[error] %s %s %s -> %s',
      req.id ?? '-',
      req.method,
      req.originalUrl,
      error.stack || error.message,
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
