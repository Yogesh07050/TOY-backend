'use strict';

const env = require('./env');

/**
 * The single answer to "is this browser origin one of ours?".
 *
 * Two separate defences ask that question - CORS decides whether a browser may
 * *read* our response, and the CSRF guard decides whether a cookie-authenticated
 * *write* is allowed to happen at all - and they have to agree. When they were
 * two independent lists, adding a staging origin to one and forgetting the
 * other produced a site that could log in but not log out.
 *
 * Any localhost origin is acceptable while developing. The dev server does not
 * always get the port it asks for - if 4200 is taken it moves to 4201 - and a
 * fixed allow list turns that into an unexplained login failure. Production is
 * unaffected: there, only CORS_ORIGINS is honoured.
 */
const isLocalDevOrigin = (origin) =>
  !env.isProduction && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

const isAllowedOrigin = (origin) =>
  Boolean(origin) && (env.corsOrigins.includes(origin) || isLocalDevOrigin(origin));

module.exports = { isAllowedOrigin, isLocalDevOrigin };
