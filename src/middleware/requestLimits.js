'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Request size limits for the request *line* (§31).
 *
 * The body is already capped at 1 MB by the JSON and urlencoded parsers, and
 * uploads by multer's `fileSize`. What neither covers is the URL, and the
 * defaults that do cover it are generous and invisible: Node caps all headers
 * together at 16 KB, and Express's query parser allows 1000 parameters. Both
 * are far above anything this API has a use for, and neither is stated
 * anywhere a go-live review (§66) could check.
 *
 * So the ceilings are named here instead. They sit well above the largest real
 * request - the longest legitimate query string in the app is a discovery call
 * with a search term, a city, a position and a page, comfortably under 500
 * characters - and well below what makes parsing or logging expensive.
 *
 * This runs before the body parsers: rejecting an oversized request should not
 * cost the read of its body (§31, "reject oversized requests before expensive
 * processing").
 */

const MAX_URL_LENGTH = 2048;
const MAX_QUERY_PARAMS = 50;

function requestLimits(req, _res, next) {
  if (req.originalUrl.length > MAX_URL_LENGTH) {
    // 414 is the specific answer for this, and unlike a generic 400 it tells a
    // client library it should stop rather than retry.
    return next(new ApiError(414, 'This request URL is too long.', undefined, 'URI_TOO_LONG'));
  }

  const queryString = req.originalUrl.slice(req.originalUrl.indexOf('?') + 1);
  // Counted off the raw string rather than `req.query`, which is a getter that
  // parses on access - the point is to refuse before paying for the parse.
  if (req.originalUrl.includes('?') && queryString.split('&').length > MAX_QUERY_PARAMS) {
    return next(
      new ApiError(400, 'This request has too many parameters.', undefined, 'TOO_MANY_PARAMETERS'),
    );
  }

  next();
}

module.exports = requestLimits;
module.exports.MAX_URL_LENGTH = MAX_URL_LENGTH;
module.exports.MAX_QUERY_PARAMS = MAX_QUERY_PARAMS;
