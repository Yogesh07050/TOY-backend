'use strict';

const { query, queryOne, execute, rawQuery } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const catalogue = require('../../config/featureCatalogue');
const plans = require('../../config/plans');
const notifications = require('../../services/notifications');

/**
 * Super Admin feature overrides (§11A-§11L).
 *
 * An override is an entitlement source that sits *alongside* the subscription,
 * never inside it (§11B, §11O). Granting one does not create, modify or pay for
 * a Razorpay subscription, and an override expiring leaves the subscription
 * exactly as it was.
 *
 * Overrides are scoped to a shop, because every entitlement check in the app is
 * per shop. `admin_user_id` records which merchant account the grant was made
 * for, which is what the Super Admin screen searches by.
 */

/**
 * An override only counts while it is active, started, and not yet expired.
 * Written as a function so it can be used with or without a table alias.
 */
const activeClause = (alias = '') => {
  const column = (name) => (alias ? `${alias}.${name}` : name);
  return `${column('status')} = 'active'
    AND ${column('starts_at')} <= NOW()
    AND (${column('is_permanent')} = 1 OR ${column('expires_at')} IS NULL OR ${column('expires_at')} > NOW())`;
};

const ACTIVE_CLAUSE = activeClause();

function mapOverride(row) {
  const entry = catalogue.entryFor(row.feature_key);
  const expired =
    row.status === 'active' &&
    !row.is_permanent &&
    row.expires_at &&
    new Date(row.expires_at) <= new Date();

  return {
    id: Number(row.id),
    shopId: Number(row.shop_id),
    shopName: row.shop_name ?? null,
    adminUserId: row.admin_user_id === null ? null : Number(row.admin_user_id),
    adminName: row.admin_name ?? null,
    featureKey: row.feature_key,
    featureName: entry?.name ?? row.feature_key,
    category: entry?.category ?? 'General',
    kind: entry?.kind ?? 'feature',
    // Reported rather than stored: a row whose expiry has passed reads as
    // expired the moment it does, without waiting for the nightly sweep (§11H).
    status: expired ? 'expired' : row.status,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    isPermanent: Boolean(row.is_permanent),
    reason: row.reason,
    grantedBy: row.granted_by === null ? null : Number(row.granted_by),
    grantedByName: row.granted_by_name ?? null,
    revokedBy: row.revoked_by === null ? null : Number(row.revoked_by),
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_WITH_NAMES = `
  SELECT o.*, s.name AS shop_name, a.name AS admin_name, g.name AS granted_by_name
    FROM feature_overrides o
    JOIN shops s ON s.id = o.shop_id
    LEFT JOIN users a ON a.id = o.admin_user_id
    LEFT JOIN users g ON g.id = o.granted_by`;

/** Appends to the immutable override history (§11I). */
async function recordEvent({
  overrideId,
  shopId,
  adminUserId = null,
  featureKey,
  action,
  previousState = null,
  newState = null,
  startsAt = null,
  expiresAt = null,
  reason = null,
  actorId = null,
}) {
  await execute(
    `INSERT INTO feature_override_events
       (override_id, shop_id, admin_user_id, feature_key, action, previous_state, new_state,
        starts_at, expires_at, reason, actor_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      overrideId ?? null,
      shopId,
      adminUserId,
      featureKey,
      action,
      previousState ? JSON.stringify(previousState) : null,
      newState ? JSON.stringify(newState) : null,
      startsAt,
      expiresAt,
      reason ? String(reason).slice(0, 500) : null,
      actorId,
    ],
  );
}

// ---------------------------------------------------------------------------
// Resolution - the part the rest of the app depends on

/**
 * The feature keys currently granted to a shop by override.
 *
 * Kept deliberately narrow (one indexed read, no joins) because it runs inside
 * every entitlement check.
 */
async function activeKeysForShop(shopId) {
  const rows = await query(
    `SELECT feature_key FROM feature_overrides WHERE shop_id = ? AND ${ACTIVE_CLAUSE}`,
    [shopId],
  );
  return rows.map((row) => row.feature_key);
}

/** Same, for several shops at once, so list endpoints avoid N+1 reads. */
async function activeKeysForShops(shopIds) {
  if (!shopIds.length) return new Map();
  const rows = await rawQuery(
    `SELECT shop_id, feature_key FROM feature_overrides
      WHERE shop_id IN (?) AND ${ACTIVE_CLAUSE}`,
    [shopIds],
  );
  const map = new Map();
  for (const row of rows) {
    const key = Number(row.shop_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row.feature_key);
  }
  return map;
}

/** Active overrides with their expiry, for the "why do I have this?" UI (§11G). */
async function activeForShop(shopId) {
  const rows = await query(
    `${SELECT_WITH_NAMES} WHERE o.shop_id = ? AND ${activeClause('o')} ORDER BY o.feature_key`,
    [shopId],
  );
  return rows.map(mapOverride);
}

// ---------------------------------------------------------------------------
// Super Admin operations (§11C)

/** Validates the feature key against the controlled catalogue (§11J). */
async function assertGrantable(featureKey) {
  if (!catalogue.isGrantable(featureKey)) {
    throw ApiError.badRequest(`"${featureKey}" is not a grantable feature.`);
  }
  const row = await queryOne('SELECT is_active FROM feature_catalogue WHERE feature_key = ?', [
    featureKey,
  ]);
  // The table is the runtime gate: a key can be retired there without a deploy.
  if (row && !row.is_active) {
    throw ApiError.badRequest(`"${featureKey}" is no longer available to grant.`);
  }
}

async function shopOrThrow(shopId) {
  const shop = await queryOne('SELECT id, name FROM shops WHERE id = ?', [shopId]);
  if (!shop) throw ApiError.notFound('Shop not found');
  return shop;
}

/** Whether re-granting a live override pushes its end date out or pulls it in. */
function classifyChange(previous, { isPermanent, expiry }) {
  if (isPermanent) return previous.isPermanent ? 'MODIFIED' : 'EXTENDED';
  if (previous.isPermanent) return 'MODIFIED';
  if (!previous.expiresAt || !expiry) return 'MODIFIED';
  return new Date(expiry) > new Date(previous.expiresAt) ? 'EXTENDED' : 'MODIFIED';
}

/**
 * Grants a feature to a shop, or re-grants / extends an existing row (§11E).
 *
 * The unique key on (shop_id, feature_key) means one row per pairing, so the
 * whole history of "granted, revoked, granted again" for a feature stays in one
 * place with the event log carrying the detail.
 */
async function grant(shopId, payload, actor) {
  const { featureKey, startsAt, expiresAt, isPermanent = false, reason, adminUserId } = payload;

  await assertGrantable(featureKey);
  const shop = await shopOrThrow(shopId);

  if (!isPermanent && !expiresAt) {
    throw ApiError.badRequest('A temporary override needs an expiry date, or mark it permanent.');
  }
  if (isPermanent && expiresAt) {
    throw ApiError.badRequest('A permanent override cannot also have an expiry date.');
  }
  if (expiresAt && startsAt && new Date(expiresAt) <= new Date(startsAt)) {
    throw ApiError.badRequest('The expiry date must be after the start date.');
  }
  if (expiresAt && new Date(expiresAt) <= new Date()) {
    throw ApiError.badRequest('The expiry date is already in the past.');
  }

  const existing = await queryOne(
    'SELECT * FROM feature_overrides WHERE shop_id = ? AND feature_key = ?',
    [shopId, featureKey],
  );
  const previous = existing ? mapOverride(existing) : null;
  // "Starts now" is written as the database's NOW(), not this process's clock.
  // Every activity check compares against NOW(), so a start stamped from an
  // app server whose clock runs ahead would leave the grant inert until the
  // database caught up.
  const start = startsAt ? new Date(startsAt) : null;
  const expiry = isPermanent ? null : new Date(expiresAt);

  await execute(
    `INSERT INTO feature_overrides
       (shop_id, admin_user_id, feature_key, status, starts_at, expires_at, is_permanent, reason, granted_by)
     VALUES (?, ?, ?, 'active', COALESCE(?, NOW()), ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = 'active', starts_at = VALUES(starts_at), expires_at = VALUES(expires_at),
       is_permanent = VALUES(is_permanent), reason = VALUES(reason),
       granted_by = VALUES(granted_by), admin_user_id = VALUES(admin_user_id),
       revoked_by = NULL, revoked_at = NULL`,
    [
      shopId,
      adminUserId ?? null,
      featureKey,
      start,
      expiry,
      isPermanent ? 1 : 0,
      reason ? String(reason).slice(0, 500) : null,
      actor?.id ?? null,
    ],
  );

  const row = await queryOne('SELECT * FROM feature_overrides WHERE shop_id = ? AND feature_key = ?', [
    shopId,
    featureKey,
  ]);
  const result = mapOverride({ ...row, shop_name: shop.name });

  // GRANTED when the shop did not already have this right; on a live override,
  // EXTENDED when the access now reaches further out and MODIFIED otherwise (§11I).
  const action = !previous || previous.status !== 'active' ? 'GRANTED' : classifyChange(previous, { isPermanent, expiry });

  await recordEvent({
    overrideId: result.id,
    shopId,
    adminUserId: adminUserId ?? null,
    featureKey,
    action,
    previousState: previous,
    newState: result,
    startsAt: start,
    expiresAt: expiry,
    reason,
    actorId: actor?.id ?? null,
  });

  await notifyShop(shopId, featureKey, result, action);
  return result;
}

/** Revokes a grant. The row is kept: history matters more than tidiness (§11I). */
async function revoke(shopId, featureKey, actor, reason) {
  const existing = await queryOne(
    'SELECT * FROM feature_overrides WHERE shop_id = ? AND feature_key = ?',
    [shopId, featureKey],
  );
  if (!existing) throw ApiError.notFound('No override exists for that feature');

  const previous = mapOverride(existing);
  await execute(
    `UPDATE feature_overrides
        SET status = 'revoked', revoked_by = ?, revoked_at = NOW(),
            reason = COALESCE(?, reason)
      WHERE id = ?`,
    [actor?.id ?? null, reason ? String(reason).slice(0, 500) : null, existing.id],
  );

  const row = await queryOne('SELECT * FROM feature_overrides WHERE id = ?', [existing.id]);
  const result = mapOverride(row);

  await recordEvent({
    overrideId: result.id,
    shopId,
    adminUserId: result.adminUserId,
    featureKey,
    action: 'REVOKED',
    previousState: previous,
    newState: result,
    reason,
    actorId: actor?.id ?? null,
  });

  return result;
}

/** Notifies the shop's team that special access changed (§11G). */
async function notifyShop(shopId, featureKey, override, action) {
  if (action === 'MODIFIED') return;
  try {
    const label = override.featureName;
    await notifications.notifyShopTeam(shopId, {
      type: 'FEATURE_ACCESS',
      title: 'Special access granted',
      message: override.isPermanent
        ? `${label} has been enabled for your shop by the OffersOffer team.`
        : `${label} has been enabled for your shop until ${new Date(
            override.expiresAt,
          ).toDateString()}.`,
    });
  } catch (error) {
    logger.error(
        {
          event: 'NOTIFICATION_SEND_FAILED',
          error_code: 'NOTIFICATION_SEND_FAILED',
          category: 'NOTIFICATION',
          dependency: 'PUSH',
          notification: 'FEATURE_OVERRIDE',
          err_message: error.message,
        },
        'Notification fan-out failed',
      );
  }
}

// ---------------------------------------------------------------------------
// Reporting (§11C, §11M)

/** Filterable list for the Super Admin screen. */
async function list({ shopId, adminUserId, featureKey, status, grantedBy, expiringWithinDays, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];

  if (shopId) {
    where.push('o.shop_id = ?');
    params.push(shopId);
  }
  if (adminUserId) {
    where.push('o.admin_user_id = ?');
    params.push(adminUserId);
  }
  if (featureKey) {
    where.push('o.feature_key = ?');
    params.push(featureKey);
  }
  if (grantedBy) {
    where.push('o.granted_by = ?');
    params.push(grantedBy);
  }
  if (status === 'active') {
    where.push(activeClause('o'));
  } else if (status === 'expired') {
    where.push(`(o.status = 'expired'
                 OR (o.status = 'active' AND o.is_permanent = 0
                     AND o.expires_at IS NOT NULL AND o.expires_at <= NOW()))`);
  } else if (status === 'permanent') {
    where.push("o.status = 'active' AND o.is_permanent = 1");
  } else if (status === 'revoked') {
    where.push("o.status = 'revoked'");
  }
  if (expiringWithinDays) {
    where.push(`o.status = 'active' AND o.is_permanent = 0 AND o.expires_at IS NOT NULL
                AND o.expires_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL ? DAY)`);
    params.push(Number(expiringWithinDays));
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows, total] = await Promise.all([
    rawQuery(
      `${SELECT_WITH_NAMES} ${clause}
        ORDER BY o.updated_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
      params,
    ),
    queryOne(
      `SELECT COUNT(*) AS count FROM feature_overrides o JOIN shops s ON s.id = o.shop_id ${clause}`,
      params,
    ),
  ]);

  return { items: rows.map(mapOverride), total: Number(total.count) };
}

