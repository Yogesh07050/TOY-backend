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
      if (activated || expired) {
        console.log('[jobs] offer lifecycle: %d activated, %d expired', activated, expired);
      }

      // Banners follow the same clock. Their customer-facing visibility is
      // computed live from the offer too, so a stale status can never leak an
      // expired offer onto the page - this just keeps the admin list honest.
      const banners = await bannerService.syncLifecycleStatuses();
      if (banners.published || banners.expired) {
        console.log(
          '[jobs] banner lifecycle: %d published, %d expired',
          banners.published,
          banners.expired,
        );
      }
    },
  },
  {
    name: 'claim-expiry',
    // Claim/Redemption §12: a claim past its expiry becomes EXPIRED. The
    // redemption path never trusts this status - it compares timestamps on
    // every attempt - so a late sweep can only make a list look stale, never
    // let an expired code through.
    schedule: '*/5 * * * *',
    run: async () => {
      const expired = await claimService.syncExpiredClaims();
      if (expired) console.log('[jobs] claim expiry: %d expired', expired);
    },
  },
  {
    name: 'service-lifecycle',
    // Same clock as offer-lifecycle, for the parallel services domain (V4 §4, §14).
    schedule: '*/5 * * * *',
    run: async () => {
      const { activated, expired } = await serviceService.syncLifecycleStatuses();
      const offers = await serviceOfferService.syncLifecycleStatuses();
      if (activated || expired || offers.activated || offers.expired) {
        console.log(
          '[jobs] service lifecycle: %d activated, %d expired (offers: %d activated, %d expired)',
          activated,
          expired,
          offers.activated,
          offers.expired,
        );
      }
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
      if (offers || serviceOffers) {
        console.log('[jobs] expiry reminders sent: %d offers, %d service offers', offers, serviceOffers);
      }
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
    run: async () => {
      const checked = await notifications.syncPushReceipts();
      if (checked) console.log('[jobs] push receipts reconciled: %d', checked);
    },
  },
  {
    name: 'analytics-snapshots',
    // 00:20 daily: fold yesterday's events into the daily roll-ups the premium
    // dashboards read (V3 §29). Idempotent - it replaces the day it covers.
    schedule: '20 0 * * *',
    run: async () => {
      const { day, rows } = await analyticsSnapshots.rebuildDay();
      console.log('[jobs] analytics snapshot for %s: %d rows', day, rows);
    },
  },
  {
    name: 'billing-lifecycle',
    // 02:00 daily. Closes grace windows on failed payments and applies
    // downgrades whose paid period has ended (§10, §11, §12). Merchant data is
    // never deleted - only the plan changes.
    schedule: '0 2 * * *',
    run: async () => {
      const downgraded = await subscriptionService.sweepLapsed();
      if (downgraded) console.log('[jobs] billing lifecycle: %d shops downgraded', downgraded);
    },
  },
  {
    name: 'override-expiry',
    // 02:10 daily (§11H). Bookkeeping rather than enforcement: an expired
    // override stops granting its feature the moment its date passes, because
    // the resolver filters on the date. This writes the EXPIRED audit event.
    schedule: '10 2 * * *',
    run: async () => {
      const expired = await featureOverrides.expireLapsed();
      if (expired) console.log('[jobs] feature overrides expired: %d', expired);
    },
  },
  {
    name: 'prune',
    // Nightly cleanup of spent tokens and stale read notifications.
    schedule: '30 3 * * *',
    run: async () => {
      const [tokens, notices] = await Promise.all([
        authService.pruneExpiredTokens(),
        notifications.pruneOld(),
      ]);
      console.log('[jobs] pruned %d tokens and %d notifications', tokens, notices);
    },
  },
];

function start() {
  for (const job of jobs) {
    cron.schedule(job.schedule, () => {
      job.run().catch((error) => console.error('[jobs] %s failed: %s', job.name, error.message));
    });
  }
  console.log('[jobs] scheduled: %s', jobs.map((job) => job.name).join(', '));

  // Bring statuses up to date immediately rather than waiting for the first tick.
  offerService
    .syncLifecycleStatuses()
    .catch((error) => console.error('[jobs] initial lifecycle sync failed: %s', error.message));
  serviceService
    .syncLifecycleStatuses()
    .catch((error) => console.error('[jobs] initial service lifecycle sync failed: %s', error.message));
  serviceOfferService
    .syncLifecycleStatuses()
    .catch((error) => console.error('[jobs] initial service offer lifecycle sync failed: %s', error.message));
}

module.exports = { start, jobs };
