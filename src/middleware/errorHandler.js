'use strict';

const multer = require('multer');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');

const notFoundHandler = (req, _res, next) => {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
};

/** Maps driver-level errors onto friendly messages without leaking internals. */
function translate(error) {
  if (error instanceof ApiError) return error;

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') return ApiError.badRequest('File is too large');
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
    case 'ECONNREFUSED':
    case 'PROTOCOL_CONNECTION_LOST':
      return new ApiError(503, 'Database is unavailable');
    default:
      break;
  }

  if (error.type === 'entity.parse.failed') return ApiError.badRequest('Malformed JSON body');
  return null;
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity
function errorHandler(error, req, res, _next) {
  const apiError = translate(error) || new ApiError(500, 'Something went wrong on our side');

  if (apiError.status >= 500) {
    console.error('[error] %s %s -> %s', req.method, req.originalUrl, error.stack || error.message);
  }

  const body = {
    success: false,
    error: {
      code: apiError.code || 'INTERNAL_ERROR',
      message: apiError.message,
    },
  };
  if (apiError.details) body.error.details = apiError.details;
  if (!env.isProduction && apiError.status >= 500) body.error.stack = error.stack;

  res.status(apiError.status).json(body);
}

module.exports = { notFoundHandler, errorHandler };
