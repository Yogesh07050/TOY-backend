'use strict';

const cron = require('node-cron');
const offerService = require('../modules/offers/offer.service');
const serviceService = require('../modules/services/service.service');
const serviceOfferService = require('../modules/services/serviceOffer.service');
const bannerService = require('../modules/banners/banner.service');
const notifications = require('../services/notifications');
const analyticsSnapshots = require('../services/analyticsSnapshots');
const authService = require('../modules/auth/auth.service');
const subscriptionService = require('../modules/subscriptions/subscription.service');
const featureOverrides = require('../modules/featureOverrides/featureOverride.service');
const claimService = require('../modules/claims/claim.service');
const failureLog = require('../services/failureLog');
const idempotency = require('../middleware/idempotency');
const logger = require('../utils/logger');
const env = require('../config/env');
const { runJob } = require('./runner');

/**
 * Background maintenance. Everything here is idempotent, so running a job twice
 * (two app instances, a manual trigger) is harmless.
 */
const jobs = [
  {
    name: 'offer-lifecycle',
    // Every five minutes: scheduled -> active -> expired (§14).
    schedule: '*/5 * * * *',
    run: async () => {
      const { activated, expired } = await offerService.syncLifecycleStatuses();

      // Banners follow the same clock. Their customer-facing visibility is
      // computed live from the offer too, so a stale status can never leak an
      // expired offer onto the page - this just keeps the admin list honest.
      const banners = await bannerService.syncLifecycleStatuses();

      return {
        processed: activated + expired + banners.published + banners.expired,
        offers_activated: activated,
        offers_expired: expired,
        banners_published: banners.published,
        banners_expired: banners.expired,
      };
    },
  },
  {
    name: 'claim-expiry',
    // Claim/Redemption §12: a claim past its expiry becomes EXPIRED. The
    // redemption path never trusts this status - it compares timestamps on
    // every attempt - so a late sweep can only make a list look stale, never
    // let an expired code through.
    schedule: '*/5 * * * *',
    run: async () => ({ processed: await claimService.syncExpiredClaims() }),
  },
  {
    name: 'service-lifecycle',
    // Same clock as offer-lifecycle, for the parallel services domain (V4 §4, §14).
    schedule: '*/5 * * * *',
    run: async () => {
      const { activated, expired } = await serviceService.syncLifecycleStatuses();
      const offers = await serviceOfferService.syncLifecycleStatuses();
      return {
        processed: activated + expired + offers.activated + offers.expired,
        services_activated: activated,
        services_expired: expired,
        service_offers_activated: offers.activated,
        service_offers_expired: offers.expired,
      };
    },
  },
  {
    name: 'expiring-saved',
    // Once a day at 09:00: warn customers about saved offers ending soon, at
    // every configured threshold, for both products and services (§24-§26, §36).
    schedule: '0 9 * * *',
    run: async () => {
      const [offers, serviceOffers] = await Promise.all([
        notifications.notifyExpiringSaved('offer'),
        notifications.notifyExpiringSaved('service_offer'),
      ]);
      return {
        processed: offers + serviceOffers,
        offer_reminders: offers,
        service_offer_reminders: serviceOffers,
      };
    },
  },
  {
    name: 'push-receipts',
    // Every 15 minutes. A push ticket only says the relay accepted the
    // message; the receipt says what Google and Apple did with it, and is
    // where an uninstalled app finally surfaces as a dead token (Push §31).
    // Expo discards receipts after 24 hours, so this has to run often enough
    // to catch them - and is a no-op when there is nothing pending.
    schedule: '*/15 * * * *',
    run: async () => ({ processed: await notifications.syncPushReceipts() }),
  },
  {
    name: 'analytics-snapshots',
    // 00:20 daily: fold yesterday's events into the daily roll-ups the premium
    // dashboards read (V3 §29). Idempotent - it replaces the day it covers.
    schedule: '20 0 * * *',
    run: async () => {
      const { day, rows } = await analyticsSnapshots.rebuildDay();
      return { processed: rows, snapshot_day: day };
    },
  },
  {
    name: 'billing-lifecycle',
    // 02:00 daily. Closes grace windows on failed payments and applies
    // downgrades whose paid period has ended (§10, §11, §12). Merchant data is
    // never deleted - only the plan changes.
    schedule: '0 2 * * *',
    run: async () => ({ processed: await subscriptionService.sweepLapsed() }),
  },
  {
    name: 'override-expiry',
    // 02:10 daily (§11H). Bookkeeping rather than enforcement: an expired
    // override stops granting its feature the moment its date passes, because
    // the resolver filters on the date. This writes the EXPIRED audit event.
    schedule: '10 2 * * *',
    run: async () => ({ processed: await featureOverrides.expireLapsed() }),
  },
  {
    name: 'idempotency-sweep',
    // Every 5 minutes. Releases keys claimed by a request whose process died
    // before it could answer (§50) - without this, an interrupted payment
    // leaves its key stuck `in_progress` and the merchant unable to retry at
    // all, which is worse than the duplicate the key was preventing.
    schedule: '*/5 * * * *',
    run: async () => ({ processed: await idempotency.releaseStale(15) }),
  },
  {
    name: 'prune',
    // Nightly cleanup of spent tokens and stale read notifications.
    schedule: '30 3 * * *',
    run: async () => {
      // The failure log joins the sweep (Business §56): it is diagnostic data
      // with a user id attached, so it is kept only as long as it is useful
      // for tracing a support ticket.
      const [tokens, notices, failures, keys] = await Promise.all([
        authService.pruneExpiredTokens(),
        notifications.pruneOld(),
        // §35: retention is configurable rather than a literal, because "how
        // long do we keep this?" is a policy question and policy changes.
        failureLog.pruneOlderThan(env.logging.retentionDays),
        // A settled key is only useful while a client might still retry with
        // it; two days is far beyond any timeout worth honouring.
        idempotency.pruneCompleted(48),
      ]);
      return {
        processed: tokens + notices + failures + keys,
        tokens_pruned: tokens,
        notifications_pruned: notices,
        failure_records_pruned: failures,
        idempotency_keys_pruned: keys,
        retention_days: env.logging.retentionDays,
      };
    },
  },
];

function start() {
  for (const job of jobs) {
    // `runJob` owns the whole lifecycle including failure (§24), so nothing is
    // attached here - a `.catch` would only ever see an error it already logged.
    cron.schedule(job.schedule, () => void runJob(job));
  }
  logger.info(
    { event: 'JOBS_SCHEDULED', jobs: jobs.map((job) => job.name), count: jobs.length },
    `Scheduled ${jobs.length} background jobs`,
  );

  // Bring statuses up to date immediately rather than waiting for the first
  // tick. Run through the same wrapper so a failure at boot is as visible as
  // one at 03:00, and carries a job id somebody can search for.
  void runJob({
    name: 'initial-lifecycle-sync',
    run: async () => {
      const [offers, services, serviceOffers] = await Promise.all([
        offerService.syncLifecycleStatuses(),
        serviceService.syncLifecycleStatuses(),
        serviceOfferService.syncLifecycleStatuses(),
      ]);
      return {
        processed:
          offers.activated + offers.expired + services.activated + services.expired +
          serviceOffers.activated + serviceOffers.expired,
        offers_activated: offers.activated,
        offers_expired: offers.expired,
        services_activated: services.activated,
        services_expired: services.expired,
        service_offers_activated: serviceOffers.activated,
        service_offers_expired: serviceOffers.expired,
      };
    },
  });
}

module.exports = { start, jobs };
