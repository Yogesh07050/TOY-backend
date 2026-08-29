# Production environment variables

Every variable the backend reads, what it does in production, and whether you
have to set it. Derived from the code (`grep process.env` across `src/` and
`scripts/`), not from memory — 84 variables, all listed.

**This file contains no real values and must never contain any.** Placeholders
are written `<...>`. Real production credentials belong in `.env.production` on
the production host, or better, injected from a secrets manager — never in Git,
a ticket, or a chat message.

Production reads `.env.production` and never the generic `.env`. A production
process cannot inherit a developer's database or their test payment keys.

**Legend** — **Required**: startup fails or the feature is broken without it.
**Recommended**: has a default, but the default is wrong for production.
**Optional**: the default is fine; set it only to tune.

---

## 1. Environment and database

The four that make environment separation real. `DB_NAME` is what the app
connects to; `PRODUCTION_DB_NAME` is what it expects. If they disagree, startup
is refused — that is the check that catches a production deploy aimed at
staging.

| Variable | Status | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | **Required** | `development` | Must be exactly `production`. Everything below keys off it. |
| `DB_HOST` | **Required** | `127.0.0.1` | Private network address. Not publicly reachable. |
| `DB_PORT` | Optional | `3306` | |
| `DB_NAME` | **Required** | `offers_app` | e.g. `offers_production`. The default is the dev database — never leave it. |
| `PRODUCTION_DB_NAME` | **Required** | — | Must equal `DB_NAME`. Startup is refused if unset. |
| `PRODUCTION_DB_HOSTS` | Optional | — | Comma-separated allow-list of permitted hosts. Leave blank if the host is not predictable (service DNS, socket). |
| `DB_USER` | **Required** | `root` | A dedicated least-privilege user. `root` and `admin` are rejected at startup. |
| `DB_PASSWORD` | **Required** | empty | Rejected if empty. Must differ from dev and staging. |
| `DB_CONNECTION_LIMIT` | Recommended | `10` | Raise for production traffic; 20 is a reasonable start. |

The startup guard also rejects a `DB_NAME` containing `dev`, `staging`, `test`,
`qa`, `sandbox`, `demo`, `local` or `scratch`.

## 2. Server and origins

| Variable | Status | Default | Notes |
|---|---|---|---|
| `PORT` | Recommended | `3000` | |
| `API_PREFIX` | Optional | `/api` | Changing it breaks published client URLs. |
| `CORS_ORIGINS` | **Required** | `http://localhost:4200` | Comma-separated production web origins. The localhost default allows nothing useful in production. |
| `PUBLIC_API_URL` | **Required** | `http://localhost:3000` | Public HTTPS base. Uploaded-image URLs are built from it, so a wrong value produces broken images. |
| `APP_URL` | **Required** | `http://localhost:4200` | Public web app base. Email verification and password-reset links are built from it — wrong here means every reset link points at localhost. |
| `MOBILE_APP_SCHEME` | Recommended | `offersapp` | Must match `expo.scheme` in the mobile app, or notification deep links open nothing. |

## 3. Authentication

| Variable | Status | Default | Notes |
|---|---|---|---|
| `JWT_ACCESS_SECRET` | **Required** | placeholder | Startup refuses the shipped placeholder. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `JWT_REFRESH_SECRET` | **Required** | placeholder | A *different* secret. Same generator. |
| `JWT_ACCESS_EXPIRES_IN` | Optional | `15m` | |
| `JWT_REFRESH_EXPIRES_IN` | Optional | `30d` | |
| `BCRYPT_ROUNDS` | Optional | `12` | Do not lower. |
| `CLAIM_QR_SECRET` | Recommended | derived | Signs the QR payload on a claim. Blank derives a key from the access secret; if set, must be 32+ chars or startup fails. |

### Refresh cookie

Defaults are already correct for the common production shape (API and web app
on different domains). Only change them if that is not your shape.

| Variable | Status | Prod default | Notes |
|---|---|---|---|
| `REFRESH_COOKIE_SAMESITE` | Optional | `none` | `none` for a separate API domain; `lax` if same-site. |
| `REFRESH_COOKIE_SECURE` | Optional | `true` | Never `false` in production. `SameSite=none` requires it. |
| `REFRESH_COOKIE_DOMAIN` | Optional | empty | Set only to share the cookie across subdomains. |

## 4. Seed data

