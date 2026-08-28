'use strict';

const crypto = require('node:crypto');
const { queryOne, execute, rawQuery } = require('../../db/pool');
const env = require('../../config/env');
const ApiError = require('../../utils/ApiError');
const accessControl = require('../../services/accessControl');
const analyticsEvents = require('../../services/analyticsEvents');

/**
 * Claim codes and merchant redemption (Claim/Redemption workflow).
 *
 * The one rule the whole module is built around is §38.6/§27: *the frontend's
 * claim status is never trusted*. Every question that decides whether a benefit
 * is handed over - is this code real, has it expired, is this the right branch,
 * was it already used, may this member of staff redeem it - is answered here,
 * from the database, on every single attempt.
 *
 * Claim and redemption stay separate (§18). Claiming records what a customer
 * intends; redeeming records that a shop actually served them. Only the second
 * is evidence of a conversion, so only a merchant action can produce it (§38.7)
 * and a customer can never write it about themselves (§25).
 */

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

/**
 * Crockford-ish alphabet: no O/0 or I/1, because half of these codes get read
 * aloud across a counter or copied off a cracked phone screen.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_PREFIX = 'OFR-';

/**
 * §4: opaque and hard to guess. 32^8 is about 10^12 codes, so even at the
 * verification rate limit an attacker would be at this for millennia - and
 * §28's lockout would have stopped them in the first minute.
 *
 * `randomInt` rather than `randomBytes(n)[i] % 32`: 256 is a multiple of 32 so
 * the modulo happens to be uniform here, but that is a coincidence of the
 * alphabet length, and it stops being true the moment someone edits ALPHABET.
 */
function generateCode() {
  let body = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    body += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return `${CODE_PREFIX}${body}`;
}

/** Accepts `ofr-8x72q`, `8X72Q` and `OFR-8X72Q` as the same code. */
function normaliseCode(input) {
  const upper = String(input ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const bare = upper.startsWith(CODE_PREFIX) ? upper.slice(CODE_PREFIX.length) : upper;
  return `${CODE_PREFIX}${bare}`;
}

// ---------------------------------------------------------------------------
// QR
// ---------------------------------------------------------------------------

/**
 * The QR is signed rather than being the bare code (§6).
 *
 * The code alone would work - it is what manual entry uses - but a QR is
 * scanned by a camera, so anything that renders as a QR gets pointed at the
 * verify screen. Signing means the server can tell a code the customer's app
 * issued from a code someone typed into a QR generator, and the payload carries
 * only the claim id and code: no name, no phone, no customer id (§4, §6).
 *
 * Deriving the key from the access secret keeps this working on installs that
 * never set CLAIM_QR_SECRET, while staying a different key from the one that
 * signs sessions - a leaked QR must never be a step towards a leaked token.
 */
const QR_KEY = env.claims?.qrSecret
  ? Buffer.from(env.claims.qrSecret)
  : crypto.createHmac('sha256', env.jwt.accessSecret).update('offer-claim-qr').digest();

function signQrPayload(claim) {
  const body = Buffer.from(
    JSON.stringify({ v: 1, id: Number(claim.id), c: claim.code }),
  ).toString('base64url');
  const signature = crypto.createHmac('sha256', QR_KEY).update(body).digest('base64url');
  return `${body}.${signature}`;
}

/**
 * Returns the code the token vouches for, or null. Timing-safe because this is
 * reachable by anyone holding VERIFY_CLAIM, and a comparison that returns early
 * leaks how much of a forged signature was right.
 */
function readQrPayload(token) {
  const [body, signature] = String(token ?? '').split('.');
  if (!body || !signature) return null;

  const expected = crypto.createHmac('sha256', QR_KEY).update(body).digest('base64url');
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof payload.c === 'string' ? normaliseCode(payload.c) : null;
  } catch {
    return null;
  }
}

/**
 * What the customer's app renders as a QR. A deep link rather than a raw token
 * so that a scan by any ordinary camera app - not just ours - lands the
 * customer somewhere that explains what they are holding.
 */
const qrValueFor = (claim) => `${env.appUrl}/claims/scan?t=${signQrPayload(claim)}`;

