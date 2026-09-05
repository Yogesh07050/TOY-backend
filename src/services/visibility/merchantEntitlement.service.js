'use strict';

const { query, execute, queryOne } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const entitlements = require('../entitlements');
const plans = require('../../config/plans');
const vis = require('../../config/visibility');

/**
 * MerchantEntitlementService (§30).
 *
 * §23 states the resolution rule exactly:
 *
 *     Role Permission AND (Subscription Entitlement OR Super Admin Override)
 *
 * The role half is enforced at the route by `requirePermission`. This module
 * owns the bracket: what a shop is *eligible* for, from its plan or from a
 * Super Admin's grant, with no knowledge of who is asking.
 *
 * There are two independent override channels, and they answer different
 * questions:
 *
 *   `feature_overrides`                  - "does this shop have FEATURED_PLACEMENTS?"
 *   `merchant_visibility_entitlements`   - "what visibility *level* does it have?"
 *
 * A level is not a flag. §23's worked example - a Free shop granted Premium
 * visibility as a Founding Merchant until 31 Dec 2026 - is a rank with a reason
 * and an expiry, and collapsing it to a boolean would lose all three. Both are
 * unioned here, and the higher of the two always wins: an override may only
 * ever raise what a merchant can reach, never lower what they are paying for.
 *
 * §23 also requires that none of this touches billing. Nothing in this file
 * writes to `shop_subscriptions` or marks anything as paid.
 */

const levelRank = (key) => vis.VISIBILITY_LEVELS[key]?.rank ?? 0;
const levelForRank = (rank) => vis.LEVEL_BY_RANK[Math.max(0, Math.min(2, rank))];

/**
 * The visibility level a plan's features imply.
 *
 * Read from the feature set rather than the plan key so a Super Admin who
 * grants PRIORITY_DISCOVERY through the ordinary feature-override screen gets
 * the level that goes with it - two screens that disagreed about what a
 * merchant is entitled to would be a support ticket waiting to happen.
 */
function levelFromFeatures(features) {
  if (features.includes(plans.FEATURES.PRIORITY_DISCOVERY)) return 'PRIORITY';
  if (features.includes(plans.FEATURES.ENHANCED_DISCOVERY)) return 'ENHANCED';
  return 'BASIC';
}

/** The live visibility grant for a shop, or null. */
async function activeGrant(shopId) {
  return queryOne(
    `SELECT * FROM merchant_visibility_entitlements
      WHERE shop_id = ? AND status = 'active'
        AND starts_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY FIELD(visibility_level, 'BASIC','ENHANCED','PRIORITY') DESC, id DESC
      LIMIT 1`,
    [shopId],
  );
}

/**
 * Everything the visibility system needs to know about one shop.
 *
 * `source` is reported so §11G's "Access:" line and §27's merchant explanation
 * can say *why* a merchant has the level they have - "Premium Plan", "Super
 * Admin Grant", or both. A merchant told only "you have Priority visibility"
 * has no way to tell a lapsed override from a paid plan.
 */
async function resolve(shopId) {
  const [resolved, grant] = await Promise.all([entitlements.resolve(shopId), activeGrant(shopId)]);

  const planLevel = levelFromFeatures(resolved.features);
  const grantLevel = grant ? grant.visibility_level : null;
  const level = levelForRank(Math.max(levelRank(planLevel), levelRank(grantLevel ?? 'BASIC')));

  const featuredFromPlan = resolved.features.includes(plans.FEATURES.FEATURED_PLACEMENTS);
  // §9: "Super Admin can grant Featured access through a feature override even
  // when a merchant is not paying." Either channel is enough.
  const featuredAccess = featuredFromPlan || Boolean(grant?.featured_access);

  const sources = [];
  if (levelRank(planLevel) > 0) sources.push('plan');
  if (grant && levelRank(grantLevel) > 0) sources.push('override');

  return {
    shopId: Number(shopId),
    planKey: resolved.planKey,
    plan: resolved.plan,
    features: resolved.features,
    limits: resolved.limits,
    visibilityLevel: level,
    visibilityRank: levelRank(level),
    // What the SUBSCRIPTION ranking factor contributes before its weight.
    subscriptionScore: vis.VISIBILITY_LEVELS[level].score,
    featuredAccess,
    featuredSource: featuredFromPlan ? (grant?.featured_access ? 'plan+override' : 'plan') : grant?.featured_access ? 'override' : null,
    source: sources.length === 2 ? 'plan+override' : (sources[0] ?? 'plan'),
    override: grant
      ? {
          id: Number(grant.id),
          level: grant.visibility_level,
          reason: grant.reason,
          featuredAccess: Boolean(grant.featured_access),
          startsAt: grant.starts_at,
          expiresAt: grant.expires_at,
        }
      : null,
    // §21's fixed wording for the level this shop is actually on, so a
    // Business merchant is never told about "your Premium plan".
    promise: vis.promiseFor(level),
  };
}

