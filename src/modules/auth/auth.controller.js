'use strict';

const service = require('./auth.service');
const audit = require('../../utils/audit');
const { ok, created } = require('../../utils/respond');
const env = require('../../config/env');
const tokens = require('../../utils/tokens');
const logger = require('../../utils/logger');
const { maskEmail } = require('../../utils/mask');
const deviceInfo = require('../../utils/device');

/**
 * The refresh token is returned in the body (for non-browser clients) *and* set
 * as an httpOnly cookie, which is what the Angular app uses (§22) - keeping it
 * out of JavaScript-readable storage limits the blast radius of an XSS bug.
 *
 * SameSite is configurable because the right value depends on the deployment:
 * an API and SPA on the same site can use Lax, while a separate API domain
 * needs None (and therefore Secure) for the cookie to be sent at all.
 */
function cookieOptions() {
  return {
    httpOnly: true,
    secure: env.refreshCookie.secure,
    sameSite: env.refreshCookie.sameSite,
    ...(env.refreshCookie.domain ? { domain: env.refreshCookie.domain } : {}),
    path: `${env.apiPrefix}/auth`,
  };
}

function setRefreshCookie(res, refreshToken) {
  res.cookie('refresh_token', refreshToken, {
    ...cookieOptions(),
    maxAge: tokens.durationToMs(env.jwt.refreshExpiresIn),
  });
}

const clearRefreshCookie = (res) => res.clearCookie('refresh_token', cookieOptions());

const readRefreshToken = (req) => req.body?.refreshToken || req.cookies?.refresh_token || null;

/**
 * Web clients hold the refresh token in a cookie they cannot read, so they
 * cannot echo it back to say "this session". The cookie itself identifies it.
 */
const currentFamily = (req) => service.familyForToken(readRefreshToken(req));

exports.register = async (req, res) => {
  const result = await service.register(req.body, req);
  setRefreshCookie(res, result.refreshToken);
  // The registrant is the actor for this entry; the request had no user yet.
  req.user = { id: result.user.id };
  await audit.record(req, {
    action: 'USER_REGISTERED',
    entityType: 'user',
    entityId: result.user.id,
    newValue: { email: result.user.email },
  });
  created(res, result);
};

/**
 * Authentication event context (§18).
 *
 * §18 lists what a failed login must carry: timestamp, request id, an account
 * reference where there is one, IP metadata, device/platform and the result.
 * Timestamp and request id come from the logger; the rest is assembled here.
 *
 * The email is masked (§37). It has to be *something* - "a login failed" with
 * no subject cannot be investigated, and cannot answer the customer who is on
 * the phone saying they cannot get in - but a log of full addresses paired
 * with failures is a credential-stuffing target list, so `t***@example.com` is
 * the compromise: enough to confirm which account, not enough to enumerate.
 *
 * The password is never touched, in any form. Not its length, not a hash.
 */
function authContext(req, email) {
  const device = deviceInfo.describe(req);
  return {
    account: email ? maskEmail(email) : undefined,
    ip_address: device.ipAddress,
    device_type: device.deviceType,
    platform: device.platform,
  };
}

exports.login = async (req, res) => {
  const context = authContext(req, req.body?.email);

  let result;
  try {
    result = await service.login(req.body, req);
  } catch (error) {
    // §18: a failed login is its own event, at WARN. The generic 401 the error
    // handler logs cannot say which account was targeted, and the *pattern* of
    // failures per account is what §29's login-failure alert is built on.
    (req.log ?? logger).warn(
      {
        ...context,
        event: 'LOGIN_FAILED',
        error_code: 'AUTH_INVALID_CREDENTIALS',
        category: 'AUTHENTICATION',
        result: 'FAILURE',
        // Distinguishes "wrong credentials" from "account deactivated"; the
        // customer is told neither, but support needs to know which it was.
        reason: error.status === 403 ? 'ACCOUNT_DEACTIVATED' : 'INVALID_CREDENTIALS',
      },
      'Login failed',
    );
    throw error;
  }

  setRefreshCookie(res, result.refreshToken);
  // §50 lists login among the actions that must be auditable. The device the
  // session was opened from is the detail an investigation actually needs.
  req.user = { id: result.user.id };
  await audit.record(req, {
    action: 'LOGIN',
    entityType: 'user',
    entityId: result.user.id,
    newValue: { email: result.user.email },
  });
  (req.log ?? logger).info(
    { ...context, event: 'LOGIN_SUCCEEDED', user_id: String(result.user.id), result: 'SUCCESS' },
    'Login succeeded',
  );
  ok(res, result);
};