// ---------------------------------------------------------------------------
// Reading claims
// ---------------------------------------------------------------------------

const CLAIM_SELECT = `
  SELECT c.*, o.title AS offer_title, o.offer_text, o.end_date AS offer_end_date,
         o.applicability_type, o.max_redemptions_per_claim,
         s.name AS shop_name, b.branch_name, u.name AS customer_name, u.phone AS customer_phone,
         ru.name AS redeemed_by_name,
         (SELECT oi.image_url FROM offer_images oi
           WHERE oi.offer_id = o.id ORDER BY oi.display_order, oi.id LIMIT 1) AS image_url
    FROM offer_claims c
    JOIN offers o ON o.id = c.offer_id
    JOIN shops  s ON s.id = c.shop_id
    JOIN users  u ON u.id = c.user_id
    LEFT JOIN shop_branches b ON b.id = c.branch_id
    LEFT JOIN users ru ON ru.id = c.redeemed_by`;

/**
 * Shapes a claim row for the API.
 *
 * `audience` is what decides how much of the customer appears. §24 is explicit
 * that merchants see customer data only as far as authorisation allows, and a
 * shopkeeper needs to know they are serving the right person - not their phone
 * number. So 'customer' sees their own claim in full, 'merchant' gets a name
 * and nothing else, and only 'admin' - a Super Admin investigating a dispute
 * (§26) - sees contact details.
 */
function mapClaim(row, audience = 'customer') {
  const claim = {
    id: Number(row.id),
    code: row.code,
    status: row.status,
    claimedAt: row.claimed_at,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at,
    redemptionCount: Number(row.redemption_count ?? 0),
    maxRedemptions: Number(row.max_redemptions_per_claim ?? 1),
    verificationMethod: row.verification_method ?? null,
    offer: {
      id: Number(row.offer_id),
      title: row.offer_title,
      offerText: row.offer_text,
      endDate: row.offer_end_date,
      imageUrl: row.image_url ?? null,
    },
    shop: { id: Number(row.shop_id), name: row.shop_name },
    branch: row.branch_id ? { id: Number(row.branch_id), name: row.branch_name } : null,
  };

  if (audience === 'customer') {
    claim.qrValue = qrValueFor(row);
    return claim;
  }

  claim.customer = { id: Number(row.user_id), name: row.customer_name };
  claim.redeemedBy = row.redeemed_by ? { id: Number(row.redeemed_by), name: row.redeemed_by_name } : null;

  if (audience === 'admin') {
    claim.customer.phone = row.customer_phone ?? null;
    claim.revokedAt = row.revoked_at;
    claim.revokeReason = row.revoke_reason;
  }
  return claim;
}

const findById = (id) => queryOne(`${CLAIM_SELECT} WHERE c.id = ?`, [id]);

/**
 * Looks a claim up by what someone typed or scanned.
 *
 * Both spellings are tried because codes issued before §4 introduced the `OFR-`
 * prefix are still in customers' pockets, and rewriting them in a migration
 * would invalidate every printed and screenshotted code that already exists.
 * The unique index means at most one of the two can match.
 */
function findByCode(code) {
  const prefixed = normaliseCode(code);
  const bare = prefixed.slice(CODE_PREFIX.length);
  return queryOne(`${CLAIM_SELECT} WHERE c.code IN (?, ?)`, [prefixed, bare]);
}

// ---------------------------------------------------------------------------
// Claiming (§3, §17)
// ---------------------------------------------------------------------------

/**
 * How long a freshly issued code lives.
 *
 * Capped at the offer's own end date, always. §14 says an expired claim cannot
 * be redeemed, and a code that outlived the promotion it belongs to is exactly
 * the argument nobody wants to have at a counter.
 */
function expiryFor(offer, now = new Date()) {
  const offerEnd = new Date(offer.end_date);
  if (!offer.claim_validity_hours) return offerEnd;
  const window = new Date(now.getTime() + Number(offer.claim_validity_hours) * 3600 * 1000);
  return window < offerEnd ? window : offerEnd;
}

