'use strict';

/** Wraps an async route handler so rejected promises reach the error middleware. */
module.exports = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};
