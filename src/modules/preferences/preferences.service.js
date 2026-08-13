'use strict';

const { queryOne, query, transaction } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');

async function loadShape(userId, connection = null) {
  const runner = connection ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows) : query;

  const [user, categoryRows, shopRows, offerTypeRows] = await Promise.all([
    connection
      ? connection.execute('SELECT preferences_completed, minimum_discount_percent FROM users WHERE id = ?', [userId]).then(([rows]) => rows[0])
      : queryOne('SELECT preferences_completed, minimum_discount_percent FROM users WHERE id = ?', [userId]),
    runner('SELECT category_id FROM customer_category_preferences WHERE user_id = ?', [userId]),
    runner('SELECT shop_id FROM followed_shops WHERE user_id = ?', [userId]),
    runner('SELECT offer_type FROM customer_preferred_offer_types WHERE user_id = ?', [userId]),
  ]);

  if (!user) throw ApiError.notFound('User not found');

  return {
    preferencesCompleted: Boolean(user.preferences_completed),
    categoryIds: categoryRows.map((r) => Number(r.category_id)),
    shopIds: shopRows.map((r) => Number(r.shop_id)),
    minimumDiscountPercent:
      user.minimum_discount_percent === null || user.minimum_discount_percent === undefined
        ? null
        : Number(user.minimum_discount_percent),
    offerTypes: offerTypeRows.map((r) => r.offer_type),
  };
}

async function getPreferences(userId) {
  return loadShape(userId);
}

async function getStatus(userId) {
  const user = await queryOne('SELECT preferences_completed FROM users WHERE id = ?', [userId]);
  if (!user) throw ApiError.notFound('User not found');
  return { preferencesCompleted: Boolean(user.preferences_completed) };
}

/**
 * Replaces the customer's full preference set in one transaction. Categories
 * and offer types are "replace whole set" (delete + bulk insert - onboarding
 * and editing both submit the complete list, there's nothing to diff).
 * shopIds is optional: omitted means "leave favorite shops as they are"
 * (e.g. a discount-only edit), provided means "this is now the full set",
 * reusing followed_shops rather than a parallel table (see schema.sql).
 */
async function setPreferences(userId, payload) {
  await transaction(async (connection) => {
    const userRow = await connection.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]).then(([rows]) => rows[0]);
    if (!userRow) throw ApiError.notFound('User not found');

    await connection.execute('DELETE FROM customer_category_preferences WHERE user_id = ?', [userId]);
    if (payload.categoryIds.length > 0) {
      const values = payload.categoryIds.map(() => '(?, ?)').join(', ');
      const params = payload.categoryIds.flatMap((categoryId) => [userId, categoryId]);
      await connection.execute(
        `INSERT INTO customer_category_preferences (user_id, category_id) VALUES ${values}`,
        params,
      );
    }

    if (payload.offerTypes !== undefined) {
      await connection.execute('DELETE FROM customer_preferred_offer_types WHERE user_id = ?', [userId]);
      if (payload.offerTypes.length > 0) {
        const values = payload.offerTypes.map(() => '(?, ?)').join(', ');
        const params = payload.offerTypes.flatMap((offerType) => [userId, offerType]);
        await connection.execute(
          `INSERT INTO customer_preferred_offer_types (user_id, offer_type) VALUES ${values}`,
          params,
        );
      }
    }

    if (payload.shopIds !== undefined) {
      await connection.execute('DELETE FROM followed_shops WHERE user_id = ?', [userId]);
      if (payload.shopIds.length > 0) {
        const values = payload.shopIds.map(() => '(?, ?)').join(', ');
        const params = payload.shopIds.flatMap((shopId) => [userId, shopId]);
        await connection.execute(`INSERT INTO followed_shops (user_id, shop_id) VALUES ${values}`, params);
      }
    }

    // undefined = "not part of this submission, leave as-is"; null = "cleared to any discount".
    if (payload.minimumDiscountPercent !== undefined) {
      await connection.execute('UPDATE users SET preferences_completed = 1, minimum_discount_percent = ? WHERE id = ?', [
        payload.minimumDiscountPercent,
        userId,
      ]);
    } else {
      await connection.execute('UPDATE users SET preferences_completed = 1 WHERE id = ?', [userId]);
    }
  });

  return loadShape(userId);
}

module.exports = { getPreferences, getStatus, setPreferences };