/**
 * Everything §3 lists, checked in the order that produces the most useful
 * message: what the offer is, then whether this customer may have it.
 *
 * Returns `{ offer, existing }` or throws. `existing` is a live claim the
 * customer already holds - when the offer allows one claim each (the usual
 * setting), claiming again must hand back the same code rather than mint a
 * second one, so the button stays safe to press twice.
 */
async function assertClaimable(offerId, userId) {
  const offer = await queryOne(
    `SELECT o.id, o.shop_id, o.status, o.start_date, o.end_date, o.title,
            o.claim_limit_per_customer, o.total_claim_limit, o.claim_validity_hours,
            s.status AS shop_status
       FROM offers o JOIN shops s ON s.id = o.shop_id WHERE o.id = ?`,
    [offerId],
  );
  if (!offer) throw ApiError.notFound('Offer not found');

  const now = new Date();
  const live =
    offer.status === 'active' &&
    offer.shop_status === 'active' &&
    new Date(offer.start_date) <= now &&
    new Date(offer.end_date) >= now;
  if (!live) throw ApiError.badRequest('This offer is not available to claim');

  // Claims this customer already holds. Cancelled and revoked ones do not count
  // against the limit - the customer got nothing for them.
  const mine = await rawQuery(
    `SELECT id, status, claim_seq FROM offer_claims
      WHERE user_id = ? AND offer_id = ? AND status NOT IN ('cancelled','revoked')
      ORDER BY claim_seq`,
    [userId, offerId],
  );

  const reusable = mine.find((claim) => claim.status === 'claimed');
  if (reusable) return { offer, existing: reusable };

  const perCustomer = Number(offer.claim_limit_per_customer ?? 1);
  if (mine.length >= perCustomer) {
    throw ApiError.conflict(
      perCustomer === 1
        ? 'You have already claimed this offer'
        : `You have used all ${perCustomer} claims for this offer`,
    );
  }

  if (offer.total_claim_limit) {
    const [{ taken }] = await rawQuery(
      `SELECT COUNT(*) AS taken FROM offer_claims
        WHERE offer_id = ? AND status NOT IN ('cancelled','revoked')`,
      [offerId],
    );
    if (Number(taken) >= Number(offer.total_claim_limit)) {
      throw ApiError.conflict('This offer has been fully claimed');
    }
  }

  const nextSeq = mine.reduce((max, claim) => Math.max(max, Number(claim.claim_seq)), 0) + 1;
  return { offer, existing: null, nextSeq };
}

/** MySQL's duplicate-key error, whatever the driver version calls it. */
const isDuplicate = (error) => error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;

/**
 * Issues a code. Retries on a code collision, and treats a duplicate on
 * (user, offer, seq) as "another request beat me to it" - which is §17's
 * "duplicate requests" case, and the reason the unique key exists at all.
 */
