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

## Configuration

See `.env.example`. Notable values:

| Variable | Purpose |
|---|---|
| `CORS_ORIGINS` | Comma-separated browser origins allowed to call the API |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Must be changed outside development — the app refuses to boot in production with the defaults |
| `SMTP_HOST` | Leave empty to log emails to the console instead of sending |
| `STORAGE_DRIVER` | `local` (implemented) or `s3` (stub) |
| `MAX_UPLOAD_MB` | Per-image upload cap |

## Background jobs

| Job | Schedule | Does |
|---|---|---|
| `offer-lifecycle` | every 5 min | scheduled → active → expired |
| `expiring-favourites` | daily 09:00 | emails customers about saved offers ending within 48h |
| `prune` | daily 03:30 | deletes spent tokens and read notifications older than 60 days |
