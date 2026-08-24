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
const featureCatalogue = require('../config/featureCatalogue');

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

  // ---- V3 -----------------------------------------------------------------
  // Location on the raw offer event, for the location intelligence dashboard.
  {
    table: 'offer_views',
    column: 'city',
    sql: 'ALTER TABLE offer_views ADD COLUMN city VARCHAR(120) DEFAULT NULL AFTER ip_address',
    after: [
      'ALTER TABLE offer_views ADD COLUMN latitude DECIMAL(10,7) DEFAULT NULL AFTER city',
      'ALTER TABLE offer_views ADD COLUMN longitude DECIMAL(10,7) DEFAULT NULL AFTER latitude',
      'ALTER TABLE offer_views ADD KEY idx_ov_city (city)',
      'ALTER TABLE offer_views ADD KEY idx_ov_offer_type_time (offer_id, event_type, created_at)',
    ],
  },
  {
    table: 'banners',
    column: 'campaign_id',
    sql: 'ALTER TABLE banners ADD COLUMN campaign_id BIGINT UNSIGNED DEFAULT NULL AFTER click_count',
  },

  // ---- V2 personalization ---------------------------------------------------
  // Lives on users (like pref_city/pref_latitude/pref_longitude above) so it
  // rides along on /auth/me, login and register for free — the mobile app's
  // boot-time onboarding check needs it with no extra request.
  {
    table: 'users',
    column: 'preferences_completed',
    sql: 'ALTER TABLE users ADD COLUMN preferences_completed TINYINT(1) NOT NULL DEFAULT 0 AFTER pref_longitude',
    after: [
      'ALTER TABLE users ADD COLUMN minimum_discount_percent TINYINT UNSIGNED DEFAULT NULL AFTER preferences_completed',
    ],
  },

  // ---- V4 (Services) -------------------------------------------------------
  {
    table: 'analytics_events',
    column: 'service_id',
    sql: 'ALTER TABLE analytics_events ADD COLUMN service_id BIGINT UNSIGNED DEFAULT NULL AFTER offer_id',
    after: ['ALTER TABLE analytics_events ADD KEY idx_ae_service (service_id, created_at)'],
  },
  {
    table: 'notification_preferences',
    column: 'saved_service_offer_expiring',
    sql: "ALTER TABLE notification_preferences ADD COLUMN saved_service_offer_expiring TINYINT(1) NOT NULL DEFAULT 1 AFTER favorite_expiring",
  },

  // ---- Push notifications --------------------------------------------------
  // `push_devices` and `push_tickets` are new tables, so schema.sql creates
  // them on any install; only the columns bolted onto the two pre-existing
  // notification tables need patching here.
  {
    table: 'notification_preferences',
    column: 'push_enabled',
    sql: 'ALTER TABLE notification_preferences ADD COLUMN push_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER offer_updates',
    after: [
      'ALTER TABLE notification_preferences ADD COLUMN claim_updates TINYINT(1) NOT NULL DEFAULT 1 AFTER push_enabled',
      'ALTER TABLE notification_preferences ADD COLUMN redemption_updates TINYINT(1) NOT NULL DEFAULT 1 AFTER claim_updates',
      'ALTER TABLE notification_preferences ADD COLUMN booking_updates TINYINT(1) NOT NULL DEFAULT 1 AFTER redemption_updates',
    ],
  },
  {
    table: 'notifications',
    column: 'deep_link',
    sql: 'ALTER TABLE notifications ADD COLUMN deep_link VARCHAR(255) DEFAULT NULL AFTER entity_id',
    after: [
      `ALTER TABLE notifications ADD COLUMN push_state
         ENUM('none','queued','sent','delivered','failed','cancelled','expired')
         NOT NULL DEFAULT 'none' AFTER deep_link`,
      'ALTER TABLE notifications ADD COLUMN opened_at DATETIME DEFAULT NULL AFTER is_read',
    ],
  },

  // ---- V3 Razorpay payments -----------------------------------------------
  // Gateway bookkeeping on the existing one-row-per-shop subscription.
  {
    table: 'shop_subscriptions',
    column: 'gateway_customer_id',
    sql: 'ALTER TABLE shop_subscriptions ADD COLUMN gateway VARCHAR(40) DEFAULT NULL AFTER provider_ref',
    after: [
      'ALTER TABLE shop_subscriptions ADD COLUMN gateway_customer_id VARCHAR(120) DEFAULT NULL AFTER gateway',
      'ALTER TABLE shop_subscriptions ADD COLUMN gateway_subscription_id VARCHAR(120) DEFAULT NULL AFTER gateway_customer_id',
      'ALTER TABLE shop_subscriptions ADD COLUMN gateway_plan_id VARCHAR(120) DEFAULT NULL AFTER gateway_subscription_id',
      'ALTER TABLE shop_subscriptions ADD COLUMN current_period_start DATETIME DEFAULT NULL AFTER gateway_plan_id',
      'ALTER TABLE shop_subscriptions ADD COLUMN current_period_end DATETIME DEFAULT NULL AFTER current_period_start',
      'ALTER TABLE shop_subscriptions ADD COLUMN cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0 AFTER current_period_end',
      "ALTER TABLE shop_subscriptions ADD COLUMN pending_plan ENUM('FREE','BUSINESS','PREMIUM') DEFAULT NULL AFTER cancel_at_period_end",
      'ALTER TABLE shop_subscriptions ADD COLUMN grace_until DATETIME DEFAULT NULL AFTER cancel_at_period_end',
      'ALTER TABLE shop_subscriptions ADD COLUMN autopay_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER grace_until',
      'ALTER TABLE shop_subscriptions ADD COLUMN payment_method VARCHAR(40) DEFAULT NULL AFTER autopay_enabled',
      'ALTER TABLE shop_subscriptions ADD COLUMN last_payment_at DATETIME DEFAULT NULL AFTER payment_method',
      'ALTER TABLE shop_subscriptions ADD COLUMN last_failure_reason VARCHAR(255) DEFAULT NULL AFTER last_payment_at',
      'ALTER TABLE shop_subscriptions ADD KEY idx_subscription_gateway (gateway_subscription_id)',
    ],
  },

  {
    table: 'shop_subscriptions',
    column: 'checkout_plan',
    sql: "ALTER TABLE shop_subscriptions ADD COLUMN checkout_plan ENUM('FREE','BUSINESS','PREMIUM') DEFAULT NULL AFTER pending_plan",
  },

  // ---- Persistent login: refresh_tokens becomes the device-session table ----
  {
    table: 'refresh_tokens',
    column: 'family_id',
    sql: 'ALTER TABLE refresh_tokens ADD COLUMN family_id CHAR(32) DEFAULT NULL AFTER token_hash',
    after: [
      `ALTER TABLE refresh_tokens ADD COLUMN revoked_reason
         ENUM('rotated','logout','logout_others','reuse_detected','password_changed','revoked','account_disabled')
         DEFAULT NULL AFTER revoked_at`,
      `ALTER TABLE refresh_tokens ADD COLUMN device_type
         ENUM('mobile','tablet','desktop','web','unknown') NOT NULL DEFAULT 'unknown' AFTER revoked_reason`,
      'ALTER TABLE refresh_tokens ADD COLUMN device_name VARCHAR(120) DEFAULT NULL AFTER device_type',
      'ALTER TABLE refresh_tokens ADD COLUMN platform VARCHAR(40) DEFAULT NULL AFTER device_name',
      'ALTER TABLE refresh_tokens ADD COLUMN last_used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER ip_address',
      'ALTER TABLE refresh_tokens ADD KEY idx_refresh_family (family_id)',
      // Pre-existing tokens have no family; give each its own so rotation
      // and "log out this device" behave for sessions that predate this.
      'UPDATE refresh_tokens SET family_id = REPLACE(UUID(), \'-\', \'\') WHERE family_id IS NULL',
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
  {
    name: 'banners.campaign_id -> campaigns FK',
    // The column is declared inline on `banners`, which MySQL creates before
    // `campaigns` exists, so the constraint has to be attached afterwards.
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'banners'
            AND CONSTRAINT_NAME = 'fk_banner_campaign' LIMIT 1`,
        [dbName],
      );
      return rows.length === 0;
    },
    sql: `ALTER TABLE banners
            ADD CONSTRAINT fk_banner_campaign FOREIGN KEY (campaign_id)
            REFERENCES campaigns (id) ON DELETE SET NULL`,
  },
  {
    name: 'every shop has a subscription row',
    // Entitlement checks assume the row exists; back-fill Free for shops that
    // pre-date V3 so nothing has to special-case a missing subscription.
    check: async (connection) => {
      const [rows] = await connection.query(
        `SELECT COUNT(*) AS missing FROM shops s
          WHERE NOT EXISTS (SELECT 1 FROM shop_subscriptions sub WHERE sub.shop_id = s.id)`,
      );
      return Number(rows[0].missing) > 0;
    },
    sql: `INSERT INTO shop_subscriptions (shop_id, plan, status, price_amount, payment_status)
          SELECT s.id, 'FREE', 'active', 0.00, 'not_required' FROM shops s
           WHERE NOT EXISTS (SELECT 1 FROM shop_subscriptions sub WHERE sub.shop_id = s.id)`,
  },
  {
    name: "shop_subscriptions.status += 'created','paused'",
    // Razorpay distinguishes a subscription that exists but has never been
    // paid ('created') from one halted mid-life ('paused') (§9).
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'shop_subscriptions' AND COLUMN_NAME = 'status'`,
        [dbName],
      );
      return rows.length > 0 && !rows[0].t.includes('paused');
    },
    sql: `ALTER TABLE shop_subscriptions
            MODIFY COLUMN status ENUM('created','active','past_due','paused','cancelled','expired')
            NOT NULL DEFAULT 'active'`,
  },
  {
    name: 'subscription_events.action += payment lifecycle',
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'subscription_events' AND COLUMN_NAME = 'action'`,
        [dbName],
      );
      return rows.length > 0 && !rows[0].t.includes('payment_failed');
    },
    sql: `ALTER TABLE subscription_events
            MODIFY COLUMN action ENUM('created','upgraded','downgraded','renewed','cancelled',
                                      'reactivated','payment_failed','past_due','expired','grace_started')
            NOT NULL`,
  },
  {
    name: 'feature_catalogue is in sync with config/featureCatalogue.js',
    // The catalogue is declared in code (§11J) and mirrored into the table so
    // override rows can be validated with a join. Re-running only ever
    // upserts, so a key removed from code stays in the table for history.
    check: async (connection) => {
      const [rows] = await connection.query('SELECT COUNT(*) AS n FROM feature_catalogue');
      return Number(rows[0].n) !== featureCatalogue.CATALOGUE.length;
    },
    run: async (connection) => {
      for (const entry of featureCatalogue.CATALOGUE) {
        await connection.query(
          `INSERT INTO feature_catalogue (feature_key, name, description, category, is_active)
           VALUES (?, ?, ?, ?, 1)
           ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description),
                                   category = VALUES(category), is_active = 1`,
          [entry.featureKey, entry.name, entry.description, entry.category],
        );
      }
    },
  },
  {
    name: 'push_tickets.device_id detaches instead of cascading',
    // The first cut of this table cascaded, so signing out - which unregisters
    // the device - deleted the delivery history of every push already sent to
    // it. Rebuilt as SET NULL so the ticket outlives the device.
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'push_tickets'
            AND CONSTRAINT_NAME = 'fk_pt_device' AND DELETE_RULE = 'CASCADE' LIMIT 1`,
        [dbName],
      );
      return rows.length > 0;
    },
    run: async (connection) => {
      await connection.query('ALTER TABLE push_tickets DROP FOREIGN KEY fk_pt_device');
      await connection.query('ALTER TABLE push_tickets MODIFY device_id BIGINT UNSIGNED DEFAULT NULL');
      await connection.query(
        `ALTER TABLE push_tickets ADD CONSTRAINT fk_pt_device FOREIGN KEY (device_id)
           REFERENCES push_devices (id) ON DELETE SET NULL`,
      );
    },
  },
  {
    name: 'analytics_events.service_id -> services FK',
    // `services` is created later in schema.sql than `analytics_events`, so on
    // a fresh install the constraint has to be attached after both exist.
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'analytics_events'
            AND CONSTRAINT_NAME = 'fk_ae_service' LIMIT 1`,
        [dbName],
      );
      return rows.length === 0;
    },
    sql: `ALTER TABLE analytics_events
            ADD CONSTRAINT fk_ae_service FOREIGN KEY (service_id)
            REFERENCES services (id) ON DELETE CASCADE`,
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
    // A patch is either one statement or a function, for the few that need
    // to loop over data declared in code.
    if (patch.run) await patch.run(connection);
    else await connection.query(patch.sql);
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
