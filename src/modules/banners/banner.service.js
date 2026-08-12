'use strict';

const { query, queryOne, execute, rawQuery } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const { limitOffset } = require('../../utils/pagination');
const accessControl = require('../../services/accessControl');
const entitlements = require('../../services/entitlements');
const subscriptions = require('../subscriptions/subscription.service');
const { FEATURES } = require('../../config/plans');

/**
 * Featured banners (§3-§14).
 *
 * A banner exists to promote one specific offer, so `offer_id` is required and
 * the offer's own validity always wins: an expired or deactivated offer pulls
 * its banner off the customer page even while the banner's own window is open
 * (§10). That rule lives in ONE place - `LIVE_BANNER_CONDITION` - so the
 * customer feed and the admin "is this actually showing?" flag can never drift.
 */
const LIVE_BANNER_CONDITION = `
  b.status = 'published'
  AND b.start_date <= NOW()
  AND b.end_date   >= NOW()
  AND o.status     = 'active'
  AND o.start_date <= NOW()
  AND o.end_date   >= NOW()
  AND s.status     = 'active'`;

const BANNER_SELECT = `
  SELECT b.*,
         o.title       AS offer_title,
         o.offer_text  AS offer_text,
         o.status      AS offer_status,
         o.end_date    AS offer_end_date,
         o.shop_id     AS shop_id,
         s.name        AS shop_name,
         s.slug        AS shop_slug,
         s.logo_url    AS shop_logo_url,
         (SELECT oi.image_url FROM offer_images oi
           WHERE oi.offer_id = o.id ORDER BY oi.display_order, oi.id LIMIT 1) AS offer_image_url,
         (${LIVE_BANNER_CONDITION.replace(/\n\s*/g, ' ')}) AS is_live,
         cu.name AS created_by_name
    FROM banners b
    JOIN offers o ON o.id = b.offer_id
    JOIN shops  s ON s.id = o.shop_id
    LEFT JOIN users cu ON cu.id = b.created_by`;

