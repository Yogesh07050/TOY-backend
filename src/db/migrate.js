'use strict';

/**
 * Applies `schema.sql` to the configured database, creating the database first
 * if it does not exist.
 *
 *   node src/db/migrate.js           # create/upgrade
 *   node src/db/migrate.js --fresh   # drop the database first
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const env = require('../config/env');

const FRESH = process.argv.includes('--fresh');

/** Split a .sql file into statements, ignoring `--` comments. */
function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/**
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table untouched, so columns
 * added to schema.sql after the first deploy need an explicit ALTER. Each patch
 * is checked against information_schema first, making this safe to re-run.
 */
const COLUMN_PATCHES = [
  {
    table: 'roles',
    column: 'scope',
    sql: "ALTER TABLE roles ADD COLUMN scope ENUM('global','shop') NOT NULL DEFAULT 'shop' AFTER description",
    // Existing installs pre-date scoping; keep the built-ins behaving correctly.
    after: [
      "UPDATE roles SET scope = 'global' WHERE name IN ('SUPER_ADMIN', 'CUSTOMER')",
      "UPDATE roles SET scope = 'shop' WHERE name = 'ADMIN'",
    ],
  },
];

/**
 * Patches that are not "add a missing column" - each carries its own check so
 * re-running the migration is still a no-op.
 */
const STATEMENT_PATCHES = [
  {
    name: "offer_views.event_type += 'impression'",
    // V2 tracks impressions to close the top of the funnel (§24).
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'offer_views' AND COLUMN_NAME = 'event_type'`,
        [dbName],
      );
      return rows.length > 0 && !rows[0].t.includes('impression');
    },
    sql: `ALTER TABLE offer_views
            MODIFY COLUMN event_type ENUM('view','click','share','impression')
            NOT NULL DEFAULT 'view'`,
  },
];

async function applyPatches(connection, dbName) {
  const applied = [];
  for (const patch of COLUMN_PATCHES) {
    const [rows] = await connection.query(
      `SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
      [dbName, patch.table, patch.column],
    );
    if (rows.length) continue;

    await connection.query(patch.sql);
    for (const followUp of patch.after ?? []) await connection.query(followUp);
    applied.push(`${patch.table}.${patch.column}`);
  }

  for (const patch of STATEMENT_PATCHES) {
    if (!(await patch.check(connection, dbName))) continue;
    await connection.query(patch.sql);
    applied.push(patch.name);
  }

  return applied;
}

async function main() {
  const connection = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    multipleStatements: false,
  });

  const dbName = env.db.database;
  if (FRESH) {
    console.log(`Dropping database \`${dbName}\` ...`);
    await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  }

  await connection.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await connection.query(`USE \`${dbName}\``);

  const sql = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = splitStatements(sql);

  for (const statement of statements) {
    await connection.query(statement);
  }
  console.log(`Applied ${statements.length} statements to \`${dbName}\`.`);

  const patched = await applyPatches(connection, dbName);
  if (patched.length) console.log(`Patched existing tables: ${patched.join(', ')}.`);

  await connection.end();
}

main().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
