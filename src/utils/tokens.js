'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

/** Signs the short lived access token. Permissions are resolved per request, not baked in. */
function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user.id), email: user.email, type: 'access' },
    env.jwt.accessSecret,
    { expiresIn: env.jwt.accessExpiresIn },
  );
}

function signRefreshToken(user, jti) {
  return jwt.sign(
    { sub: String(user.id), jti, type: 'refresh' },
    env.jwt.refreshSecret,
    { expiresIn: env.jwt.refreshExpiresIn },
  );
}

function verifyAccessToken(token) {
  const payload = jwt.verify(token, env.jwt.accessSecret);
  if (payload.type !== 'access') throw new jwt.JsonWebTokenError('Wrong token type');
  return payload;
}

function verifyRefreshToken(token) {
  const payload = jwt.verify(token, env.jwt.refreshSecret);
  if (payload.type !== 'refresh') throw new jwt.JsonWebTokenError('Wrong token type');
  return payload;
}

/** Random URL-safe token for email links; only its SHA-256 digest is stored. */
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Converts "15m" / "30d" / "3600" to milliseconds. */
function durationToMs(value) {
  const match = /^(\d+)([smhd])?$/.exec(String(value).trim());
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2] || 's';
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return amount * multipliers[unit];
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  randomToken,
  hashToken,
  durationToMs,
};