/**
 * Batch resolution for ranking.
 *
 * A ranked page touches dozens of shops, and resolving them one at a time would
 * be dozens of round trips per search. This answers only what the scorer needs
 * - the level and Featured access - in three queries regardless of pool size.
 */
async function resolveMany(shopIds) {
  const ids = [...new Set(shopIds.map(Number))].filter(Boolean);
  const result = new Map();
  if (!ids.length) return result;

  const placeholders = ids.map(() => '?').join(',');
  const [planRows, overrideRows, grantRows] = await Promise.all([
    query(
      `SELECT shop_id, plan, status FROM shop_subscriptions WHERE shop_id IN (${placeholders})`,
      ids,
    ),
    query(
      `SELECT shop_id, feature_key FROM feature_overrides
        WHERE shop_id IN (${placeholders}) AND status = 'active'
          AND (expires_at IS NULL OR expires_at > NOW())`,
      ids,
    ),
    query(
      `SELECT shop_id, visibility_level, featured_access FROM merchant_visibility_entitlements
        WHERE shop_id IN (${placeholders}) AND status = 'active'
          AND starts_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW())`,
      ids,
    ),
  ]);

  const planByShop = new Map();
  for (const row of planRows) {
    // A lapsed subscription confers nothing, exactly as the discovery SQL has
    // always treated it (`PLAN_RANK_SQL`): an unpaid Premium plan stops
    // boosting the moment its status leaves 'active'.
    planByShop.set(Number(row.shop_id), row.status === 'active' ? row.plan : 'FREE');
  }

  const overrideByShop = new Map();
  for (const row of overrideRows) {
    const list = overrideByShop.get(Number(row.shop_id)) ?? [];
    list.push(row.feature_key);
    overrideByShop.set(Number(row.shop_id), list);
  }

  const grantByShop = new Map();
  for (const row of grantRows) {
    const existing = grantByShop.get(Number(row.shop_id));
    if (!existing || levelRank(row.visibility_level) > levelRank(existing.visibility_level)) {
      grantByShop.set(Number(row.shop_id), row);
    }
  }

  for (const id of ids) {
    const planKey = planByShop.get(id) ?? 'FREE';
    const features = [...plans.planFor(planKey).features, ...(overrideByShop.get(id) ?? [])];
    const grant = grantByShop.get(id) ?? null;
    const level = levelForRank(
      Math.max(levelRank(levelFromFeatures(features)), levelRank(grant?.visibility_level ?? 'BASIC')),
    );

    result.set(id, {
      shopId: id,
      planKey,
      visibilityLevel: level,
      visibilityRank: levelRank(level),
      subscriptionScore: vis.VISIBILITY_LEVELS[level].score,
      featuredAccess:
        features.includes(plans.FEATURES.FEATURED_PLACEMENTS) || Boolean(grant?.featured_access),
      endingSoonEligible:
        features.includes(plans.FEATURES.ENDING_SOON) || levelRank(level) >= 1,
    });
  }

  return result;
}

/** Throws unless the shop may use Featured placements by plan or by grant (§9). */
async function assertFeaturedAccess(shopId) {
  const resolved = await resolve(shopId);
  if (resolved.featuredAccess) return resolved;
  throw entitlements.featureRefusal(plans.FEATURES.FEATURED_PLACEMENTS, resolved.planKey);
}

// ---------------------------------------------------------------------------
// Super Admin grants (§23)

