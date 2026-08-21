# Offers App — Backend

Node.js / Express / MySQL API for the Offers App: shops publish discounts, customers
discover them by search, category, shop and location.

Implements the requirements document in full — RBAC, shop & branch management,
the multi-type offer model, location-aware discovery, favourites, follows,
notifications, reviews, analytics and audit logging.

---

## Requirements

- Node.js 20.11+
- MySQL 8.0+ (uses `JSON` columns, `CHECK` constraints and `DEFAULT` on `TEXT`)

## Getting started

```bash
npm install
cp .env.example .env      # then edit the DB credentials
npm run db:migrate        # create the schema
npm run db:seed           # permissions, roles, categories, demo data
npm run dev               # http://localhost:3000/api
```

`npm run db:reset` drops and rebuilds everything.

### Seeded accounts

| Role | Email | Password |
|---|---|---|
| Super Admin | `superadmin@offers.app` | `SuperAdmin@123` |
| Admin (Zara, Coimbatore) | `john@zara.com` | `ShopAdmin@123` |
| Customer | `priya@example.com` | `Customer@123` |

Change `SEED_SUPERADMIN_*` in `.env` before seeding anywhere real, and set
`SEED_DEMO_DATA=false` to skip the sample shops and offers.

---

## Architecture

```
src/
  config/       env parsing, canonical permission catalogue
  db/           connection pool, schema.sql, migrate + seed scripts
  middleware/   auth, authorize, validate, upload, rate limits, error handler
  services/     accessControl, notifications, storage (image pipeline)
  modules/      one folder per resource: routes -> controller -> service -> SQL
  jobs/         cron: offer lifecycle, expiry reminders, token pruning
  utils/        errors, tokens, geo maths, pagination, audit, mailer
```

Queries are hand-written SQL through `mysql2` prepared statements. There is no
ORM: the discovery query needs correlated subqueries and a bounding-box
prefilter that an ORM would obscure.

### Authorization

The chain from §38 is enforced on every protected route:

```
authenticated user -> role -> permission -> resource ownership -> allow / deny
```

- Permissions are resolved **per request** (`services/accessControl`), not baked
  into the JWT, so revoking a role takes effect immediately.
- A user's permissions are the union of their **global roles** (`user_roles`)
  and the **shop-scoped role** attached to each `shop_members` row.
- `requireGlobalPermission` demands the permission application-wide;
  `requireShopScope` demands it for one specific shop; `loadOfferForWrite` loads
  the offer first and checks its `shop_id` against the caller's memberships.

That last one is what stops an Admin at Zara from editing an H&M offer by
changing the id in the URL — verified by the ownership tests below.

> Note on permission choice: `VIEW_OFFERS` and `VIEW_SHOP` are granted to every
> customer (they only mean "may browse"). Management endpoints therefore scope
> on `EDIT_OFFER` / `EDIT_SHOP` / `VIEW_SHOP_MEMBERS` instead. Using a
> browse-level permission for scoping silently widens access to every shop.

### Role scope — why an Admin is an admin *of a shop*

Every role carries a `scope`:

| scope | permissions apply |
|---|---|
| `global` | application-wide, across every shop |
| `shop` | only to the shops the user is a member of |

`SUPER_ADMIN` and `CUSTOMER` are global. **`ADMIN` is shop-scoped**, because §3.2
defines an Admin as "a user assigned to a particular shop".

The practical consequence: giving someone the ADMIN role grants nothing on its
own — they must also be attached to a shop (`shop_members`). Two ways to do it:

- `POST /api/shops/:id/members` — from the shop's side, or
- `POST /api/users/:id/memberships` — from the user's side, which is what the
  Users admin screen uses.

Until that happens the API reports the role in `unassignedShopRoles` on
`/auth/me`, and the UI says so explicitly rather than silently showing the
person a customer view.

Without scoping, a globally-assigned ADMIN would have passed
`hasGlobalPermission('EDIT_OFFER')` and gained control of *every* shop.

### Offer lifecycle

`draft → scheduled → active → expired`, plus manual `deactivated`.

