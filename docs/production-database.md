# Production database — setup and go-live runbook

Implements the Production Database Separation requirements. Every command here
was rehearsed against a throwaway database and two least-privilege users; the
grants below are the ones that were verified to work, not the ones that looked
plausible.

Run these **on the production host**. Nothing in this file should ever contain
a real credential, and no production credential should be pasted into a chat,
a ticket, or a commit (§12).

---

## 0. Before you start

| | |
|---|---|
| Node | 22 (`nvm use` — see `.nvmrc`) |
| MySQL | 8.0+ |
| Reachability | The database must **not** be reachable from the public internet (§9). The API server reaches it over a private network. |

The development database (`offers_app`) stays exactly as it is. It is the
development/staging database from now on (§3) and nothing below touches it.

---

## 1. Create the database and two users

Two users, not one (§10). The application never needs to change the shape of
the schema, so it is not given the ability to.

```sql
CREATE DATABASE offers_production
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Migration user: runs `db:migrate` and `db:seed`, and nothing else.
-- Note the absence of DROP. It is not an oversight: without it
-- `migrate.js --fresh` cannot destroy the database, which is the single
-- most expensive mistake available at this prompt.
CREATE USER 'offers_migrate_prod'@'<api-server-host>' IDENTIFIED BY '<secret>';
GRANT CREATE, ALTER, INDEX, REFERENCES, SELECT, INSERT, UPDATE, DELETE
  ON offers_production.* TO 'offers_migrate_prod'@'<api-server-host>';

-- Application user: data only. This is what the running API connects as.
CREATE USER 'offers_app_prod'@'<api-server-host>' IDENTIFIED BY '<a-different-secret>';
GRANT SELECT, INSERT, UPDATE, DELETE
  ON offers_production.* TO 'offers_app_prod'@'<api-server-host>';

FLUSH PRIVILEGES;
```

The two passwords must differ from each other and from every development and
staging password (§11).

**Why these exact privileges.** The schema is 60 tables with no views,
triggers, stored procedures or temporary tables, so the migration needs
`CREATE` (tables), `ALTER` (added columns, dropped indexes and foreign keys),
`INDEX`, and `REFERENCES` (foreign keys). `CREATE` at database scope also
covers the `CREATE DATABASE IF NOT EXISTS` the migration issues, so step 1's
`CREATE DATABASE` is belt-and-braces rather than strictly required. The
application itself only ever reads and writes rows.

---

## 2. Configure the environment

```bash
cp .env.production.example .env.production
# then fill in every <placeholder>
```

Production reads `.env.production` and **never** the generic `.env` — a
production process must not be able to inherit a developer's database or their
test payment keys (§13). Injecting these as real environment variables from a
secrets manager instead of writing a file is better still; the app works either
way.

Two settings do the work of §15:

```bash
DB_NAME=offers_production             # what we connect to
PRODUCTION_DB_NAME=offers_production  # what we expect
```

If they ever disagree, the process refuses to start.

---

## 3. Apply the schema

Run as the **migration** user, not the application user:

```bash
NODE_ENV=production \
DB_USER=offers_migrate_prod DB_PASSWORD='<secret>' \
npm run db:migrate
```

Expect `Applied 60 statements to \`offers_production\``.

Never pass `--fresh` in production. It drops the database. The grant in step 1
means the attempt fails rather than succeeds, but do not rely on that.

---

## 4. Seed system data only

```bash
NODE_ENV=production \
DB_USER=offers_migrate_prod DB_PASSWORD='<secret>' \
SEED_DEMO_DATA=false \
SEED_SUPERADMIN_EMAIL='<a-real-admin-address>' \
SEED_SUPERADMIN_PASSWORD='<generated>' \
npm run db:seed
```

Generate that password rather than choosing one:

```bash
node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"
```

The seed refuses to run in production if either value is still the shipped
default — those are printed in this repo's README and identical on every
install, which is fine on a laptop and an open door on a public database.

This writes only what §29 approves:

```
permissions        47
roles               3   SUPER_ADMIN, ADMIN, CUSTOMER
categories         24
subscription_plans  3   FREE, BUSINESS (₹999), PREMIUM (₹2,500)
feature_catalogue  35
notification_thresholds  2
users               1   the first administrator
```

and no shops, offers, claims, redemptions or payments (§6, §42).

---

## 5. Verify before connecting the API

```bash
# 60 tables, and no business data
mysql -u offers_migrate_prod -p offers_production -e "
  SELECT COUNT(*) AS tables_present FROM information_schema.tables
   WHERE table_schema='offers_production';
  SELECT (SELECT COUNT(*) FROM shops)  AS shops,
         (SELECT COUNT(*) FROM offers) AS offers,
         (SELECT COUNT(*) FROM offer_claims) AS claims,
         (SELECT COUNT(*) FROM payment_transactions) AS payments;"
```

Expect `60`, and zero across the second row. Then start the API. If any of the
production configuration is wrong it will refuse to boot and name the reason:

```
APPLICATION STARTUP FAILED

Production database configuration is invalid:

  - Connected database is "offers_staging" but PRODUCTION_DB_NAME expects "offers_production".
```

---

## 6. Backups before real data arrives (§24, §25, §26)

A backup that has never been restored is not a backup. Do this before launch,
not after the first incident:

1. Enable scheduled full backups and set a retention period.
2. Enable point-in-time recovery if the host supports it.
3. Restore the backup into a **separate** empty database.
4. Run the step 5 verification against the restored copy.
5. Write down where backups live, who can restore, and how long it takes.

---

## 7. Go-live checklist (§43)

```
[ ] offers_production created, dev database untouched
[ ] Two users created; application user cannot DROP
[ ] Passwords differ from development and staging
[ ] MySQL not reachable from the public internet
[ ] .env.production filled in; NODE_ENV=production
[ ] PRODUCTION_DB_NAME matches DB_NAME
[ ] Migration applied — 60 tables
[ ] System seed applied — no shops, offers, claims or payments
[ ] Super admin credentials are not the shipped defaults
[ ] Razorpay LIVE keys here and test keys in staging (§17)
[ ] Razorpay webhook points at the production API only (§31)
[ ] Production storage separate from staging uploads (§19)
[ ] Push/Firebase credentials are the production project (§18)
[ ] Backup configured, and a restore actually tested (§26)
[ ] Startup guard verified by pointing at a wrong DB name once
[ ] Monitoring active
```

Any record created during a production smoke test is real production data.
Decide in advance how it will be removed, and write that down (§43).