exports.refresh = async (req, res) => {
  let result;
  try {
    result = await service.refresh(readRefreshToken(req), req);
  } catch (error) {
    // §18. WARN rather than ERROR: the common cause is an expired session,
    // which is the system working. The signal is in the rate, which is why it
    // needs to be countable (§29).
    (req.log ?? logger).warn(
      {
        ...authContext(req),
        event: 'REFRESH_FAILED',
        error_code: 'AUTH_REFRESH_FAILED',
        category: 'AUTHENTICATION',
        result: 'FAILURE',
      },
      'Token refresh failed',
    );
    throw error;
  }

  setRefreshCookie(res, result.refreshToken);
  (req.log ?? logger).debug(
    { event: 'REFRESH_SUCCEEDED', user_id: String(result.user.id), result: 'SUCCESS' },
    'Token refreshed',
  );
  ok(res, result);
};

exports.logout = async (req, res) => {
  // Captured before the token is spent - afterwards there is nothing left to
  // identify who signed out, since `optionalAuth` leaves `req.user` unset for a
  // client that sent only its refresh cookie.
  const userId = req.user?.id ?? null;
  await service.logout(readRefreshToken(req), userId);
  clearRefreshCookie(res);
  // §50. An unauthenticated logout - an already-expired access token, or a
  // cookie for a session that is gone - is a no-op and not worth a row.
  if (userId) await audit.record(req, { action: 'LOGOUT', entityType: 'user', entityId: userId });
  ok(res, { message: 'Signed out' });
};

exports.forgotPassword = async (req, res) => {
  const result = await service.forgotPassword(req.body.email);
  ok(res, {
    message: result?.delivered
      ? 'If an account exists for that address, a reset link has been sent.'
      : 'Email delivery is not configured on this server, so no message could be sent.',
    delivered: Boolean(result?.delivered),
  });
};

exports.resetPassword = async (req, res) => {
  await service.resetPassword(req.body);
  clearRefreshCookie(res);
  ok(res, { message: 'Password updated. Please sign in again.' });
};

exports.verifyEmail = async (req, res) => {
  await service.verifyEmail(req.body.token);
  ok(res, { message: 'Email verified.' });
};

exports.resendVerification = async (req, res) => {
  const result = await service.resendVerification(req.body.email);
  ok(res, {
    message: result?.delivered
      ? 'If the address needs verification, a new link has been sent.'
      : 'Email delivery is not configured on this server, so no message could be sent.',
    delivered: Boolean(result?.delivered),
  });
};

exports.changePassword = async (req, res) => {
  await service.changePassword(req.user.id, req.body, await currentFamily(req));
  await audit.record(req, { action: 'PASSWORD_CHANGED', entityType: 'user', entityId: req.user.id });
  ok(res, { message: 'Password updated. Other devices have been signed out.' });
};

// ---- Device sessions (§27, §28) -------------------------------------------

exports.sessions = async (req, res) => {
  ok(res, await service.listSessions(req.user.id, await currentFamily(req)));
};

exports.revokeSession = async (req, res) => {
  const result = await service.revokeSession(req.user.id, req.params.id);
  await audit.record(req, {
    action: 'SESSION_REVOKED',
    entityType: 'user',
    entityId: req.user.id,
    newValue: { sessionId: req.params.id },
  });
  // Revoking the session the request was made with is a logout.
  if (req.params.id === (await currentFamily(req))) clearRefreshCookie(res);
  ok(res, result);
};

exports.revokeOtherSessions = async (req, res) => {
  const result = await service.revokeOtherSessions(req.user.id, await currentFamily(req));
  await audit.record(req, {
    action: 'OTHER_SESSIONS_REVOKED',
    entityType: 'user',
    entityId: req.user.id,
    newValue: result,
  });
  ok(res, result);
};

exports.me = async (req, res) => {
  ok(res, await service.me(req.user.id));
};
