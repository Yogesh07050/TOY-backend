'use strict';

const { execute, rawQuery } = require('../db/pool');
const { ALERT_RULES } = require('../config/businessMetrics');
const logger = require('../utils/logger');
const endpointFor = require('../utils/endpoint');
const { internalCodeFor, categoryFor } = require('../config/errorCodes');

/**
 * Internal failure logging (§56) and the spike detection built on it (§59).
 *
 * §56 lists what to record and closes with "avoid logging unnecessary sensitive
 * information", which is the harder half. What is written here is the minimum
 * that makes a failure diagnosable: where it happened, what kind it was, which
 * dependency was involved, and who to call back. Request bodies, query strings,
 * headers and tokens are all deliberately absent - a support ticket has never
 * been solved by the Authorization header, and storing one turns this table
 * into a liability.
 *
 * Writing is best-effort in the strictest sense: this runs from the error
 * handler, so if it throws it takes the error response down with it. Every path
 * out of `record` swallows.
 */

// ---------------------------------------------------------------------------
// Dependency attribution
// ---------------------------------------------------------------------------

const DEPENDENCIES = {
  DATABASE: 'DATABASE',
  RAZORPAY: 'RAZORPAY',
  PUSH: 'PUSH',
  STORAGE: 'STORAGE',
  GEOCODING: 'GEOCODING',
  EMAIL: 'EMAIL',
  AI: 'AI',
  AUTH: 'AUTH',
};

/** MySQL driver codes that mean "the database itself is unhappy". */
const DB_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'PROTOCOL_CONNECTION_LOST',
  'ER_CON_COUNT_ERROR',
  'ER_LOCK_WAIT_TIMEOUT',
  'ER_LOCK_DEADLOCK',
  'ETIMEDOUT',
  'ENOTFOUND',
]);

/**
 * Which dependency, if any, is behind an error.
 *
 * Order matters: a driver code is conclusive, so it is checked before the
 * softer path-based guess. An error with no dependency is our own bug, and
 * saying so (by leaving the column null) is more useful than blaming something.
 */
function dependencyFor(error, req) {
  if (error?.dependency) return error.dependency;
  if (DB_ERROR_CODES.has(error?.code)) return DEPENDENCIES.DATABASE;
  if (typeof error?.code === 'string' && error.code.startsWith('ER_')) return DEPENDENCIES.DATABASE;
  if (error?.sqlMessage || error?.sqlState) return DEPENDENCIES.DATABASE;

  const path = req?.originalUrl ?? '';
  if (path.includes('/payments') || path.includes('/subscriptions')) return DEPENDENCIES.RAZORPAY;
  if (path.includes('/uploads')) return DEPENDENCIES.STORAGE;
  if (path.includes('/geo')) return DEPENDENCIES.GEOCODING;
  if (path.includes('/notifications')) return DEPENDENCIES.PUSH;
  if (path.includes('/ai')) return DEPENDENCIES.AI;
  if (path.includes('/auth')) return DEPENDENCIES.AUTH;
  return null;
}

/** The shop this request concerned, where the route made that explicit. */
function shopIdFor(req) {
  const candidate =
    req.shopId ??
    req.shop?.id ??
    req.offer?.shop_id ??
    req.service?.shop_id ??
    req.params?.shopId ??
    req.body?.shopId;
  const value = Number(candidate);
  return Number.isInteger(value) && value > 0 ? value : null;
}

const truncate = (value, length) =>
  value === null || value === undefined ? null : String(value).slice(0, length);

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Records one failure. Called from the error handler for anything worth
 * investigating - which is not every 4xx: a validation error or a wrong
 * password is the system working, and logging those would bury the real ones.
 */
