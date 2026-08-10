'use strict';

const { query, queryOne, execute, rawQuery, transaction } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const geo = require('../../utils/geo');
const { limitOffset } = require('../../utils/pagination');
const accessControl = require('../../services/accessControl');
const notifications = require('../../services/notifications');

/**
 * Predicate matching the branches an offer applies to (§8.3):
 *   shop_wide         -> every active branch of the shop
 *   selected_branches -> the branches listed in offer_locations
 *   online            -> no physical branch, so nothing matches
 */
const branchPredicate = (alias) => `(
  (o.applicability_type = 'shop_wide' AND ${alias}.shop_id = o.shop_id)
  OR (o.applicability_type = 'selected_branches' AND EXISTS (
       SELECT 1 FROM offer_locations ol WHERE ol.offer_id = o.id AND ol.branch_id = ${alias}.id))
)`;

/** Distance in km to the closest applicable branch, or NULL when not locatable. */
function nearestDistanceSql() {
  return `(
    SELECT MIN(${geo.distanceKmSql('b.latitude', 'b.longitude')})
      FROM shop_branches b
     WHERE b.status = 'active'
       AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
       AND ${branchPredicate('b')}
  )`;
}

/** City label for the closest applicable branch (falls back to the primary branch). */
function locationLabelSql(hasPosition) {
  if (hasPosition) {
    return `(
      SELECT b.city FROM shop_branches b
       WHERE b.status = 'active' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
         AND ${branchPredicate('b')}
       ORDER BY ${geo.distanceKmSql('b.latitude', 'b.longitude')} ASC LIMIT 1
    )`;
  }
  return `(
    SELECT b.city FROM shop_branches b
     WHERE b.status = 'active' AND ${branchPredicate('b')}
     ORDER BY b.is_primary DESC, b.id ASC LIMIT 1
  )`;
}

const PRIMARY_IMAGE_SQL = `(
  SELECT oi.image_url FROM offer_images oi
   WHERE oi.offer_id = o.id ORDER BY oi.display_order ASC, oi.id ASC LIMIT 1
)`;
const PRIMARY_THUMB_SQL = `(
  SELECT oi.thumbnail_url FROM offer_images oi
   WHERE oi.offer_id = o.id ORDER BY oi.display_order ASC, oi.id ASC LIMIT 1
)`;

const SORT_SQL = {
  newest: 'o.created_at DESC, o.id DESC',
  endingSoon: 'o.end_date ASC, o.id ASC',
  highestDiscount:
    "(CASE WHEN o.discount_type = 'percentage' THEN o.discount_value ELSE 0 END) DESC, o.discount_value DESC",
  mostViewed: 'o.view_count DESC, o.id DESC',
  mostPopular: '(o.favorite_count * 3 + o.click_count * 2 + o.view_count) DESC, o.id DESC',
  nearest: 'distance_km IS NULL, distance_km ASC',
};

/** Maps a joined offer row onto the API representation. */
function mapOffer(row, { includeRelations = false } = {}) {
  const offer = {
    id: Number(row.id),
    title: row.title,
    productName: row.product_name,
    description: row.description,
    offerText: row.offer_text,
    offerType: row.offer_type,
    discountType: row.discount_type,
    discountValue: row.discount_value === null ? null : Number(row.discount_value),
    originalPrice: row.original_price === null ? null : Number(row.original_price),
    discountedPrice: row.discounted_price === null ? null : Number(row.discounted_price),
    buyQuantity: row.buy_quantity === null ? null : Number(row.buy_quantity),
    getQuantity: row.get_quantity === null ? null : Number(row.get_quantity),
    minPurchase: row.min_purchase === null ? null : Number(row.min_purchase),
    termsConditions: row.terms_conditions,
    eligibility: row.eligibility,
    usageRestrictions: row.usage_restrictions,
    applicableProducts: row.applicable_products,
    isRecurring: Boolean(row.is_recurring),
    recurrenceType: row.recurrence_type,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    applicabilityType: row.applicability_type,
    imageUrl: row.image_url ?? null,
    thumbnailUrl: row.thumbnail_url ?? null,
    viewCount: Number(row.view_count ?? 0),
    clickCount: Number(row.click_count ?? 0),
    favoriteCount: Number(row.favorite_count ?? 0),
    distanceKm: row.distance_km === null || row.distance_km === undefined ? null : Number(Number(row.distance_km).toFixed(2)),
    locationLabel: row.location_label ?? null,
    isFavorite: Boolean(row.is_favorite),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    shop: {
      id: Number(row.shop_id),
      name: row.shop_name,
      slug: row.shop_slug,
      logoUrl: row.shop_logo_url,
    },
    category: row.category_id
      ? { id: Number(row.category_id), name: row.category_name, slug: row.category_slug }
      : null,
  };

  if (includeRelations) {
    offer.subcategory = row.subcategory_id
      ? { id: Number(row.subcategory_id), name: row.subcategory_name }
      : null;
    offer.createdBy = row.created_by_name
      ? { id: Number(row.created_by), name: row.created_by_name }
      : null;
    offer.updatedBy = row.updated_by_name
      ? { id: Number(row.updated_by), name: row.updated_by_name }
      : null;
  }

  return offer;
}

