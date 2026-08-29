'use strict';

/**
 * The endpoint label for a request, as one stable pattern.
 *
 * Grouping (§30), per-endpoint dashboards (§28) and spike detection (§29) all
 * need one endpoint to be one value. `/offers/8821` and `/offers/8822` are the
 * same endpoint; recorded literally they scatter a single broken route into
 * thousands of labels and no aggregate over it means anything.
 *
 * ## Why not `req.route.path`
 *
 * Express knows the pattern it matched, and reading `req.baseUrl + req.route.path`
 * looks like the obvious way to get `/api/offers/:id`. It does not survive the
 * response: Express mutates `req.baseUrl` while dispatching into a mounted
 * router and *restores it* on the way out, so by the time a `finish` handler or
 * an app-level error handler runs, `req.route` is still set but `baseUrl` is
 * back to `''`. The result is a confident-looking `/:id` with the mount prefix
 * silently missing - which is exactly the sort of value that is wrong in a way
 * nobody notices until they try to search for it.
 *
 * So the label is derived from `originalUrl`, which Express never rewrites.
 * Numeric segments are the only thing generalised; slugs are low-cardinality by
 * nature and more useful left intact.
 */

const MAX_LENGTH = 255;

function endpointFor(req) {
  const path = (req?.originalUrl ?? '/').split('?')[0];
  return path.replace(/\/\d+/g, '/:id').slice(0, MAX_LENGTH) || '/';
}

module.exports = endpointFor;
module.exports.MAX_LENGTH = MAX_LENGTH;
