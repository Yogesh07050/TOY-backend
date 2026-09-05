'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const vis = require('../../src/config/visibility');
const ranking = require('../../src/services/visibility/ranking.service');
const fairness = require('../../src/services/visibility/fairness');
const signals = require('../../src/services/visibility/signals.service');
const placements = require('../../src/services/visibility/featuredPlacement.service');

/**
 * The Visibility & Promotion System's promises, as tests.
 *
 * These are not unit tests of convenience - each one pins a sentence from the
 * specification that is expensive to get wrong and easy to break by retuning a
 * weight. §5's worked example in particular is a promise to customers about
 * what the marketplace is; a weight change that quietly inverts it should fail
 * here rather than in a merchant's complaint six weeks later.
 */

const rules = vis.DEFAULT_RULES;
const now = Date.now();

const entitlements = new Map([
  [1, { subscriptionScore: 0, featuredAccess: false, endingSoonEligible: false }],   // Free
  [2, { subscriptionScore: vis.VISIBILITY_LEVELS.PRIORITY.score, featuredAccess: true, endingSoonEligible: true } ], // Premium
  [3, { subscriptionScore: vis.VISIBILITY_LEVELS.ENHANCED.score, featuredAccess: false, endingSoonEligible: true }], // Business
]);

const listing = (overrides = {}) => ({
  id: 1,
  shop_id: 1,
  listing_type: 'offer',
  title: 'Kids School Shoes 30% Off',
  shop_name: 'Sri Shoes',
  category_name: 'Footwear',
  category_id: 7,
  subcategory_id: null,
  description: 'Genuine leather school shoes for children, all sizes available.',
  offer_text: '30% OFF',
  image_url: 'shoes.jpg',
  discount_type: 'percentage',
  discount_value: 30,
  distance_km: 0.5,
  created_at: new Date(now - 2 * 86400000),
  updated_at: new Date(now - 2 * 86400000),
  end_date: new Date(now + 10 * 86400000),
  quality_score: 0.8,
  engagement_score: 0.5,
  has_scores: 1,
  total_claim_limit: null,
  claims_used: 0,
  is_saved: 0,
  ...overrides,
});

const contextFor = (surface, search = null) => ({
  surface,
  now,
  queryTokens: ranking.tokenize(search),
  categoryId: 7,
  entitlements,
});

const scoreOn = (surface, candidate, search = null) =>
  ranking.scoreCandidate(candidate, contextFor(surface, search), vis.DEFAULT_WEIGHTS[surface], rules)
    .score;

// ---------------------------------------------------------------------------

test('§5: a relevant Free offer 500 m away outranks a Premium offer 5 km away', () => {
  const free = listing({ id: 1, shop_id: 1, distance_km: 0.5 });
  const premium = listing({ id: 2, shop_id: 2, distance_km: 5 });

  // Every surface except Ending Soon, which is not a general discovery
  // surface: §12 makes it a Business-and-Premium section, so a Free listing is
  // not ranked lower there, it is not in the section at all. Its own case is
  // below.
  for (const surface of vis.SURFACE_KEYS.filter((key) => key !== vis.SURFACES.ENDING_SOON)) {
    const search = surface === vis.SURFACES.SEARCH ? 'school shoes' : null;
    assert.ok(
      scoreOn(surface, free, search) > scoreOn(surface, premium, search),
      `${surface}: the nearer Free listing must win - §5 and §26 both depend on it`,
    );
  }
});

test('§5 + §12: inside Ending Soon, a nearer Business offer beats a distant Premium one', () => {
  // Both shops are eligible for the section, so the comparison is the one §5
  // is actually about: does paying more buy a position that distance cannot?
  const business = listing({ id: 3, shop_id: 3, distance_km: 0.5 });
  const premium = listing({ id: 2, shop_id: 2, distance_km: 5 });

  assert.ok(scoreOn(vis.SURFACES.ENDING_SOON, business) > scoreOn(vis.SURFACES.ENDING_SOON, premium));
});

test('§12: a Free shop is not eligible for Ending Soon at all', () => {
  const free = listing({ id: 1, shop_id: 1 });
  assert.equal(
    ranking.placementScore(free, contextFor(vis.SURFACES.ENDING_SOON), rules),
    0,
    'eligibility here is a subscription rule, not a score - §12 says Business and Premium',
  );
});

test('§2.5: at equal relevance and distance, the paid plan wins', () => {
  const free = listing({ id: 1, shop_id: 1 });
  const premium = listing({ id: 2, shop_id: 2 });
  const business = listing({ id: 3, shop_id: 3 });

  const near = vis.SURFACES.NEAR_ME;
  assert.ok(scoreOn(near, premium) > scoreOn(near, business));
  assert.ok(scoreOn(near, business) > scoreOn(near, free));
});

