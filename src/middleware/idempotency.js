'use strict';

const crypto = require('node:crypto');
const { execute, queryOne } = require('../db/pool');
const ApiError = require('../utils/ApiError');

/**
 * Duplicate action protection (§50, §51).
 *
 * §51 lists the operations that must be idempotent - claim, payment, redeem,
 * create offer, create booking - and §50 adds the case that makes it hard: a
 * request that timed out. The client has no idea whether it succeeded, and
 * both available choices are wrong. Retrying may charge twice; not retrying
 * may lose a booking the customer thinks they made.
 *
 * So the client stops guessing. It generates a key once per user *intent* -
 * not per attempt - and sends it with every attempt. The first request through
 * claims the key and does the work; any later request carrying the same key
 * gets the first one's answer back verbatim, having done nothing.
 *
 * This is a second line rather than the first. `offer_claims` still has its
 * unique key, redemption still has its conditional UPDATE, and the Razorpay
 * webhook still has its unique event id - those are what protect a client that
 * sends no key at all, and they are the ones that hold when two different
 * devices act at once. This layer is what turns "safe but confusing" (a retry
 * answered with "already redeemed") into "safe and correct" (a retry answered
 * with the original success).
 *
 * The key is optional. A request without one behaves exactly as it did before,
 * because a mobile client mid-rollout must not start failing.
 */

const HEADER = 'Idempotency-Key';
const MAX_KEY_LENGTH = 120;

/** Stable hash of the body, so a reused key with different content is caught. */
function fingerprint(body) {
  // `JSON.stringify` is not order-stable across clients, so keys are sorted
  // before hashing - otherwise a client that serialises its object differently
  // on the retry would be told it changed the payload.
  const canonical = JSON.stringify(body ?? {}, (_key, value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

const isDuplicate = (error) => error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;

/**
 * Guards one route. Place it after `authenticate` and after `validate`, so the
 * fingerprint is taken of the parsed, validated body rather than whatever
 * arrived.
 */
function idempotent() {
  return async function idempotencyMiddleware(req, res, next) {
    const key = req.get(HEADER);
    if (!key) return next();

    if (key.length > MAX_KEY_LENGTH) {
      return next(ApiError.badRequest(`${HEADER} must be at most ${MAX_KEY_LENGTH} characters`));
    }

    const userId = req.user?.id ?? null;
    const endpoint = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`;
    const hash = fingerprint(req.body);

    try {
      await execute(
        `INSERT INTO idempotency_keys (idempotency_key, user_id, endpoint, fingerprint)
         VALUES (?, ?, ?, ?)`,
        [key, userId, endpoint.slice(0, 255), hash],
      );
    } catch (error) {
      if (!isDuplicate(error)) return next(error);
      return replay(req, res, next, { key, userId, hash });
    }

    // We own the key. Capture whatever the handler answers so a retry can be
    // given the same thing.
    captureResponse(res, { key, userId });
    return next();
  };
}

/** Answers a repeat of a key we have already seen. */
async function replay(req, res, next, { key, userId, hash }) {
  const existing = await queryOne(
    'SELECT * FROM idempotency_keys WHERE idempotency_key = ? AND user_id <=> ?',
    [key, userId],
  );

  if (!existing) {
    // The row vanished between the failed insert and this read - the nightly
    // prune, or a manual cleanup. Treat it as a fresh request rather than
    // failing: doing the work once more is better than refusing to do it.
    return next();
  }

  if (existing.fingerprint !== hash) {
    return next(
      ApiError.unprocessable(
        `This ${HEADER} was already used for a different request. Use a new key for a new action.`,
      ),
    );
  }

  if (existing.status === 'in_progress') {
    // The original is still running. 409 rather than 425/503 because there is
    // nothing to retry *yet* - the answer is coming, and a client that hammers
    // this is the exact double-submit the header exists to prevent.
    return next(
      new ApiError(
        409,
        'This request is already being processed. Please wait a moment before trying again.',
        undefined,
        'REQUEST_IN_PROGRESS',
      ),
    );
  }

  res.setHeader('Idempotent-Replay', 'true');
  return res.status(existing.response_status ?? 200).json(parseBody(existing.response_body));
}

function parseBody(value) {
  if (value === null || value === undefined) return { success: true };
  // mysql2 hands back a JSON column already parsed on some driver versions and
  // as a string on others.
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return { success: true };
    }
  }
  return value;
}

/**
 * Records what the handler answered.
 *
 * Only successful responses are stored. A failure is not a completed action -
 * replaying a 500 forever would leave the customer permanently unable to claim
 * that offer - so the key is released instead, and the retry runs for real.
 */
function captureResponse(res, { key, userId }) {
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    const status = res.statusCode;
    const settle =
      status >= 200 && status < 300
        ? execute(
            `UPDATE idempotency_keys
                SET status = 'completed', response_status = ?, response_body = ?, completed_at = NOW()
              WHERE idempotency_key = ? AND user_id <=> ?`,
            [status, JSON.stringify(body), key, userId],
          )
        : execute('DELETE FROM idempotency_keys WHERE idempotency_key = ? AND user_id <=> ?', [
            key,
            userId,
          ]);

    // Never let bookkeeping delay or break the response the caller is waiting
    // on. A lost record costs a duplicate on retry; a thrown error here costs
    // the response itself.
    settle.catch((error) => console.error('[idempotency] could not settle %s: %s', key, error.message));

    return originalJson(body);
  };
}

/**
 * Releases keys claimed by a request that never answered - a crashed process,
 * a killed container. Without this an interrupted payment would leave its key
 * stuck `in_progress` and the merchant unable to retry at all.
 */
async function releaseStale(minutes = 15) {
  const result = await execute(
    `DELETE FROM idempotency_keys
      WHERE status = 'in_progress' AND created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [minutes],
  );
  return result.affectedRows ?? 0;
}

/** Completed keys are only useful for as long as a client might still retry. */
async function pruneCompleted(hours = 48) {
  const result = await execute(
    `DELETE FROM idempotency_keys
      WHERE status = 'completed' AND completed_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    [hours],
  );
  return result.affectedRows ?? 0;
}

module.exports = { idempotent, releaseStale, pruneCompleted, HEADER, fingerprint };