The status is derived from the dates on write, and a cron job (`jobs/index.js`,
every 5 minutes) promotes `scheduled → active` and `active → expired`. Public
listings additionally filter on `start_date <= NOW() <= end_date`, so a missed
tick can never surface an offer early or late.

### Location search

Distance is computed in SQL, never in the client (§33):

1. A bounding box on `(latitude, longitude)` range-scans `idx_branch_geo`.
2. The Haversine expression then computes the exact distance to the nearest
   *applicable* branch — which depends on `applicability_type`
   (`shop_wide` / `selected_branches` / `online`).
3. `HAVING distance_km <= radius` applies the radius, and `sort=nearest`
   orders by it.

### Email

Verification and password-reset links go out over SMTP. **With `SMTP_HOST`
empty nothing is sent** — messages are written to `mail-outbox/*.html` and the
link is printed to the server log, so signup can still be completed locally.

The API never claims otherwise: `/auth/forgot-password` and
`/auth/resend-verification` return `delivered: true|false`, `/health` reports
`email: smtp | not-configured`, and the transport is checked once at boot so a
bad password surfaces on startup rather than at a customer's first reset.

`.env.example` has working Gmail and Mailtrap settings to copy.

Tokens are never returned in an API response — only emailed, logged or written
to the outbox — so the fallback cannot be used to take over an account.

### V2: featured banners

A banner promotes exactly one offer, so `offer_id` is `NOT NULL`. The offer's
validity always beats the banner's (§10): an expired or deactivated offer pulls
its banner off the customer page even while the banner's own window is open.

That rule lives in one place — `LIVE_BANNER_CONDITION` in
`modules/banners/banner.service.js` — used by both the customer feed and the
admin `isLive` flag, so the two can never disagree.

Banner permissions are granted **individually**. `VIEW_BANNERS`, `CREATE_BANNER`,
`EDIT_BANNER`, `DELETE_BANNER` and `PUBLISH_BANNER` are deliberately absent from
the built-in ADMIN role (§6): a Super Admin grants them per Admin, typically via
a custom shop-scoped role. Creating and publishing are separate, so an Admin can
hold `CREATE_BANNER` and still be refused a published banner — it saves as a
draft instead.

### V2: discovery

`/api/discovery/featured|ending-soon|nearby|recommended` are read-only and
anonymous-friendly (`optionalAuth`), so the future mobile app (§26) can call
them before login and get a personalised response afterwards.

Recommendations live in `services/recommendations.js` as a standalone,
rule-based scorer using the §21 weights. Each result carries the `score` and a
human `reason` ("Because you follow this shop"), and the module has a single
entry point so a model can replace the internals later without touching the
routes.

Ending Soon thresholds and the default radius are configurable via
`DISCOVERY_*` env vars rather than hardcoded (§16).

### V2: claims, redemptions and the funnel

A claim reserves an offer and issues a short code (no O/0/I/1, so it survives
being read aloud); shop staff redeem it with `REDEEM_CLAIM`, scoped to their own
shop. Claiming twice returns the same code rather than issuing a second one.

Together these close the §24 funnel — impressions → views → saves → claims →
redemptions — where each stage reports its conversion against the previous one.
`/api/analytics/funnel` and `/growth` accept `days` or an explicit `from`/`to`
range, and every query in a response uses the same resolved window.

### Images

Uploads are buffered in memory, re-encoded through `sharp` (which also
neutralises files that merely claim an image MIME type), resized, converted to
WebP and given a thumbnail. Only URLs are stored in MySQL. Swapping local disk
for S3/CDN means implementing `put()` in `services/storage.js`; nothing else
changes.

---

## API

All routes are under `/api`. Responses are enveloped:

```jsonc
{ "success": true, "data": ... , "meta": { "page": 1, "total": 42 } }
{ "success": false, "error": { "code": "FORBIDDEN", "message": "..." } }
```

