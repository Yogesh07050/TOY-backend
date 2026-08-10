'use strict';

const { queryOne, execute, rawQuery } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const { limitOffset } = require('../../utils/pagination');
const accessControl = require('../../services/accessControl');

const mapReview = (row) => ({
  id: Number(row.id),
  offerId: row.offer_id === null ? null : Number(row.offer_id),
  shopId: row.shop_id === null ? null : Number(row.shop_id),
  rating: Number(row.rating),
  comment: row.comment,
  status: row.status,
  user: { id: Number(row.user_id), name: row.user_name, avatarUrl: row.avatar_url },
  offerTitle: row.offer_title,
  shopName: row.shop_name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const SELECT = `
  SELECT r.*, u.name AS user_name, u.avatar_url,
         o.title AS offer_title, s.name AS shop_name
    FROM reviews r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN offers o ON o.id = r.offer_id
    LEFT JOIN shops s ON s.id = r.shop_id`;

async function listForOffer(offerId, params, user) {
  const { limit, page, offset } = limitOffset(params);

  // Only moderators see anything other than approved reviews; a customer can
  // additionally always see their own pending review.
  const canModerate = user && accessControl.hasAnyPermission(user, 'MODERATE_REVIEWS');
  const where = ['r.offer_id = ?'];
  const whereParams = [offerId];

  if (!canModerate) {
    if (user) {
      where.push("(r.status = 'approved' OR r.user_id = ?)");
      whereParams.push(user.id);
    } else {
      where.push("r.status = 'approved'");
    }
  } else if (params.status && params.status !== 'all') {
    where.push('r.status = ?');
    whereParams.push(params.status);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const [rows, countRows] = await Promise.all([
    rawQuery(`${SELECT} ${whereSql} ORDER BY r.created_at DESC LIMIT ${limit} OFFSET ${offset}`, whereParams),
    rawQuery(`SELECT COUNT(*) AS total FROM reviews r ${whereSql}`, whereParams),
  ]);

  return {
    items: rows.map(mapReview),
    pagination: { page, limit, total: Number(countRows[0].total) },
  };
}

/** One review per customer per offer; posting again edits the existing one. */
async function upsertForOffer(offerId, payload, user) {
  const offer = await queryOne('SELECT id, shop_id, status FROM offers WHERE id = ?', [offerId]);
  if (!offer) throw ApiError.notFound('Offer not found');

  const existing = await queryOne('SELECT * FROM reviews WHERE user_id = ? AND offer_id = ?', [
    user.id,
    offerId,
  ]);

  if (existing) {
    await execute('UPDATE reviews SET rating = ?, comment = ? WHERE id = ?', [
      payload.rating,
      payload.comment ?? null,
      existing.id,
    ]);
    return getById(existing.id);
  }

  const result = await execute(
    'INSERT INTO reviews (user_id, offer_id, shop_id, rating, comment) VALUES (?, ?, ?, ?, ?)',
    [user.id, offerId, offer.shop_id, payload.rating, payload.comment ?? null],
  );
  return getById(result.insertId);
}

async function getById(id) {
  const rows = await rawQuery(`${SELECT} WHERE r.id = ?`, [id]);
  if (!rows.length) throw ApiError.notFound('Review not found');
  return mapReview(rows[0]);
}

/**
 * Authors may edit their own review's text and rating. Moderators may
 * additionally change its status (§26).
 */
async function update(id, payload, user) {
  const existing = await queryOne('SELECT * FROM reviews WHERE id = ?', [id]);
  if (!existing) throw ApiError.notFound('Review not found');

  const isAuthor = Number(existing.user_id) === user.id;
  const canModerate = accessControl.hasAnyPermission(user, 'MODERATE_REVIEWS');
  if (!isAuthor && !canModerate) throw ApiError.forbidden('You can only edit your own review');
  if (payload.status && !canModerate) throw ApiError.forbidden('Only moderators can change a review status');

  await execute('UPDATE reviews SET rating = ?, comment = ?, status = ? WHERE id = ?', [
    payload.rating ?? existing.rating,
    payload.comment !== undefined ? payload.comment : existing.comment,
    payload.status ?? existing.status,
    id,
  ]);
  return getById(id);
}

async function remove(id, user) {
  const existing = await queryOne('SELECT * FROM reviews WHERE id = ?', [id]);
  if (!existing) throw ApiError.notFound('Review not found');

  const isAuthor = Number(existing.user_id) === user.id;
  if (!isAuthor && !accessControl.hasAnyPermission(user, 'MODERATE_REVIEWS')) {
    throw ApiError.forbidden('You can only remove your own review');
  }
  await execute('DELETE FROM reviews WHERE id = ?', [id]);
  return existing;
}

/** Moderation queue for Super Admins. */
async function listAll(params) {
  const { limit, page, offset } = limitOffset(params);
  const where = [];
  const whereParams = [];
  if (params.status && params.status !== 'all') {
    where.push('r.status = ?');
    whereParams.push(params.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows, countRows] = await Promise.all([
    rawQuery(`${SELECT} ${whereSql} ORDER BY r.created_at DESC LIMIT ${limit} OFFSET ${offset}`, whereParams),
    rawQuery(`SELECT COUNT(*) AS total FROM reviews r ${whereSql}`, whereParams),
  ]);

  return { items: rows.map(mapReview), pagination: { page, limit, total: Number(countRows[0].total) } };
}

module.exports = { listForOffer, upsertForOffer, getById, update, remove, listAll };
