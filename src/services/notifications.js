'use strict';

const { query, queryOne, execute, rawQuery } = require('../db/pool');
const env = require('../config/env');
const mailer = require('../utils/mailer');
const geo = require('../utils/geo');

/**
 * Notification fan-out (§24). Every notification is persisted in-app; an email
 * is additionally sent when the recipient's preferences allow it.
 *
 * All entry points are fire-and-forget from the caller's perspective - a
 * failure here must never fail the administrative action that triggered it.
 */

const offerUrl = (offerId) => `${env.appUrl}/offers/${offerId}`;

/** Preference column that gates each notification type. */
const PREFERENCE_COLUMN = {
  NEW_OFFER_FOLLOWED_SHOP: 'followed_shop_offers',
  NEW_OFFER_FOLLOWED_CATEGORY: 'followed_category_offers',
  NEW_OFFER_NEARBY: 'nearby_offers',
  FAVORITE_EXPIRING: 'favorite_expiring',
  OFFER_UPDATED: 'offer_updates',
  OFFER_DEACTIVATED: 'offer_updates',
  ADMIN_ANNOUNCEMENT: 'admin_announcements',
  OFFER_PUBLISHED: 'admin_announcements',
};

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
 * Inserts notification rows and sends the matching emails.
 * @param {Array<{id:number,name:string,email:string}>} recipients
 */
async function dispatch(recipients, { type, title, message, entityType, entityId, email }) {
  if (!recipients.length) return 0;

  const column = PREFERENCE_COLUMN[type];
  const ids = recipients.map((recipient) => recipient.id);
  const placeholders = ids.map(() => '?').join(',');

  // Users without a preferences row fall back to "everything enabled".
  const preferences = await rawQuery(
    `SELECT user_id, email_enabled, ${column || 'admin_announcements'} AS allowed
       FROM notification_preferences WHERE user_id IN (${placeholders})`,
    ids,
  );
  const byUser = new Map(preferences.map((row) => [Number(row.user_id), row]));

  const allowed = recipients.filter((recipient) => {
    const preference = byUser.get(recipient.id);
    return !preference || preference.allowed === 1;
  });
  if (!allowed.length) return 0;

  const values = allowed.flatMap((recipient) => [
    recipient.id,
    type,
    title,
    message,
    entityType,
    entityId,
  ]);
  await rawQuery(
    `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id)
     VALUES ${allowed.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
    values,
  );

  if (email) {
    await Promise.all(
      allowed
        .filter((recipient) => byUser.get(recipient.id)?.email_enabled !== 0)
        .map((recipient) => mailer.send({ to: recipient.email, ...email(recipient) })),
    );
  }

  return allowed.length;
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
 * Scheduled sweep: warns customers about saved offers expiring within 48 hours,
 * and shop staff about their own offers nearing expiry.
 */
async function notifyExpiringOffers() {
  const rows = await query(
    `SELECT f.user_id, u.name, u.email, o.id AS offer_id, o.title, s.name AS shop_name
       FROM favorites f
       JOIN offers o ON o.id = f.offer_id AND o.status = 'active'
       JOIN shops s ON s.id = o.shop_id
       JOIN users u ON u.id = f.user_id AND u.status = 'active'
      WHERE o.end_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 2 DAY)
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.user_id = f.user_id AND n.entity_type = 'offer'
             AND n.entity_id = o.id AND n.type = 'FAVORITE_EXPIRING'
        )`,
  );

  for (const row of rows) {
    const offer = { id: Number(row.offer_id), title: row.title, shop_name: row.shop_name };
    await dispatch([{ id: Number(row.user_id), name: row.name, email: row.email }], {
      type: 'FAVORITE_EXPIRING',
      title: 'A saved offer is ending soon',
      message: `${row.shop_name}: ${row.title}`,
      entityType: 'offer',
      entityId: offer.id,
      email: (recipient) => mailer.templates.offerExpiring(recipient.name, offer, offerUrl(offer.id)),
    });
  }
  return rows.length;
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

/** Removes read notifications older than 60 days. */
async function pruneOld() {
  const result = await execute(
    'DELETE FROM notifications WHERE is_read = 1 AND created_at < DATE_SUB(NOW(), INTERVAL 60 DAY)',
  );
  return result.affectedRows;
}

module.exports = {
  notifyNewOffer,
  notifyOfferUpdated,
  notifyOfferDeactivated,
  notifyExpiringOffers,
  announce,
  pruneOld,
  dispatch,
};