| Area | Routes |
|---|---|
| Auth | `POST /auth/register\|login\|logout\|refresh-token\|forgot-password\|reset-password\|verify-email\|resend-verification\|change-password`, `GET /auth/me` |
| Users | `GET /users`, `GET /users/:id`, `PUT /users/:id`, `PATCH /users/:id/status`, `PUT /users/me` |
| Shop access | `POST /users/:id/memberships`, `PUT\|DELETE /users/:id/memberships/:membershipId` |
| Roles | `GET|POST /roles`, `GET|PUT|DELETE /roles/:id` |
| Permissions | `GET|POST /permissions`, `PUT|DELETE /permissions/:id` |
| Shops | `GET|POST /shops`, `GET|PUT|DELETE /shops/:id` |
| Branches | `GET|POST /shops/:id/branches`, `PUT|DELETE /shops/:id/branches/:branchId` |
| Members | `GET|POST /shops/:id/members`, `PUT|DELETE /shops/:id/members/:memberId` |
| Categories | `GET|POST /categories`, `GET|PUT|DELETE /categories/:id` |
| Offers | `GET|POST /offers`, `GET|PUT|DELETE /offers/:id`, `PATCH /offers/:id/status`, `POST /offers/:id/track` |
| Reviews | `GET|POST /offers/:id/reviews`, `GET /reviews`, `PUT|DELETE /reviews/:id` |
| Favorites | `GET /favorites`, `POST|DELETE /favorites/:offerId` |
| Following | `GET /following/shops\|categories`, `POST|DELETE /following/shops/:shopId`, `POST|DELETE /following/categories/:categoryId` |
| Notifications | `GET /notifications`, `PATCH /notifications/:id/read`, `PATCH /notifications/read-all`, `GET|PUT /notifications/preferences`, `POST /notifications/announce` |
| Analytics | `GET /analytics/overview\|offers\|shops\|categories\|locations`, `GET /analytics/shops/:shopId` |
| Audit | `GET /audit-logs`, `GET /audit-logs/filters` |
| Uploads | `POST /uploads/:type` (`offers\|shops\|categories\|avatars`), `POST /uploads/offers/batch` |
| Banners (V2) | `GET\|POST /banners`, `GET\|PUT\|DELETE /banners/:id`, `PATCH /banners/:id/status`, `GET /banners/selectable-offers`, `GET /banners/analytics` |
| Discovery (V2) | `GET /discovery/featured\|ending-soon\|nearby\|recommended`, `POST /discovery/featured/:id/track` |
| Claims (V2) | `GET /claims`, `POST /claims/:offerId`, `GET /claims/lookup/:code`, `POST /claims/lookup/:code/redeem` |
| Analytics (V2) | `GET /analytics/funnel`, `GET /analytics/growth` |
| Subscriptions (V3) | `GET /subscriptions/plans`, `PUT /subscriptions/plans/:id`, `GET\|PUT /subscriptions/shops/:shopId` |
| AI (V3) | `POST /ai/offer-assistant/recommend\|regenerate`, `POST /ai/content/generate\|regenerate`, `POST /ai/offer/improve`, `GET /ai/shops\|usage\|history\|status`, `GET /ai/capabilities/:shopId`, `GET\|PATCH /ai/history/:id` |

### Offer listing parameters

```
?search=shirt          &category=clothing   &shop=zara
&city=Coimbatore       &pincode=641004      &branchId=3
&latitude=11.0168      &longitude=76.9558   &radius=10
&minDiscount=30        &maxDiscount=70      &offerType=percentage
&status=active         &expiringInDays=7    &startDate=&endDate=
&favorites=true        &following=true      &manage=true
&sort=newest|endingSoon|highestDiscount|mostViewed|mostPopular|nearest
&page=1&limit=20
```

`manage=true` switches to the management view: drafts and expired offers,
restricted to shops the caller may administer.

---

## Security

- bcrypt password hashing; strength rules enforced server-side.
- Short-lived JWT access tokens; refresh tokens are **rotated** on use, stored
  only as SHA-256 digests, and revoked on password reset or deactivation.
- The refresh token is also set as an `httpOnly` cookie for the browser client.
- Login answers identically for an unknown email and a wrong password, and
  spends comparable time, so it cannot be used to enumerate accounts.
