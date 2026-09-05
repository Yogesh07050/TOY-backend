'use strict';

const crypto = require('node:crypto');
const { rawQuery } = require('../../db/pool');
const vis = require('../../config/visibility');

/**
 * Fairness: rotation, shop diversity and frequency control (§2.6, §10, §18,
 * §19, §28).
 *
 * These rules operate on the *ordered list*, not on individual listings, which
 * is why they live apart from the scorer. "No more than one offer per shop in
 * any three consecutive results" is not a property a listing can have on its
 * own - it only exists once there is a list.
 *
 * The order they are applied in matters and is deliberate:
 *
 *   1. frequency  - adjusts scores for listings this customer has already seen
 *                   too often, before anything is ordered.
 *   2. rotation   - reshuffles ties, so equal listings take turns.
 *   3. diversity  - reorders the final list so no shop owns the fold.
 *
 * Frequency first because it changes scores; rotation second because it only
 * matters among equal scores; diversity last because it is the one rule that
 * may move a genuinely higher-scoring listing down, and doing that before the
 * others would have the others fighting to undo it.
 */

// ---------------------------------------------------------------------------
// §10, §28 - rotation

/**
 * A stable pseudo-random number in [0,1) for a listing inside the current
 * rotation bucket.
 *
 * Deterministic on purpose. §10 wants exposure to circulate, but a customer
 * who scrolls, opens something and comes back must not find the list
 * rearranged under them - and two app instances answering the same request
 * must agree. Hashing (listing, bucket) gives both: stable for the length of a
 * bucket, different in the next one, and identical on every server.
 */
function rotationJitter(listingKey, bucket) {
  const digest = crypto.createHash('sha1').update(`${bucket}:${listingKey}`).digest();
  // 32 bits of the digest, scaled to [0,1).
  return digest.readUInt32BE(0) / 0x100000000;
}

const bucketFor = (rules, now = Date.now()) =>
  Math.floor(now / (rules.rotationBucketMinutes * 60000));

/**
 * Rotates listings whose scores are within the tie band (§28: "When scores are
 * close, the system can rotate prominent positions").
 *
 * The band is what makes this safe. Rotation only ever reorders listings that
 * were already effectively equal, so it can never move a genuinely better
 * result below a worse one - which is what separates fair rotation from
 * randomising the results page.
 *
 * Recent prominent exposure is folded in here too, capped at
 * `rotationExposurePenalty`: a listing that has been at the top all day drifts
 * down within its band, and a listing nobody has seen drifts up. Capped
 * because §2.6's exposure balancing is a nudge, not a ranking factor.
 */
function applyRotation(scored, rules, exposureByKey = new Map(), now = Date.now()) {
  if (!scored.length) return scored;
  const bucket = bucketFor(rules, now);

  const withJitter = scored.map((entry) => {
    const key = `${entry.row.listing_type}:${entry.row.id}`;
    const exposure = exposureByKey.get(key) ?? 0;
    // Normalised against the pool's own busiest listing, so the penalty means
    // "relative to everything else here" rather than depending on absolute
    // traffic volumes that vary by orders of magnitude between installs.
    const jitter = rotationJitter(key, bucket);
    return { entry, key, exposure, jitter };
  });

  const maxExposure = withJitter.reduce((max, item) => Math.max(max, item.exposure), 0);

  return withJitter
    .map((item) => {
      const exposurePenalty =
        maxExposure > 0 ? (item.exposure / maxExposure) * rules.rotationExposurePenalty : 0;
      // The tie-break value: the score, minus recent exposure, plus a jitter
      // that can only move a listing inside its own band.
      const rotated =
        item.entry.score - exposurePenalty + (item.jitter - 0.5) * rules.rotationTieBand;
      return { ...item.entry, rotationScore: rotated, exposure: item.exposure };
    })
    .sort((a, b) => {
      // Outside the band, the real score always wins; inside it, the rotated
      // one does. This is the single line that makes rotation fair rather than
      // arbitrary.
      if (Math.abs(a.score - b.score) > rules.rotationTieBand) return b.score - a.score;
      return b.rotationScore - a.rotationScore;
    });
}

/**
 * How much prominent exposure each listing in the pool has had recently.
 *
 * Counts only impressions in the top positions: being shown at rank 40 is not
 * exposure worth balancing, and counting it would penalise a listing for
 * appearing deep in lists nobody scrolled to.
 */