/**
 * Builds the shared FROM/WHERE for offer discovery.
 * Returns SQL fragments plus the ordered parameter lists.
 */
function buildListQuery(params, user) {
  const hasPosition = params.latitude !== undefined && params.longitude !== undefined;

  const selectParams = [];
  const whereParams = [];
  const where = ['1 = 1'];

  // --- distance projection -------------------------------------------------
  let distanceSelect = 'NULL AS distance_km';
  if (hasPosition) {
    distanceSelect = `${nearestDistanceSql()} AS distance_km`;
    selectParams.push(...geo.distanceKmParams(params.latitude, params.longitude));
  }

  let labelSelect = `${locationLabelSql(hasPosition)} AS location_label`;
  const labelParams = hasPosition ? geo.distanceKmParams(params.latitude, params.longitude) : [];

  // --- favourite flag ------------------------------------------------------
  let favoriteSelect = '0 AS is_favorite';
  const favoriteParams = [];
  if (user) {
    favoriteSelect = '(SELECT 1 FROM favorites fv WHERE fv.offer_id = o.id AND fv.user_id = ?) AS is_favorite';
    favoriteParams.push(user.id);
  }

  // --- visibility ----------------------------------------------------------
  // Management mode returns drafts/expired offers but only for shops the caller
  // may administer. Discovery mode is limited to live offers of active shops.
  const managing = Boolean(params.manage) || (params.status && params.status !== 'active');

  if (managing) {
    if (!user) throw ApiError.unauthorized('Sign in to manage offers');
    // Scope on EDIT_OFFER, not VIEW_OFFERS: every customer holds VIEW_OFFERS
    // globally (it just means "may browse"), so it would widen this to all shops.
    const scope = accessControl.shopScopeFor(user, 'EDIT_OFFER');
    if (scope !== null) {
      if (scope.length === 0) throw ApiError.forbidden('You are not assigned to any shop');
      where.push(`o.shop_id IN (${scope.map(() => '?').join(',')})`);
      whereParams.push(...scope);
    }
    if (params.status && params.status !== 'all') {
      where.push('o.status = ?');
      whereParams.push(params.status);
    }
  } else {
    where.push("o.status = 'active'", "s.status = 'active'", 'o.end_date >= NOW()', 'o.start_date <= NOW()');
  }

  // --- text search (§7) ----------------------------------------------------
  if (params.search) {
    const term = `%${params.search}%`;
    where.push(`(
      o.title LIKE ? OR o.product_name LIKE ? OR o.description LIKE ? OR o.offer_text LIKE ?
      OR s.name LIKE ? OR c.name LIKE ?
      OR EXISTS (SELECT 1 FROM shop_branches sb WHERE sb.shop_id = o.shop_id
                   AND (sb.city LIKE ? OR sb.pincode LIKE ?))
    )`);
    whereParams.push(term, term, term, term, term, term, term, term);
  }

  // --- category / shop -----------------------------------------------------
  if (params.categoryId) {
    where.push('(o.category_id = ? OR o.subcategory_id = ?)');
    whereParams.push(params.categoryId, params.categoryId);
  } else if (params.category) {
    where.push(`(c.slug = ? OR c.name = ? OR o.category_id = ?)`);
    whereParams.push(params.category, params.category, Number.parseInt(params.category, 10) || 0);
  }

  if (params.shopId) {
    where.push('o.shop_id = ?');
    whereParams.push(params.shopId);
  } else if (params.shop) {
    where.push('(s.slug = ? OR s.name = ? OR o.shop_id = ?)');
    whereParams.push(params.shop, params.shop, Number.parseInt(params.shop, 10) || 0);
  }

  if (params.branchId) {
    where.push(`EXISTS (SELECT 1 FROM shop_branches b3
                         WHERE b3.id = ? AND ${branchPredicate('b3')})`);
    whereParams.push(params.branchId);
  }

  // --- location filters (§8.5) --------------------------------------------
  if (params.city) {
    where.push(`EXISTS (SELECT 1 FROM shop_branches b4
                         WHERE b4.status = 'active' AND b4.city = ? AND ${branchPredicate('b4')})`);
    whereParams.push(params.city);
  }
  if (params.pincode) {
    where.push(`EXISTS (SELECT 1 FROM shop_branches b5
                         WHERE b5.status = 'active' AND b5.pincode = ? AND ${branchPredicate('b5')})`);
    whereParams.push(params.pincode);
  }

  // Bounding box first so MySQL can range-scan idx_branch_geo before the
  // trigonometry runs; the exact radius is applied by the HAVING clause.
  let having = '';
  const havingParams = [];
  if (params.radius && hasPosition) {
    const box = geo.boundingBox(params.latitude, params.longitude, params.radius);
    where.push(`EXISTS (SELECT 1 FROM shop_branches b6
                         WHERE b6.status = 'active'
                           AND b6.latitude BETWEEN ? AND ?
                           AND b6.longitude BETWEEN ? AND ?
                           AND ${branchPredicate('b6')})`);
    whereParams.push(box.minLat, box.maxLat, box.minLng, box.maxLng);
    having = 'HAVING distance_km IS NOT NULL AND distance_km <= ?';
    havingParams.push(params.radius);
  }

  // --- discount / type / dates --------------------------------------------
  if (params.minDiscount !== undefined) {
    where.push("(o.discount_type = 'percentage' AND o.discount_value >= ?)");
    whereParams.push(params.minDiscount);
  }
  if (params.maxDiscount !== undefined) {
    where.push("(o.discount_type = 'percentage' AND o.discount_value <= ?)");
    whereParams.push(params.maxDiscount);
  }
  if (params.offerType) {
    where.push('o.offer_type = ?');
    whereParams.push(params.offerType);
  }
  if (params.expiringInDays) {
    where.push('o.end_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL ? DAY)');
    whereParams.push(params.expiringInDays);
  }
  if (params.startDate) {
    where.push('o.end_date >= ?');
    whereParams.push(params.startDate);
  }
  if (params.endDate) {
    where.push('o.start_date <= ?');
    whereParams.push(params.endDate);
  }

  // --- personalised collections -------------------------------------------
  if (params.favorites) {
    if (!user) throw ApiError.unauthorized('Sign in to view saved offers');
    where.push('EXISTS (SELECT 1 FROM favorites f2 WHERE f2.offer_id = o.id AND f2.user_id = ?)');
    whereParams.push(user.id);
  }
  if (params.following) {
    if (!user) throw ApiError.unauthorized('Sign in to view offers you follow');
    where.push(`(
      EXISTS (SELECT 1 FROM followed_shops fs WHERE fs.shop_id = o.shop_id AND fs.user_id = ?)
      OR EXISTS (SELECT 1 FROM followed_categories fc
                  WHERE fc.user_id = ? AND fc.category_id IN (o.category_id, o.subcategory_id))
    )`);
    whereParams.push(user.id, user.id);
  }

  const from = `
      FROM offers o
      JOIN shops s ON s.id = o.shop_id
      LEFT JOIN categories c ON c.id = o.category_id`;

  return {
    from,
    whereSql: `WHERE ${where.join('\n       AND ')}`,
    having,
    distanceSelect,
    labelSelect,
    favoriteSelect,
    selectParams,
    labelParams,
    favoriteParams,
    whereParams,
    havingParams,
    hasPosition,
  };
}