function mapBanner(row) {
  return {
    id: Number(row.id),
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    imageUrl: row.image_url,
    mobileImageUrl: row.mobile_image_url,
    desktopImageUrl: row.desktop_image_url,
    buttonText: row.button_text,
    offerId: Number(row.offer_id),
    offerTitle: row.offer_title,
    offerText: row.offer_text,
    offerStatus: row.offer_status,
    offerEndDate: row.offer_end_date,
    offerImageUrl: row.offer_image_url,
    shop: {
      id: Number(row.shop_id),
      name: row.shop_name,
      slug: row.shop_slug,
      logoUrl: row.shop_logo_url,
    },
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    displayOrder: Number(row.display_order),
    /** True when the customer feed would show this right now. */
    isLive: Boolean(Number(row.is_live)),
    impressionCount: Number(row.impression_count ?? 0),
    clickCount: Number(row.click_count ?? 0),
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Customer feed (§14 `GET /api/discovery/featured`). Returns only banners that
 * pass every eligibility rule, ordered by the display order an admin chose.
 */
async function listLive({ limit = 10 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 20);
  const rows = await rawQuery(
    `${BANNER_SELECT} WHERE ${LIVE_BANNER_CONDITION}
      ORDER BY b.display_order ASC, b.created_at DESC
      LIMIT ${safeLimit}`,
  );
  return rows.map(mapBanner);
}

/** Admin listing, scoped to the shops the caller may manage banners for. */
async function list(params, user) {
  const { limit, page, offset } = limitOffset(params);
  const where = ['1 = 1'];
  const whereParams = [];

  // A banner belongs to a shop through its offer, so banner visibility follows
  // the same shop scope as everything else.
  const scope = accessControl.shopScopeFor(user, 'VIEW_BANNERS');
  if (scope !== null) {
    if (!scope.length) throw ApiError.forbidden('You are not assigned to any shop');
    where.push(`o.shop_id IN (${scope.map(() => '?').join(',')})`);
    whereParams.push(...scope);
  }

  if (params.status && params.status !== 'all') {
    where.push('b.status = ?');
    whereParams.push(params.status);
  }
  if (params.shopId) {
    where.push('o.shop_id = ?');
    whereParams.push(params.shopId);
  }
  if (params.search) {
    const term = `%${params.search}%`;
    where.push('(b.title LIKE ? OR b.subtitle LIKE ? OR o.title LIKE ?)');
    whereParams.push(term, term, term);
  }
  if (params.live) where.push(LIVE_BANNER_CONDITION);

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const [rows, countRows] = await Promise.all([
    rawQuery(
      `${BANNER_SELECT} ${whereSql}
        ORDER BY b.display_order ASC, b.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      whereParams,
    ),
    rawQuery(
      `SELECT COUNT(*) AS total FROM banners b
         JOIN offers o ON o.id = b.offer_id
         JOIN shops s ON s.id = o.shop_id ${whereSql}`,
      whereParams,
    ),
  ]);

  return {
    items: rows.map(mapBanner),
    pagination: { page, limit, total: Number(countRows[0].total) },
  };
}

async function getById(id, user) {
  const rows = await rawQuery(`${BANNER_SELECT} WHERE b.id = ?`, [id]);
  if (!rows.length) throw ApiError.notFound('Banner not found');

  const banner = rows[0];
  if (!accessControl.hasShopPermission(user, banner.shop_id, 'VIEW_BANNERS')) {
    throw ApiError.forbidden('This banner belongs to another shop');
  }
  return mapBanner(banner);
}

/**
 * Loads the offer a banner points at and checks the caller may promote it.
 * Only offers within the caller's shop scope are selectable (§7).
 */
async function assertOfferIsUsable(offerId, user, permission) {
  const offer = await queryOne(
    `SELECT o.id, o.shop_id, o.status, o.end_date, o.title
       FROM offers o WHERE o.id = ?`,
    [offerId],
  );
  if (!offer) throw ApiError.badRequest('That offer does not exist');
  if (!accessControl.hasShopPermission(user, offer.shop_id, permission)) {
    throw ApiError.forbidden('You cannot create banners for another shop\'s offers');
  }
  return offer;
}

/** Derives the stored status from the requested one and the dates (§8). */
function resolveStatus(requested, startDate, endDate) {
  const now = new Date();
  if (requested === 'draft') return 'draft';
  if (requested === 'deactivated') return 'deactivated';
  if (endDate <= now) return 'expired';
  if (startDate > now) return 'scheduled';
  return 'published';
}

async function create(payload, user) {
  const offer = await assertOfferIsUsable(payload.offerId, user, 'CREATE_BANNER');

  // V3 §3: featured banners are a Premium entitlement, and scheduling one for a
  // future window is a separate entitlement again. Both are checked against the
  // shop that owns the offer the banner points at, not the caller's other shops.
  await entitlements.assertFeature(offer.shop_id, FEATURES.FEATURED_BANNERS);
  if (payload.status === 'scheduled' || new Date(payload.startDate) > new Date()) {
    await entitlements.assertFeature(offer.shop_id, FEATURES.BANNER_SCHEDULING);
  }

  // Publishing is a separate permission from creating (§6), so a banner is
  // only allowed to land in a live state if the caller may publish.
  const wantsPublish = payload.status !== 'draft';
  if (wantsPublish && !accessControl.hasAnyPermission(user, 'PUBLISH_BANNER')) {
    throw ApiError.forbidden('You can create banners but not publish them. Save it as a draft.');
  }

  const status = resolveStatus(payload.status, payload.startDate, payload.endDate);
  const result = await execute(
    `INSERT INTO banners (title, subtitle, description, image_url, mobile_image_url,
                          desktop_image_url, offer_id, button_text, start_date, end_date,
                          status, display_order, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.title,
      payload.subtitle ?? null,
      payload.description ?? null,
      payload.imageUrl ?? null,
      payload.mobileImageUrl ?? null,
      payload.desktopImageUrl ?? null,
      payload.offerId,
      payload.buttonText || 'View Offer',
      payload.startDate,
      payload.endDate,
      status,
      payload.displayOrder ?? 0,
      user.id,
      user.id,
    ],
  );

  if (status !== 'draft') await subscriptions.recordUsage(offer.shop_id, 'banners_published');

  return getById(result.insertId, user);
}

async function update(id, payload, user) {
  const existing = await queryOne(
    `SELECT b.*, o.shop_id FROM banners b JOIN offers o ON o.id = b.offer_id WHERE b.id = ?`,
    [id],
  );
  if (!existing) throw ApiError.notFound('Banner not found');
  if (!accessControl.hasShopPermission(user, existing.shop_id, 'EDIT_BANNER')) {
    throw ApiError.forbidden('This banner belongs to another shop');
  }

  // Repointing a banner at a different offer is re-checked against that offer's shop.
  const offerId = payload.offerId ?? existing.offer_id;
  if (Number(offerId) !== Number(existing.offer_id)) {
    await assertOfferIsUsable(offerId, user, 'EDIT_BANNER');
  }

  const startDate = payload.startDate ?? existing.start_date;
  const endDate = payload.endDate ?? existing.end_date;
  const requested = payload.status ?? existing.status;

  const becomingLive = requested !== 'draft' && existing.status === 'draft';
  if (becomingLive && !accessControl.hasAnyPermission(user, 'PUBLISH_BANNER')) {
    throw ApiError.forbidden('You can edit banners but not publish them.');
  }

  const keep = (value, current) => (value !== undefined ? value : current);
  await execute(
    `UPDATE banners SET title = ?, subtitle = ?, description = ?, image_url = ?,
            mobile_image_url = ?, desktop_image_url = ?, offer_id = ?, button_text = ?,
            start_date = ?, end_date = ?, status = ?, display_order = ?, updated_by = ?
      WHERE id = ?`,
    [
      payload.title ?? existing.title,
      keep(payload.subtitle, existing.subtitle),
      keep(payload.description, existing.description),
      keep(payload.imageUrl, existing.image_url),
      keep(payload.mobileImageUrl, existing.mobile_image_url),
      keep(payload.desktopImageUrl, existing.desktop_image_url),
      offerId,
      payload.buttonText || existing.button_text,
      startDate,
      endDate,
      resolveStatus(requested, new Date(startDate), new Date(endDate)),
      keep(payload.displayOrder, existing.display_order),
      user.id,
      id,
    ],
  );

  return getById(id, user);
}

async function changeStatus(id, status, user) {
  const existing = await queryOne(
    `SELECT b.*, o.shop_id FROM banners b JOIN offers o ON o.id = b.offer_id WHERE b.id = ?`,
    [id],
  );
  if (!existing) throw ApiError.notFound('Banner not found');

  // Publishing and un-publishing both need PUBLISH_BANNER for that shop.
  if (!accessControl.hasShopPermission(user, existing.shop_id, 'PUBLISH_BANNER')) {
    throw ApiError.forbidden('You do not have permission to publish or deactivate banners');
  }

  const resolved = resolveStatus(status, new Date(existing.start_date), new Date(existing.end_date));
  if (status === 'published' && resolved === 'expired') {
    throw ApiError.badRequest('Extend the banner end date before publishing it again');
  }

  await execute('UPDATE banners SET status = ?, updated_by = ? WHERE id = ?', [
    resolved,
    user.id,
    id,
  ]);
  return getById(id, user);
}

async function remove(id, user) {
  const existing = await queryOne(
    `SELECT b.id, b.title, o.shop_id FROM banners b JOIN offers o ON o.id = b.offer_id WHERE b.id = ?`,
    [id],
  );
  if (!existing) throw ApiError.notFound('Banner not found');
  if (!accessControl.hasShopPermission(user, existing.shop_id, 'DELETE_BANNER')) {
    throw ApiError.forbidden('This banner belongs to another shop');
  }

  await execute('DELETE FROM banners WHERE id = ?', [id]);
  return existing;
}

/** Records an impression or a click (§12). */
async function track(id, event, user, ip) {
  const banner = await queryOne('SELECT id FROM banners WHERE id = ?', [id]);
  if (!banner) throw ApiError.notFound('Banner not found');

  await execute(
    'INSERT INTO banner_events (banner_id, user_id, event_type, ip_address) VALUES (?, ?, ?, ?)',
    [id, user?.id ?? null, event, ip ?? null],
  );
  await execute(
    `UPDATE banners SET ${event === 'click' ? 'click_count = click_count + 1' : 'impression_count = impression_count + 1'} WHERE id = ?`,
    [id],
  );
}

/** Offers this user may attach a banner to, for the create form (§7). */
async function selectableOffers(user, search) {
  const scope = accessControl.shopScopeFor(user, 'CREATE_BANNER');
  const where = ["o.status IN ('active', 'scheduled')", 'o.end_date >= NOW()'];
  const params = [];

  if (scope !== null) {
    if (!scope.length) return [];
    where.push(`o.shop_id IN (${scope.map(() => '?').join(',')})`);
    params.push(...scope);
  }
  if (search) {
    where.push('(o.title LIKE ? OR s.name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const rows = await rawQuery(
    `SELECT o.id, o.title, o.offer_text, o.status, o.end_date, s.name AS shop_name
       FROM offers o JOIN shops s ON s.id = o.shop_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.created_at DESC LIMIT 100`,
    params,
  );

  return rows.map((row) => ({
    id: Number(row.id),
    title: row.title,
    offerText: row.offer_text,
    status: row.status,
    endDate: row.end_date,
    shopName: row.shop_name,
  }));
}

/**
 * Lifecycle maintenance, run on the same schedule as offers:
 *   scheduled -> published once the start date passes
 *   published -> expired   once the end date passes
 */
async function syncLifecycleStatuses() {
  const published = await execute(
    `UPDATE banners SET status = 'published'
      WHERE status = 'scheduled' AND start_date <= NOW() AND end_date > NOW()`,
  );
  const expired = await execute(
    `UPDATE banners SET status = 'expired'
      WHERE status IN ('published', 'scheduled') AND end_date <= NOW()`,
  );
  return { published: published.affectedRows, expired: expired.affectedRows };
}

/** Banner performance for the dashboards (§12). */
async function analytics(user, { days = 30, shopId } = {}) {
  const scope = accessControl.shopScopeFor(user, 'VIEW_ANALYTICS');
  const where = ['1 = 1'];
  const params = [];

  if (scope !== null) {
    if (!scope.length) throw ApiError.forbidden('You are not assigned to any shop');
    where.push(`o.shop_id IN (${scope.map(() => '?').join(',')})`);
    params.push(...scope);
  }
  if (shopId) {
    where.push('o.shop_id = ?');
    params.push(shopId);
  }

  const rows = await rawQuery(
    `SELECT b.id, b.title, b.status, b.display_order,
            o.title AS offer_title, o.id AS offer_id, s.name AS shop_name,
            (SELECT COUNT(*) FROM banner_events e
              WHERE e.banner_id = b.id AND e.event_type = 'impression'
                AND e.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)) AS impressions,
            (SELECT COUNT(*) FROM banner_events e
              WHERE e.banner_id = b.id AND e.event_type = 'click'
                AND e.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)) AS clicks,
            o.view_count AS offer_views
       FROM banners b
       JOIN offers o ON o.id = b.offer_id
       JOIN shops  s ON s.id = o.shop_id
      WHERE ${where.join(' AND ')}
      ORDER BY impressions DESC, b.display_order
      LIMIT 25`,
    [days, days, ...params],
  );

  return rows.map((row) => {
    const impressions = Number(row.impressions);
    const clicks = Number(row.clicks);
    return {
      id: Number(row.id),
      title: row.title,
      status: row.status,
      offerId: Number(row.offer_id),
      offerTitle: row.offer_title,
      shopName: row.shop_name,
      impressions,
      clicks,
      // Click-through rate is the number a merchant actually acts on.
      ctr: impressions ? Number(((clicks / impressions) * 100).toFixed(1)) : 0,
      offerViews: Number(row.offer_views),
    };
  });
}

module.exports = {
  listLive,
  list,
  getById,
  create,
  update,
  changeStatus,
  remove,
  track,
  selectableOffers,
  syncLifecycleStatuses,
  analytics,
  LIVE_BANNER_CONDITION,
};
