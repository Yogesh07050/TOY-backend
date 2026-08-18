'use strict';

const { queryOne, execute } = require('../../db/pool');
const env = require('../../config/env');
const razorpay = require('../../services/razorpay');
const payments = require('./payment.service');
const subscriptions = require('../subscriptions/subscription.service');
const notifications = require('../../services/notifications');

/**
 * Razorpay webhook processing (§8).
 *
 * This is the only place a subscription becomes ACTIVE (§7). The order of
 * operations is the one §8 lays out:
 *
 *   verify signature -> validate event -> already processed? -> update state
 *   -> record the event -> answer 200
 *
 * Idempotency comes from the unique key on `payment_webhooks(gateway,
 * event_id)`: the INSERT is attempted first, and a duplicate-key error *is*
 * the "already processed" answer. Checking with a SELECT instead would race
 * two concurrent redeliveries of the same event.
 */

/** Razorpay sends epoch seconds; MySQL wants a Date. */
const at = (seconds) => (seconds ? new Date(Number(seconds) * 1000) : null);

/** Human label for the method, for the billing table (§15). */
function describeMethod(payment) {
  if (!payment) return { method: null, detail: null };
  const method = payment.method ?? null;
  if (method === 'upi') {
    // The VPA is an address, not a credential - Razorpay returns it and it is
    // what the merchant recognises on their statement. No PIN is ever involved.
    return { method: 'upi', detail: payment.vpa ?? payment.upi?.vpa ?? null };
  }
  if (method === 'card') {
    const card = payment.card ?? {};
    // Network + last four only. The number, CVV and expiry never reach us (§6).
    return { method: 'card', detail: [card.network, card.last4].filter(Boolean).join(' ****') || null };
  }
  if (method === 'netbanking') return { method: 'netbanking', detail: payment.bank ?? null };
  if (method === 'wallet') return { method: 'wallet', detail: payment.wallet ?? null };
  return { method, detail: null };
}

/** Tells shop staff that a renewal failed, so they can act before downgrade (§10). */
async function notifyPaymentFailure(shopId, subscription, reason) {
  try {
    await notifications.notifyShopTeam(shopId, {
      type: 'SUBSCRIPTION_BILLING',
      title: 'Subscription payment failed',
      message:
        `We could not collect the ${subscription.planName} plan payment for your shop. ` +
        `Your features stay on until ${
          subscription.graceUntil ? new Date(subscription.graceUntil).toDateString() : 'the grace period ends'
        }. ` +
        (reason ? `Reason: ${reason}` : 'Please update your payment method.'),
      entityType: 'shop',
      entityId: shopId,
    });
  } catch (error) {
    // A notification failure must never make a webhook look unprocessed.
    console.error('[payments] failed to notify shop %d: %s', shopId, error.message);
  }
}

// ---------------------------------------------------------------------------
// Event handlers. Each resolves the shop itself, because Razorpay events carry
// the subscription/order rather than anything of ours.

async function shopForSubscription(gatewaySubscriptionId) {
  if (!gatewaySubscriptionId) return null;
  return subscriptions.findByGatewaySubscriptionId(gatewaySubscriptionId);
}

/**
 * Falls back to the `notes.shop_id` we set when the object was created, for
 * events that arrive before `gateway_subscription_id` was stored.
 */
