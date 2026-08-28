'use strict';

const { query, queryOne, execute, rawQuery } = require('../db/pool');
const env = require('../config/env');
const mailer = require('../utils/mailer');
const geo = require('../utils/geo');
const push = require('./push');

/**
 * Notification fan-out (§24). Every notification is persisted in-app; an email
 * is additionally sent when the recipient's preferences allow it.
 *
 * All entry points are fire-and-forget from the caller's perspective - a
 * failure here must never fail the administrative action that triggered it.
 */

const offerUrl = (offerId) => `${env.appUrl}/offers/${offerId}`;
const serviceUrl = (serviceId) => `${env.appUrl}/services/${serviceId}`;

/** Preference column that gates each notification type. */
const PREFERENCE_COLUMN = {
  NEW_OFFER_FOLLOWED_SHOP: 'followed_shop_offers',
  NEW_OFFER_FOLLOWED_CATEGORY: 'followed_category_offers',
  NEW_OFFER_NEARBY: 'nearby_offers',
  FAVORITE_EXPIRING: 'favorite_expiring',
  SAVED_SERVICE_OFFER_EXPIRING: 'saved_service_offer_expiring',
  OFFER_UPDATED: 'offer_updates',
  OFFER_DEACTIVATED: 'offer_updates',
  ADMIN_ANNOUNCEMENT: 'admin_announcements',
  OFFER_PUBLISHED: 'admin_announcements',
  SUBSCRIPTION_BILLING: 'admin_announcements',
  FEATURE_ACCESS: 'admin_announcements',

  // Transactional confirmations (Push §16-§18).
  OFFER_CLAIMED: 'claim_updates',
  SERVICE_OFFER_CLAIMED: 'claim_updates',
  OFFER_REDEEMED: 'redemption_updates',
  SERVICE_OFFER_REDEEMED: 'redemption_updates',
  BOOKING_CREATED: 'booking_updates',
  BOOKING_UPDATED: 'booking_updates',
  BOOKING_CANCELLED: 'booking_updates',
};

/**
 * Where tapping each notification should land (Push §26).
 *
 * Keyed by `entityType` rather than by notification type: several types point
 * at the same screen, and the entity is what actually identifies the
 * destination. Anything unmapped falls back to the notification centre, which
 * is always a valid place to arrive.
 */
const DEEP_LINK_PATHS = {
  offer: (id) => `offer/${id}`,
  // A service offer has no page of its own - its parent service is the screen,
  // which is why the expiry sweep already stores the service id here.
  service_offer: (id) => `service/${id}`,
  service: (id) => `service/${id}`,
  shop: (id) => `shop/${id}`,
  // Claim/Redemption §5/§34 gave the claim a screen of its own, which is what
  // the "[View Claim]" button in §37 opens: the code and the QR, not the offer
  // the customer already knows they claimed.
  offer_claim: (id) => `claim/${id}`,
  // Service claims got the same screen as product ones (§22), so tapping the
  // notification now opens the code rather than the service it came from.
  service_offer_claim: (id) => `service-claim/${id}`,
};

/**
 * Builds the `offersapp://...` URL stored on the notification row.
 *
 * An entity type absent from the table above - a booking, say - has no screen
 * that opens it by id, so deriving `booking/17` would produce a link matching
 * no route that quietly does nothing. Those callers pass an explicit `deepLink`
 * to the listing the record belongs to instead, which is a real screen and the
 * one a customer wants anyway.
 */
function deepLinkFor(entityType, entityId) {
  const path = entityId != null && DEEP_LINK_PATHS[entityType]?.(entityId);
  return `${env.appScheme}://${path || 'notifications'}`;
}

/**
 * Transactional notifications are the ones a customer is waiting for, so they
 * are worth waking the device for; everything else rides at normal priority.
 */
const HIGH_PRIORITY_TYPES = new Set([
  'OFFER_CLAIMED',
  'SERVICE_OFFER_CLAIMED',
  'OFFER_REDEEMED',
  'SERVICE_OFFER_REDEEMED',
  'BOOKING_CREATED',
  'BOOKING_UPDATED',
  'BOOKING_CANCELLED',
  'SUBSCRIPTION_BILLING',
]);

async function loadOffer(offerId) {
  return queryOne(
    `SELECT o.id, o.title, o.offer_text, o.shop_id, o.category_id, o.subcategory_id,
            o.status, o.end_date, o.applicability_type, s.name AS shop_name
       FROM offers o JOIN shops s ON s.id = o.shop_id
      WHERE o.id = ?`,
    [offerId],
  );
}