Used only by `npm run db:seed`, but read at startup — `SEED_DEMO_DATA=true`
blocks a production boot.

| Variable | Status | Default | Notes |
|---|---|---|---|
| `SEED_DEMO_DATA` | **Required** | `true` | Must be `false`. The default writes demo shops, offers and claims. |
| `SEED_SUPERADMIN_EMAIL` | **Required** | `superadmin@offers.app` | Seeding refuses the shipped default in production. |
| `SEED_SUPERADMIN_PASSWORD` | **Required** | `SuperAdmin@123` | Same — the default is printed in this repo's README. Generate: `node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"` |

## 5. Razorpay — live credentials

Live keys belong only in production. Staging uses test mode; connecting staging
to live credentials means real money moves during QA.

| Variable | Status | Default | Notes |
|---|---|---|---|
| `RAZORPAY_KEY_ID` | **Required** | empty | `rzp_live_...`. Empty makes payment endpoints answer "not configured". |
| `RAZORPAY_KEY_SECRET` | **Required** | empty | |
| `RAZORPAY_WEBHOOK_SECRET` | **Required** | empty | Without it the webhook returns 503 and no subscription ever activates. |
| `RAZORPAY_PLAN_BUSINESS` | **Required** | empty | Razorpay Plan id for ₹999 Business. |
| `RAZORPAY_PLAN_PREMIUM` | **Required** | empty | Razorpay Plan id for ₹2,500 Premium. |
| `RAZORPAY_API_BASE` | Optional | `https://api.razorpay.com/v1` | |
| `RAZORPAY_TOTAL_COUNT` | Optional | `120` | Billing cycles a mandate is authorised for. |

Point the production Razorpay webhook at the production API only.

## 6. Billing

| Variable | Status | Default | Notes |
|---|---|---|---|
| `BILLING_TAX_PERCENT` | Recommended | `18` | Appears on real invoices — confirm against current GST before launch. |
| `BILLING_GRACE_DAYS` | Optional | `5` | Days a failed renewal keeps features before downgrade. |
| `BILLING_INVOICE_PREFIX` | Optional | `INV` | |

## 7. Email

| Variable | Status | Default | Notes |
|---|---|---|---|
| `SMTP_HOST` | **Required** | empty | Empty writes mail to `mail-outbox/` instead of sending — password resets silently never arrive. |
| `SMTP_PORT` | Recommended | `587` | |
| `SMTP_SECURE` | Recommended | `false` | `true` for port 465. |
| `SMTP_USER` | **Required** | empty | |
| `SMTP_PASSWORD` | **Required** | empty | |
| `MAIL_FROM` | Recommended | `OffersOffer <no-reply@offers.app>` | Use your real sending domain or mail lands in spam. |

## 8. Storage

| Variable | Status | Default | Notes |
|---|---|---|---|
| `STORAGE_DRIVER` | Optional | `local` | Only `local` is implemented; anything else throws 501. |
| `UPLOAD_DIR` | **Required** | `uploads` | An absolute path on persistent storage, separate from staging uploads. The default is inside the repo and is lost on redeploy. |
| `MAX_UPLOAD_MB` | Optional | `5` | |

## 9. Push notifications

| Variable | Status | Default | Notes |
|---|---|---|---|
| `PUSH_ENABLED` | Recommended | `true` | |
| `PUSH_TRANSPORT` | Optional | `expo` | |
| `EXPO_ACCESS_TOKEN` | Recommended | empty | Required once Expo push security is enabled. Production project, not development. |
| `EXPO_PUSH_API_BASE` | Optional | `https://exp.host/--/api/v2/push` | |
| `PUSH_BATCH_SIZE` | Optional | `100` | Expo's per-request maximum. |
| `PUSH_TIMEOUT_MS` | Optional | `15000` | |
| `PUSH_MAX_DEVICE_FAILURES` | Optional | `5` | Consecutive failures before a token is retired. |

## 10. AI service

| Variable | Status | Default | Notes |
|---|---|---|---|
| `AI_SERVICE_ENABLED` | Recommended | `true` | `false` makes AI endpoints answer "unavailable" cleanly. |
| `AI_SERVICE_URL` | **Required** if enabled | `http://127.0.0.1:8000` | The production AI service. |
| `AI_SERVICE_TOKEN` | Recommended | empty | Shared secret. Provider API keys live in that service, never here. |
| `AI_SERVICE_TIMEOUT_MS` | Optional | `60000` | |
| `AI_HISTORY_OFFER_LIMIT` | Optional | `12` | |
| `AI_HISTORY_WINDOW_DAYS` | Optional | `180` | |
| `AI_MIN_HISTORY_OFFERS` | Optional | `2` | |

