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
const { queryBoolean } = require('../../utils/queryBoolean');
const { ok, noContent, paginated } = require('../../utils/respond');
const notificationService = require('../../services/notifications');

const router = express.Router();

const listQuery = z.object({
  ...paginationSchema,
  // Not z.coerce.boolean(): that is Boolean(value), so the string "false" -
  // which is exactly what the app sends - would read as true and the feed
  // would only ever return unread notifications (Push §28).
  unreadOnly: queryBoolean(false),
});

/**
 * Every preference flag, as `apiField -> column`. The schema, the reader and
 * the writer are all derived from this one table - adding a category (as push
 * did with claims, redemptions and bookings) is a single line rather than
 * three edits that have to stay in step.
 */
const PREFERENCE_FIELDS = {
  emailEnabled: 'email_enabled',
  // Master switch for device push. Off still writes the in-app notification -
  // it only skips the device fan-out (Push §29).
  pushEnabled: 'push_enabled',
  followedShopOffers: 'followed_shop_offers',
  followedCategoryOffers: 'followed_category_offers',
  nearbyOffers: 'nearby_offers',
  favoriteExpiring: 'favorite_expiring',
  savedServiceOfferExpiring: 'saved_service_offer_expiring',
  offerUpdates: 'offer_updates',
  claimUpdates: 'claim_updates',
  redemptionUpdates: 'redemption_updates',
  bookingUpdates: 'booking_updates',
  adminAnnouncements: 'admin_announcements',
};

const preferencesSchema = z.object(
  Object.fromEntries(
    Object.keys(PREFERENCE_FIELDS).map((field) => [field, z.coerce.boolean().optional()]),
  ),
);

const mapPreferences = (row) =>
  Object.fromEntries(
    Object.entries(PREFERENCE_FIELDS).map(([field, column]) => [field, Boolean(row[column])]),
  );

/** Registration of a device that can receive push (Push §37). */
const deviceSchema = z.object({
  token: z.string().trim().min(10).max(255),
  platform: z.string().trim().max(40).optional(),
  deviceName: z.string().trim().max(120).optional(),
  transport: z.enum(['expo', 'fcm', 'apns']).optional().default('expo'),
});

const unregisterSchema = z.object({ token: z.string().trim().min(10).max(255) });

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
  // Where tapping this lands (Push §26). The app prefers it over re-deriving a
  // destination from entityType, so old notifications keep working when the
  // navigation map changes.
  deepLink: row.deep_link,
  pushState: row.push_state,
  isRead: Boolean(row.is_read),
  openedAt: row.opened_at,
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
    ok(res, mapPreferences(row));
  }),
);

router.put(
  '/preferences',
  validate({ body: preferencesSchema }),
  asyncHandler(async (req, res) => {
    await execute('INSERT IGNORE INTO notification_preferences (user_id) VALUES (?)', [req.user.id]);

    // A partial body is a patch, not a replacement: only the flags the client
    // actually sent are written, so a client built before a category existed
    // cannot silently reset it.
    const changed = Object.keys(PREFERENCE_FIELDS).filter((field) => req.body[field] !== undefined);
    if (changed.length) {
      await execute(
        `UPDATE notification_preferences
            SET ${changed.map((field) => `${PREFERENCE_FIELDS[field]} = ?`).join(', ')}
          WHERE user_id = ?`,
        [...changed.map((field) => (req.body[field] ? 1 : 0)), req.user.id],
      );
    }

    const row = await queryOne('SELECT * FROM notification_preferences WHERE user_id = ?', [req.user.id]);
    ok(res, mapPreferences(row));
  }),
);

// ---- Push devices (Push §37) ------------------------------------------------

const mapDevice = (row) => ({
  id: Number(row.id),
  platform: row.platform,
  deviceName: row.device_name,
  transport: row.transport,
  isActive: Boolean(row.is_active),
  lastSeenAt: row.last_seen_at,
  createdAt: row.created_at,
});

/**
 * Registers this device for push, or re-registers it.
 *
 * Called on every launch of a signed-in app, not just the first: tokens rotate,
 * and the same phone can be handed to a different account. The token is the
 * unique key, so re-registering under a new user moves the row rather than
 * leaving the previous owner's notifications going to a device they no longer
 * hold. A registration also revives a token that a failed send had retired and
 * clears its failure budget - the client is telling us it works.
 */
router.post(
  '/devices',
  validate({ body: deviceSchema }),
  asyncHandler(async (req, res) => {
    await execute(
      `INSERT INTO push_devices (user_id, token, transport, platform, device_name)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), transport = VALUES(transport),
                               platform = VALUES(platform), device_name = VALUES(device_name),
                               is_active = 1, failure_count = 0, last_seen_at = NOW()`,
      [
        req.user.id,
        req.body.token,
        req.body.transport,
        req.body.platform ?? req.get('X-Device-Platform') ?? null,
        req.body.deviceName ?? req.get('X-Device-Name') ?? null,
      ],
    );
    const row = await queryOne('SELECT * FROM push_devices WHERE token = ?', [req.body.token]);
    ok(res, mapDevice(row));
  }),
);

/**
 * Stops push to one device - what sign-out calls, so the next person to use
 * the phone does not receive the previous account's notifications.
 *
 * Scoped to the caller's own rows, and deliberately not an error when nothing
 * matches: signing out should never fail because a token was already cleared.
 */
router.post(
  '/devices/unregister',
  validate({ body: unregisterSchema }),
  asyncHandler(async (req, res) => {
    const result = await execute('DELETE FROM push_devices WHERE token = ? AND user_id = ?', [
      req.body.token,
      req.user.id,
    ]);
    ok(res, { removed: result.affectedRows });
  }),
);

router.get(
  '/devices',
  asyncHandler(async (req, res) => {
    const rows = await rawQuery(
      'SELECT * FROM push_devices WHERE user_id = ? ORDER BY last_seen_at DESC',
      [req.user.id],
    );
    ok(res, rows.map(mapDevice));
  }),
);

/**
 * OPENED, the last step of the lifecycle (Push §31). Reported by the app when
 * a notification is tapped, which is a stronger signal than `is_read` - that
 * only means the row was seen in the feed. Marks it read too, since a tap has
 * unambiguously seen it.
 */
router.post(
  '/:id/opened',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const result = await execute(
      `UPDATE notifications SET is_read = 1, opened_at = COALESCE(opened_at, NOW())
        WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id],
    );
    if (!result.affectedRows) throw ApiError.notFound('Notification not found');
    ok(res, { id: Number(req.params.id), isRead: true, openedAt: new Date() });
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
