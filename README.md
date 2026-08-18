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

### V3: subscription plans

Three merchant tiers, defined once in `config/plans.js` — pricing, feature
flags and usage limits together. The API serves that same object to the
frontend, so the pricing table, the upgrade prompts and the server-side checks
cannot drift apart.

| | Free | Business | Premium |
|---|---|---|---|
| Price / month | ₹0 | ₹999 | ₹2,500 |
| Offers | 1 per month | unlimited | unlimited |
| Branches | 1 | 2 | unlimited |
| Categories | 1 | 5 | unlimited |
| Featured banners | — | — | unlimited |
| Analytics | basic views | standard | advanced |
| Export | — | — | CSV + Excel |
| Discovery | basic | standard | priority eligibility |

Enforcement lives in `services/entitlements.js`, which knows nothing about
Express so a rule can be checked at the point it actually applies —
`offer.service` checks the monthly allowance where an offer is published, not
at the edge. `middleware/subscription.js` wraps the same checks for route-level
gating. Every refusal is a 403 with code `PLAN_UPGRADE_REQUIRED` and details
naming the plan required, which is what lets the UI render a contextual upgrade
prompt without hard-coding the ladder:

```jsonc
{ "success": false, "error": {
    "code": "PLAN_UPGRADE_REQUIRED",
    "message": "Featured banners is available with the ₹2,500 Premium plan.",
    "details": { "requiredPlan": "PREMIUM", "feature": "FEATURED_BANNERS", "currentPlan": "BUSINESS" } } }
```

Limits are checked against the source tables (offers, branches, categories),
never against the counters — a counter that drifted can therefore never unblock
a limit. `subscription_usage` is the audit trail of what was published, not the
gate. Super Admins are exempt from plan gates throughout: they administer the
platform rather than subscribe to it.

### V3: premium analytics

Seventeen dashboards under `/api/analytics/premium`, all sharing one filter
contract (date preset or custom range, branch, category, offer, campaign,
location) and one scope resolver. Ownership is resolved first and is never
relaxed by a plan: a paid plan widens what a merchant sees about *their own*
shops, never whose shops they can see.

Counts come from the raw event tables over an explicit window, using correlated
subqueries rather than joins — joining `offers` to both `offer_views` and
`offer_claims` multiplies each offer by its claims and silently inflates every
view count. Conversions follow §10 rather than strict adjacency: claims convert
from **views**, not from saves, because claiming an offer never required saving
it first (dividing by saves reports rates above 100% as soon as claims outnumber
saves).

`analytics_daily_snapshots` holds nightly per-shop and per-offer roll-ups for
trend queries, rebuilt idempotently by the `analytics-snapshots` job.
`shop_customers` records first/last engagement per shop, which is what makes
new-vs-returning answerable without scanning the whole event stream.

Exports are generated in-process: `utils/exporters.js` writes CSV (with a BOM,
so Excel on Windows reads UTF-8 rather than mangling the rupee sign) and a real
OOXML `.xlsx` package — a genuine ZIP with content types, relationships and
styles, not a renamed CSV — so no dependency was added for it.

### V3: premium discovery

Premium buys priority **eligibility**, not placement (§36). The boost is a
tie-breaker *inside* a relevance band, never a key that outranks relevance:
offers are bucketed first by what the customer asked for — the kilometre they
sit in, the day they were posted, how soon they end — and only within a bucket
does a paid plan surface first. A Premium shop can win a tie at the same
distance; it can never jump ahead of a genuinely nearer offer. Management
listings are never reordered by plan.

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
| Sessions | `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/sessions/revoke-others` |
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
| Subscriptions (V3) | `GET /subscriptions/plans\|me\|current`, `GET /subscriptions/shops/:shopId\|/usage\|/history\|/billing-history\|/invoices`, `PUT /subscriptions/shops/:shopId` (Free only), `POST /subscriptions/shops/:shopId/checkout\|checkout/verify\|upgrade\|downgrade\|cancel\|confirm-payment` |
| Payments (Razorpay) | `POST /payments/razorpay/webhook`, `GET /payments/config`, `GET /payments/transactions` (Super Admin) |
| Feature overrides (Super Admin) | `GET /feature-overrides\|/catalogue\|/summary\|/history`, `GET /feature-overrides/shops/:shopId`, `POST /feature-overrides/shops/:shopId`, `DELETE /feature-overrides/shops/:shopId/:featureKey` |
| Campaigns (V3) | `GET\|POST /campaigns`, `GET\|PUT\|DELETE /campaigns/:id` |
| Premium analytics (V3) | `GET /analytics/premium/overview\|offer-performance\|funnel\|locations\|branches\|customers\|acquisition\|retention\|campaigns\|offer-comparison\|discount-effectiveness\|best-time\|ending-soon\|offer-health\|recommendations\|category-insights\|roi\|offer-intelligence` |
| Reports (V3) | `GET /analytics/premium/reports`, `GET /analytics/premium/reports/export?type=&format=csv\|xlsx` |
| Event ingest (V3) | `POST /analytics/events`, `POST /analytics/events/batch`, `GET /analytics/events/types` |