async function recentExposure(listings, rules, prominentPositions = 5) {
  if (!listings.length) return new Map();

  const byType = new Map();
  for (const item of listings) {
    const list = byType.get(item.listing_type) ?? [];
    list.push(Number(item.id));
    byType.set(item.listing_type, list);
  }

  const clauses = [];
  const params = [];
  for (const [type, ids] of byType) {
    clauses.push(`(listing_type = ? AND listing_id IN (${ids.map(() => '?').join(',')}))`);
    params.push(type, ...ids);
  }

  const rows = await rawQuery(
    `SELECT listing_type, listing_id, COUNT(*) AS exposures
       FROM visibility_events
      WHERE event_type IN ('IMPRESSION','FEATURED_IMPRESSION')
        AND position IS NOT NULL AND position <= ?
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        AND (${clauses.join(' OR ')})
      GROUP BY listing_type, listing_id`,
    [prominentPositions, rules.rotationExposureWindowHours, ...params],
  );

  return new Map(rows.map((row) => [`${row.listing_type}:${row.listing_id}`, Number(row.exposures)]));
}

// ---------------------------------------------------------------------------
// §19 - shop and category diversity

/**
 * Reorders so no shop (or category) fills a run of consecutive results.
 *
 * A greedy pass rather than a global optimisation: walk the ranked list, and
 * whenever the next listing would break a window limit, take the best listing
 * that would not. Anything that never fits is appended at the end rather than
 * dropped - §19 is about "giving customers more choices", not about hiding a
 * merchant's second offer, and a merchant with three good offers should still
 * see all three on the page.
 *
 * The result is §19's worked example exactly: A1, B1, C1, A2 rather than A1,
 * A2, A3, B1.
 */
function applyDiversity(ordered, rules) {
  const maxPerShop = rules.diversityMaxPerShop;
  const shopWindow = rules.diversityWindow;
  const maxPerCategory = rules.diversityMaxPerCategory;
  const categoryWindow = rules.diversityCategoryWindow;

  if (ordered.length <= 1 || maxPerShop <= 0) return ordered;

  const remaining = [...ordered];
  const result = [];

  const countIn = (window, accessor, value) =>
    window.filter((entry) => accessor(entry) === value).length;

  while (remaining.length) {
    const shopSlice = result.slice(-Math.max(0, shopWindow - 1));
    const categorySlice = result.slice(-Math.max(0, categoryWindow - 1));

    const fits = (entry) => {
      const shopId = Number(entry.row.shop_id);
      if (countIn(shopSlice, (e) => Number(e.row.shop_id), shopId) >= maxPerShop) return false;
      const categoryId = entry.row.category_id === null ? null : Number(entry.row.category_id);
      if (categoryId === null) return true;
      return countIn(categorySlice, (e) => (e.row.category_id === null ? null : Number(e.row.category_id)), categoryId) < maxPerCategory;
    };

    // `remaining` is already in score order, so the first that fits is the
    // best that fits - no second sort needed.
    const index = remaining.findIndex(fits);
    // Nothing fits: every candidate left belongs to a shop already filling the
    // window. Taking the best one anyway keeps the page full; the alternative
    // is a short page, which serves nobody.
    result.push(...remaining.splice(index === -1 ? 0 : index, 1));
  }

  return result;
}

// ---------------------------------------------------------------------------
// §18 - frequency control

/**
 * How often this customer has already been shown each listing (and each shop).
 *
 * Keyed on the user when there is one and the anonymous session otherwise,
 * because §18 says "per customer/session" and a guest has no user id. IP is
 * deliberately not a fallback - capping by IP caps an entire office or
 * household together, which is a worse failure than not capping a guest with
 * no session at all.
 */