async function record(error, req, apiError) {
  try {
    // §8, §9. Derived here rather than passed in, so a row is categorised the
    // same way whoever writes it - the error handler, a job, a future caller.
    const errorCode = internalCodeFor(error, apiError.code);

    await execute(
      `INSERT INTO error_logs
         (request_id, user_id, shop_id, method, endpoint, error_type, error_code,
          category, http_status, dependency, message, platform, app_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        truncate(req.id ?? 'REQ-UNKNOWN', 40),
        req.user?.id ?? null,
        shopIdFor(req),
        truncate(req.method, 10),
        endpointFor(req),
        truncate(error?.name || error?.code || 'Error', 80),
        truncate(errorCode, 60),
        truncate(categoryFor(errorCode), 40),
        apiError.status,
        dependencyFor(error, req),
        // The message only. A stack belongs in the process log, where it is
        // not retained for months next to a user id.
        truncate(error?.message, 500),
        truncate(req.get?.('X-Client-Platform'), 40),
        truncate(req.get?.('X-Client-Version'), 40),
      ],
    );
  } catch (loggingError) {
    // The one place a swallow is mandatory: this runs inside the error handler.
    logger.error(
      { event: 'FAILURE_LOG_WRITE_FAILED', request_id: req?.id, err_message: loggingError.message },
      'Could not record failure',
    );
  }
}

/** Whether a failure is worth a row. Expected refusals are not. */
function isWorthLogging(apiError) {
  if (apiError.status >= 500) return true;
  // 429 is the rate limiter doing its job, but a *spike* of them is an
  // incident, and §59 wants authentication failure spikes specifically.
  return apiError.status === 429;
}

// ---------------------------------------------------------------------------
// Reading (§59)
// ---------------------------------------------------------------------------

/**
 * Failure counts per dependency for the current window and the one before it,
 * which is what a spike is measured against.
 */
async function dependencyWindows({ windowMinutes = ALERT_RULES.windowMinutes } = {}) {
  const rows = await rawQuery(
    `SELECT COALESCE(dependency, 'APPLICATION') AS dependency,
            SUM(created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE))            AS current_count,
            SUM(created_at <  DATE_SUB(NOW(), INTERVAL ? MINUTE)
                AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE))        AS previous_count
       FROM error_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
      GROUP BY COALESCE(dependency, 'APPLICATION')`,
    [windowMinutes, windowMinutes, windowMinutes * 2, windowMinutes * 2],
  );

  return rows.map((row) => ({
    dependency: row.dependency,
    current: Number(row.current_count ?? 0),
    previous: Number(row.previous_count ?? 0),
  }));
}

/** The endpoints failing most in the window, for the incident detail panel. */
async function topFailingEndpoints({ windowMinutes = 60, limit = 10 } = {}) {
  const rows = await rawQuery(
    `SELECT endpoint, method, COUNT(*) AS failures,
            MAX(created_at) AS last_seen,
            COALESCE(dependency, 'APPLICATION') AS dependency
       FROM error_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
      GROUP BY endpoint, method, COALESCE(dependency, 'APPLICATION')
      ORDER BY failures DESC
      LIMIT ?`,
    [windowMinutes, limit],
  );

  return rows.map((row) => ({
    endpoint: row.endpoint,
    method: row.method,
    dependency: row.dependency,
    failures: Number(row.failures),
    lastSeen: row.last_seen,
  }));
}

/** One request's failure, for a support lookup by reference (§57). */
async function findByRequestId(requestId) {
  const rows = await rawQuery(
    `SELECT id, request_id, user_id, shop_id, method, endpoint, error_type, error_code,
            category, http_status, dependency, message, platform, app_version, created_at
       FROM error_logs WHERE request_id = ? ORDER BY created_at DESC LIMIT 20`,
    [requestId],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    requestId: row.request_id,
    userId: row.user_id === null ? null : Number(row.user_id),
    shopId: row.shop_id === null ? null : Number(row.shop_id),
    method: row.method,
    endpoint: row.endpoint,
    errorType: row.error_type,
    errorCode: row.error_code,
    category: row.category,
    httpStatus: Number(row.http_status),
    dependency: row.dependency,
    message: row.message,
    platform: row.platform,
    appVersion: row.app_version,
    createdAt: row.created_at,
  }));
}

/** Nightly housekeeping - a failure log is only useful while it is recent. */
async function pruneOlderThan(days = 90) {
  const result = await execute('DELETE FROM error_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [
    days,
  ]);
  return result.affectedRows ?? 0;
}

module.exports = {
  DEPENDENCIES,
  record,
  isWorthLogging,
  dependencyFor,
  dependencyWindows,
  topFailingEndpoints,
  findByRequestId,
  pruneOlderThan,
};