async function issue(offerId, userId) {
  const { offer, existing, nextSeq } = await assertClaimable(offerId, userId);
  if (existing) return { claimId: Number(existing.id), isNew: false, offer };

  const expiresAt = expiryFor(offer);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await execute(
        `INSERT INTO offer_claims (offer_id, user_id, shop_id, code, claim_seq, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [offerId, userId, offer.shop_id, generateCode(), nextSeq, expiresAt],
      );
      return { claimId: Number(result.insertId), isNew: true, offer };
    } catch (error) {
      if (!isDuplicate(error)) throw error;

      // Two requests raced for the same sequence number. The other one won, so
      // hand back what it created rather than issuing a second code.
      const raced = await queryOne(
        `SELECT id FROM offer_claims
          WHERE user_id = ? AND offer_id = ? AND claim_seq = ?`,
        [userId, offerId, nextSeq],
      );
      if (raced) return { claimId: Number(raced.id), isNew: false, offer };
      // Otherwise it was the code that collided; loop and draw another.
    }
  }
  throw ApiError.conflict('Could not issue a claim code just now. Please try again.');
}

// ---------------------------------------------------------------------------
// Verification (§8, §9, §13-§16)
// ---------------------------------------------------------------------------

/**
 * Why a verification failed, and what the merchant is told.
 *
 * The reasons are for the audit trail; the messages are what §13 permits us to
 * say out loud. "Could not be found" deliberately covers both a typo and a code
 * for a rival shop, because telling someone which one they hit turns the verify
 * screen into an oracle for enumerating live codes.
 */
const REJECTIONS = {
  NOT_FOUND: 'This coupon could not be found. Please check the code and try again.',
  WRONG_SHOP: 'This coupon could not be found. Please check the code and try again.',
  WRONG_BRANCH: 'This offer is not valid at this branch.',
  EXPIRED: 'This claim is no longer valid.',
  ALREADY_REDEEMED: 'This offer was already redeemed.',
  CANCELLED: 'This claim is no longer valid.',
  REVOKED: 'This claim is no longer valid.',
};

/**
 * The branches an offer may be redeemed at (§16).
 *
 * `shop_wide` means every active branch. `selected_branches` means the ones
 * pinned to the offer. `online` has no counter to walk into, so nothing
 * qualifies and the check falls through to "wrong branch" - which is the
 * honest answer for a merchant trying to redeem a web-only offer in a shop.
 */
async function allowedBranchIds(offer) {
  if (offer.applicability_type === 'online') return [];
  if (offer.applicability_type === 'selected_branches') {
    const rows = await rawQuery('SELECT branch_id FROM offer_locations WHERE offer_id = ?', [offer.id]);
    return rows.map((row) => Number(row.branch_id));
  }
  const rows = await rawQuery(
    "SELECT id FROM shop_branches WHERE shop_id = ? AND status = 'active'",
    [offer.shop_id],
  );
  return rows.map((row) => Number(row.id));
}

/**
 * Decides whether `claim` may be redeemed right now, by `actor`, at `branchId`.
 *
 * Everything §27 lists is here, and nothing here reads anything the client
 * sent about the claim itself - only the code it typed and the branch it says
 * it is standing in, both of which are then checked against the database.
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: string, message: string}>}
 */
async function evaluate(claim, actor, branchId) {
  const reject = (reason) => ({ ok: false, reason, message: REJECTIONS[reason] });

  if (!accessControl.hasShopPermission(actor, claim.shop_id, 'VERIFY_CLAIM')) {
    return reject('WRONG_SHOP');
  }
  if (claim.status === 'cancelled') return reject('CANCELLED');
  if (claim.status === 'revoked') return reject('REVOKED');

  // Status is a cache that a stalled cron job can leave behind; the timestamp
  // is the truth, so expiry is decided on the date and not on the enum.
  if (claim.status === 'expired' || new Date(claim.expires_at) < new Date()) {
    return reject('EXPIRED');
  }

  const allowed = Number(claim.max_redemptions_per_claim ?? 1);
  if (Number(claim.redemption_count ?? 0) >= allowed) return reject('ALREADY_REDEEMED');

  // No branch means nobody told us where this till is - the usual case for a
  // one-shop merchant whose staff are not assigned to a branch. §16 is a rule
  // about *which* branch, so with no branch to check it has nothing to say,
  // and refusing every redemption instead would break every single-site shop.
  if (branchId !== null && branchId !== undefined) {
    const branches = await allowedBranchIds({
      id: claim.offer_id,
      shop_id: claim.shop_id,
      applicability_type: claim.applicability_type,
    });
    if (!branches.includes(Number(branchId))) return reject('WRONG_BRANCH');
  }

  return { ok: true };
}

/**
 * Which branch the merchant is redeeming at.
 *
 * Staff attached to a single branch redeem for that branch and are not asked;
 * a shop owner who covers several may say which, and a request that names one
 * they have no membership of is refused rather than quietly reassigned.
 */
function resolveBranch(actor, shopId, requestedBranchId) {
  const membership = actor.shops?.find((shop) => shop.shopId === Number(shopId));
  if (requestedBranchId === null || requestedBranchId === undefined) {
    return membership?.branchId ?? null;
  }
  const requested = Number(requestedBranchId);
  // A Super Admin has no membership anywhere but may act for any shop (§26).
  if (actor.isSuperAdmin) return requested;
  if (membership?.branchId && membership.branchId !== requested) {
    throw ApiError.forbidden('You can only redeem claims at your own branch');
  }
  return requested;
}

// ---------------------------------------------------------------------------
// The verification log (§30) and the rate limiter it feeds (§28)
// ---------------------------------------------------------------------------

const VERIFICATION_METHODS = ['QR_SCAN', 'CODE_ENTRY'];

/**
 * Appends one attempt. Never throws: a failed log write must not turn a
 * successful redemption into an error the customer watches happen.
 */
async function logVerification(req, entry) {
  try {
    await execute(
      `INSERT INTO claim_verifications
         (claim_id, offer_id, shop_id, branch_id, customer_id, verified_by,
          code_attempted, method, action, reason, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.claimId ?? null,
        entry.offerId ?? null,
        entry.shopId ?? null,
        entry.branchId ?? null,
        entry.customerId ?? null,
        req?.user?.id ?? null,
        entry.code ?? null,
        entry.method,
        entry.action,
        entry.reason ?? null,
        req?.ip ?? null,
      ],
    );
  } catch (error) {
    console.error('[claims] failed to log a %s verification: %s', entry.action, error.message);
  }
}