/**
 * Inserts notification rows, sends the matching emails, and pushes to every
 * device the allowed recipients have registered.
 *
 * The in-app row is the record of truth (Push §29): it is written first and
 * unconditionally, so a customer who had push switched off, whose token had
 * expired, or who was simply offline still finds the notification waiting in
 * the notification centre. Email and push are both best-effort layers on top.
 *
 * @param {Array<{id:number,name:string,email:string}>} recipients
 */
async function dispatch(recipients, { type, title, message, entityType, entityId, email, deepLink }) {
  if (!recipients.length) return 0;

  const column = PREFERENCE_COLUMN[type];
  const ids = recipients.map((recipient) => recipient.id);
  const placeholders = ids.map(() => '?').join(',');

  // Users without a preferences row fall back to "everything enabled".
  const preferences = await rawQuery(
    `SELECT user_id, email_enabled, push_enabled, ${column || 'admin_announcements'} AS allowed
       FROM notification_preferences WHERE user_id IN (${placeholders})`,
    ids,
  );
  const byUser = new Map(preferences.map((row) => [Number(row.user_id), row]));

  const allowed = recipients.filter((recipient) => {
    const preference = byUser.get(recipient.id);
    return !preference || preference.allowed === 1;
  });
  if (!allowed.length) return 0;

  // The entity is the right default destination for most types; the ones
  // whose record has no screen of its own say where to go instead.
  const destination = deepLink ?? deepLinkFor(entityType, entityId);
  const values = allowed.flatMap((recipient) => [
    recipient.id,
    type,
    title,
    message,
    entityType,
    entityId,
    destination,
  ]);
  const result = await rawQuery(
    `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id, deep_link)
     VALUES ${allowed.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
    values,
  );

  if (email) {
    await Promise.all(
      allowed
        .filter((recipient) => byUser.get(recipient.id)?.email_enabled !== 0)
        .map((recipient) => mailer.send({ to: recipient.email, ...email(recipient) })),
    );
  }

  // Push is the one layer allowed to fail quietly: the notification already
  // exists, and a dead transport must not turn into a failed claim or a failed
  // offer publish for the caller upstream.
  const pushable = allowed.filter((recipient) => byUser.get(recipient.id)?.push_enabled !== 0);
  await fanOutPush(result, allowed.length, pushable, { type, title, message, deepLink: destination, entityType, entityId })
    .catch((error) => console.error('[push] fan-out failed for %s: %s', type, error.message));

  return allowed.length;
}

/**
 * Sends the just-inserted notifications to their owners' devices.
 *
 * The insert above was one multi-row statement, so InnoDB allocated a
 * contiguous block of auto-increment ids starting at `insertId`. Reading the
 * block back is what pairs each notification id to the user it belongs to,
 * which the ticket rows need - a single notification fans out to every device
 * that user has, and each copy succeeds or fails independently.
 */
async function fanOutPush(insertResult, insertedCount, recipients, { type, title, message, deepLink, entityType, entityId }) {
  if (!recipients.length || !push.isConfigured() || !insertResult?.insertId) return;

  const firstId = Number(insertResult.insertId);
  const [inserted, devices] = await Promise.all([
    rawQuery(
      'SELECT id, user_id FROM notifications WHERE id BETWEEN ? AND ? AND type = ?',
      [firstId, firstId + insertedCount - 1, type],
    ),
    rawQuery(
      `SELECT id, user_id, token FROM push_devices
        WHERE is_active = 1 AND user_id IN (${recipients.map(() => '?').join(',')})`,
      recipients.map((recipient) => recipient.id),
    ),
  ]);
  if (!devices.length) return;

  const notificationByUser = new Map(inserted.map((row) => [Number(row.user_id), Number(row.id)]));

  const targets = [];
  const messages = [];
  for (const device of devices) {
    const notificationId = notificationByUser.get(Number(device.user_id));
    // A device whose owner was filtered out by preferences has no row here.
    if (!notificationId || !push.isExpoToken(device.token)) continue;

    targets.push({ deviceId: Number(device.id), notificationId });
    messages.push({
      to: device.token,
      title,
      body: message ?? '',
      sound: 'default',
      channelId: 'default',
      priority: HIGH_PRIORITY_TYPES.has(type) ? 'high' : 'default',
      // Read by the app's tap handler to open the right screen (Push §27).
      // Kept small and flat - Expo caps the whole payload at 4 KiB.
      data: { notificationId, type, entityType, entityId, deepLink },
    });
  }
  if (!messages.length) return;

  const results = await push.send(messages);
  await recordTickets(targets, results);
}

/**
 * Persists one ticket row per attempted device and rolls the outcome up onto
 * the notification, giving the QUEUED -> SENT / FAILED transitions of the
 * lifecycle (Push §31). Devices the transport rejected outright are retired
 * here so the next send does not waste a slot on them.
 */
async function recordTickets(targets, results) {
  const rows = targets.map((target, index) => {
    const result = results[index] ?? { ok: false, ticketId: null, error: 'NoResult' };
    return { ...target, ...result };
  });

  await rawQuery(
    `INSERT INTO push_tickets (notification_id, device_id, ticket_id, status, error_code)
     VALUES ${rows.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
    rows.flatMap((row) => [
      row.notificationId,
      row.deviceId,
      row.ticketId,
      row.ok ? 'sent' : 'failed',
      row.ok ? null : row.error,
    ]),
  );

  const sentIds = [...new Set(rows.filter((row) => row.ok).map((row) => row.notificationId))];
  const failedIds = [...new Set(rows.filter((row) => !row.ok).map((row) => row.notificationId))];

  // A notification counts as sent if it reached at least one of its devices;
  // only one that reached none of them is a failure.
  if (sentIds.length) {
    await rawQuery(
      `UPDATE notifications SET push_state = 'sent' WHERE id IN (${sentIds.map(() => '?').join(',')})`,
      sentIds,
    );
  }
  const whollyFailed = failedIds.filter((id) => !sentIds.includes(id));
  if (whollyFailed.length) {
    await rawQuery(
      `UPDATE notifications SET push_state = 'failed' WHERE id IN (${whollyFailed.map(() => '?').join(',')})`,
      whollyFailed,
    );
  }

  await retireFailedDevices(rows);
}

/**
 * A token that the transport says is gone is deactivated at once; anything
 * else (a timeout, a rate limit) only counts against a failure budget, so one
 * bad afternoon does not unsubscribe a working phone. Any success clears the
 * count back to zero.
 */
async function retireFailedDevices(rows) {
  // A ticket can outlive its device - signing out unregisters it while a push
  // may still be awaiting a receipt - so entries with no device left are
  // simply nothing to retire.
  const live = rows.filter((row) => row.deviceId);
  const fatal = live.filter((row) => !row.ok && push.isFatalTokenError(row.error)).map((row) => row.deviceId);
  const soft = live.filter((row) => !row.ok && !push.isFatalTokenError(row.error)).map((row) => row.deviceId);
  const healthy = live.filter((row) => row.ok).map((row) => row.deviceId);

  if (fatal.length) {
    await rawQuery(
      `UPDATE push_devices SET is_active = 0 WHERE id IN (${fatal.map(() => '?').join(',')})`,
      fatal,
    );
  }
  if (soft.length) {
    await rawQuery(
      `UPDATE push_devices
          SET failure_count = failure_count + 1,
              is_active = IF(failure_count + 1 >= ?, 0, is_active)
        WHERE id IN (${soft.map(() => '?').join(',')})`,
      [env.push.maxDeviceFailures, ...soft],
    );
  }
  if (healthy.length) {
    await rawQuery(
      `UPDATE push_devices SET failure_count = 0, last_seen_at = NOW()
        WHERE id IN (${healthy.map(() => '?').join(',')}) AND failure_count > 0`,
      healthy,
    );
  }
}

/** Followers of the shop, followers of the category, and nearby customers. */
async function notifyNewOffer(offerId) {
  const offer = await loadOffer(offerId);
  if (!offer || offer.status !== 'active') return;

  const [shopFollowers, categoryFollowers] = await Promise.all([
    query(
      `SELECT u.id, u.name, u.email FROM followed_shops fs
         JOIN users u ON u.id = fs.user_id AND u.status = 'active'
        WHERE fs.shop_id = ?`,
      [offer.shop_id],
    ),
    offer.category_id
      ? query(
          `SELECT u.id, u.name, u.email FROM followed_categories fc
             JOIN users u ON u.id = fc.user_id AND u.status = 'active'
            WHERE fc.category_id IN (?, ?)`,
          [offer.category_id, offer.subcategory_id ?? offer.category_id],
        )
      : Promise.resolve([]),
  ]);

  await dispatch(shopFollowers, {
    type: 'NEW_OFFER_FOLLOWED_SHOP',
    title: `New offer from ${offer.shop_name}`,
    message: offer.offer_text || offer.title,
    entityType: 'offer',
    entityId: offer.id,
    email: (recipient) =>
      mailer.templates.newOffer(
        recipient.name,
        offer,
        `${offer.shop_name}, a shop you follow, just published a new offer.`,
        offerUrl(offer.id),
      ),
  });

  const shopFollowerIds = new Set(shopFollowers.map((follower) => Number(follower.id)));
  await dispatch(
    categoryFollowers.filter((follower) => !shopFollowerIds.has(Number(follower.id))),
    {
      type: 'NEW_OFFER_FOLLOWED_CATEGORY',
      title: `New offer in a category you follow`,
      message: `${offer.shop_name}: ${offer.offer_text || offer.title}`,
      entityType: 'offer',
      entityId: offer.id,
      email: (recipient) =>
        mailer.templates.newOffer(
          recipient.name,
          offer,
          'A new offer was published in a category you follow.',
          offerUrl(offer.id),
        ),
    },
  );

  await notifyNearbyCustomers(offer, new Set([...shopFollowerIds, ...categoryFollowers.map((f) => Number(f.id))]));
  await notifyShopStaff(offer);
}

/** Customers whose preferred location falls within 10 km of an applicable branch. */
async function notifyNearbyCustomers(offer, alreadyNotified) {
  const RADIUS_KM = 10;
  const branches = await query(
    `SELECT b.latitude, b.longitude FROM shop_branches b
      WHERE b.status = 'active' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
        AND (
          (? = 'shop_wide' AND b.shop_id = ?)
          OR (? = 'selected_branches' AND EXISTS (
                SELECT 1 FROM offer_locations ol WHERE ol.offer_id = ? AND ol.branch_id = b.id))
        )`,
    [offer.applicability_type ?? 'shop_wide', offer.shop_id, offer.applicability_type ?? 'shop_wide', offer.id],
  );
  if (!branches.length) return;

  const seen = new Map();
  for (const branch of branches) {
    const lat = Number(branch.latitude);
    const lng = Number(branch.longitude);
    const box = geo.boundingBox(lat, lng, RADIUS_KM);
    const nearby = await rawQuery(
      `SELECT u.id, u.name, u.email
         FROM users u
        WHERE u.status = 'active'
          AND u.pref_latitude BETWEEN ? AND ?
          AND u.pref_longitude BETWEEN ? AND ?
          AND ${geo.distanceKmSql('u.pref_latitude', 'u.pref_longitude')} <= ?`,
      [box.minLat, box.maxLat, box.minLng, box.maxLng, ...geo.distanceKmParams(lat, lng), RADIUS_KM],
    );
    for (const user of nearby) {
      if (!alreadyNotified.has(Number(user.id))) seen.set(Number(user.id), { ...user, id: Number(user.id) });
    }
  }

  await dispatch([...seen.values()], {
    type: 'NEW_OFFER_NEARBY',
    title: 'A new offer near you',
    message: `${offer.shop_name}: ${offer.offer_text || offer.title}`,
    entityType: 'offer',
    entityId: offer.id,
    email: (recipient) =>
      mailer.templates.newOffer(
        recipient.name,
        offer,
        'A new offer was published near your preferred location.',
        offerUrl(offer.id),
      ),
  });
}

/** In-app notice to the shop's own members that their offer went live (§24). */
async function notifyShopStaff(offer) {
  const staff = await query(
    `SELECT u.id, u.name, u.email FROM shop_members sm
       JOIN users u ON u.id = sm.user_id AND u.status = 'active'
      WHERE sm.shop_id = ? AND sm.status = 'active'`,
    [offer.shop_id],
  );
  await dispatch(staff, {
    type: 'OFFER_PUBLISHED',
    title: 'Offer published',
    message: `"${offer.title}" is now live.`,
    entityType: 'offer',
    entityId: offer.id,
  });
}

/**
 * Notice to a shop's own team, for things that happen to the shop rather than
 * to an offer - a failed renewal (§10), a granted feature (§11G).
 */
async function notifyShopTeam(shopId, { type, title, message, entityType = 'shop', entityId = shopId }) {
  const staff = await query(
    `SELECT u.id, u.name, u.email FROM shop_members sm
       JOIN users u ON u.id = sm.user_id AND u.status = 'active'
      WHERE sm.shop_id = ? AND sm.status = 'active'`,
    [shopId],
  );
  return dispatch(staff, { type, title, message, entityType, entityId });
}

/** Customers who saved the offer are told when it changes. */
async function notifyOfferUpdated(offerId) {
  const offer = await loadOffer(offerId);
  if (!offer) return;
  const savers = await query(
    `SELECT u.id, u.name, u.email FROM favorites f
       JOIN users u ON u.id = f.user_id AND u.status = 'active'
      WHERE f.offer_id = ?`,
    [offerId],
  );
  await dispatch(savers, {
    type: 'OFFER_UPDATED',
    title: 'A saved offer was updated',
    message: `${offer.shop_name}: ${offer.title}`,
    entityType: 'offer',
    entityId: offer.id,
  });
}

async function notifyOfferDeactivated(offerId) {
  const offer = await loadOffer(offerId);
  if (!offer) return;
  const savers = await query(
    `SELECT u.id, u.name, u.email FROM favorites f
       JOIN users u ON u.id = f.user_id AND u.status = 'active'
      WHERE f.offer_id = ?`,
    [offerId],
  );
  await dispatch(savers, {
    type: 'OFFER_DEACTIVATED',
    title: 'A saved offer is no longer available',
    message: `${offer.shop_name}: ${offer.title}`,
    entityType: 'offer',
    entityId: offer.id,
  });
}

/**
 * Configurable saved-offer expiry reminders (§24-§26, §36). One parameterized
 * sweep handles both product offers and service offers - the notification
 * types differ, but the "find who saved something ending soon, check
 * preferences, avoid duplicates" logic must not be implemented twice.
 *
 * Thresholds are Super-Admin-configurable (`notification_thresholds`); a
 * saved listing can fire once per active threshold, deduped via
 * `notification_deliveries` rather than the `notifications` table itself, so
 * a suppressed notification (preference off) still counts as "handled" for
 * that threshold and is not re-evaluated on every run.
 */
async function findExpiringOffers(hoursBefore) {
  return query(
    `SELECT f.user_id, u.name, u.email, o.id AS offer_id, o.title, s.name AS shop_name
       FROM favorites f
       JOIN offers o ON o.id = f.offer_id AND o.status = 'active'
       JOIN shops s ON s.id = o.shop_id
       JOIN users u ON u.id = f.user_id AND u.status = 'active'
      WHERE o.end_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL ? HOUR)
        AND NOT EXISTS (
          SELECT 1 FROM offer_claims oc
           WHERE oc.user_id = f.user_id AND oc.offer_id = o.id AND oc.status = 'redeemed'
        )
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries nd
           WHERE nd.user_id = f.user_id AND nd.type = 'FAVORITE_EXPIRING'
             AND nd.entity_type = 'offer' AND nd.entity_id = o.id AND nd.threshold_hours = ?
        )`,
    [hoursBefore, hoursBefore],
  );
}

async function findExpiringServiceOffers(hoursBefore) {
  return query(
    `SELECT ss.user_id, u.name, u.email, so.id AS service_offer_id, sv.id AS service_id,
            sv.name AS service_name, s.name AS shop_name
       FROM saved_services ss
       JOIN services sv ON sv.id = ss.service_id AND sv.status = 'active'
       JOIN service_offers so ON so.service_id = sv.id AND so.status = 'active'
       JOIN shops s ON s.id = sv.shop_id
       JOIN users u ON u.id = ss.user_id AND u.status = 'active'
      WHERE so.end_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL ? HOUR)
        AND NOT EXISTS (
          SELECT 1 FROM service_offer_claims soc
           WHERE soc.user_id = ss.user_id AND soc.service_offer_id = so.id AND soc.status = 'redeemed'
        )
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries nd
           WHERE nd.user_id = ss.user_id AND nd.type = 'SAVED_SERVICE_OFFER_EXPIRING'
             AND nd.entity_type = 'service_offer' AND nd.entity_id = so.id AND nd.threshold_hours = ?
        )`,
    [hoursBefore, hoursBefore],
  );
}

/**
 * Dispatches one expiry reminder and records it in the dedup ledger.
 *
 * `entityId` is what the customer-facing notification/email link to - it must
 * be a real detail page. `dedupEntityId` is what the ledger tracks "already
 * handled" against, which is the specific thing that's expiring; the two
 * differ for service offers, where the offer itself has no standalone page
 * (only its parent service does) but each offer still needs its own dedup.
 */
async function sendExpiryReminder({
  userId,
  name,
  email,
  type,
  title,
  message,
  entityType,
  entityId,
  dedupEntityId = entityId,
  thresholdHours,
  emailTemplate,
}) {
  await dispatch([{ id: Number(userId), name, email }], {
    type,
    title,
    message,
    entityType,
    entityId,
    email: emailTemplate,
  });
  await execute(
    `INSERT IGNORE INTO notification_deliveries (user_id, type, entity_type, entity_id, threshold_hours)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, type, entityType, dedupEntityId, thresholdHours],
  );
}

async function notifyExpiringOffersAtThreshold(hoursBefore) {
  const rows = await findExpiringOffers(hoursBefore);
  for (const row of rows) {
    const offer = { id: Number(row.offer_id), title: row.title, shop_name: row.shop_name };
    await sendExpiryReminder({
      userId: row.user_id,
      name: row.name,
      email: row.email,
      type: 'FAVORITE_EXPIRING',
      title: 'A saved offer is ending soon',
      message: `${row.shop_name}: ${row.title}`,
      entityType: 'offer',
      entityId: offer.id,
      thresholdHours: hoursBefore,
      emailTemplate: (recipient) => mailer.templates.offerExpiring(recipient.name, offer, offerUrl(offer.id)),
    });
  }
  return rows.length;
}

async function notifyExpiringServiceOffersAtThreshold(hoursBefore) {
  const rows = await findExpiringServiceOffers(hoursBefore);
  for (const row of rows) {
    // What the customer sees a link to - the service, not the offer row.
    const service = { id: Number(row.service_id), title: row.service_name, shop_name: row.shop_name };
    await sendExpiryReminder({
      userId: row.user_id,
      name: row.name,
      email: row.email,
      type: 'SAVED_SERVICE_OFFER_EXPIRING',
      title: "Don't miss this service deal",
      message: `${row.shop_name}: ${row.service_name}`,
      entityType: 'service_offer',
      entityId: service.id,
      dedupEntityId: Number(row.service_offer_id),
      thresholdHours: hoursBefore,
      emailTemplate: (recipient) =>
        mailer.templates.serviceOfferExpiring(recipient.name, service, serviceUrl(service.id)),
    });
  }
  return rows.length;
}

const EXPIRY_SWEEPS = {
  offer: notifyExpiringOffersAtThreshold,
  service_offer: notifyExpiringServiceOffersAtThreshold,
};

/** Runs every configured, active threshold for one listing kind. */
async function notifyExpiringSaved(kind) {
  const sweep = EXPIRY_SWEEPS[kind];
  if (!sweep) throw new Error(`Unknown expiry kind: ${kind}`);

  const thresholds = await query('SELECT hours_before FROM notification_thresholds WHERE is_active = 1');
  let sent = 0;
  for (const { hours_before: hoursBefore } of thresholds) {
    sent += await sweep(Number(hoursBefore));
  }
  return sent;
}

/** Back-compat name for the `expiring-favourites` job history. */
const notifyExpiringOffers = () => notifyExpiringSaved('offer');
const notifyExpiringServiceOffers = () => notifyExpiringSaved('service_offer');

/**
 * Reconciles delivery receipts (Push §31).
 *
 * A ticket only means Expo accepted the message. The receipt, available a few
 * minutes later, is what Google and Apple actually did with it - and is where
 * a token that has been uninstalled finally shows up as `DeviceNotRegistered`.
 *
 * Expo drops receipts after 24 hours, so the window is bounded on both sides:
 * young enough to still exist, old enough to have been resolved. Anything that
 * ages out keeps its 'sent' status, which is the honest answer - it was sent,
 * and delivery was never confirmed either way.
 */
async function syncPushReceipts() {
  const pending = await query(
    `SELECT id, ticket_id, device_id, notification_id FROM push_tickets
      WHERE status = 'sent' AND checked_at IS NULL AND ticket_id IS NOT NULL
        AND sent_at <= DATE_SUB(NOW(), INTERVAL 15 MINUTE)
        AND sent_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      ORDER BY sent_at LIMIT 1000`,
  );
  if (!pending.length) return 0;

  const receipts = await push.getReceipts(pending.map((row) => row.ticket_id));
  const resolved = pending
    .map((row) => ({ row, receipt: receipts.get(row.ticket_id) }))
    .filter((entry) => entry.receipt);
  if (!resolved.length) return 0;

  const delivered = resolved.filter((entry) => entry.receipt.ok);
  const failed = resolved.filter((entry) => !entry.receipt.ok);

  if (delivered.length) {
    const ids = delivered.map((entry) => entry.row.id);
    await rawQuery(
      `UPDATE push_tickets SET status = 'delivered', checked_at = NOW()
        WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    const notificationIds = [...new Set(delivered.map((entry) => Number(entry.row.notification_id)))];
    await rawQuery(
      `UPDATE notifications SET push_state = 'delivered'
        WHERE id IN (${notificationIds.map(() => '?').join(',')}) AND push_state = 'sent'`,
      notificationIds,
    );
  }

  for (const entry of failed) {
    await execute(
      "UPDATE push_tickets SET status = 'failed', error_code = ?, checked_at = NOW() WHERE id = ?",
      [entry.receipt.error, entry.row.id],
    );
  }

  // Same retirement rule as at send time, applied to the errors that only
  // surface this late.
  await retireFailedDevices(
    failed.map((entry) => ({
      ok: false,
      error: entry.receipt.error,
      deviceId: entry.row.device_id === null ? null : Number(entry.row.device_id),
    })),
  );

  return resolved.length;
}

// ---- Transactional customer notifications (Push §16-§18) -------------------

/**
 * Claim confirmation. The customer is told the code they now need to show at
 * the counter, so this is the one notification whose body carries the payload
 * rather than just a pointer to it.
 */
async function notifyOfferClaimed(claimId) {
  const claim = await queryOne(
    `SELECT c.id, c.code, c.offer_id, u.id AS user_id, u.name, u.email, o.title, s.name AS shop_name
       FROM offer_claims c
       JOIN offers o ON o.id = c.offer_id
       JOIN shops s ON s.id = o.shop_id
       JOIN users u ON u.id = c.user_id AND u.status = 'active'
      WHERE c.id = ?`,
    [claimId],
  );
  if (!claim) return 0;

  return dispatch([{ id: Number(claim.user_id), name: claim.name, email: claim.email }], {
    type: 'OFFER_CLAIMED',
    title: 'Offer claimed successfully',
    message: `${claim.shop_name} - ${claim.title}. Claim code: ${claim.code}. Show this at the shop.`,
    entityType: 'offer_claim',
    entityId: Number(claim.id),
    // §37's "[View Claim]": the code and QR, which is what the customer is
    // about to need at the counter.
    deepLink: deepLinkFor('offer_claim', Number(claim.id)),
  });
}

/** Redemption confirmation, sent after the merchant verifies the code. */
async function notifyOfferRedeemed(claimId) {
  const claim = await queryOne(
    `SELECT c.id, c.offer_id, u.id AS user_id, u.name, u.email, o.title, s.name AS shop_name
       FROM offer_claims c
       JOIN offers o ON o.id = c.offer_id
       JOIN shops s ON s.id = o.shop_id
       JOIN users u ON u.id = c.user_id AND u.status = 'active'
      WHERE c.id = ?`,
    [claimId],
  );
  if (!claim) return 0;

  return dispatch([{ id: Number(claim.user_id), name: claim.name, email: claim.email }], {
    type: 'OFFER_REDEEMED',
    title: 'Offer redeemed',
    message: `Your ${claim.title} offer at ${claim.shop_name} has been successfully redeemed.`,
    entityType: 'offer_claim',
    entityId: Number(claim.id),
    deepLink: deepLinkFor('offer_claim', Number(claim.id)),
  });
}

async function notifyServiceOfferClaimed(claimId) {
  const claim = await queryOne(
    `SELECT c.id, c.code, sv.id AS service_id, u.id AS user_id, u.name, u.email,
            sv.name AS service_name, s.name AS shop_name
       FROM service_offer_claims c
       JOIN service_offers so ON so.id = c.service_offer_id
       JOIN services sv ON sv.id = so.service_id
       JOIN shops s ON s.id = sv.shop_id
       JOIN users u ON u.id = c.user_id AND u.status = 'active'
      WHERE c.id = ?`,
    [claimId],
  );
  if (!claim) return 0;

  return dispatch([{ id: Number(claim.user_id), name: claim.name, email: claim.email }], {
    type: 'SERVICE_OFFER_CLAIMED',
    title: 'Service offer claimed successfully',
    message: `${claim.shop_name} - ${claim.service_name}. Claim code: ${claim.code}.`,
    entityType: 'service_offer_claim',
    entityId: Number(claim.id),
    deepLink: deepLinkFor('service_offer_claim', Number(claim.id)),
  });
}

async function notifyServiceOfferRedeemed(claimId) {
  const claim = await queryOne(
    `SELECT c.id, sv.id AS service_id, u.id AS user_id, u.name, u.email,
            sv.name AS service_name, s.name AS shop_name
       FROM service_offer_claims c
       JOIN service_offers so ON so.id = c.service_offer_id
       JOIN services sv ON sv.id = so.service_id
       JOIN shops s ON s.id = sv.shop_id
       JOIN users u ON u.id = c.user_id AND u.status = 'active'
      WHERE c.id = ?`,
    [claimId],
  );
  if (!claim) return 0;

  return dispatch([{ id: Number(claim.user_id), name: claim.name, email: claim.email }], {
    type: 'SERVICE_OFFER_REDEEMED',
    title: 'Service offer redeemed',
    message: `Your ${claim.service_name} offer at ${claim.shop_name} has been successfully redeemed.`,
    entityType: 'service_offer_claim',
    entityId: Number(claim.id),
    deepLink: deepLinkFor('service_offer_claim', Number(claim.id)),
  });
}

/**
 * Booking notifications (Push §18). One function covers created, updated and
 * cancelled: the audience, the lookup and the destination are identical and
 * only the wording differs, so the alternative would be three copies of the
 * same query.
 */
const BOOKING_MESSAGES = {
  BOOKING_CREATED: (booking) => ({
    title: 'Booking confirmed',
    message: `${booking.service_name} at ${booking.shop_name}${booking.when ? ` - ${booking.when}` : ''}.`,
  }),
  BOOKING_UPDATED: (booking) => ({
    title: 'Booking updated',
    message: `Your ${booking.service_name} booking with ${booking.shop_name} has been updated${
      booking.when ? ` to ${booking.when}` : ''
    }.`,
  }),
  BOOKING_CANCELLED: (booking) => ({
    title: 'Booking cancelled',
    message: `Your ${booking.service_name} booking with ${booking.shop_name} has been cancelled.`,
  }),
};

async function notifyBooking(bookingId, type) {
  const template = BOOKING_MESSAGES[type];
  if (!template) throw new Error(`Unknown booking notification type: ${type}`);

  const booking = await queryOne(
    `SELECT b.id, b.requested_at, b.service_id, u.id AS user_id, u.name, u.email,
            sv.name AS service_name, s.name AS shop_name
       FROM service_bookings b
       JOIN services sv ON sv.id = b.service_id
       JOIN shops s ON s.id = sv.shop_id
       JOIN users u ON u.id = b.user_id AND u.status = 'active'
      WHERE b.id = ?`,
    [bookingId],
  );
  if (!booking) return 0;

  const when = booking.requested_at
    ? new Date(booking.requested_at).toLocaleString('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Kolkata',
      })
    : null;

  const { title, message } = template({ ...booking, when });
  return dispatch([{ id: Number(booking.user_id), name: booking.name, email: booking.email }], {
    type,
    title,
    message,
    entityType: 'service_booking',
    entityId: Number(booking.id),
    deepLink: deepLinkFor('service', Number(booking.service_id)),
  });
}

