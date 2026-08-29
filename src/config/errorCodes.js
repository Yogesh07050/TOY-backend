'use strict';

/**
 * Stable error codes (§8) and their categories (§9).
 *
 * Two code spaces, deliberately kept apart:
 *
 *   - The **response code** is what a client sees, and §3 constrains it hard:
 *     it may not name the database, the dependency or the failure mode. It is
 *     also a published contract - Angular and React Native branch on it - so it
 *     changes only with a client release.
 *
 *   - The **internal code** is what goes in the log, and it is as specific as
 *     we can make it: `DB_QUERY_TIMEOUT`, not `INTERNAL_ERROR`. This is the
 *     column an on-call engineer filters by (§28) and groups on (§30).
 *
 * §3's own example is exactly this split - the customer is shown "Something
 * went wrong / REQ-8F29A1" while the log says "Database timeout". So a single
 * failure carries both: `SERVICE_UNAVAILABLE` out to the caller,
 * `DB_CONNECTION_FAILED` into the log.
 *
 * §8's closing requirement - "these codes should remain stable even if the
 * underlying implementation changes" - is why the mapping lives in one table
 * rather than being derived at each throw site. Renaming a driver constant
 * upstream changes which key matches here; it must never change what we log.
 */

/** §9. The source a failure is attributed to, for dashboards and filtering. */
const CATEGORIES = {
  AUTHENTICATION: 'AUTHENTICATION',
  AUTHORIZATION: 'AUTHORIZATION',
  VALIDATION: 'VALIDATION',
  BUSINESS_LOGIC: 'BUSINESS_LOGIC',
  DATABASE: 'DATABASE',
  PAYMENT: 'PAYMENT',
  NOTIFICATION: 'NOTIFICATION',
  FIREBASE: 'FIREBASE',
  STORAGE: 'STORAGE',
  IMAGE: 'IMAGE',
  LOCATION: 'LOCATION',
  AI: 'AI',
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  SYSTEM: 'SYSTEM',
};

/**
 * Every code this application can log or return, mapped to its category.
 *
 * Codes already in use by the clients are listed alongside the ones §8 adds,
 * because the point of the table is to be the whole vocabulary - a code that is
 * thrown but missing here is uncategorised on every dashboard that reads it.
 */
const ERROR_CODES = {
  // -- Authentication (§8, §18) --------------------------------------------
  AUTH_INVALID_CREDENTIALS: CATEGORIES.AUTHENTICATION,
  AUTH_SESSION_EXPIRED: CATEGORIES.AUTHENTICATION,
  AUTH_REFRESH_FAILED: CATEGORIES.AUTHENTICATION,
  AUTH_ACCOUNT_DEACTIVATED: CATEGORIES.AUTHENTICATION,
  // Existing client-facing codes. Kept verbatim - renaming them would break
  // the token-refresh branch in both apps.
  UNAUTHORIZED: CATEGORIES.AUTHENTICATION,
  TOKEN_EXPIRED: CATEGORIES.AUTHENTICATION,

  // -- Authorization (§19) --------------------------------------------------
  AUTHORIZATION_DENIED: CATEGORIES.AUTHORIZATION,
  FORBIDDEN: CATEGORIES.AUTHORIZATION,
  CSRF_ORIGIN_REJECTED: CATEGORIES.AUTHORIZATION,
  PLAN_UPGRADE_REQUIRED: CATEGORIES.AUTHORIZATION,

  // -- Validation -----------------------------------------------------------
  VALIDATION_ERROR: CATEGORIES.VALIDATION,
  BAD_REQUEST: CATEGORIES.VALIDATION,
  URI_TOO_LONG: CATEGORIES.VALIDATION,
  TOO_MANY_PARAMETERS: CATEGORIES.VALIDATION,

  // -- Business logic: offers, claims, redemptions (§8, §17) ---------------
  OFFER_NOT_FOUND: CATEGORIES.BUSINESS_LOGIC,
  OFFER_EXPIRED: CATEGORIES.BUSINESS_LOGIC,
  OFFER_CLAIM_LIMIT_REACHED: CATEGORIES.BUSINESS_LOGIC,
  CLAIM_INVALID: CATEGORIES.BUSINESS_LOGIC,
  CLAIM_EXPIRED: CATEGORIES.BUSINESS_LOGIC,
  CLAIM_ALREADY_REDEEMED: CATEGORIES.BUSINESS_LOGIC,
  CLAIM_WRONG_BRANCH: CATEGORIES.BUSINESS_LOGIC,
  CLAIM_WRONG_SHOP: CATEGORIES.BUSINESS_LOGIC,
  NOT_FOUND: CATEGORIES.BUSINESS_LOGIC,
  CONFLICT: CATEGORIES.BUSINESS_LOGIC,

  // -- Database (§12) -------------------------------------------------------
  DB_CONNECTION_FAILED: CATEGORIES.DATABASE,
  DB_QUERY_TIMEOUT: CATEGORIES.DATABASE,
  DB_TRANSACTION_FAILED: CATEGORIES.DATABASE,
  DB_CONSTRAINT_VIOLATION: CATEGORIES.DATABASE,
  DB_DEADLOCK: CATEGORIES.DATABASE,

  // -- Payment (§15, §16) ---------------------------------------------------
  PAYMENT_FAILED: CATEGORIES.PAYMENT,
  PAYMENT_WEBHOOK_INVALID: CATEGORIES.PAYMENT,
  PAYMENT_WEBHOOK_DUPLICATE: CATEGORIES.PAYMENT,
  PAYMENTS_NOT_CONFIGURED: CATEGORIES.PAYMENT,
  GATEWAY_ERROR: CATEGORIES.PAYMENT,
  GATEWAY_UNREACHABLE: CATEGORIES.PAYMENT,

  // -- Storage and images (§20) ---------------------------------------------
  IMAGE_UPLOAD_FAILED: CATEGORIES.IMAGE,
  IMAGE_INVALID: CATEGORIES.IMAGE,
  IMAGE_TOO_LARGE: CATEGORIES.IMAGE,
  STORAGE_UNAVAILABLE: CATEGORIES.STORAGE,
  STORAGE_TIMEOUT: CATEGORIES.STORAGE,

  // -- Notifications (§21) --------------------------------------------------
  NOTIFICATION_SEND_FAILED: CATEGORIES.NOTIFICATION,
  FIREBASE_UNAVAILABLE: CATEGORIES.FIREBASE,
  DEVICE_TOKEN_INVALID: CATEGORIES.NOTIFICATION,

  // -- Location and maps (§23) ----------------------------------------------
  LOCATION_UNAVAILABLE: CATEGORIES.LOCATION,
  MAP_SERVICE_FAILED: CATEGORIES.LOCATION,
  GEOCODING_FAILED: CATEGORIES.LOCATION,

  // -- AI (§22) -------------------------------------------------------------
  AI_SERVICE_UNAVAILABLE: CATEGORIES.AI,
  AI_GENERATION_FAILED: CATEGORIES.AI,
  AI_LIMIT_REACHED: CATEGORIES.AI,
  AI_SERVICE_DISABLED: CATEGORIES.AI,
  INVALID_MODEL_OUTPUT: CATEGORIES.AI,

  // -- Transport and system -------------------------------------------------
  RATE_LIMIT_EXCEEDED: CATEGORIES.NETWORK,
  RATE_LIMITED: CATEGORIES.NETWORK,
  REQUEST_TIMEOUT: CATEGORIES.TIMEOUT,
  TIMEOUT: CATEGORIES.TIMEOUT,
  RETRYABLE: CATEGORIES.TIMEOUT,
  REQUEST_IN_PROGRESS: CATEGORIES.NETWORK,
  SERVICE_UNAVAILABLE: CATEGORIES.SYSTEM,
  INTERNAL_SERVER_ERROR: CATEGORIES.SYSTEM,
  INTERNAL_ERROR: CATEGORIES.SYSTEM,
};