## 11. Geocoding

| Variable | Status | Default | Notes |
|---|---|---|---|
| `GEOCODING_ENABLED` | Optional | `true` | |
| `GEOCODING_PROVIDER` | Optional | `nominatim` | |
| `GEOCODING_API_BASE` | Recommended | `https://nominatim.openstreetmap.org` | The public instance allows ~1 request/second and may block heavy use. Self-host or use a commercial endpoint for production volume. |
| `GEOCODING_USER_AGENT` | Recommended | `OffersOffer/1.0 (<APP_URL>)` | Nominatim's usage policy requires an identifying agent. The default embeds `APP_URL`, so leaving `APP_URL` unset advertises localhost. |
| `GEOCODING_MIN_INTERVAL_MS` | Optional | `1100` | Do not lower against the public instance. |
| `GEOCODING_TIMEOUT_MS` | Optional | `5000` | |
| `GEOCODING_BUDGET_MS` | Optional | `12000` | |
| `GEOCODING_MAX_QUERIES` | Optional | `4` | |
| `GEOCODING_MAX_QUEUE_DEPTH` | Optional | `8` | |
| `GEOCODING_CACHE_SIZE` | Optional | `500` | |

## 12. Logging

| Variable | Status | Default | Notes |
|---|---|---|---|
| `LOG_LEVEL` | Optional | `info` in production | Raise to `debug` only to trace an incident, then put it back. |
| `LOG_PRETTY` | Recommended | `false` in production | Keep `false` — collectors need JSON lines. |
| `LOG_SERVICE_NAME` | Optional | `offers-api` | |
| `APP_VERSION` | Recommended | `package.json` version | Set from the build so "did this start after Tuesday's release?" is answerable. |
| `DEPLOYMENT_ID` | Recommended | — | Set by the deploy pipeline. |
| `LOG_SLOW_REQUEST_MS` | Optional | `500` | |
| `LOG_VERY_SLOW_REQUEST_MS` | Optional | `2000` | |
| `LOG_SLOW_QUERY_MS` | Optional | `1000` | |
| `LOG_RETENTION_DAYS` | Optional | `90` | How long `error_logs` rows are kept. Audit and payment records are governed separately. |

## 13. Discovery and cache

| Variable | Status | Default |
|---|---|---|
| `DISCOVERY_DEFAULT_RADIUS_KM` | Optional | `10` |
| `DISCOVERY_ENDING_SOON_HOURS` | Optional | `72` |
| `DISCOVERY_URGENT_HOURS` | Optional | `6` |
| `CACHE_PUBLIC_MAX_AGE` | Optional | `60` |
| `CACHE_SHARED_MAX_AGE` | Optional | `300` |

---

## The minimum that must be set

Everything else has a workable default. These 24 do not:

```
NODE_ENV  DB_HOST  DB_NAME  PRODUCTION_DB_NAME  DB_USER  DB_PASSWORD
CORS_ORIGINS  PUBLIC_API_URL  APP_URL
JWT_ACCESS_SECRET  JWT_REFRESH_SECRET
SEED_DEMO_DATA  SEED_SUPERADMIN_EMAIL  SEED_SUPERADMIN_PASSWORD
RAZORPAY_KEY_ID  RAZORPAY_KEY_SECRET  RAZORPAY_WEBHOOK_SECRET
RAZORPAY_PLAN_BUSINESS  RAZORPAY_PLAN_PREMIUM
SMTP_HOST  SMTP_USER  SMTP_PASSWORD
UPLOAD_DIR
AI_SERVICE_URL          (if AI_SERVICE_ENABLED is true)
```

Six of these are enforced at startup — `NODE_ENV`, `PRODUCTION_DB_NAME`,
`DB_USER`, `DB_PASSWORD`, `SEED_DEMO_DATA` and the two JWT secrets. The rest
fail later and more quietly: a wrong `APP_URL` sends every password-reset link
to localhost, an empty `SMTP_HOST` writes mail to a directory instead of
sending it, and a default `UPLOAD_DIR` loses every uploaded image on redeploy.

See `docs/production-database.md` for the go-live runbook and
`.env.production.example` for a fill-in-the-blanks template.
