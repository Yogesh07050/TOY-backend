'use strict';

const express = require('express');
const { z } = require('zod');
const { queryOne, execute, rawQuery } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const audit = require('../../utils/audit');
const { authenticate } = require('../../middleware/auth');
const { requireGlobalPermission, requireSuperAdmin } = require('../../middleware/authorize');
const { limitOffset, paginationSchema } = require('../../utils/pagination');
const { ok, noContent, paginated } = require('../../utils/respond');
const notificationService = require('../../services/notifications');

const router = express.Router();

const listQuery = z.object({
  ...paginationSchema,
  unreadOnly: z.coerce.boolean().optional().default(false),
});

const preferencesSchema = z.object({
  emailEnabled: z.coerce.boolean().optional(),
  followedShopOffers: z.coerce.boolean().optional(),
  followedCategoryOffers: z.coerce.boolean().optional(),
  nearbyOffers: z.coerce.boolean().optional(),
  favoriteExpiring: z.coerce.boolean().optional(),
  savedServiceOfferExpiring: z.coerce.boolean().optional(),
  offerUpdates: z.coerce.boolean().optional(),
  adminAnnouncements: z.coerce.boolean().optional(),
});

const thresholdBody = z.object({
  hoursBefore: z.coerce.number().int().min(1).max(8760),
  label: z.string().trim().max(60).optional().nullable(),
  isActive: z.coerce.boolean().optional().default(true),
});

const thresholdPatchBody = z.object({
  hoursBefore: z.coerce.number().int().min(1).max(8760).optional(),
  label: z.string().trim().max(60).optional().nullable(),
  isActive: z.coerce.boolean().optional(),
});

