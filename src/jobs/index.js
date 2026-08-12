'use strict';

const cron = require('node-cron');
const offerService = require('../modules/offers/offer.service');
const bannerService = require('../modules/banners/banner.service');
const notifications = require('../services/notifications');
const analyticsSnapshots = require('../services/analyticsSnapshots');
const authService = require('../modules/auth/auth.service');

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
    name: 'expiring-favourites',
    // Once a day at 09:00: warn customers about saved offers ending soon (§24).
    schedule: '0 9 * * *',
    run: async () => {
      const sent = await notifications.notifyExpiringOffers();
      if (sent) console.log('[jobs] expiry reminders sent: %d', sent);
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
}

module.exports = { start, jobs };