test('§26: no surface lets subscription outweigh relevance and distance together', () => {
  for (const surface of vis.SURFACE_KEYS) {
    const weights = vis.DEFAULT_WEIGHTS[surface];
    assert.ok(
      weights.SUBSCRIPTION < weights.RELEVANCE + weights.DISTANCE,
      `${surface}: subscription must never be able to beat relevance plus distance`,
    );
    assert.ok(
      weights.SUBSCRIPTION < Math.max(...Object.values(weights)),
      `${surface}: subscription must never be the largest weight`,
    );
  }
});

test('§13: search weights follow the recommended priority order', () => {
  const weights = vis.DEFAULT_WEIGHTS.SEARCH;
  // 1 relevance, 2 location, 3 validity, 4 customer preference, 5 offer
  // quality, 6 engagement, 7 subscription, 8 freshness.
  const order = [
    'RELEVANCE',
    'DISTANCE',
    'AVAILABILITY',
    'CUSTOMER_PREFERENCE',
    'OFFER_QUALITY',
    'ENGAGEMENT',
    'SUBSCRIPTION',
    'FRESHNESS',
  ];
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(
      weights[order[index - 1]] >= weights[order[index]],
      `${order[index - 1]} must weigh at least as much as ${order[index]}`,
    );
  }
});

test('§2.3: freshness decays smoothly and expires', () => {
  const at = (days) => ranking.freshnessScore(listing({ created_at: new Date(now - days * 86400000), updated_at: new Date(now - days * 86400000) }), rules, now);

  assert.equal(at(0), 1);
  assert.ok(Math.abs(at(rules.freshnessHalfLifeDays) - 0.5) < 0.001, 'half the boost at the half life');
  assert.equal(at(rules.freshnessMaxDays), 0, 'no advantage at all beyond the window');
  // Monotonic: no age is ever fresher than a younger one.
  for (let day = 1; day <= 20; day += 1) assert.ok(at(day) < at(day - 1));
});

test('§2.4: raw impressions alone earn nothing', () => {
  const impressionsOnly = signals.engagementFrom(
    { impressions: 50000, totalEvents: 50000, distinctUsers: 40000 },
    rules,
  );
  assert.equal(impressionsOnly, 0, 'reach with no engagement is not engagement');

  const withRedemptions = signals.engagementFrom(
    { impressions: 500, views: 60, claims: 6, redemptions: 3, totalEvents: 570, distinctUsers: 500 },
    rules,
  );
  assert.ok(withRedemptions > 0.5, 'verified redemptions are the strong signal §2.4 calls them');
});

test('§25: engagement concentrated in one account is discounted', () => {
  const counts = { views: 100, saves: 10, totalEvents: 110 };
  const spread = signals.engagementFrom({ ...counts, distinctUsers: 100 }, rules);
  const concentrated = signals.engagementFrom({ ...counts, distinctUsers: 2 }, rules);
  assert.ok(concentrated < spread, 'the same events from one device must count for less');
});

test('§19: consecutive results are not filled by one shop', () => {
  const entry = (shopId, id, score) => ({ row: { shop_id: shopId, id, listing_type: 'offer', category_id: null }, score });
  const ordered = fairness.applyDiversity(
    [entry(1, 11, 0.9), entry(1, 12, 0.89), entry(1, 13, 0.88), entry(2, 21, 0.87), entry(3, 31, 0.86)],
    rules,
  );

  assert.deepEqual(
    ordered.map((item) => item.row.id),
    [11, 21, 31, 12, 13],
    'expected §19\'s preferred A1, B1, C1, A2 shape',
  );
  assert.equal(ordered.length, 5, 'diversity reorders, it never drops results');
});

test('§19: a page with only one shop is not emptied by the diversity rule', () => {
  const entry = (id, score) => ({ row: { shop_id: 1, id, listing_type: 'offer', category_id: null }, score });
  assert.equal(fairness.applyDiversity([entry(1, 0.9), entry(2, 0.8), entry(3, 0.7)], rules).length, 3);
});

test('§28: close scores rotate, distant scores do not', () => {
  const entry = (id, score) => ({ row: { id, listing_type: 'offer' }, score });

  // A gap far wider than the tie band must survive rotation untouched.
  const clear = fairness.applyRotation([entry(1, 0.9), entry(2, 0.4)], rules);
  assert.deepEqual(clear.map((item) => item.row.id), [1, 2]);

  // Within the band, order depends on the bucket - which is what makes
  // "Shop A -> #1 forever" impossible.
  const bucketOne = fairness.rotationJitter('offer:7', 100);
  const bucketTwo = fairness.rotationJitter('offer:7', 101);
  assert.notEqual(bucketOne, bucketTwo, 'a new bucket must reshuffle the band');
  assert.equal(bucketOne, fairness.rotationJitter('offer:7', 100), 'stable inside one bucket');
});