/** Maps a booking's new status onto the notification it should produce. */
const BOOKING_STATUS_TYPES = {
  confirmed: 'BOOKING_UPDATED',
  completed: 'BOOKING_UPDATED',
  cancelled: 'BOOKING_CANCELLED',
};

async function notifyBookingStatusChanged(bookingId, status) {
  const type = BOOKING_STATUS_TYPES[status];
  // 'requested' is the state a booking is created in - the confirmation for it
  // was already sent by notifyBooking(..., 'BOOKING_CREATED').
  if (!type) return 0;
  return notifyBooking(bookingId, type);
}

/** Broadcast used by Super Admins for platform-wide announcements. */
async function announce({ title, message, audience = 'all' }) {
  const filters = {
    all: "u.status = 'active'",
    admins: "u.status = 'active' AND EXISTS (SELECT 1 FROM shop_members sm WHERE sm.user_id = u.id AND sm.status = 'active')",
    customers: "u.status = 'active' AND NOT EXISTS (SELECT 1 FROM shop_members sm WHERE sm.user_id = u.id AND sm.status = 'active')",
  };
  const recipients = await query(
    `SELECT u.id, u.name, u.email FROM users u WHERE ${filters[audience] || filters.all}`,
  );
  return dispatch(recipients, {
    type: 'ADMIN_ANNOUNCEMENT',
    title,
    message,
    entityType: 'announcement',
    entityId: null,
  });
}

