'use strict';

const ApiError = require('../utils/ApiError');
const { isAllowedOrigin } = require('../config/origins');

/**
 * CSRF protection for cookie-authenticated writes (§52).
 *
 * The refresh session lives in an httpOnly cookie (§14), which is what keeps it
 * out of reach of an XSS bug - but a cookie is attached by the browser to *any*
 * request to this API, including one triggered by a page on another site. CORS
 * does not help: it decides whether the attacker may read the response, not
 * whether the request happens. A form post from evil.com to `/auth/logout`
 * signs the user out, and one to `/auth/refresh-token` rotates their session
 * out from under them. In production the cookie is `SameSite=none` - the API
 * and the SPA are on different domains, so it has to be - which removes the
 * browser's own last defence.
 *
 * So the origin is checked explicitly. `Origin` is set by the browser on every
 * cross-origin request and on all same-origin POSTs, and cannot be forged by
 * page script; `Referer` is the fallback for the handful of older browsers that
 * omit `Origin` on same-origin requests.
 *
 * Scope is deliberately narrow - this only refuses requests that are *both*
 * state-changing and carrying the cookie:
 *
 *   - Safe methods (GET/HEAD/OPTIONS) are untouched. They change nothing, and
 *     gating them would break ordinary navigation.
 *   - Requests with no session cookie are untouched. A React Native client
 *     sends a Bearer token, which no browser attaches automatically, so it is
 *     not forgeable in the first place - and native clients send no Origin.
 *   - A request with neither header *and* no cookie is a non-browser caller
 *     (curl, a server-to-server integration, the Razorpay webhook) and passes.
 *
 * What is left is exactly the browser-with-a-cookie case, where a missing or
 * foreign Origin means the request did not come from our own app.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The origin of a URL, or null if it is not parseable as one. */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function csrfGuard(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!req.cookies?.refresh_token) return next();

  const claimed = req.get('Origin') || originOf(req.get('Referer') || '');

  // A cookie-bearing request always comes from a browser, and a browser always
  // sets one of the two on a cross-site write. Absent both, treat it as hostile
  // rather than as a trusted non-browser caller - a real API client would not
  // be holding this cookie.
  if (!isAllowedOrigin(claimed)) {
    return next(
      new ApiError(
        403,
        "This request didn't come from a recognised app. Please refresh the page and try again.",
        undefined,
        'CSRF_ORIGIN_REJECTED',
      ),
    );
  }

  next();
}

module.exports = csrfGuard;
