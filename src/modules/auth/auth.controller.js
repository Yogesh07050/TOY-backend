'use strict';

const service = require('./auth.service');
const audit = require('../../utils/audit');
const { ok, created } = require('../../utils/respond');
const env = require('../../config/env');

/**
 * The refresh token is returned in the body (for non-browser clients) *and* set
 * as an httpOnly cookie, which is what the Angular app uses - keeping it out of
 * JavaScript-readable storage limits the blast radius of an XSS bug.
 */
function setRefreshCookie(res, refreshToken) {
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: env.isProduction ? 'strict' : 'lax',
    path: `${env.apiPrefix}/auth`,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

const clearRefreshCookie = (res) =>
  res.clearCookie('refresh_token', { path: `${env.apiPrefix}/auth` });

const readRefreshToken = (req) => req.body?.refreshToken || req.cookies?.refresh_token || null;

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
  await service.forgotPassword(req.body.email);
  ok(res, { message: 'If an account exists for that address, a reset link has been sent.' });
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
  await service.resendVerification(req.body.email);
  ok(res, { message: 'If the address needs verification, a new link has been sent.' });
};

exports.changePassword = async (req, res) => {
  await service.changePassword(req.user.id, req.body);
  await audit.record(req, { action: 'PASSWORD_CHANGED', entityType: 'user', entityId: req.user.id });
  ok(res, { message: 'Password updated.' });
};

exports.me = async (req, res) => {
  ok(res, await service.me(req.user.id));
};
