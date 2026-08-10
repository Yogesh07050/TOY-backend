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
  await connection.end();
}

main().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
