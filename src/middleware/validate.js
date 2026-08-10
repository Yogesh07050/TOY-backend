'use strict';

const { ZodError } = require('zod');
const ApiError = require('../utils/ApiError');

/**
 * Validates and *replaces* the given request part with the parsed result, so
 * handlers only ever see coerced, whitelisted values.
 *
 *   router.post('/', validate({ body: createOfferSchema }), controller.create)
 */
const validate = (schemas) => (req, _res, next) => {
  try {
    for (const part of ['body', 'query', 'params']) {
      if (!schemas[part]) continue;
      const parsed = schemas[part].parse(req[part]);
      // `req.query` is a getter on the Express prototype, so a plain assignment
      // would throw in strict mode - define an own property to shadow it.
      Object.defineProperty(req, part, { value: parsed, writable: true, configurable: true, enumerable: true });
    }
    next();
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        message: issue.message,
      }));
      return next(ApiError.unprocessable('Validation failed', details));
    }
    next(error);
  }
};

module.exports = validate;