async function grant(shopId, { level, reason, featuredAccess = false, startsAt, expiresAt }, actorId) {
  const shop = await queryOne('SELECT id FROM shops WHERE id = ?', [shopId]);
  if (!shop) throw ApiError.notFound('Shop not found');
  if (!vis.VISIBILITY_LEVELS[level]) throw ApiError.badRequest('Unknown visibility level');
  if (expiresAt && startsAt && new Date(expiresAt) <= new Date(startsAt)) {
    throw ApiError.badRequest('The expiry must be after the start date');
  }

  // One live grant per shop: a second active row would make "what level is this
  // merchant on" a question with two answers, and the revoke screen would have
  // to guess which one the Super Admin meant.
  await execute(
    `UPDATE merchant_visibility_entitlements SET status = 'revoked', revoked_by = ?, revoked_at = NOW()
      WHERE shop_id = ? AND status = 'active'`,
    [actorId ?? null, shopId],
  );

  const result = await execute(
    `INSERT INTO merchant_visibility_entitlements
       (shop_id, visibility_level, reason, featured_access, starts_at, expires_at, granted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      shopId,
      level,
      reason ?? null,
      featuredAccess ? 1 : 0,
      startsAt ?? new Date(),
      expiresAt ?? null,
      actorId ?? null,
    ],
  );

  return getById(result.insertId);
}

async function revoke(shopId, actorId) {
  const existing = await activeGrant(shopId);
  if (!existing) throw ApiError.notFound('This shop has no active visibility grant');

  await execute(
    `UPDATE merchant_visibility_entitlements
        SET status = 'revoked', revoked_by = ?, revoked_at = NOW()
      WHERE id = ?`,
    [actorId ?? null, existing.id],
  );
  return getById(existing.id);
}

const mapGrant = (row) => ({
  id: Number(row.id),
  shopId: Number(row.shop_id),
  shopName: row.shop_name ?? null,
  level: row.visibility_level,
  reason: row.reason,
  featuredAccess: Boolean(row.featured_access),
  startsAt: row.starts_at,
  expiresAt: row.expires_at,
  status: row.status,
  grantedBy: row.granted_by === null ? null : Number(row.granted_by),
  grantedByName: row.granted_by_name ?? null,
  revokedAt: row.revoked_at,
  createdAt: row.created_at,
});

async function getById(id) {
  const row = await queryOne(
    `SELECT e.*, s.name AS shop_name, u.name AS granted_by_name
       FROM merchant_visibility_entitlements e
       JOIN shops s ON s.id = e.shop_id
       LEFT JOIN users u ON u.id = e.granted_by
      WHERE e.id = ?`,
    [id],
  );
  return row ? mapGrant(row) : null;
}

async function list({ shopId, status, limit = 50, offset = 0 } = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (shopId) {
    where.push('e.shop_id = ?');
    params.push(shopId);
  }
  if (status) {
    where.push('e.status = ?');
    params.push(status);
  }

  const rows = await query(
    `SELECT e.*, s.name AS shop_name, u.name AS granted_by_name
       FROM merchant_visibility_entitlements e
       JOIN shops s ON s.id = e.shop_id
       LEFT JOIN users u ON u.id = e.granted_by
      WHERE ${where.join(' AND ')}
      ORDER BY e.created_at DESC
      LIMIT ${Number.parseInt(limit, 10)} OFFSET ${Number.parseInt(offset, 10)}`,
    params,
  );
  return rows.map(mapGrant);
}

/**
 * Marks lapsed grants expired. Run by the scheduler.
 *
 * Purely cosmetic for access control - `activeGrant` compares `expires_at` on
 * every read, so a grant is dead the moment its date passes whether or not this
 * has run. What it fixes is the admin list, which would otherwise keep showing
 * expired grants as active.
 */
async function expireLapsed() {
  const result = await execute(
    `UPDATE merchant_visibility_entitlements
        SET status = 'expired'
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()`,
  );
  return result.affectedRows;
}

module.exports = {
  resolve,
  resolveMany,
  assertFeaturedAccess,
  grant,
  revoke,
  list,
  getById,
  expireLapsed,
  levelFromFeatures,
};
