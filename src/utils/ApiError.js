'use strict';

/** Error carrying an HTTP status so the error middleware can respond precisely. */
class ApiError extends Error {
  constructor(status, message, details = undefined, code = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.code = code;
    this.expected = true;
  }

  static badRequest(message = 'Bad request', details) {
    return new ApiError(400, message, details, 'BAD_REQUEST');
  }

  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, message, undefined, 'UNAUTHORIZED');
  }

  static forbidden(message = 'You do not have permission to perform this action') {
    return new ApiError(403, message, undefined, 'FORBIDDEN');
  }

  static notFound(message = 'Resource not found') {
    return new ApiError(404, message, undefined, 'NOT_FOUND');
  }

  static conflict(message = 'Resource already exists') {
    return new ApiError(409, message, undefined, 'CONFLICT');
  }

  static unprocessable(message = 'Validation failed', details) {
    return new ApiError(422, message, details, 'VALIDATION_ERROR');
  }

  static tooMany(message = 'Too many requests') {
    return new ApiError(429, message, undefined, 'RATE_LIMITED');
  }
}

module.exports = ApiError;
