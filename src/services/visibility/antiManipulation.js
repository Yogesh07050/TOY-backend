'use strict';

const { execute, query, rawQuery } = require('../../db/pool');
const config = require('./config');

/**
 * Anti-manipulation (§25).
 *
 * §25 lists the patterns to watch for and says suspicious activity "should be
 * filtered or down-weighted when calculating ranking signals". Two mechanisms
 * do that here, and they are deliberately different in severity:
 *
 *   flag  - marks individual events `is_suspicious`, which removes them from
 *           every ranking aggregate *and* from every analytics figure. Cheap,
 *           reversible, and applied to the excess only: a customer who really
 *           did look at an offer thirty times keeps the first twenty.
 *   sweep - opens an automatic `ranking_exclusions` row for a listing whose
 *           engagement is overwhelmingly fabricated. This takes it out of
 *           discovery entirely, so it is reserved for the clear cases and
 *           always expires on its own.
 *
 * ## Why this runs in a job rather than on the request
 *
 * Detecting "the same account viewed this fifty times today" needs the window,
 * not the event. Deciding at insert time would mean a counting query on the hot
 * path of every impression - a cost paid by every honest customer to catch a
 * rare dishonest one. The rollup sees the whole window at once and costs
 * nothing per request.
 *
 * Ranking is unaffected in the meantime because engagement is read from the
 * precomputed scores, which are rebuilt by the same job *after* this has run.
 */

/**
 * Flags the excess events beyond the per-user-per-listing cap (§25: "Repeated
 * views from the same account/device", "Repeated claims").
 *
 * The cap is applied per (identity, listing, event type) so that a burst of
 * views does not suppress a genuine single claim from the same person.
 *
 * Identity is the user id when there is one, and the device hash otherwise -
 * `COALESCE` rather than two passes, because an automated client that never
 * signs in is exactly the case §25 calls "automated requests".
 */
async function flagExcessEvents() {
  const { rules } = await config.get();
  const windowHours = rules.antiManipulationWindowHours;
  const cap = rules.antiManipulationMaxEventsPerUserPerListing;

  // The subquery numbers each identity's events on a listing, newest last, and
  // anything past the cap is flagged. Ordering by id means the *earliest*
  // events survive - the ones most likely to be the real interaction.
  const result = await rawQuery(
    `UPDATE visibility_events ve
       JOIN (
         SELECT id FROM (
           SELECT id,
                  ROW_NUMBER() OVER (
                    PARTITION BY COALESCE(CAST(user_id AS CHAR), device_hash, ip_hash),
                                 listing_type, listing_id, event_type
                    ORDER BY id
                  ) AS seq
             FROM visibility_events
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
              AND is_suspicious = 0
              AND COALESCE(CAST(user_id AS CHAR), device_hash, ip_hash) IS NOT NULL
              AND listing_id IS NOT NULL
         ) numbered
         WHERE numbered.seq > ?
       ) excess ON excess.id = ve.id
        SET ve.is_suspicious = 1`,
    [windowHours, cap],
  );

  return result.affectedRows ?? 0;
}

/**
 * Suspends listings whose recent engagement is mostly flagged (§25).
 *
 * The test is a ratio, not a count: a busy listing with a hundred flagged
 * events out of ten thousand is popular and slightly spammed, while one with
 * forty flagged out of fifty is being manufactured. Only the second is a
 * listing the platform should stop ranking.
 *
 * The exclusion expires on its own, so a false positive costs a day of reach
 * rather than a merchant's livelihood until someone notices.
 */
async function suspendManipulatedListings({ minEvents = 40, suspiciousRatio = 0.6, expiryHours = 24 } = {}) {
  const rows = await query(
    `SELECT listing_type, listing_id, shop_id,
            COUNT(*) AS total,
            SUM(is_suspicious) AS flagged
       FROM visibility_events
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AND listing_id IS NOT NULL
      GROUP BY listing_type, listing_id, shop_id
     HAVING total >= ? AND flagged / total >= ?`,
    [minEvents, suspiciousRatio],
  );

  let opened = 0;
  for (const row of rows) {
    // INSERT ... SELECT with a NOT EXISTS guard rather than a unique key: the
    // table also holds deliberate Super Admin exclusions, and a unique key
    // would let an automatic sweep silently overwrite one of those.
    const result = await execute(
      `INSERT INTO ranking_exclusions (listing_type, listing_id, shop_id, scope, source, reason, expires_at)
       SELECT ?, ?, ?, 'listing', 'auto', ?, DATE_ADD(NOW(), INTERVAL ? HOUR)
        WHERE NOT EXISTS (
          SELECT 1 FROM ranking_exclusions x
           WHERE x.listing_type = ? AND x.listing_id = ? AND x.status = 'active'
             AND (x.expires_at IS NULL OR x.expires_at > NOW()))`,
      [
        row.listing_type,
        row.listing_id,
        row.shop_id,
        `Automatic: ${Number(row.flagged)} of ${Number(row.total)} engagement events in 24h flagged as suspicious`,
        expiryHours,
        row.listing_type,
        row.listing_id,
      ],
    );
    opened += result.affectedRows ?? 0;
  }

  return opened;
}

/** Closes automatic exclusions whose expiry has passed. Admin ones are left alone. */
async function lapseExpiredExclusions() {
  const result = await execute(
    `UPDATE ranking_exclusions SET status = 'lifted', lifted_at = NOW()
      WHERE status = 'active' AND source = 'auto'
        AND expires_at IS NOT NULL AND expires_at <= NOW()`,
  );
  return result.affectedRows;
}

/**
 * The `AND NOT EXISTS (...)` fragment every candidate query carries (§24).
 *
 * Returned as SQL rather than applied as a post-filter on purpose: filtering
 * after the LIMIT would silently shrink a page, and filtering after the count
 * would report a total the caller can never reach.
 */
function exclusionPredicate(listingTypeSql, listingIdSql, shopIdSql) {
  return `NOT EXISTS (
    SELECT 1 FROM ranking_exclusions rx
     WHERE rx.status = 'active'
       AND (rx.expires_at IS NULL OR rx.expires_at > NOW())
       AND (
         (rx.scope = 'listing' AND rx.listing_type = ${listingTypeSql} AND rx.listing_id = ${listingIdSql})
         OR (rx.scope = 'shop' AND rx.shop_id = ${shopIdSql})
       ))`;
}

module.exports = {
  flagExcessEvents,
  suspendManipulatedListings,
  lapseExpiredExclusions,
  exclusionPredicate,
};