### Premium analytics parameters

```
?preset=today|yesterday|last7|last30|last90|thisMonth|lastMonth|custom
&from=2026-07-01       &to=2026-07-31       (custom range)
&shopId=1              &branchId=3          &categoryId=2
&offerId=7             &campaignId=1        &city=Coimbatore
&offerType=percentage  &discountType=flat   &status=active
&sort=views|claims|redemptions|conversion|saves|newest   &limit=50
```

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
- Rotation carries a **session family** (`refresh_tokens.family_id`): one family
  per device. Presenting a token that was already rotated away means a copy
  leaked, so the whole family is revoked — the thief and the owner cannot take
  turns refreshing.
- The refresh token is also set as an `httpOnly` cookie for the browser client,
  which is what lets the web app stay signed in without a long-lived credential
  in `localStorage`. `REFRESH_COOKIE_SAMESITE` tunes it per deployment.
- A password change signs out every *other* device; the one that made the
  change keeps its session, having just proved it knows the old password.
- **Subscriptions are never activated by the frontend.** A paid plan is created
  `pending` and only a signature-verified Razorpay webhook may set it active.
  Merchant Admins cannot set a paid plan, confirm a payment, or grant
  themselves a feature — all three are refused at the route.
- Razorpay webhooks are verified by HMAC over the **raw** request body and
  deduplicated on a unique `(gateway, event_id)` key, so redelivery is a no-op.
- No card number, CVV, PIN, UPI PIN or banking credential is ever received or
  stored — only gateway identifiers and the descriptors Razorpay echoes back.
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
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Leave empty and checkout answers `503 PAYMENTS_NOT_CONFIGURED` instead of failing mid-call |
| `RAZORPAY_WEBHOOK_SECRET` | Required for `POST /payments/razorpay/webhook`; without it the endpoint refuses rather than trusting unverified events |
| `RAZORPAY_PLAN_BUSINESS` / `RAZORPAY_PLAN_PREMIUM` | Razorpay Plan ids. Recurring billing and UPI AutoPay are created against these |
| `BILLING_GRACE_DAYS` | Days a failed renewal keeps its features before dropping to Free (data is never deleted) |
| `BILLING_TAX_PERCENT` | Tax already included in the plan price; invoices back-compute the split |
| `REFRESH_COOKIE_SAMESITE` | `lax` when API and SPA share a site, `none` (+ Secure) when they do not |

## Background jobs

| Job | Schedule | Does |
|---|---|---|
| `offer-lifecycle` | every 5 min | scheduled → active → expired |
| `expiring-favourites` | daily 09:00 | emails customers about saved offers ending within 48h |
| `analytics-snapshots` | daily 00:20 | folds yesterday's events into `analytics_daily_snapshots` (V3) |
| `billing-lifecycle` | daily 02:00 | closes grace windows and applies downgrades whose paid period ended — plan only, never data |
| `override-expiry` | daily 02:10 | writes the `EXPIRED` audit event for lapsed Super Admin grants (they stop granting the moment their date passes, independently of this job) |
| `prune` | daily 03:30 | deletes spent tokens and read notifications older than 60 days |