async function list(params, user) {
  const built = buildListQuery(params, user);
  const { limit, page, offset } = limitOffset(params);

  const orderBy = SORT_SQL[params.sort] || SORT_SQL.newest;

  const sql = `
    SELECT o.*,
           s.name AS shop_name, s.slug AS shop_slug, s.logo_url AS shop_logo_url,
           c.name AS category_name, c.slug AS category_slug,
           ${PRIMARY_IMAGE_SQL} AS image_url,
           ${PRIMARY_THUMB_SQL} AS thumbnail_url,
           ${built.distanceSelect},
           ${built.labelSelect},
           ${built.favoriteSelect}
    ${built.from}
    ${built.whereSql}
    ${built.having}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}`;

  const sqlParams = [
    ...built.selectParams,
    ...built.labelParams,
    ...built.favoriteParams,
    ...built.whereParams,
    ...built.havingParams,
  ];

  const countSql = `
    SELECT COUNT(*) AS total FROM (
      SELECT o.id, ${built.distanceSelect}
      ${built.from}
      ${built.whereSql}
      ${built.having}
    ) AS matched`;
  const countParams = [...built.selectParams, ...built.whereParams, ...built.havingParams];

  const [rows, countRows] = await Promise.all([
    rawQuery(sql, sqlParams),
    rawQuery(countSql, countParams),
  ]);

  return {
    items: rows.map((row) => mapOffer(row)),
    pagination: { page, limit, total: Number(countRows[0]?.total ?? 0) },
  };
}