/**
 * Driver and runtime error codes, mapped onto our own (§8, §12).
 *
 * These are the values MySQL and Node put on a thrown error. They are somebody
 * else's vocabulary and they leak implementation detail, which is why nothing
 * downstream is allowed to see them - they are translated here once, into codes
 * that stay put.
 */
const DRIVER_CODE_MAP = {
  // Connectivity: the database is not answering at all.
  ECONNREFUSED: 'DB_CONNECTION_FAILED',
  PROTOCOL_CONNECTION_LOST: 'DB_CONNECTION_FAILED',
  ER_CON_COUNT_ERROR: 'DB_CONNECTION_FAILED',
  ENOTFOUND: 'DB_CONNECTION_FAILED',
  ETIMEDOUT: 'DB_QUERY_TIMEOUT',

  // Contention: the query reached the server and gave up waiting on a lock.
  ER_LOCK_WAIT_TIMEOUT: 'DB_QUERY_TIMEOUT',
  ER_LOCK_DEADLOCK: 'DB_DEADLOCK',

  // Integrity: our own bug or a genuine duplicate, not an outage.
  ER_DUP_ENTRY: 'DB_CONSTRAINT_VIOLATION',
  ER_NO_REFERENCED_ROW: 'DB_CONSTRAINT_VIOLATION',
  ER_NO_REFERENCED_ROW_2: 'DB_CONSTRAINT_VIOLATION',
  ER_ROW_IS_REFERENCED: 'DB_CONSTRAINT_VIOLATION',
  ER_ROW_IS_REFERENCED_2: 'DB_CONSTRAINT_VIOLATION',

  // Multer, on an upload that broke a limit.
  LIMIT_FILE_SIZE: 'IMAGE_TOO_LARGE',
  LIMIT_FILE_COUNT: 'IMAGE_UPLOAD_FAILED',
  LIMIT_UNEXPECTED_FILE: 'IMAGE_INVALID',
};

/** The category for a code, or SYSTEM for one that predates this table. */
const categoryFor = (code) => ERROR_CODES[code] ?? CATEGORIES.SYSTEM;

/**
 * The internal code for a raw error (§8).
 *
 * Preference order matters. An explicit `internalCode` set at the throw site is
 * the author telling us exactly what happened and always wins. A driver code is
 * next, because it is evidence rather than inference. The `ER_` prefix catches
 * the long tail of MySQL codes not worth naming one by one. Only then do we
 * fall back to the response code, which is the least specific of the four.
 */
function internalCodeFor(error, responseCode) {
  if (error?.internalCode && ERROR_CODES[error.internalCode]) return error.internalCode;

  const driverCode = error?.code;
  if (driverCode && DRIVER_CODE_MAP[driverCode]) return DRIVER_CODE_MAP[driverCode];
  if (typeof driverCode === 'string' && driverCode.startsWith('ER_')) return 'DB_TRANSACTION_FAILED';
  if (error?.sqlState || error?.sqlMessage) return 'DB_TRANSACTION_FAILED';

  if (responseCode && ERROR_CODES[responseCode]) return responseCode;
  return 'INTERNAL_SERVER_ERROR';
}

module.exports = { CATEGORIES, ERROR_CODES, DRIVER_CODE_MAP, categoryFor, internalCodeFor };