/**
 * §28. Counted on rejections only, per merchant user, because that is what
 * distinguishes someone guessing codes from a busy Saturday: a real counter
 * produces mostly successes, and a fat-fingered code twice in a row is normal.
 *
 * Deliberately in the database rather than in express-rate-limit's memory - the
 * general limiter already covers request floods, while this one has to survive
 * a restart and follow the *user* across devices, which is §17's "changing
 * devices" applied to the merchant side.
 */
const FAILURE_WINDOW_MINUTES = 10;
const FAILURE_LIMIT = 10;

/**
 * The window is a module constant rather than a bound parameter: MySQL will not
 * take a placeholder for the count in `INTERVAL ? MINUTE` on every version, and
 * a number we wrote ourselves is not user input to begin with.
 */
async function countRecentFailures(userId) {
  const rows = await rawQuery(
    `SELECT COUNT(*) AS failures FROM claim_verifications
      WHERE verified_by = ? AND action = 'REJECTED'
        AND created_at > (NOW() - INTERVAL ${FAILURE_WINDOW_MINUTES} MINUTE)`,
    [userId],
  );
  return Number(rows[0]?.failures ?? 0);
}

async function assertNotRateLimited(userId) {
  if ((await countRecentFailures(userId)) < FAILURE_LIMIT) return;
  throw ApiError.tooMany('Too many unsuccessful attempts. Please try again later.');
}

/** How many more failures this user may make before the limiter closes in. */
async function failureBudget(userId) {
  return Math.max(FAILURE_LIMIT - (await countRecentFailures(userId)), 0);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Moves live claims past their expiry to `expired` (§12). Idempotent, and
 * purely cosmetic in the sense that `evaluate` never trusts the status anyway -
 * this is what keeps "My Claims" and the merchant's counts honest.
 */
async function syncExpiredClaims() {
  const result = await execute(
    "UPDATE offer_claims SET status = 'expired' WHERE status = 'claimed' AND expires_at < NOW()",
  );
  return Number(result.affectedRows ?? 0);
}

/** Records the funnel event pair for a claim (§19, §32). */
async function recordClaimEvents(offer, userId) {
  await analyticsEvents.touchShopCustomer(offer.shop_id, userId, 'claim');
  await analyticsEvents.record(analyticsEvents.EVENT_TYPES.OFFER_CLAIM, {
    shopId: offer.shop_id,
    offerId: Number(offer.id),
    userId,
  });
}

module.exports = {
  CLAIM_SELECT,
  CODE_PREFIX,
  VERIFICATION_METHODS,
  FAILURE_LIMIT,
  FAILURE_WINDOW_MINUTES,
  generateCode,
  normaliseCode,
  signQrPayload,
  readQrPayload,
  qrValueFor,
  mapClaim,
  findById,
  findByCode,
  expiryFor,
  assertClaimable,
  issue,
  allowedBranchIds,
  evaluate,
  resolveBranch,
  logVerification,
  assertNotRateLimited,
  failureBudget,
  syncExpiredClaims,
  recordClaimEvents,
  REJECTIONS,
};