/**
 * Full offer detail including images, applicable branches and rating summary.
 * `position` is the customer's current/selected location, used for distances.
 */
async function getById(id, user, { forManagement = false, position = null } = {}) {
  const hasPosition = position?.latitude !== undefined && position?.longitude !== undefined && position !== null;

  const selectParams = [];
  let distanceSelect = 'NULL AS distance_km';
  if (hasPosition) {
    distanceSelect = `${nearestDistanceSql()} AS distance_km`;
    selectParams.push(...geo.distanceKmParams(position.latitude, position.longitude));
  }

  const favoriteParams = user ? [user.id] : [];
  const favoriteSelect = user
    ? '(SELECT 1 FROM favorites fv WHERE fv.offer_id = o.id AND fv.user_id = ?) AS is_favorite'
    : '0 AS is_favorite';

  const row = await rawQuery(
    `SELECT o.*,
            s.name AS shop_name, s.slug AS shop_slug, s.logo_url AS shop_logo_url,
            s.description AS shop_description, s.contact_number AS shop_contact,
            s.status AS shop_status,
            c.name AS category_name, c.slug AS category_slug,
            sc.name AS subcategory_name,
            cu.name AS created_by_name, uu.name AS updated_by_name,
            ${PRIMARY_IMAGE_SQL} AS image_url,
            ${PRIMARY_THUMB_SQL} AS thumbnail_url,
            ${distanceSelect},
            ${favoriteSelect}
       FROM offers o
       JOIN shops s ON s.id = o.shop_id
       LEFT JOIN categories c ON c.id = o.category_id
       LEFT JOIN categories sc ON sc.id = o.subcategory_id
       LEFT JOIN users cu ON cu.id = o.created_by
       LEFT JOIN users uu ON uu.id = o.updated_by
      WHERE o.id = ?`,
    [...selectParams, ...favoriteParams, id],
  ).then((rows) => rows[0]);

  if (!row) throw ApiError.notFound('Offer not found');

  // Customers only ever see live offers; shop staff and super admins see the rest.
  const canManage = Boolean(user) && accessControl.hasShopPermission(user, row.shop_id, 'EDIT_OFFER');
  const isPubliclyVisible = row.status === 'active' && row.shop_status === 'active';
  if (!isPubliclyVisible && !canManage && !forManagement) {
    throw ApiError.notFound('Offer not found');
  }

  const [images, branches, rating] = await Promise.all([
    query(
      'SELECT id, image_url, thumbnail_url, display_order FROM offer_images WHERE offer_id = ? ORDER BY display_order, id',
      [id],
    ),
    rawQuery(
      `SELECT b.id, b.branch_name, b.address, b.city, b.state, b.country, b.pincode,
              b.latitude, b.longitude, b.contact_number, b.is_primary
              ${hasPosition ? `, ${geo.distanceKmSql('b.latitude', 'b.longitude')} AS distance_km` : ', NULL AS distance_km'}
         FROM shop_branches b
         JOIN offers o ON o.id = ?
        WHERE b.status = 'active' AND ${branchPredicate('b')}
        ORDER BY ${hasPosition ? 'distance_km IS NULL, distance_km ASC,' : ''} b.is_primary DESC, b.id`,
      hasPosition ? [...geo.distanceKmParams(position.latitude, position.longitude), id] : [id],
    ),
    queryOne(
      `SELECT COUNT(*) AS count, ROUND(AVG(rating), 2) AS average
         FROM reviews WHERE offer_id = ? AND status = 'approved'`,
      [id],
    ),
  ]);

  const offer = mapOffer(row, { includeRelations: true });
  offer.images = images.map((image) => ({
    id: Number(image.id),
    url: image.image_url,
    thumbnailUrl: image.thumbnail_url,
    displayOrder: image.display_order,
  }));
  offer.branches = branches.map((branch) => ({
    id: Number(branch.id),
    branchName: branch.branch_name,
    address: branch.address,
    city: branch.city,
    state: branch.state,
    country: branch.country,
    pincode: branch.pincode,
    latitude: branch.latitude === null ? null : Number(branch.latitude),
    longitude: branch.longitude === null ? null : Number(branch.longitude),
    contactNumber: branch.contact_number,
    isPrimary: Boolean(branch.is_primary),
    distanceKm: branch.distance_km === null ? null : Number(Number(branch.distance_km).toFixed(2)),
  }));
  offer.shop.description = row.shop_description;
  offer.shop.contactNumber = row.shop_contact;
  offer.rating = { count: Number(rating.count), average: rating.average === null ? null : Number(rating.average) };
  offer.branchIds = offer.branches.map((branch) => branch.id);

  return offer;
}

