'use strict';

const service = require('./auth.service');
const audit = require('../../utils/audit');
const { ok, created } = require('../../utils/respond');
const env = require('../../config/env');
const tokens = require('../../utils/tokens');

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

exports.login = async (req, res) => {
  const result = await service.login(req.body, req);
  setRefreshCookie(res, result.refreshToken);
  ok(res, result);
};

exports.refresh = async (req, res) => {
  const result = await service.refresh(readRefreshToken(req), req);
  setRefreshCookie(res, result.refreshToken);
  ok(res, result);
};

exports.logout = async (req, res) => {
  await service.logout(readRefreshToken(req), req.user?.id);
  clearRefreshCookie(res);
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