- Every input is parsed by a Zod schema that *replaces* the request part, so
  handlers only ever see coerced, whitelisted values.
- All SQL uses placeholders. `LIMIT`/`OFFSET` cannot be bound in MySQL, so they
  are integer-coerced and range-clamped before interpolation.
- `helmet`, CORS allow-list, compression, and tiered rate limits (auth: 20 failed
  attempts / 15 min; email: 5 / hour).
- Uploads are type-checked, size-capped and re-encoded before touching disk.
- Error responses never include stack traces in production.

### V3: subscriptions and the AI features

Three tiers, seeded into `subscription_plans` and editable by a Super Admin
through `PUT /subscriptions/plans/:id` — TOY.md requires the allowances to be
configurable rather than hardcoded.

| | Free | Business (₹999) | Premium (₹2,500) |
|---|---|---|---|
| AI Offer Assistant | — | — | ✅ unlimited |
| AI Content Generator | — | ✅ 10 / month | ✅ unlimited |
| AI Offer Optimisation | — | — | ✅ |
| History / location / timing insights | — | — | ✅ |
| Social captions | — | — | ✅ |

A shop with no `shop_subscriptions` row, a cancelled one, or one whose
`expires_at` has passed is on Free. Expiry is resolved on read, so a lapsed
subscription stops working immediately rather than at the next nightly job.

**The AI itself lives in `TOY-ai-backend/`** (Python / FastAPI, nested inside
this project), which is the only process holding a Gemini or OpenAI key. This API is what makes it safe to call:

```
authorise the shop → check the plan → gather only that shop's data →
call the AI service → validate the response → re-check it against the offer →
record usage and history → return
```

Notable pieces:

- `services/subscriptions.js` — plan resolution and the monthly quota. Only
  *successful* generations count, so a provider outage never costs a merchant
  their allowance.
- `modules/ai/ai.context.js` — builds the merchant context. Scoped to one shop
  id throughout; the location and timing sections are aggregate counts, and
  premium-only sections are not even queried when the plan excludes them.
- `modules/ai/ai.guard.js` — an independent re-check of generated copy against
  the offer's real numbers. §40 says never trust AI discount values without
  validation, and trusting another service to have validated them does not
  satisfy that. Copy that fails is dropped, not shown.
- `ai_usage` / `ai_generations` — metering (§32) and the accepted/rejected
  history (§33).

No AI endpoint writes to `offers`. §10 and §35 require the admin to review,
edit and publish, so the assistant returns a pre-fill and the admin's own
`POST /offers` creates the offer.

If the AI service is unreachable or the provider fails, the endpoints return a
plain "try again later" message — the provider's own error is logged, never
returned (§36, §37) — and the normal offer workflow is unaffected.

## Configuration

See `.env.example`. Notable values:

| Variable | Purpose |
|---|---|
| `CORS_ORIGINS` | Comma-separated browser origins allowed to call the API |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Must be changed outside development — the app refuses to boot in production with the defaults |
| `SMTP_HOST` | Leave empty to log emails to the console instead of sending |
| `STORAGE_DRIVER` | `local` (implemented) or `s3` (stub) |
| `MAX_UPLOAD_MB` | Per-image upload cap |
| `AI_SERVICE_URL` | Where `TOY-ai-backend` is listening |
| `AI_SERVICE_TOKEN` | Shared secret; must match the AI service's own value |
| `AI_SERVICE_ENABLED` | `false` makes the AI endpoints answer "unavailable" cleanly |
| `AI_HISTORY_WINDOW_DAYS` / `AI_MIN_HISTORY_OFFERS` | How much history the assistant may use, and how little counts as "not enough" (§38) |

## Background jobs

| Job | Schedule | Does |
|---|---|---|
| `offer-lifecycle` | every 5 min | scheduled → active → expired |
| `expiring-favourites` | daily 09:00 | emails customers about saved offers ending within 48h |
| `prune` | daily 03:30 | deletes spent tokens and read notifications older than 60 days |
