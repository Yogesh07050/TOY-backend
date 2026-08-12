'use strict';

const { queryOne, execute, transaction } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const env = require('../../config/env');
const password = require('../../utils/password');
const tokens = require('../../utils/tokens');
const mailer = require('../../utils/mailer');
const access = require('../../services/accessControl');

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

/** Shape of the user object returned to the client - never includes the hash. */
function publicUser(user, context) {
  return {
    id: Number(user.id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    status: user.status,
    emailVerified: Boolean(user.email_verified),
    avatarUrl: user.avatar_url,
    preferredLocation:
      user.pref_city || user.pref_latitude
        ? {
            city: user.pref_city,
            latitude: user.pref_latitude === null ? null : Number(user.pref_latitude),
            longitude: user.pref_longitude === null ? null : Number(user.pref_longitude),
          }
        : null,
    roles: context.roleNames,
    permissions: context.effectivePermissions,
    isSuperAdmin: context.isSuperAdmin,
    canAccessAdmin: context.canAccessAdmin,
    /** Shop-scoped roles that are inert until the user is assigned to a shop. */
    unassignedShopRoles: context.unassignedShopRoles,
    shops: context.shops.map((shop) => ({
      shopId: shop.shopId,
      shopName: shop.shopName,
      shopSlug: shop.shopSlug,
      shopLogoUrl: shop.shopLogoUrl,
      branchId: shop.branchId,
      designation: shop.designation,
      roleName: shop.roleName,
      permissions: shop.permissions,
    })),
  };
}

/** Issues an access + refresh pair and persists the refresh token's digest. */
async function issueSession(user, req) {
  const jti = tokens.randomToken(16);
  const accessToken = tokens.signAccessToken(user);
  const refreshToken = tokens.signRefreshToken(user, jti);
  const expiresAt = new Date(Date.now() + tokens.durationToMs(env.jwt.refreshExpiresIn));

  await execute(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES (?, ?, ?, ?, ?)`,
    [
      user.id,
      tokens.hashToken(refreshToken),
      expiresAt,
      (req?.headers?.['user-agent'] || '').slice(0, 255) || null,
      req?.ip || null,
    ],
  );

  return {
    accessToken,
    refreshToken,
    expiresIn: Math.floor(tokens.durationToMs(env.jwt.accessExpiresIn) / 1000),
  };
}

async function createAuthToken(userId, purpose, ttlMs) {
  const token = tokens.randomToken();
  await execute(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
    [userId, purpose, tokens.hashToken(token), new Date(Date.now() + ttlMs)],
  );
  return token;
}

async function sendVerificationEmail(user) {
  const token = await createAuthToken(user.id, 'email_verification', VERIFY_TTL_MS);
  const url = `${env.appUrl}/auth/verify-email?token=${token}`;
  await mailer.send({ to: user.email, ...mailer.templates.verifyEmail(user.name, url) });
}

// ---------------------------------------------------------------------------

async function register(payload, req) {
  const existing = await queryOne('SELECT id FROM users WHERE email = ?', [payload.email]);
  if (existing) throw ApiError.conflict('An account with this email already exists');

  const passwordHash = await password.hash(payload.password);

  const userId = await transaction(async (connection) => {
    const [result] = await connection.execute(
      `INSERT INTO users (name, email, password_hash, phone) VALUES (?, ?, ?, ?)`,
      [payload.name, payload.email, passwordHash, payload.phone || null],
    );
    const newId = result.insertId;

    // Everyone starts as a Customer (§19); elevation is an explicit admin action.
    await connection.execute(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT ?, id FROM roles WHERE name = 'CUSTOMER'`,
      [newId],
    );
    await connection.execute(`INSERT INTO notification_preferences (user_id) VALUES (?)`, [newId]);
    return newId;
  });

  const user = await queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  await sendVerificationEmail(user);

  const context = await access.loadAccessContext(userId);
  const session = await issueSession(user, req);
  return { user: publicUser(user, context), ...session };
}

