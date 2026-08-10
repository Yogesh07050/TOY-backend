'use strict';

const jwt = require('jsonwebtoken');
const ApiError = require('../utils/ApiError');
const { verifyAccessToken } = require('../utils/tokens');
const { queryOne } = require('../db/pool');
const access = require('../services/accessControl');

function readBearer(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

async function resolveUser(token) {
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new ApiError(401, 'Access token expired', undefined, 'TOKEN_EXPIRED');
    }
    throw ApiError.unauthorized('Invalid access token');
  }

  const user = await queryOne(
    `SELECT id, name, email, phone, status, email_verified, avatar_url,
            pref_city, pref_latitude, pref_longitude
       FROM users WHERE id = ?`,
    [payload.sub],
  );

  if (!user) throw ApiError.unauthorized('Account no longer exists');
  if (user.status !== 'active') throw ApiError.forbidden('This account has been deactivated');

  const context = await access.loadAccessContext(user.id);
  return {
    id: Number(user.id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    emailVerified: Boolean(user.email_verified),
    avatarUrl: user.avatar_url,
    prefCity: user.pref_city,
    prefLatitude: user.pref_latitude,
    prefLongitude: user.pref_longitude,
    ...context,
  };
}

/** Rejects the request unless a valid access token is present. */
async function authenticate(req, _res, next) {
  try {
    const token = readBearer(req);
    if (!token) throw ApiError.unauthorized('Authentication required');
    req.user = await resolveUser(token);
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Attaches `req.user` when a valid token is present but lets anonymous requests
 * through. Public discovery endpoints use this to personalise responses
 * (isFavorite, isFollowing) without requiring a login.
 */
async function optionalAuth(req, _res, next) {
  try {
    const token = readBearer(req);
    if (token) req.user = await resolveUser(token);
  } catch {
    // A bad or expired token on a public route is simply treated as anonymous.
    req.user = undefined;
  }
  next();
}

module.exports = { authenticate, optionalAuth };