const announcementSchema = z.object({
  title: z.string().trim().min(3).max(200),
  message: z.string().trim().min(3).max(1000),
  audience: z.enum(['all', 'admins', 'customers']).default('all'),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

const mapNotification = (row) => ({
  id: Number(row.id),
  type: row.type,
  title: row.title,
  message: row.message,
  entityType: row.entity_type,
  entityId: row.entity_id === null ? null : Number(row.entity_id),
  isRead: Boolean(row.is_read),
  createdAt: row.created_at,
});

router.use(authenticate);

router.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { limit, page, offset } = limitOffset(req.query);
    const where = ['user_id = ?'];
    const params = [req.user.id];
    if (req.query.unreadOnly) where.push('is_read = 0');
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [rows, countRows, unreadRows] = await Promise.all([
      rawQuery(
        `SELECT * FROM notifications ${whereSql} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      rawQuery(`SELECT COUNT(*) AS total FROM notifications ${whereSql}`, params),
      rawQuery('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0', [
        req.user.id,
      ]),
    ]);

    res.json({
      success: true,
      data: rows.map(mapNotification),
      meta: {
        page,
        limit,
        total: Number(countRows[0].total),
        totalPages: Math.ceil(Number(countRows[0].total) / limit),
        hasNext: page * limit < Number(countRows[0].total),
        unread: Number(unreadRows[0].unread),
      },
    });
  }),
);

router.patch(
  '/:id/read',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const result = await execute(
      'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id],
    );
    if (!result.affectedRows) throw ApiError.notFound('Notification not found');
    ok(res, { id: Number(req.params.id), isRead: true });
  }),
);

router.patch(
  '/read-all',
  asyncHandler(async (req, res) => {
    const result = await execute(
      'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0',
      [req.user.id],
    );
    ok(res, { updated: result.affectedRows });
  }),
);

router.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await execute('DELETE FROM notifications WHERE id = ? AND user_id = ?', [
      req.params.id,
      req.user.id,
    ]);
    noContent(res);
  }),
);

// ---- Preferences (§24) -----------------------------------------------------

router.get(
  '/preferences',
  asyncHandler(async (req, res) => {
    let row = await queryOne('SELECT * FROM notification_preferences WHERE user_id = ?', [req.user.id]);
    if (!row) {
      await execute('INSERT IGNORE INTO notification_preferences (user_id) VALUES (?)', [req.user.id]);
      row = await queryOne('SELECT * FROM notification_preferences WHERE user_id = ?', [req.user.id]);
    }
    ok(res, {
      emailEnabled: Boolean(row.email_enabled),
      followedShopOffers: Boolean(row.followed_shop_offers),
      followedCategoryOffers: Boolean(row.followed_category_offers),
      nearbyOffers: Boolean(row.nearby_offers),
      favoriteExpiring: Boolean(row.favorite_expiring),
      savedServiceOfferExpiring: Boolean(row.saved_service_offer_expiring),
      offerUpdates: Boolean(row.offer_updates),
      adminAnnouncements: Boolean(row.admin_announcements),
    });
  }),
);

router.put(
  '/preferences',
  validate({ body: preferencesSchema }),
  asyncHandler(async (req, res) => {
    await execute('INSERT IGNORE INTO notification_preferences (user_id) VALUES (?)', [req.user.id]);
    const existing = await queryOne('SELECT * FROM notification_preferences WHERE user_id = ?', [
      req.user.id,
    ]);
    const flag = (value, current) => (value === undefined ? current : value ? 1 : 0);

    await execute(
      `UPDATE notification_preferences SET email_enabled = ?, followed_shop_offers = ?,
              followed_category_offers = ?, nearby_offers = ?, favorite_expiring = ?,
              saved_service_offer_expiring = ?, offer_updates = ?, admin_announcements = ?
        WHERE user_id = ?`,
      [
        flag(req.body.emailEnabled, existing.email_enabled),
        flag(req.body.followedShopOffers, existing.followed_shop_offers),
        flag(req.body.followedCategoryOffers, existing.followed_category_offers),
        flag(req.body.nearbyOffers, existing.nearby_offers),
        flag(req.body.favoriteExpiring, existing.favorite_expiring),
        flag(req.body.savedServiceOfferExpiring, existing.saved_service_offer_expiring),
        flag(req.body.offerUpdates, existing.offer_updates),
        flag(req.body.adminAnnouncements, existing.admin_announcements),
        req.user.id,
      ],
    );

    const row = await queryOne('SELECT * FROM notification_preferences WHERE user_id = ?', [req.user.id]);
    ok(res, {
      emailEnabled: Boolean(row.email_enabled),
      followedShopOffers: Boolean(row.followed_shop_offers),
      followedCategoryOffers: Boolean(row.followed_category_offers),
      nearbyOffers: Boolean(row.nearby_offers),
      favoriteExpiring: Boolean(row.favorite_expiring),
      savedServiceOfferExpiring: Boolean(row.saved_service_offer_expiring),
      offerUpdates: Boolean(row.offer_updates),
      adminAnnouncements: Boolean(row.admin_announcements),
    });
  }),
);

// ---- Expiry notification thresholds (§25, Super Admin) ---------------------

const mapThreshold = (row) => ({
  id: Number(row.id),
  hoursBefore: Number(row.hours_before),
  label: row.label,
  isActive: Boolean(row.is_active),
});

router.get(
  '/thresholds',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const rows = await rawQuery('SELECT * FROM notification_thresholds ORDER BY hours_before DESC');
    ok(res, rows.map(mapThreshold));
  }),
);

router.post(
  '/thresholds',
  requireSuperAdmin,
  validate({ body: thresholdBody }),
  asyncHandler(async (req, res) => {
    const result = await execute(
      'INSERT INTO notification_thresholds (hours_before, label, is_active) VALUES (?, ?, ?)',
      [req.body.hoursBefore, req.body.label ?? null, req.body.isActive ? 1 : 0],
    );
    const row = await queryOne('SELECT * FROM notification_thresholds WHERE id = ?', [result.insertId]);
    await audit.record(req, {
      action: 'NOTIFICATION_THRESHOLD_CREATED',
      entityType: 'notification_threshold',
      entityId: result.insertId,
      newValue: { hoursBefore: req.body.hoursBefore, isActive: req.body.isActive },
    });
    ok(res, mapThreshold(row));
  }),
);

router.patch(
  '/thresholds/:id',
  requireSuperAdmin,
  validate({ params: idParam, body: thresholdPatchBody }),
  asyncHandler(async (req, res) => {
    const existing = await queryOne('SELECT * FROM notification_thresholds WHERE id = ?', [req.params.id]);
    if (!existing) throw ApiError.notFound('Threshold not found');

    await execute(
      'UPDATE notification_thresholds SET hours_before = ?, label = ?, is_active = ? WHERE id = ?',
      [
        req.body.hoursBefore ?? existing.hours_before,
        req.body.label === undefined ? existing.label : req.body.label,
        req.body.isActive === undefined ? existing.is_active : req.body.isActive ? 1 : 0,
        req.params.id,
      ],
    );
    const row = await queryOne('SELECT * FROM notification_thresholds WHERE id = ?', [req.params.id]);
    await audit.record(req, {
      action: 'NOTIFICATION_THRESHOLD_UPDATED',
      entityType: 'notification_threshold',
      entityId: Number(req.params.id),
      oldValue: mapThreshold(existing),
      newValue: mapThreshold(row),
    });
    ok(res, mapThreshold(row));
  }),
);

router.delete(
  '/thresholds/:id',
  requireSuperAdmin,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await execute('DELETE FROM notification_thresholds WHERE id = ?', [req.params.id]);
    noContent(res);
  }),
);

// ---- Announcements ---------------------------------------------------------

router.post(
  '/announce',
  requireGlobalPermission('MANAGE_USERS'),
  validate({ body: announcementSchema }),
  asyncHandler(async (req, res) => {
    const recipients = await notificationService.announce(req.body);
    await audit.record(req, {
      action: 'ANNOUNCEMENT_SENT',
      entityType: 'announcement',
      newValue: { title: req.body.title, audience: req.body.audience, recipients },
    });
    ok(res, { recipients });
  }),
);

module.exports = router;
