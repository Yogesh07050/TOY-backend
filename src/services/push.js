'use strict';

const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Push transport (Push §37).
 *
 * This module knows how to hand a message to a delivery network and nothing
 * else - no audience selection, no preferences, no persistence. Those live in
 * `services/notifications.js`, which is the only caller. The split is what
 * makes a later move to raw FCM/APNs a new adapter here rather than a rewrite
 * of the notification rules.
 *
 * Every export is safe to call when push is unconfigured or the network is
 * down: a transport failure must never fail the action that triggered the
 * notification, and the in-app record is already saved by the time we run.
 */

const EXPO = 'expo';

/** Expo tokens are the only shape this transport can send to. */
const EXPO_TOKEN_PATTERN = /^Expo(nent)?PushToken\[[^\]]+\]$/;

const isExpoToken = (token) => typeof token === 'string' && EXPO_TOKEN_PATTERN.test(token);

/**
 * Push works without any credential on Expo, so "configured" only asks whether
 * it was switched off and whether the transport is one we implement.
 */
const isConfigured = () => env.push.enabled && env.push.transport === EXPO;

/** Splits into request-sized batches (Expo caps a send at 100 messages). */
function chunk(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

async function postJson(path, body) {
  const headers = {
    accept: 'application/json',
    'accept-encoding': 'gzip, deflate',
    'content-type': 'application/json',
  };
  if (env.push.expoAccessToken) {
    headers.authorization = `Bearer ${env.push.expoAccessToken}`;
  }

  const response = await fetch(`${env.push.expoApiBase}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(env.push.requestTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Expo push ${path} responded ${response.status}`);
  }
  return response.json();
}

/**
 * Sends messages and returns one result per input message, in input order.
 *
 * The caller pairs results back to devices positionally, so a batch that fails
 * wholesale still yields the right number of entries - it just marks every
 * message in it failed rather than silently dropping the batch.
 *
 * @param {Array<{to:string, title:string, body:string, data:object, channelId?:string}>} messages
 * @returns {Promise<Array<{ok:boolean, ticketId:string|null, error:string|null}>>}
 */
async function send(messages) {
  if (!messages.length) return [];
  if (!isConfigured()) {
    return messages.map(() => ({ ok: false, ticketId: null, error: 'PushNotConfigured' }));
  }

  const results = [];
  for (const batch of chunk(messages, env.push.batchSize)) {
    try {
      const payload = await postJson('/send', batch);
      const tickets = Array.isArray(payload?.data) ? payload.data : [];

      for (let index = 0; index < batch.length; index += 1) {
        const ticket = tickets[index];
        if (!ticket) {
          // A short `data` array means Expo rejected the request as a whole;
          // `errors` describes why, and applies to every message in the batch.
          results.push({
            ok: false,
            ticketId: null,
            error: payload?.errors?.[0]?.code || 'NoTicketReturned',
          });
        } else if (ticket.status === 'ok') {
          results.push({ ok: true, ticketId: ticket.id ?? null, error: null });
        } else {
          results.push({
            ok: false,
            ticketId: ticket.id ?? null,
            error: ticket.details?.error || ticket.message || 'UnknownError',
          });
        }
      }
    } catch (error) {
      // Network/timeout: the whole batch is unsent. Recorded per message so the
      // ticket rows still line up with the devices they were meant for.
      // §21: the provider is unreachable, not the message invalid. Logged
      // once per batch rather than per device - a thousand identical lines is
      // what §30 exists to prevent.
      logger.error(
        {
          event: 'NOTIFICATION_SEND_FAILED',
          error_code: 'FIREBASE_UNAVAILABLE',
          category: 'NOTIFICATION',
          dependency: 'PUSH',
          provider: env.push.transport,
          reason: 'PROVIDER_UNREACHABLE',
          batch_size: batch.length,
          err_message: error.message,
        },
        'Push batch could not be delivered to the provider',
      );
      for (let index = 0; index < batch.length; index += 1) {
        results.push({ ok: false, ticketId: null, error: 'TransportUnavailable' });
      }
    }
  }

  return results;
}

/**
 * Reads delivery receipts for previously accepted tickets.
 *
 * A ticket only says Expo took the message; the receipt says whether Google or
 * Apple actually delivered it, and is where a dead token finally surfaces as
 * `DeviceNotRegistered`. Expo discards receipts after 24 hours, so an id we
 * cannot resolve is reported as unknown rather than retried forever.
 *
 * @param {string[]} ticketIds
 * @returns {Promise<Map<string, {ok:boolean, error:string|null}>>}
 */
async function getReceipts(ticketIds) {
  const receipts = new Map();
  if (!ticketIds.length || !isConfigured()) return receipts;

  for (const batch of chunk(ticketIds, 1000)) {
    try {
      const payload = await postJson('/getReceipts', { ids: batch });
      for (const [ticketId, receipt] of Object.entries(payload?.data ?? {})) {
        receipts.set(
          ticketId,
          receipt.status === 'ok'
            ? { ok: true, error: null }
            : { ok: false, error: receipt.details?.error || receipt.message || 'UnknownError' },
        );
      }
    } catch (error) {
      // Leave this batch unresolved - the sweep will pick it up next run,
      // until the ticket ages past Expo's 24-hour retention.
      logger.warn(
        {
          event: 'NOTIFICATION_RECEIPT_LOOKUP_FAILED',
          error_code: 'FIREBASE_UNAVAILABLE',
          category: 'NOTIFICATION',
          dependency: 'PUSH',
          provider: env.push.transport,
          err_message: error.message,
        },
        'Push receipt lookup failed; will retry next sweep',
      );
    }
  }

  return receipts;
}

/**
 * Errors that mean "this token will never work again" rather than "try later".
 * A device hitting one of these is retired immediately instead of burning
 * through the failure budget.
 */
const FATAL_TOKEN_ERRORS = new Set(['DeviceNotRegistered', 'InvalidCredentials']);

const isFatalTokenError = (code) => FATAL_TOKEN_ERRORS.has(code);

module.exports = { isConfigured, isExpoToken, send, getReceipts, isFatalTokenError };
