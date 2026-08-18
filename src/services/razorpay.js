'use strict';

const crypto = require('node:crypto');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');

/**
 * Razorpay REST client (V3 payments §2).
 *
 * Deliberately a thin wrapper over `fetch` rather than the vendor SDK: the app
 * needs six endpoints and two HMAC checks, and the signature verification below
 * is the security-critical part - it is clearer with the bytes in view.
 *
 * The application never sees a card number, CVV, PIN or UPI credential (§6).
 * Everything that crosses this boundary is an identifier or an amount.
 */

const isConfigured = Boolean(env.razorpay.keyId && env.razorpay.keySecret);

/** Razorpay amounts are in the smallest currency unit - paise for INR. */
const toPaise = (rupees) => Math.round(Number(rupees) * 100);
const fromPaise = (paise) => Number(paise ?? 0) / 100;

function authHeader() {
  const raw = `${env.razorpay.keyId}:${env.razorpay.keySecret}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

/**
 * @param {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} method
 * @param {string} path e.g. '/subscriptions'
 * @param {object} [body]
 */
async function request(method, path, body) {
  if (!isConfigured) {
    throw new ApiError(
      503,
      'Online payments are not configured on this server.',
      undefined,
      'PAYMENTS_NOT_CONFIGURED',
    );
  }

  let response;
  try {
    response = await fetch(`${env.razorpay.apiBase}${path}`, {
      method,
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    // A network failure must not look like a declined payment.
    throw new ApiError(
      502,
      'Could not reach the payment gateway. Please try again.',
      undefined,
      'GATEWAY_UNREACHABLE',
    );
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.error?.description || 'The payment gateway rejected the request.';
    const error = new ApiError(
      response.status === 400 ? 400 : 502,
      message,
      undefined,
      'GATEWAY_ERROR',
    );
    error.details = { gatewayCode: payload?.error?.code ?? null, status: response.status };
    throw error;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Resources

/** Reuses one gateway customer per merchant so cards/mandates stay attached. */
const createCustomer = ({ name, email, contact, notes }) =>
  request('POST', '/customers', {
    name,
    email,
    contact: contact || undefined,
    // Razorpay 400s on a duplicate email unless told the existing one will do.
    fail_existing: '0',
    notes,
  });

/**
 * A recurring subscription against a Razorpay Plan. This is what makes UPI
 * AutoPay and card mandates possible (§4, §5) - a one-off order cannot carry a
 * mandate, so the app never builds its own recurring billing (§4).
 */
const createSubscription = ({ planId, customerId, totalCount, notes, customerNotify = 1 }) =>
  request('POST', '/subscriptions', {
    plan_id: planId,
    customer_id: customerId || undefined,
    total_count: totalCount,
    customer_notify: customerNotify,
    notes,
  });

const fetchSubscription = (subscriptionId) => request('GET', `/subscriptions/${subscriptionId}`);

/**
 * @param {boolean} atCycleEnd true keeps the plan live until the paid period
 * ends, which is the cancellation behaviour §13 describes.
 */
const cancelSubscription = (subscriptionId, atCycleEnd = true) =>
  request('POST', `/subscriptions/${subscriptionId}/cancel`, {
    cancel_at_cycle_end: atCycleEnd ? 1 : 0,
  });

/** One-off order, used when a merchant pays for a single period without a mandate. */
const createOrder = ({ amount, currency = 'INR', receipt, notes }) =>
  request('POST', '/orders', { amount: toPaise(amount), currency, receipt, notes });

const fetchPayment = (paymentId) => request('GET', `/payments/${paymentId}`);

// ---------------------------------------------------------------------------
// Signatures

/** Constant-time compare that tolerates differing lengths. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

const hmac = (secret, payload) =>
  crypto.createHmac('sha256', secret).update(payload).digest('hex');

/**
 * Verifies a webhook against the raw request body (§8.1).
 *
 * The *raw* bytes matter: re-serialising the parsed JSON would reorder keys and
 * change whitespace, and the HMAC would never match.
 */
function verifyWebhookSignature(rawBody, signature) {
  if (!env.razorpay.webhookSecret || !signature || !rawBody) return false;
  return safeEqual(hmac(env.razorpay.webhookSecret, rawBody), signature);
}

/** Checkout handshake for a one-off order payment. */
function verifyOrderPaymentSignature({ orderId, paymentId, signature }) {
  if (!isConfigured || !signature) return false;
  return safeEqual(hmac(env.razorpay.keySecret, `${orderId}|${paymentId}`), signature);
}

/** Checkout handshake for a subscription's first payment. Note the reversed order. */
function verifySubscriptionPaymentSignature({ subscriptionId, paymentId, signature }) {
  if (!isConfigured || !signature) return false;
  return safeEqual(hmac(env.razorpay.keySecret, `${paymentId}|${subscriptionId}`), signature);
}

module.exports = {
  isConfigured,
  keyId: env.razorpay.keyId,
  toPaise,
  fromPaise,
  request,
  createCustomer,
  createSubscription,
  fetchSubscription,
  cancelSubscription,
  createOrder,
  fetchPayment,
  verifyWebhookSignature,
  verifyOrderPaymentSignature,
  verifySubscriptionPaymentSignature,
};