async function impressionCounts(identity, limits, listings) {
  const emptyBuckets = () => ({ byListing: new Map(), byShop: new Map(), byCampaign: new Map() });
  const empty = { user: emptyBuckets(), session: emptyBuckets() };
  if (!listings.length) return empty;
  if (!identity?.userId && !identity?.sessionId) return empty;

  // One query over the widest window any active limit asks for, then counted
  // per-window in JS. Three queries with three windows would be three scans of
  // the same index for the same rows.
  const widest = limits.reduce((max, limit) => Math.max(max, limit.windowMinutes), 0);
  if (!widest) return empty;

  // §18 says "per customer/session", and `frequency_limits.applies_to` says
  // which one each limit means. They are genuinely different questions: a
  // signed-in customer on two devices is one customer and two sessions, and a
  // limit written for one must not be silently answered with the other.
  const conditions = [];
  const params = [];
  if (identity.userId) {
    conditions.push('user_id = ?');
    params.push(identity.userId);
  }
  if (identity.sessionId) {
    conditions.push('session_id = ?');
    params.push(identity.sessionId);
  }

  const rows = await rawQuery(
    `SELECT listing_type, listing_id, shop_id, featured_campaign_id, user_id, session_id, created_at
       FROM visibility_events
      WHERE (${conditions.join(' OR ')})
        AND event_type IN ('IMPRESSION','FEATURED_IMPRESSION')
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [...params, widest],
  );

  const counts = { user: emptyBuckets(), session: emptyBuckets() };
  const now = Date.now();

  for (const row of rows) {
    const ageMinutes = (now - new Date(row.created_at).getTime()) / 60000;
    const push = (buckets) => {
      const add = (map, key) => {
        const list = map.get(key) ?? [];
        list.push(ageMinutes);
        map.set(key, list);
      };
      add(buckets.byListing, `${row.listing_type}:${row.listing_id}`);
      if (row.shop_id) add(buckets.byShop, Number(row.shop_id));
      if (row.featured_campaign_id) add(buckets.byCampaign, Number(row.featured_campaign_id));
    };

    if (identity.userId && Number(row.user_id) === Number(identity.userId)) push(counts.user);
    if (identity.sessionId && row.session_id === identity.sessionId) push(counts.session);
  }

  // A limit written for a customer still has to hold for a guest, who has no
  // user id at all - otherwise signing out would remove every cap. So when
  // there is no user, the session's counts answer both.
  if (!identity.userId) counts.user = counts.session;
  return counts;
}

/** The buckets a limit is measured against, per its `applies_to`. */
const bucketsFor = (counts, limit) => counts[limit.appliesTo] ?? counts.user;

/** Whether a set of timestamped ages breaches a limit. */
const breaches = (ages, limit) =>
  (ages ?? []).filter((age) => age <= limit.windowMinutes).length >= limit.maxImpressions;

/**
 * Applies §18's caps by penalising, not hiding.
 *
 * §18's purpose is preventing customer fatigue. Removing a fatigued listing
 * outright would make a customer's feed shrink the more they used the app -
 * the more they browse, the less they are shown - which is a worse experience
 * than the repetition it was meant to fix. Penalising instead lets it sink
 * below fresher listings and reappear once the window rolls over.
 *
 * Featured content is subject to these controls, as §18 requires: campaign
 * placements carry their own scope and are capped more tightly by default.
 */
function applyFrequency(scored, limits, counts, rules) {
  if (!limits.length) return scored;

  const offerLimits = limits.filter((limit) => limit.scope === 'offer');
  const shopLimits = limits.filter((limit) => limit.scope === 'shop');

  return scored.map((entry) => {
    const key = `${entry.row.listing_type}:${entry.row.id}`;
    const shopId = Number(entry.row.shop_id);

    const fatigued =
      offerLimits.some((limit) => breaches(bucketsFor(counts, limit).byListing.get(key), limit)) ||
      shopLimits.some((limit) => breaches(bucketsFor(counts, limit).byShop.get(shopId), limit));

    if (!fatigued) return entry;
    return {
      ...entry,
      score: entry.score * (1 - rules.frequencyFatiguePenalty),
      fatigued: true,
    };
  });
}

/**
 * The featured half of §18: a campaign that has already been shown to this
 * customer too often this period is dropped from the slot entirely.
 *
 * Dropped rather than penalised, unlike organic results, because a Featured
 * slot has a handful of positions and there is always another eligible
 * campaign waiting for one (§10). A fatigued promotion that merely sank would
 * still occupy a position it no longer deserves.
 */
function filterFatiguedCampaigns(candidates, limits, counts) {
  const campaignLimits = limits.filter((limit) => limit.scope === 'campaign');
  if (!campaignLimits.length) return candidates;

  return candidates.filter((candidate) => {
    const id = Number(candidate.campaignId ?? candidate.id);
    return !campaignLimits.some((limit) =>
      breaches(bucketsFor(counts, limit).byCampaign.get(id), limit),
    );
  });
}

/** The limits that apply to one placement type (or to organic results). */
function limitsFor(allLimits, placementType = null) {
  return allLimits.filter(
    (limit) => limit.placementType === null || limit.placementType === placementType,
  );
}

module.exports = {
  bucketsFor,
  rotationJitter,
  bucketFor,
  applyRotation,
  recentExposure,
  applyDiversity,
  impressionCounts,
  applyFrequency,
  filterFatiguedCampaigns,
  limitsFor,
  SURFACES: vis.SURFACES,
};