test('§10: the campaign rotation serves the least-exposed campaign first', () => {
  // All live for the same 10 hours, so the only thing separating them is how
  // often each has been served.
  const startedAt = new Date(now - 10 * 3600000);
  const campaign = (id, exposures, shownHoursAgo) => ({
    id,
    priority: 0,
    start_at: startedAt,
    exposure_count: exposures,
    last_shown_at: shownHoursAgo === null ? null : new Date(now - shownHoursAgo * 3600000),
  });

  assert.deepEqual(
    placements
      .rotate([campaign(1, 30, 1), campaign(2, 10, 5), campaign(3, 0, null), campaign(4, 20, 3)], rules, now)
      .map((entry) => entry.id),
    [3, 2, 4, 1],
    'never shown first, then least exposed - §10\'s A B C A instead of A A A A',
  );
});

test('§10: serving a campaign moves it behind the one it just overtook', () => {
  // The property that actually produces rotation: two equal campaigns, one
  // served once. The other must be next. Without this, a slot with one
  // position hands it to the same merchant on every request.
  const startedAt = new Date(now - 4 * 3600000);
  const served = { id: 1, priority: 0, start_at: startedAt, exposure_count: 1, last_shown_at: new Date(now) };
  const waiting = { id: 2, priority: 0, start_at: startedAt, exposure_count: 0, last_shown_at: null };

  assert.equal(placements.rotate([served, waiting], rules, now)[0].id, 2);
});

test('§10: a long-running campaign is not starved by a brand-new one', () => {
  // Both have been served at the same *rate*; the older one simply has more
  // total exposures. A raw count would put the new campaign first forever.
  const veteran = {
    id: 1,
    priority: 0,
    start_at: new Date(now - 100 * 3600000),
    exposure_count: 100,
    last_shown_at: new Date(now - 3600000),
  };
  const newcomer = {
    id: 2,
    priority: 0,
    start_at: new Date(now - 10 * 3600000),
    exposure_count: 10,
    last_shown_at: new Date(now - 2 * 3600000),
  };

  // Equal rates, so the tie falls to who was shown longer ago - the newcomer -
  // rather than to whoever happens to be younger.
  assert.equal(placements.rotate([veteran, newcomer], rules, now)[0].id, 2);
});

test('§12: Ending Soon ranks by urgency, and elsewhere urgency is not a virtue', () => {
  const soon = listing({ end_date: new Date(now + 2 * 3600000) });
  const later = listing({ end_date: new Date(now + 60 * 3600000) });

  const ending = contextFor(vis.SURFACES.ENDING_SOON);
  ending.withinHours = 72;
  assert.ok(
    ranking.availabilityScore(soon, ending, now) > ranking.availabilityScore(later, ending, now),
    'in the Ending Soon section, less time remaining ranks higher',
  );

  const nearMe = contextFor(vis.SURFACES.NEAR_ME);
  assert.ok(
    ranking.availabilityScore(later, nearMe, now) > ranking.availabilityScore(soon, nearMe, now),
    'everywhere else, an offer with time left is the more useful one',
  );
});

test('§24: a fully claimed offer stops competing', () => {
  const exhausted = listing({ total_claim_limit: 100, claims_used: 100 });
  assert.equal(ranking.availabilityScore(exhausted, contextFor(vis.SURFACES.NEAR_ME), now), 0);
});

test('§4: PLACEMENT measures the listing, not the plan', () => {
  const context = contextFor(vis.SURFACES.NEAR_ME);
  const complete = listing({ shop_id: 1, image_url: 'x.jpg', quality_score: 0.9 });
  const noImage = listing({ shop_id: 2, image_url: null, quality_score: 0.9 });

  // The Free shop's complete listing beats the Premium shop's incomplete one.
  assert.ok(ranking.placementScore(complete, context, rules) > ranking.placementScore(noImage, context, rules));
});

test('§2.2: distance is a penalty, never an exclusion', () => {
  const far = ranking.distanceScore(listing({ distance_km: 50 }), {}, rules);
  assert.ok(far > 0, 'a distant listing is penalised, not removed - §5 needs it still rankable');
  assert.ok(far < ranking.distanceScore(listing({ distance_km: 1 }), {}, rules));

  const unknown = ranking.distanceScore(listing({ distance_km: null }), {}, rules);
  assert.ok(unknown > 0 && unknown < 1, 'an online-only listing is neither buried nor favoured');
});

test('§32: the strongest ranking signals are not client-postable', () => {
  for (const event of ['SAVE', 'CLAIM', 'REDEMPTION']) {
    assert.ok(
      !vis.CLIENT_EVENT_TYPES.includes(vis.EVENT_TYPES[event]),
      `${event} must be server-recorded only - §25 makes it a manipulation target`,
    );
  }
});

test('§21: nothing in the merchant-facing wording promises a position', () => {
  const text = Object.values(vis.VISIBILITY_PROMISE).join(' ').toLowerCase();
  for (const forbidden of ['guaranteed #1', 'always first', 'top position guaranteed', 'guaranteed first']) {
    assert.ok(!text.includes(forbidden), `the promise must never contain "${forbidden}"`);
  }
  assert.ok(text.includes('priority'), 'it should still say what the plan does buy');
});