async function login({ email, password: plain }, req) {
  const user = await queryOne('SELECT * FROM users WHERE email = ?', [email]);
  // Identical message for unknown email and wrong password so the endpoint
  // cannot be used to enumerate registered addresses.
  const invalid = ApiError.unauthorized('Invalid email or password');
  if (!user) {
    // Spend comparable time so timing does not leak account existence either.
    await password.compare(plain, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
    throw invalid;
  }

  const matches = await password.compare(plain, user.password_hash);
  if (!matches) throw invalid;
  if (user.status !== 'active') throw ApiError.forbidden('This account has been deactivated');

  await execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

  const context = await access.loadAccessContext(user.id);
  const session = await issueSession(user, req);
  return { user: publicUser(user, context), ...session };
}

/** Rotates the refresh token: the presented one is revoked as the new one is issued. */
async function refresh(refreshToken, req) {
  if (!refreshToken) throw ApiError.unauthorized('Refresh token is required');

  let payload;
  try {
    payload = tokens.verifyRefreshToken(refreshToken);
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }

  const stored = await queryOne(
    'SELECT * FROM refresh_tokens WHERE token_hash = ? LIMIT 1',
    [tokens.hashToken(refreshToken)],
  );
  if (!stored || stored.revoked_at || new Date(stored.expires_at) < new Date()) {
    throw ApiError.unauthorized('Refresh token is no longer valid');
  }

  const user = await queryOne('SELECT * FROM users WHERE id = ?', [payload.sub]);
  if (!user) throw ApiError.unauthorized('Account no longer exists');
  if (user.status !== 'active') throw ApiError.forbidden('This account has been deactivated');

  await execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ?', [stored.id]);

  const context = await access.loadAccessContext(user.id);
  const session = await issueSession(user, req);
  return { user: publicUser(user, context), ...session };
}

async function logout(refreshToken, userId) {
  if (refreshToken) {
    await execute(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = ? AND revoked_at IS NULL',
      [tokens.hashToken(refreshToken)],
    );
  } else if (userId) {
    await execute(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
      [userId],
    );
  }
}

async function forgotPassword(email) {
  const user = await queryOne('SELECT * FROM users WHERE email = ?', [email]);
  // Always report success - otherwise this endpoint enumerates accounts.
  if (!user || user.status !== 'active') return;

  const token = await createAuthToken(user.id, 'password_reset', RESET_TTL_MS);
  const url = `${env.appUrl}/auth/reset-password?token=${token}`;
  await mailer.send({ to: user.email, ...mailer.templates.resetPassword(user.name, url) });
}

async function consumeToken(token, purpose) {
  const row = await queryOne(
    `SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = ? LIMIT 1`,
    [tokens.hashToken(token), purpose],
  );
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    throw ApiError.badRequest('This link is invalid or has expired');
  }
  await execute('UPDATE auth_tokens SET used_at = NOW() WHERE id = ?', [row.id]);
  return row;
}

async function resetPassword({ token, password: plain }) {
  const row = await consumeToken(token, 'password_reset');
  const passwordHash = await password.hash(plain);

  await execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, row.user_id]);
  // A password reset invalidates every existing session.
  await execute(
    'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
    [row.user_id],
  );
}

async function verifyEmail(token) {
  const row = await consumeToken(token, 'email_verification');
  await execute('UPDATE users SET email_verified = 1 WHERE id = ?', [row.user_id]);
}

async function resendVerification(email) {
  const user = await queryOne('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || user.email_verified) return;
  await sendVerificationEmail(user);
}

async function changePassword(userId, { currentPassword, password: plain }) {
  const user = await queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw ApiError.notFound('User not found');

  const matches = await password.compare(currentPassword, user.password_hash);
  if (!matches) throw ApiError.badRequest('Current password is incorrect');

  const passwordHash = await password.hash(plain);
  await execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
}

/** Current user + freshly resolved permissions, used by the SPA on boot. */
async function me(userId) {
  const user = await queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw ApiError.notFound('User not found');
  const context = await access.loadAccessContext(userId);
  const unread = await queryOne(
    'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0',
    [userId],
  );
  return { ...publicUser(user, context), unreadNotifications: Number(unread.count) };
}

/** Removes refresh/reset tokens that expired more than a day ago. */
async function pruneExpiredTokens() {
  const [refreshResult, authResult] = await Promise.all([
    execute('DELETE FROM refresh_tokens WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)'),
    execute('DELETE FROM auth_tokens WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)'),
  ]);
  return refreshResult.affectedRows + authResult.affectedRows;
}

module.exports = {
  publicUser,
  register,
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
  changePassword,
  me,
  pruneExpiredTokens,
};