/**
 * Removes read notifications older than 60 days, and the delivery bookkeeping
 * that outlived its usefulness.
 *
 * Tickets belonging to a pruned notification go with it via the foreign key;
 * this only has to catch tickets whose notification is still around - an
 * unread one can sit in the feed indefinitely, but its receipt stopped being
 * answerable after 24 hours and stops being interesting long before 30 days.
 */
async function pruneOld() {
  const [notifications, tickets] = await Promise.all([
    execute('DELETE FROM notifications WHERE is_read = 1 AND created_at < DATE_SUB(NOW(), INTERVAL 60 DAY)'),
    execute('DELETE FROM push_tickets WHERE sent_at < DATE_SUB(NOW(), INTERVAL 30 DAY)'),
  ]);
  if (tickets.affectedRows) console.log('[notifications] pruned %d push tickets', tickets.affectedRows);
  return notifications.affectedRows;
}

module.exports = {
  notifyNewOffer,
  notifyShopTeam,
  notifyOfferUpdated,
  notifyOfferDeactivated,
  notifyExpiringOffers,
  notifyExpiringServiceOffers,
  notifyExpiringSaved,
  notifyOfferClaimed,
  notifyOfferRedeemed,
  notifyServiceOfferClaimed,
  notifyServiceOfferRedeemed,
  notifyBooking,
  notifyBookingStatusChanged,
  syncPushReceipts,
  announce,
  pruneOld,
  dispatch,
  deepLinkFor,
};