function shopIdFromNotes(entity) {
  const raw = entity?.notes?.shop_id;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function handleSubscriptionEvent(eventType, payload) {
  const entity = payload?.subscription?.entity;
  if (!entity) return { handled: false, reason: 'no subscription entity' };

  const subscription =
    (await shopForSubscription(entity.id)) ??
    (shopIdFromNotes(entity) ? await subscriptions.getForShop(shopIdFromNotes(entity)) : null);
  if (!subscription) return { handled: false, reason: `unknown subscription ${entity.id}` };

  const shopId = subscription.shopId;
  const periodStart = at(entity.current_start);
  const periodEnd = at(entity.current_end) ?? at(entity.charge_at);

  switch (eventType) {
    // The mandate exists but the first charge has not landed. AutoPay is on;
    // the plan is not (§5, §7).
    case 'subscription.authenticated':
      await execute(
        'UPDATE shop_subscriptions SET autopay_enabled = 1, payment_method = COALESCE(payment_method, ?) WHERE shop_id = ?',
        [entity.payment_method ?? null, shopId],
      );
      return { handled: true, shopId, action: 'mandate_authorised' };

    case 'subscription.activated':
    case 'subscription.charged':
    case 'subscription.resumed':
      await subscriptions.activate(shopId, {
        periodStart,
        periodEnd,
        autopay: true,
        amount: subscription.price,
      });
      return { handled: true, shopId, action: 'activated' };

    case 'subscription.pending':
    case 'subscription.halted': {
      const updated = await subscriptions.markPastDue(shopId, {
        reason: eventType === 'subscription.halted' ? 'Retries exhausted' : 'Renewal payment pending',
      });
      await notifyPaymentFailure(shopId, updated, updated.lastFailureReason);
      return { handled: true, shopId, action: 'past_due' };
    }

    case 'subscription.paused':
      await subscriptions.setStatus(shopId, 'paused');
      return { handled: true, shopId, action: 'paused' };

    case 'subscription.cancelled':
      // Razorpay cancelled the mandate. The merchant keeps the period they
      // already paid for; `sweepLapsed` drops them to Free when it ends (§13).
      await subscriptions.cancel(shopId, null, 'Cancelled at the payment gateway');
      return { handled: true, shopId, action: 'cancelled' };

    case 'subscription.completed':
      await subscriptions.downgradeToFree(shopId, 'Subscription completed at the gateway');
      return { handled: true, shopId, action: 'completed' };

    default:
      return { handled: false, reason: `unhandled ${eventType}` };
  }
}

async function handlePaymentEvent(eventType, payload) {
  const entity = payload?.payment?.entity;
  if (!entity) return { handled: false, reason: 'no payment entity' };

  // A subscription payment names its subscription; a one-off names its order.
  const subscription =
    (await shopForSubscription(entity.subscription_id)) ??
    (shopIdFromNotes(entity) ? await subscriptions.getForShop(shopIdFromNotes(entity)) : null);
  if (!subscription) return { handled: false, reason: `no shop for payment ${entity.id}` };

  const { method, detail } = describeMethod(entity);
  const status =
    eventType === 'payment.captured'
      ? 'CAPTURED'
      : eventType === 'payment.authorized'
        ? 'AUTHORIZED'
        : eventType === 'payment.failed'
          ? 'FAILED'
          : payments.PAYMENT_STATUS[entity.status] ?? 'PENDING';

  const transaction = await payments.recordTransaction({
    shopId: subscription.shopId,
    // The plan this money buys - the one still in force until `activate` runs.
    plan: subscription.checkoutPlan ?? subscription.plan,
    gatewayOrderId: entity.order_id ?? null,
    gatewayPaymentId: entity.id,
    gatewayInvoiceId: entity.invoice_id ?? null,
    amount: razorpay.fromPaise(entity.amount),
    currency: entity.currency ?? 'INR',
    paymentMethod: method,
    methodDetail: detail,
    status,
    failureReason: entity.error_description ?? null,
    paidAt: status === 'CAPTURED' ? at(entity.created_at) ?? new Date() : null,
  });

  if (status === 'CAPTURED') {
    // Money arrived. This is the moment the plan is allowed to turn on (§7).
    const active = await subscriptions.activate(subscription.shopId, {
      paymentMethod: method,
      amount: razorpay.fromPaise(entity.amount),
      autopay: Boolean(entity.subscription_id),
    });
    if (transaction) {
      await payments.issueInvoice(transaction, {
        periodStart: active.currentPeriodStart,
        periodEnd: active.currentPeriodEnd,
      });
    }
    return { handled: true, shopId: subscription.shopId, action: 'captured' };
  }

  if (status === 'FAILED') {
    const updated = await subscriptions.markPastDue(subscription.shopId, {
      reason: entity.error_description ?? 'Payment failed',
    });
    await notifyPaymentFailure(subscription.shopId, updated, updated.lastFailureReason);
    return { handled: true, shopId: subscription.shopId, action: 'failed' };
  }

  return { handled: true, shopId: subscription.shopId, action: status.toLowerCase() };
}

async function handleRefundEvent(payload) {
  const refund = payload?.refund?.entity;
  const payment = payload?.payment?.entity;
  if (!refund) return { handled: false, reason: 'no refund entity' };

  const existing = await queryOne('SELECT * FROM payment_transactions WHERE gateway_payment_id = ?', [
    refund.payment_id,
  ]);
  if (!existing) return { handled: false, reason: `unknown payment ${refund.payment_id}` };

  const refunded = razorpay.fromPaise(payment?.amount_refunded ?? refund.amount);
  const full = refunded >= Number(existing.amount);

  await execute(
    `UPDATE payment_transactions SET amount_refunded = ?, status = ? WHERE id = ?`,
    [refunded, full ? 'REFUNDED' : 'PARTIALLY_REFUNDED', existing.id],
  );
  await execute(
    `UPDATE subscription_invoices SET status = 'refunded' WHERE transaction_id = ? AND ? = 1`,
    [existing.id, full ? 1 : 0],
  );

  return { handled: true, shopId: Number(existing.shop_id), action: full ? 'refunded' : 'partially_refunded' };
}

const HANDLERS = {
  'subscription.authenticated': handleSubscriptionEvent,
  'subscription.activated': handleSubscriptionEvent,
  'subscription.charged': handleSubscriptionEvent,
  'subscription.pending': handleSubscriptionEvent,
  'subscription.halted': handleSubscriptionEvent,
  'subscription.paused': handleSubscriptionEvent,
  'subscription.resumed': handleSubscriptionEvent,
  'subscription.cancelled': handleSubscriptionEvent,
  'subscription.completed': handleSubscriptionEvent,
  'payment.authorized': handlePaymentEvent,
  'payment.captured': handlePaymentEvent,
  'payment.failed': handlePaymentEvent,
  'refund.created': (_type, payload) => handleRefundEvent(payload),
  'refund.processed': (_type, payload) => handleRefundEvent(payload),
};

/**
 * Razorpay does not send a stable event id in the body, so the `x-razorpay-
 * event-id` header is the idempotency key; falling back to a digest of the
 * event type plus the entity id keeps redeliveries deduplicated even if the
 * header is ever missing.
 */
function eventIdFor(req, body) {
  const header = req.headers['x-razorpay-event-id'];
  if (typeof header === 'string' && header.trim()) return header.trim().slice(0, 160);

  const entity =
    body?.payload?.payment?.entity?.id ??
    body?.payload?.subscription?.entity?.id ??
    body?.payload?.refund?.entity?.id ??
    'unknown';

  // The event timestamp is part of the key because a subscription entity id is
  // the *same* on every billing cycle - without it, month five's
  // `subscription.halted` would collide with month two's and be discarded as a
  // duplicate, leaving a failed renewal unprocessed. Razorpay repeats
  // `created_at` on redelivery, so genuine duplicates still collide.
  return `${body?.event ?? 'unknown'}:${entity}:${body?.created_at ?? Date.now()}`.slice(0, 160);
}

/**
 * Processes one webhook delivery.
 *
 * @returns {{status:number, body:object}} what the route should answer.
 * Failures inside a handler still answer 200 with the error recorded: a 500
 * would make Razorpay redeliver an event we have already stored, and the
 * stored row is what an operator replays from.
 */
async function process(req) {
  const raw = req.rawBody;
  const signature = req.headers['x-razorpay-signature'];

  // 1. Authenticity. Without a configured secret nothing can be trusted, so
  //    the endpoint refuses rather than accepting unverified state changes.
  if (!env.razorpay.webhookSecret) {
    return { status: 503, body: { success: false, error: 'Webhook secret is not configured' } };
  }
  if (!razorpay.verifyWebhookSignature(raw, signature)) {
    return { status: 401, body: { success: false, error: 'Invalid webhook signature' } };
  }

  // 2. Validate.
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, body: { success: false, error: 'Malformed webhook payload' } };
  }
  const eventType = body?.event;
  if (!eventType) {
    return { status: 400, body: { success: false, error: 'Missing event type' } };
  }

  // 3. Idempotency: the insert is the check.
  const eventId = eventIdFor(req, body);
  try {
    await execute(
      `INSERT INTO payment_webhooks (gateway, event_id, event_type, payload) VALUES (?, ?, ?, ?)`,
      [payments.GATEWAY, eventId, eventType, JSON.stringify(body)],
    );
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return { status: 200, body: { success: true, data: { duplicate: true, eventId } } };
    }
    throw error;
  }

  // 4./5. Apply the state change, then mark the stored event processed.
  const handler = HANDLERS[eventType];
  if (!handler) {
    await execute(
      `UPDATE payment_webhooks SET processed = 1, processed_at = NOW(), error = 'No handler'
        WHERE gateway = ? AND event_id = ?`,
      [payments.GATEWAY, eventId],
    );
    return { status: 200, body: { success: true, data: { ignored: eventType } } };
  }

  try {
    const result = await handler(eventType, body.payload ?? {});
    await execute(
      `UPDATE payment_webhooks SET processed = ?, processed_at = NOW(), error = ?
        WHERE gateway = ? AND event_id = ?`,
      [result.handled ? 1 : 0, result.handled ? null : String(result.reason ?? '').slice(0, 500), payments.GATEWAY, eventId],
    );
    return { status: 200, body: { success: true, data: { eventId, ...result } } };
  } catch (error) {
    console.error('[payments] webhook %s (%s) failed: %s', eventType, eventId, error.message);
    await execute(
      `UPDATE payment_webhooks SET processed = 0, error = ? WHERE gateway = ? AND event_id = ?`,
      [error.message.slice(0, 500), payments.GATEWAY, eventId],
    );
    // 6. Answer successfully: the event is stored and replayable, and a 5xx
    //    would only buy an endless redelivery loop.
    return { status: 200, body: { success: true, data: { eventId, stored: true, processed: false } } };
  }
}

module.exports = { process, describeMethod, eventIdFor };