/** Full history for one shop, or one override (§11C). */
async function history({ shopId, featureKey, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (shopId) {
    where.push('e.shop_id = ?');
    params.push(shopId);
  }
  if (featureKey) {
    where.push('e.feature_key = ?');
    params.push(featureKey);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await rawQuery(
    `SELECT e.*, u.name AS actor_name, s.name AS shop_name
       FROM feature_override_events e
       LEFT JOIN users u ON u.id = e.actor_id
       LEFT JOIN shops s ON s.id = e.shop_id
       ${clause}
      ORDER BY e.created_at DESC LIMIT ${Number(limit)}`,
    params,
  );

  return rows.map((row) => ({
    id: Number(row.id),
    overrideId: row.override_id === null ? null : Number(row.override_id),
    shopId: Number(row.shop_id),
    shopName: row.shop_name,
    featureKey: row.feature_key,
    featureName: catalogue.entryFor(row.feature_key)?.name ?? row.feature_key,
    action: row.action,
    previousState: row.previous_state,
    newState: row.new_state,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    reason: row.reason,
    actorId: row.actor_id === null ? null : Number(row.actor_id),
    actorName: row.actor_name,
    createdAt: row.created_at,
  }));
}

/** Dashboard tiles from §11M. */
async function summary() {
  const [counts, mostGranted] = await Promise.all([
    queryOne(
      `SELECT
         SUM(status = 'active' AND starts_at <= NOW()
             AND (is_permanent = 1 OR expires_at IS NULL OR expires_at > NOW())) AS active,
         SUM(status = 'active' AND is_permanent = 0 AND expires_at IS NOT NULL
             AND expires_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 7 DAY)) AS expiring_this_week,
         SUM(status = 'active' AND is_permanent = 1) AS permanent,
         SUM(status = 'revoked') AS revoked,
         SUM(status = 'expired'
             OR (status = 'active' AND is_permanent = 0
                 AND expires_at IS NOT NULL AND expires_at <= NOW())) AS expired
       FROM feature_overrides`,
    ),
    query(
      `SELECT feature_key, COUNT(*) AS count FROM feature_overrides
        WHERE status = 'active' AND starts_at <= NOW()
          AND (is_permanent = 1 OR expires_at IS NULL OR expires_at > NOW())
        GROUP BY feature_key ORDER BY count DESC LIMIT 10`,
    ),
  ]);

  return {
    activeOverrides: Number(counts?.active ?? 0),
    expiringThisWeek: Number(counts?.expiring_this_week ?? 0),
    permanentOverrides: Number(counts?.permanent ?? 0),
    revokedOverrides: Number(counts?.revoked ?? 0),
    expiredOverrides: Number(counts?.expired ?? 0),
    mostGranted: mostGranted.map((row) => ({
      featureKey: row.feature_key,
      featureName: catalogue.entryFor(row.feature_key)?.name ?? row.feature_key,
      count: Number(row.count),
    })),
  };
}

/**
 * The Super Admin's per-shop view (§11C): the plan, what it includes, and what
 * has been granted on top of it.
 */
async function shopOverview(shopId) {
  const subscriptions = require('../subscriptions/subscription.service');
  const shop = await shopOrThrow(shopId);
  const [subscription, overrides] = await Promise.all([
    subscriptions.getForShop(shopId),
    list({ shopId, limit: 200 }),
  ]);

  const planFeatures = plans.planFor(subscription.plan).features;
  return {
    shopId: Number(shop.id),
    shopName: shop.name,
    subscription: {
      plan: subscription.plan,
      planName: subscription.planName,
      status: subscription.status,
      price: subscription.price,
      renewsAt: subscription.renewsAt,
    },
    planFeatures,
    overrides: overrides.items,
    catalogue: catalogue.CATALOGUE,
  };
}

/**
 * Nightly sweep (§11H): rows whose expiry has passed are marked expired and an
 * EXPIRED event is written, so the history shows the lapse.
 *
 * `activeKeysForShop` already ignores them, so this is bookkeeping rather than
 * enforcement - the feature locks the instant the expiry passes, not when this
 * job happens to run.
 */
async function expireLapsed() {
  const due = await query(
    `SELECT * FROM feature_overrides
      WHERE status = 'active' AND is_permanent = 0
        AND expires_at IS NOT NULL AND expires_at <= NOW()`,
  );

  for (const row of due) {
    await execute("UPDATE feature_overrides SET status = 'expired' WHERE id = ?", [row.id]);
    await recordEvent({
      overrideId: Number(row.id),
      shopId: Number(row.shop_id),
      adminUserId: row.admin_user_id === null ? null : Number(row.admin_user_id),
      featureKey: row.feature_key,
      action: 'EXPIRED',
      previousState: mapOverride(row),
      newState: { ...mapOverride(row), status: 'expired' },
      expiresAt: row.expires_at,
      reason: 'Expiry date reached',
    });
  }
  return due.length;
}

module.exports = {
  activeKeysForShop,
  activeKeysForShops,
  activeForShop,
  grant,
  revoke,
  list,
  history,
  summary,
  shopOverview,
  expireLapsed,
  mapOverride,
};
