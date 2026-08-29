'use strict';

const { execute } = require('../db/pool');
const logger = require('./logger');

/**
 * Records an administrative action (§28). Never throws into the request path -
 * a failed audit write must not roll back the action the user just performed,
 * but it is logged loudly so the gap is visible in the server logs.
 *
 * @param {object} req      Express request (for the acting user + IP)
 * @param {object} entry
 * @param {string} entry.action       e.g. 'OFFER_CREATED'
 * @param {string} entry.entityType   e.g. 'offer'
 * @param {number|string} [entry.entityId]
 * @param {object} [entry.oldValue]
 * @param {object} [entry.newValue]
 */
async function record(req, { action, entityType, entityId = null, oldValue = null, newValue = null }) {
  try {
    await execute(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_value, new_value, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req?.user?.id ?? null,
        action,
        entityType,
        entityId,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
        req?.ip ?? null,
      ],
    );
  } catch (error) {
    // An audit gap is a compliance problem, not a nuisance - logged at ERROR
    // so it is visible even though the user's action itself succeeded.
    logger.error(
      {
        event: 'AUDIT_WRITE_FAILED',
        error_code: 'DB_TRANSACTION_FAILED',
        category: 'DATABASE',
        dependency: 'DATABASE',
        audit_action: action,
        entity_type: entityType,
        err_message: error.message,
      },
      'Could not record an audit entry',
    );
  }
}

/** Strips fields that must never end up in an audit payload. */
function sanitize(row, extraKeys = []) {
  if (!row) return null;
  const hidden = new Set(['password_hash', 'token_hash', ...extraKeys]);
  return Object.fromEntries(Object.entries(row).filter(([key]) => !hidden.has(key)));
}

module.exports = { record, sanitize };
