'use strict';

const mysql = require('mysql2/promise');
const env = require('../config/env');

const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: env.db.connectionLimit,
  queueLimit: 0,
  charset: 'utf8mb4_unicode_ci',
  dateStrings: ['DATE'],
  timezone: 'Z',
  // Everything goes through placeholders; this keeps mysql2 from client-side
  // interpolating values and gives us server-side prepared statements.
  namedPlaceholders: false,
  decimalNumbers: true,
});

/** Run a query and return the rows. */
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/** Run a query and return the first row (or null). */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/** Run an INSERT/UPDATE/DELETE and return the raw result header. */
async function execute(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

/**
 * Some statements (dynamic LIMIT/OFFSET, multi-row IN lists) are easier to build
 * with inline values that mysql2 escapes for us. `pool.query` still escapes
 * every `?` placeholder, it just does not use the binary protocol.
 */
async function rawQuery(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

/** Run `fn` inside a transaction, rolling back on any throw. */
async function transaction(fn) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function healthCheck() {
  const rows = await rawQuery('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

module.exports = { pool, query, queryOne, execute, rawQuery, transaction, healthCheck };
