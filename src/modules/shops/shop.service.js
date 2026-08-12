'use strict';

const { query, queryOne, execute, rawQuery, transaction } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const geo = require('../../utils/geo');
const { uniqueSlug } = require('../../utils/slug');
const { limitOffset } = require('../../utils/pagination');
const accessControl = require('../../services/accessControl');
const entitlements = require('../../services/entitlements');
const { PLANS, minimumPlanForLimit } = require('../../config/plans');
const passwordUtil = require('../../utils/password');
const tokens = require('../../utils/tokens');
const mailer = require('../../utils/mailer');
const env = require('../../config/env');

function mapShop(row) {
  return {
    id: Number(row.id),
    name: row.name,
    slug: row.slug,
    description: row.description,
    logoUrl: row.logo_url,
    coverUrl: row.cover_url,
    contactNumber: row.contact_number,
    email: row.email,
    websiteUrl: row.website_url,
    socialLinks: typeof row.social_links === 'string' ? JSON.parse(row.social_links) : row.social_links,
    status: row.status,
    branchCount: row.branch_count === undefined ? undefined : Number(row.branch_count),
    activeOfferCount: row.active_offer_count === undefined ? undefined : Number(row.active_offer_count),
    followerCount: row.follower_count === undefined ? undefined : Number(row.follower_count),
    isFollowing: row.is_following === undefined ? undefined : Boolean(row.is_following),
    distanceKm:
      row.distance_km === null || row.distance_km === undefined
        ? null
        : Number(Number(row.distance_km).toFixed(2)),
    city: row.city ?? null,
    categories: row.category_names
      ? row.category_names.split('||').map((entry) => {
          const [id, name, slug] = entry.split('::');
          return { id: Number(id), name, slug };
        })
      : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CATEGORY_AGG = `(
  SELECT GROUP_CONCAT(CONCAT(c.id, '::', c.name, '::', c.slug) SEPARATOR '||')
    FROM shop_categories sc JOIN categories c ON c.id = sc.category_id
   WHERE sc.shop_id = s.id
)`;

async function list(params, user) {
  const { limit, page, offset } = limitOffset(params);
  const where = ['1 = 1'];
  const whereParams = [];
  const selectParams = [];

  const hasPosition = params.latitude !== undefined && params.longitude !== undefined;
  const distanceSelect = hasPosition
    ? `(SELECT MIN(${geo.distanceKmSql('b.latitude', 'b.longitude')})
          FROM shop_branches b
         WHERE b.shop_id = s.id AND b.status = 'active'
           AND b.latitude IS NOT NULL) AS distance_km`
    : 'NULL AS distance_km';
  if (hasPosition) selectParams.push(...geo.distanceKmParams(params.latitude, params.longitude));

  const followSelect = user
    ? '(SELECT 1 FROM followed_shops fs WHERE fs.shop_id = s.id AND fs.user_id = ?) AS is_following'
    : '0 AS is_following';
  const followParams = user ? [user.id] : [];

  const wantsInactive = params.status && params.status !== 'active';

  if (params.mine) {
    // "My shops" is always allowed for a signed-in member: these are the shops
    // the caller belongs to, so seeing a deactivated one needs no extra
    // permission. This is what the Post an Offer form asks for.
    if (!user) throw ApiError.unauthorized('Sign in to view your shops');
    const ids = user.isSuperAdmin ? null : user.shopIds;
    if (ids && !ids.length) return { items: [], pagination: { page, limit, total: 0 } };
    if (ids) {
      where.push(`s.id IN (${ids.map(() => '?').join(',')})`);
      whereParams.push(...ids);
    }
    if (!wantsInactive) where.push("s.status = 'active'");
    else if (params.status !== 'all') {
      where.push('s.status = ?');
      whereParams.push(params.status);
    }
  } else if (wantsInactive) {
    // Listing every shop including deactivated ones is a different, wider ask.
    // EDIT_SHOP rather than VIEW_SHOP: customers hold VIEW_SHOP globally, which
    // would otherwise expose every deactivated shop to them.
    if (!user) throw ApiError.unauthorized('Sign in to view inactive shops');
    const scope = accessControl.shopScopeFor(user, 'EDIT_SHOP');
    if (scope !== null) {
      if (!scope.length) throw ApiError.forbidden('You are not assigned to any shop');
      where.push(`s.id IN (${scope.map(() => '?').join(',')})`);
      whereParams.push(...scope);
    }
    if (params.status !== 'all') {
      where.push('s.status = ?');
      whereParams.push(params.status);
    }
  } else {
    where.push("s.status = 'active'");
  }

  if (params.search) {
    const term = `%${params.search}%`;
    where.push('(s.name LIKE ? OR s.description LIKE ?)');
    whereParams.push(term, term);
  }
  if (params.categoryId) {
    where.push('EXISTS (SELECT 1 FROM shop_categories sc2 WHERE sc2.shop_id = s.id AND sc2.category_id = ?)');
    whereParams.push(params.categoryId);
  }
  if (params.city) {
    where.push("EXISTS (SELECT 1 FROM shop_branches b2 WHERE b2.shop_id = s.id AND b2.city = ? AND b2.status = 'active')");
    whereParams.push(params.city);
  }

  let having = '';
  const havingParams = [];
  if (params.radius && hasPosition) {
    const box = geo.boundingBox(params.latitude, params.longitude, params.radius);
    where.push(`EXISTS (SELECT 1 FROM shop_branches b3
                         WHERE b3.shop_id = s.id AND b3.status = 'active'
                           AND b3.latitude BETWEEN ? AND ? AND b3.longitude BETWEEN ? AND ?)`);
    whereParams.push(box.minLat, box.maxLat, box.minLng, box.maxLng);
    having = 'HAVING distance_km IS NOT NULL AND distance_km <= ?';
    havingParams.push(params.radius);
  }

  const orderBy = {
    name: 's.name ASC',
    newest: 's.created_at DESC',
    popular: 'follower_count DESC, active_offer_count DESC',
    nearest: 'distance_km IS NULL, distance_km ASC',
  }[params.sort] || 's.name ASC';

  const whereSql = `WHERE ${where.join('\n       AND ')}`;

  const sql = `
    SELECT s.*,
           ${CATEGORY_AGG} AS category_names,
           (SELECT COUNT(*) FROM shop_branches b4 WHERE b4.shop_id = s.id AND b4.status = 'active') AS branch_count,
           (SELECT COUNT(*) FROM offers o WHERE o.shop_id = s.id AND o.status = 'active') AS active_offer_count,
           (SELECT COUNT(*) FROM followed_shops fs2 WHERE fs2.shop_id = s.id) AS follower_count,
           (SELECT b5.city FROM shop_branches b5 WHERE b5.shop_id = s.id AND b5.status = 'active'
             ORDER BY b5.is_primary DESC, b5.id LIMIT 1) AS city,
           ${distanceSelect},
           ${followSelect}
      FROM shops s
    ${whereSql}
    ${having}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}`;

  const countSql = `
    SELECT COUNT(*) AS total FROM (
      SELECT s.id, ${distanceSelect} FROM shops s ${whereSql} ${having}
    ) AS matched`;

  const [rows, countRows] = await Promise.all([
    rawQuery(sql, [...selectParams, ...followParams, ...whereParams, ...havingParams]),
    rawQuery(countSql, [...selectParams, ...whereParams, ...havingParams]),
  ]);

  return {
    items: rows.map(mapShop),
    pagination: { page, limit, total: Number(countRows[0]?.total ?? 0) },
  };
}

/** Shop detail page (§12): profile, categories, branches and rating summary. */
async function getById(idOrSlug, user, position = null) {
  const numeric = Number.parseInt(idOrSlug, 10);
  const followParams = user ? [user.id] : [];
  const followSelect = user
    ? '(SELECT 1 FROM followed_shops fs WHERE fs.shop_id = s.id AND fs.user_id = ?) AS is_following'
    : '0 AS is_following';

  const row = await rawQuery(
    `SELECT s.*, ${CATEGORY_AGG} AS category_names,
            (SELECT COUNT(*) FROM followed_shops fs2 WHERE fs2.shop_id = s.id) AS follower_count,
            (SELECT COUNT(*) FROM offers o WHERE o.shop_id = s.id AND o.status = 'active') AS active_offer_count,
            ${followSelect}
       FROM shops s
      WHERE s.id = ? OR s.slug = ?
      LIMIT 1`,
    [...followParams, Number.isFinite(numeric) ? numeric : 0, String(idOrSlug)],
  ).then((rows) => rows[0]);

  if (!row) throw ApiError.notFound('Shop not found');

  // Staff of the shop (and Super Admins) see it even while it is deactivated.
  const canSeeInactive =
    Boolean(user) && (user.isSuperAdmin || user.shopIds.includes(Number(row.id)));
  if (row.status !== 'active' && !canSeeInactive) throw ApiError.notFound('Shop not found');

  const hasPosition = position?.latitude !== undefined && position?.longitude !== undefined;
  const branches = await rawQuery(
    `SELECT b.*,
            ${hasPosition ? `${geo.distanceKmSql('b.latitude', 'b.longitude')}` : 'NULL'} AS distance_km,
            (SELECT COUNT(*) FROM offers o
              WHERE o.status = 'active'
                AND ((o.applicability_type = 'shop_wide' AND o.shop_id = b.shop_id)
                  OR (o.applicability_type = 'selected_branches'
                      AND EXISTS (SELECT 1 FROM offer_locations ol
                                   WHERE ol.offer_id = o.id AND ol.branch_id = b.id)))) AS offer_count
       FROM shop_branches b
      WHERE b.shop_id = ? ${canSeeInactive ? '' : "AND b.status = 'active'"}
      ORDER BY ${hasPosition ? 'distance_km IS NULL, distance_km ASC,' : ''} b.is_primary DESC, b.id`,
    hasPosition ? [...geo.distanceKmParams(position.latitude, position.longitude), row.id] : [row.id],
  );

  const rating = await queryOne(
    `SELECT COUNT(*) AS count, ROUND(AVG(rating), 2) AS average
       FROM reviews WHERE shop_id = ? AND status = 'approved'`,
    [row.id],
  );

  const shop = mapShop(row);
  shop.branches = branches.map(mapBranch);
  shop.rating = { count: Number(rating.count), average: rating.average === null ? null : Number(rating.average) };
  return shop;
}

function mapBranch(row) {
  return {
    id: Number(row.id),
    shopId: Number(row.shop_id),
    branchName: row.branch_name,
    address: row.address,
    city: row.city,
    state: row.state,
    country: row.country,
    pincode: row.pincode,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    contactNumber: row.contact_number,
    isPrimary: Boolean(row.is_primary),
    status: row.status,
    offerCount: row.offer_count === undefined ? undefined : Number(row.offer_count),
    distanceKm:
      row.distance_km === null || row.distance_km === undefined
        ? null
        : Number(Number(row.distance_km).toFixed(2)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function create(payload, user) {
  const slug = await uniqueSlug('shops', payload.name);

  // A new shop always starts on Free, so its category allowance is known before
  // the row exists - which is the only reason this check can run up front.
  const freeCategories = PLANS.FREE.limits.categories;
  if ((payload.categoryIds?.length ?? 0) > freeCategories) {
    throw entitlements.upgradeRequired(
      `A new shop starts on the Free plan, which includes ${entitlements.allowanceText('categories', freeCategories)}. Upgrade the shop for more.`,
      minimumPlanForLimit('categories', payload.categoryIds.length),
      { limit: freeCategories, used: payload.categoryIds.length, limitKey: 'categories', currentPlan: 'FREE' },
    );
  }

  const shopId = await transaction(async (connection) => {
    const [result] = await connection.execute(
      `INSERT INTO shops (name, slug, description, logo_url, cover_url, contact_number, email,
                          website_url, social_links, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.name,
        slug,
        payload.description ?? null,
        payload.logoUrl ?? null,
        payload.coverUrl ?? null,
        payload.contactNumber ?? null,
        payload.email || null,
        payload.websiteUrl || null,
        payload.socialLinks ? JSON.stringify(payload.socialLinks) : null,
        payload.status ?? 'active',
        user.id,
        user.id,
      ],
    );
    const newId = result.insertId;

    for (const categoryId of payload.categoryIds || []) {
      await connection.execute(
        'INSERT IGNORE INTO shop_categories (shop_id, category_id) VALUES (?, ?)',
        [newId, categoryId],
      );
    }

    // Every shop needs a subscription row; creating it here means no code path
    // ever has to cope with a shop that has none (§38).
    await connection.execute(
      `INSERT INTO shop_subscriptions (shop_id, plan, status, price_amount, payment_status)
       VALUES (?, 'FREE', 'active', 0.00, 'not_required')
       ON DUPLICATE KEY UPDATE shop_id = VALUES(shop_id)`,
      [newId],
    );

    if (payload.primaryBranch) {
      const branch = payload.primaryBranch;
      await connection.execute(
        `INSERT INTO shop_branches (shop_id, branch_name, address, city, state, country, pincode,
                                    latitude, longitude, contact_number, is_primary, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          newId,
          branch.branchName,
          branch.address ?? null,
          branch.city,
          branch.state ?? null,
          branch.country ?? null,
          branch.pincode ?? null,
          branch.latitude ?? null,
          branch.longitude ?? null,
          branch.contactNumber ?? null,
          branch.status ?? 'active',
        ],
      );
    }

    return newId;
  });

  return getById(shopId, user);
}

/**
 * V3 §3: category breadth is part of the plan (1 / 5 / unlimited).
 *
 * The check is against the *requested* set rather than an increment, so
 * replacing five categories with five others stays allowed while adding a sixth
 * does not. `assertWithinLimit` asks "would one more fit", so it is given
 * `count - 1`.
 */
async function assertCategoriesWithinPlan(shopId, categoryIds) {
  if (!categoryIds || categoryIds.length === 0) return;
  await entitlements.assertWithinLimit(shopId, 'categories', categoryIds.length - 1);
}

async function update(shopId, payload, user) {
  const existing = await queryOne('SELECT * FROM shops WHERE id = ?', [shopId]);
  if (!existing) throw ApiError.notFound('Shop not found');

  if (payload.categoryIds !== undefined) {
    await assertCategoriesWithinPlan(shopId, payload.categoryIds);
  }

  const slug = payload.name && payload.name !== existing.name
    ? await uniqueSlug('shops', payload.name, shopId)
    : existing.slug;

  // `undefined` means "not sent"; an explicit null clears the column.
  const keep = (value, current) => (value !== undefined ? value : current);
  // mysql2 hands back JSON columns already parsed, so they need re-serialising.
  const socialLinks = keep(payload.socialLinks, existing.social_links);

  await transaction(async (connection) => {
    await connection.execute(
      `UPDATE shops SET name = ?, slug = ?, description = ?, logo_url = ?, cover_url = ?,
              contact_number = ?, email = ?, website_url = ?, social_links = ?, status = ?, updated_by = ?
        WHERE id = ?`,
      [
        payload.name ?? existing.name,
        slug,
        keep(payload.description, existing.description),
        keep(payload.logoUrl, existing.logo_url),
        keep(payload.coverUrl, existing.cover_url),
        keep(payload.contactNumber, existing.contact_number),
        payload.email !== undefined ? payload.email || null : existing.email,
        payload.websiteUrl !== undefined ? payload.websiteUrl || null : existing.website_url,
        socialLinks ? JSON.stringify(socialLinks) : null,
        payload.status ?? existing.status,
        user.id,
        shopId,
      ],
    );

    if (payload.categoryIds !== undefined) {
      await connection.execute('DELETE FROM shop_categories WHERE shop_id = ?', [shopId]);
      for (const categoryId of payload.categoryIds) {
        await connection.execute(
          'INSERT IGNORE INTO shop_categories (shop_id, category_id) VALUES (?, ?)',
          [shopId, categoryId],
        );
      }
    }
  });

  return getById(shopId, user);
}

async function remove(shopId) {
  const offers = await queryOne('SELECT COUNT(*) AS count FROM offers WHERE shop_id = ?', [shopId]);
  if (Number(offers.count) > 0) {
    throw ApiError.conflict(
      'This shop still has offers. Deactivate the shop instead, or remove its offers first.',
    );
  }
  await execute('DELETE FROM shops WHERE id = ?', [shopId]);
}

// ---------------------------------------------------------------------------
// Branches (§17)
// ---------------------------------------------------------------------------

async function listBranches(shopId, { includeInactive = false } = {}) {
  const rows = await query(
    `SELECT b.*,
            (SELECT COUNT(*) FROM offers o
              WHERE o.status = 'active'
                AND ((o.applicability_type = 'shop_wide' AND o.shop_id = b.shop_id)
                  OR (o.applicability_type = 'selected_branches'
                      AND EXISTS (SELECT 1 FROM offer_locations ol
                                   WHERE ol.offer_id = o.id AND ol.branch_id = b.id)))) AS offer_count
       FROM shop_branches b
      WHERE b.shop_id = ? ${includeInactive ? '' : "AND b.status = 'active'"}
      ORDER BY b.is_primary DESC, b.branch_name`,
    [shopId],
  );
  return rows.map(mapBranch);
}

async function createBranch(shopId, payload) {
  // V3 §3: Free is a single location, Business up to two, Premium unlimited.
  // Only active branches count, so deactivating one frees the slot back up.
  await entitlements.assertUsageWithinLimit(shopId, 'branches', 'branches');

  const branchId = await transaction(async (connection) => {
    if (payload.isPrimary) {
      await connection.execute('UPDATE shop_branches SET is_primary = 0 WHERE shop_id = ?', [shopId]);
    }
    const [result] = await connection.execute(
      `INSERT INTO shop_branches (shop_id, branch_name, address, city, state, country, pincode,
                                  latitude, longitude, contact_number, is_primary, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId,
        payload.branchName,
        payload.address ?? null,
        payload.city,
        payload.state ?? null,
        payload.country ?? null,
        payload.pincode ?? null,
        payload.latitude ?? null,
        payload.longitude ?? null,
        payload.contactNumber ?? null,
        payload.isPrimary ? 1 : 0,
        payload.status ?? 'active',
      ],
    );
    return result.insertId;
  });

  return queryOne('SELECT * FROM shop_branches WHERE id = ?', [branchId]).then(mapBranch);
}

async function updateBranch(shopId, branchId, payload) {
  const existing = await queryOne('SELECT * FROM shop_branches WHERE id = ? AND shop_id = ?', [
    branchId,
    shopId,
  ]);
  if (!existing) throw ApiError.notFound('Branch not found for this shop');

  await transaction(async (connection) => {
    if (payload.isPrimary) {
      await connection.execute('UPDATE shop_branches SET is_primary = 0 WHERE shop_id = ?', [shopId]);
    }
    await connection.execute(
      `UPDATE shop_branches SET branch_name = ?, address = ?, city = ?, state = ?, country = ?,
              pincode = ?, latitude = ?, longitude = ?, contact_number = ?, is_primary = ?, status = ?
        WHERE id = ? AND shop_id = ?`,
      [
        payload.branchName ?? existing.branch_name,
        payload.address !== undefined ? payload.address : existing.address,
        payload.city ?? existing.city,
        payload.state !== undefined ? payload.state : existing.state,
        payload.country !== undefined ? payload.country : existing.country,
        payload.pincode !== undefined ? payload.pincode : existing.pincode,
        payload.latitude !== undefined ? payload.latitude : existing.latitude,
        payload.longitude !== undefined ? payload.longitude : existing.longitude,
        payload.contactNumber !== undefined ? payload.contactNumber : existing.contact_number,
        payload.isPrimary !== undefined ? (payload.isPrimary ? 1 : 0) : existing.is_primary,
        payload.status ?? existing.status,
        branchId,
        shopId,
      ],
    );
  });

  return queryOne('SELECT * FROM shop_branches WHERE id = ?', [branchId]).then(mapBranch);
}

/** Branches are deactivated rather than deleted so historic offers stay intact. */
async function deactivateBranch(shopId, branchId) {
  const result = await execute(
    "UPDATE shop_branches SET status = 'inactive' WHERE id = ? AND shop_id = ?",
    [branchId, shopId],
  );
  if (!result.affectedRows) throw ApiError.notFound('Branch not found for this shop');
}

// ---------------------------------------------------------------------------
// Members (§18)
// ---------------------------------------------------------------------------

async function listMembers(shopId) {
  const rows = await query(
    `SELECT sm.*, u.name, u.email, u.phone, u.status AS user_status,
            r.name AS role_name, b.branch_name
       FROM shop_members sm
       JOIN users u ON u.id = sm.user_id
       LEFT JOIN roles r ON r.id = sm.role_id
       LEFT JOIN shop_branches b ON b.id = sm.branch_id
      WHERE sm.shop_id = ?
      ORDER BY u.name`,
    [shopId],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    shopId: Number(row.shop_id),
    userId: Number(row.user_id),
    name: row.name,
    email: row.email,
    phone: row.phone,
    userStatus: row.user_status,
    branchId: row.branch_id === null ? null : Number(row.branch_id),
    branchName: row.branch_name,
    roleId: row.role_id === null ? null : Number(row.role_id),
    roleName: row.role_name,
    designation: row.designation,
    status: row.status,
    createdAt: row.created_at,
  }));
}

/**
 * Adds a member. If the email does not belong to an account yet, a customer
 * account is created and the person receives a password-setup link, which is
 * how a new shop Admin is onboarded (§44 steps 3-5).
 */
async function addMember(shopId, payload) {
  let userId = payload.userId;
  let createdUser = null;

  if (!userId) {
    const existing = await queryOne('SELECT id FROM users WHERE email = ?', [payload.email]);
    if (existing) {
      userId = Number(existing.id);
    } else {
      if (!payload.name) throw ApiError.badRequest('A name is required to invite a new member');
      // Random placeholder hash: the invite link is the only way in.
      const placeholder = await passwordUtil.hash(tokens.randomToken(24));
      const result = await execute(
        'INSERT INTO users (name, email, password_hash, phone) VALUES (?, ?, ?, ?)',
        [payload.name, payload.email, placeholder, payload.phone ?? null],
      );
      userId = result.insertId;
      await execute(
        "INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE name = 'CUSTOMER'",
        [userId],
      );
      await execute('INSERT INTO notification_preferences (user_id) VALUES (?)', [userId]);
      createdUser = { id: userId, name: payload.name, email: payload.email };
    }
  }

  const duplicate = await queryOne('SELECT id FROM shop_members WHERE shop_id = ? AND user_id = ?', [
    shopId,
    userId,
  ]);
  if (duplicate) throw ApiError.conflict('This user is already a member of the shop');

  if (payload.branchId) {
    const branch = await queryOne('SELECT id FROM shop_branches WHERE id = ? AND shop_id = ?', [
      payload.branchId,
      shopId,
    ]);
    if (!branch) throw ApiError.badRequest('That branch does not belong to this shop');
  }

  const result = await execute(
    `INSERT INTO shop_members (shop_id, branch_id, user_id, role_id, designation, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      shopId,
      payload.branchId ?? null,
      userId,
      payload.roleId ?? null,
      payload.designation ?? null,
      payload.status ?? 'active',
    ],
  );

  if (createdUser) {
    const token = tokens.randomToken();
    await execute(
      `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
       VALUES (?, 'password_reset', ?, DATE_ADD(NOW(), INTERVAL 7 DAY))`,
      [userId, tokens.hashToken(token)],
    );
    const url = `${env.appUrl}/auth/reset-password?token=${token}`;
    await mailer.send({ to: createdUser.email, ...mailer.templates.resetPassword(createdUser.name, url) });
  }

  const members = await listMembers(shopId);
  return members.find((member) => member.id === result.insertId);
}

async function updateMember(shopId, memberId, payload) {
  const existing = await queryOne('SELECT * FROM shop_members WHERE id = ? AND shop_id = ?', [
    memberId,
    shopId,
  ]);
  if (!existing) throw ApiError.notFound('Member not found for this shop');

  if (payload.branchId) {
    const branch = await queryOne('SELECT id FROM shop_branches WHERE id = ? AND shop_id = ?', [
      payload.branchId,
      shopId,
    ]);
    if (!branch) throw ApiError.badRequest('That branch does not belong to this shop');
  }

  await execute(
    `UPDATE shop_members SET branch_id = ?, role_id = ?, designation = ?, status = ?
      WHERE id = ? AND shop_id = ?`,
    [
      payload.branchId !== undefined ? payload.branchId : existing.branch_id,
      payload.roleId !== undefined ? payload.roleId : existing.role_id,
      payload.designation !== undefined ? payload.designation : existing.designation,
      payload.status ?? existing.status,
      memberId,
      shopId,
    ],
  );

  const members = await listMembers(shopId);
  return members.find((member) => member.id === Number(memberId));
}

async function removeMember(shopId, memberId) {
  const result = await execute('DELETE FROM shop_members WHERE id = ? AND shop_id = ?', [
    memberId,
    shopId,
  ]);
  if (!result.affectedRows) throw ApiError.notFound('Member not found for this shop');
}

module.exports = {
  assertCategoriesWithinPlan,
  list,
  getById,
  create,
  update,
  remove,
  listBranches,
  createBranch,
  updateBranch,
  deactivateBranch,
  listMembers,
  addMember,
  updateMember,
  removeMember,
  mapShop,
  mapBranch,
};