/** Derives the initial lifecycle status from the requested one and the dates (§14). */
function resolveStatus(requested, startDate, endDate) {
  const now = new Date();
  if (requested === 'draft') return 'draft';
  if (endDate <= now) return 'expired';
  if (startDate > now) return 'scheduled';
  return 'active';
}

async function assertBranchesBelongToShop(connection, shopId, branchIds) {
  if (!branchIds.length) return;
  const placeholders = branchIds.map(() => '?').join(',');
  const [rows] = await connection.query(
    `SELECT id FROM shop_branches WHERE shop_id = ? AND id IN (${placeholders})`,
    [shopId, ...branchIds],
  );
  if (rows.length !== branchIds.length) {
    throw ApiError.badRequest('One or more selected branches do not belong to this shop');
  }
}

async function create(payload, user) {
  const shop = await queryOne('SELECT id, name, status FROM shops WHERE id = ?', [payload.shopId]);
  if (!shop) throw ApiError.badRequest('Shop not found');

  const status = resolveStatus(payload.status, payload.startDate, payload.endDate);

  const offerId = await transaction(async (connection) => {
    await assertBranchesBelongToShop(connection, payload.shopId, payload.branchIds);

    const [result] = await connection.execute(
      `INSERT INTO offers (
         shop_id, category_id, subcategory_id, title, product_name, description, offer_text,
         offer_type, discount_type, discount_value, original_price, discounted_price,
         buy_quantity, get_quantity, min_purchase, terms_conditions, eligibility,
         usage_restrictions, applicable_products, is_recurring, recurrence_type,
         start_date, end_date, status, applicability_type, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.shopId,
        payload.categoryId ?? null,
        payload.subcategoryId ?? null,
        payload.title,
        payload.productName ?? null,
        payload.description ?? null,
        payload.offerText ?? null,
        payload.offerType,
        payload.discountType,
        payload.discountValue ?? null,
        payload.originalPrice ?? null,
        payload.discountedPrice ?? null,
        payload.buyQuantity ?? null,
        payload.getQuantity ?? null,
        payload.minPurchase ?? null,
        payload.termsConditions ?? null,
        payload.eligibility ?? null,
        payload.usageRestrictions ?? null,
        payload.applicableProducts ?? null,
        payload.isRecurring ? 1 : 0,
        payload.isRecurring ? payload.recurrenceType ?? null : null,
        payload.startDate,
        payload.endDate,
        status,
        payload.applicabilityType,
        user.id,
        user.id,
      ],
    );
    const newId = result.insertId;

    if (payload.applicabilityType === 'selected_branches') {
      for (const branchId of payload.branchIds) {
        await connection.execute(
          'INSERT INTO offer_locations (offer_id, branch_id) VALUES (?, ?)',
          [newId, branchId],
        );
      }
    }

    for (const [index, image] of (payload.images || []).entries()) {
      await connection.execute(
        'INSERT INTO offer_images (offer_id, image_url, thumbnail_url, display_order) VALUES (?, ?, ?, ?)',
        [newId, image.url, image.thumbnailUrl ?? null, index],
      );
    }

    return newId;
  });

  if (status === 'active') {
    // Fan-out runs after the transaction so a notification failure cannot roll
    // back a published offer.
    notifications.notifyNewOffer(offerId).catch((error) =>
      console.error('[notifications] new offer fan-out failed: %s', error.message),
    );
  }

  return getById(offerId, user, { forManagement: true });
}

async function update(offerId, payload, user, previous) {
  if (Number(payload.shopId) !== Number(previous.shop_id)) {
    // Moving an offer between shops would bypass the ownership check.
    throw ApiError.forbidden('An offer cannot be moved to a different shop');
  }

  const keepStatus = ['deactivated', 'draft'].includes(previous.status)
    ? previous.status
    : resolveStatus(payload.status === 'draft' ? previous.status : payload.status, payload.startDate, payload.endDate);

  await transaction(async (connection) => {
    await assertBranchesBelongToShop(connection, previous.shop_id, payload.branchIds);

    await connection.execute(
      `UPDATE offers SET
         category_id = ?, subcategory_id = ?, title = ?, product_name = ?, description = ?,
         offer_text = ?, offer_type = ?, discount_type = ?, discount_value = ?,
         original_price = ?, discounted_price = ?, buy_quantity = ?, get_quantity = ?,
         min_purchase = ?, terms_conditions = ?, eligibility = ?, usage_restrictions = ?,
         applicable_products = ?, is_recurring = ?, recurrence_type = ?, start_date = ?,
         end_date = ?, status = ?, applicability_type = ?, updated_by = ?
       WHERE id = ?`,
      [
        payload.categoryId ?? null,
        payload.subcategoryId ?? null,
        payload.title,
        payload.productName ?? null,
        payload.description ?? null,
        payload.offerText ?? null,
        payload.offerType,
        payload.discountType,
        payload.discountValue ?? null,
        payload.originalPrice ?? null,
        payload.discountedPrice ?? null,
        payload.buyQuantity ?? null,
        payload.getQuantity ?? null,
        payload.minPurchase ?? null,
        payload.termsConditions ?? null,
        payload.eligibility ?? null,
        payload.usageRestrictions ?? null,
        payload.applicableProducts ?? null,
        payload.isRecurring ? 1 : 0,
        payload.isRecurring ? payload.recurrenceType ?? null : null,
        payload.startDate,
        payload.endDate,
        keepStatus,
        payload.applicabilityType,
        user.id,
        offerId,
      ],
    );

    await connection.execute('DELETE FROM offer_locations WHERE offer_id = ?', [offerId]);
    if (payload.applicabilityType === 'selected_branches') {
      for (const branchId of payload.branchIds) {
        await connection.execute(
          'INSERT INTO offer_locations (offer_id, branch_id) VALUES (?, ?)',
          [offerId, branchId],
        );
      }
    }

    if (payload.images) {
      await connection.execute('DELETE FROM offer_images WHERE offer_id = ?', [offerId]);
      for (const [index, image] of payload.images.entries()) {
        await connection.execute(
          'INSERT INTO offer_images (offer_id, image_url, thumbnail_url, display_order) VALUES (?, ?, ?, ?)',
          [offerId, image.url, image.thumbnailUrl ?? null, index],
        );
      }
    }
  });

  notifications.notifyOfferUpdated(offerId).catch((error) =>
    console.error('[notifications] offer update fan-out failed: %s', error.message),
  );

  return getById(offerId, user, { forManagement: true });
}

const ALLOWED_TRANSITIONS = {
  draft: ['scheduled', 'active', 'deactivated'],
  scheduled: ['active', 'deactivated', 'draft'],
  active: ['deactivated', 'expired'],
  expired: ['deactivated', 'scheduled', 'active'],
  deactivated: ['active', 'scheduled', 'draft'],
};

async function changeStatus(offer, status, user) {
  if (offer.status === status) return getById(offer.id, user, { forManagement: true });

  if (!ALLOWED_TRANSITIONS[offer.status]?.includes(status)) {
    throw ApiError.badRequest(`An offer cannot move from "${offer.status}" to "${status}"`);
  }
  if (['active', 'scheduled'].includes(status) && new Date(offer.end_date) <= new Date()) {
    throw ApiError.badRequest('Extend the end date before republishing this offer');
  }

  const resolved =
    status === 'active' ? resolveStatus('active', new Date(offer.start_date), new Date(offer.end_date)) : status;

  await execute('UPDATE offers SET status = ?, updated_by = ? WHERE id = ?', [resolved, user.id, offer.id]);

  if (resolved === 'active' && offer.status !== 'active') {
    notifications.notifyNewOffer(offer.id).catch(() => {});
  }
  if (resolved === 'deactivated') {
    notifications.notifyOfferDeactivated(offer.id).catch(() => {});
  }

  return getById(offer.id, user, { forManagement: true });
}

async function remove(offerId) {
  await execute('DELETE FROM offers WHERE id = ?', [offerId]);
}

/**
 * Records a view/click/share. The denormalised counters on `offers` keep the
 * card listings cheap; `offer_views` retains the raw events for analytics.
 */
async function trackEvent(offerId, { event, branchId }, user, ip) {
  const offer = await queryOne('SELECT id FROM offers WHERE id = ?', [offerId]);
  if (!offer) throw ApiError.notFound('Offer not found');

  await execute(
    'INSERT INTO offer_views (offer_id, user_id, branch_id, event_type, ip_address) VALUES (?, ?, ?, ?, ?)',
    [offerId, user?.id ?? null, branchId ?? null, event, ip ?? null],
  );

  if (event === 'view') {
    await execute('UPDATE offers SET view_count = view_count + 1 WHERE id = ?', [offerId]);
  } else if (event === 'click') {
    await execute('UPDATE offers SET click_count = click_count + 1 WHERE id = ?', [offerId]);
  }
}

/**
 * Lifecycle maintenance (§14, §45). Run on a schedule:
 *   scheduled -> active  once the start date passes
 *   active    -> expired once the end date passes
 */
async function syncLifecycleStatuses() {
  const activated = await execute(
    `UPDATE offers SET status = 'active'
      WHERE status = 'scheduled' AND start_date <= NOW() AND end_date > NOW()`,
  );
  const expired = await execute(
    `UPDATE offers SET status = 'expired'
      WHERE status IN ('active', 'scheduled') AND end_date <= NOW()`,
  );
  return { activated: activated.affectedRows, expired: expired.affectedRows };
}

module.exports = {
  list,
  getById,
  create,
  update,
  changeStatus,
  remove,
  trackEvent,
  syncLifecycleStatuses,
  mapOffer,
  resolveStatus,
};
