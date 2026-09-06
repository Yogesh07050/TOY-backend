'use strict';

/**
 * Visibility & Promotion System configuration (Visibility §4, §18, §22, §31).
 *
 * This file declares the *defaults* and the vocabulary; it is deliberately not
 * the source of truth at runtime. §4 requires that "weights must be
 * configurable from the backend rather than permanently hard-coded", so the
 * numbers here are seeded into `ranking_weights` / `visibility_rules` on
 * migration and read back through `services/visibility/weights.js`, which a
 * Super Admin can change without a deploy.
 *
 * Keeping the defaults in code anyway buys two things a config table cannot:
 * a fresh install ranks sensibly before anyone opens the admin screen, and a
 * row deleted or corrupted in the database falls back to a known-good value
 * instead of silently scoring 0.
 */

// ---------------------------------------------------------------------------
// Surfaces and placements

/**
 * Where ranking happens. Each surface gets its own weight set because the same
 * factor means different things in different places: distance decides Near Me
 * and barely matters in a text search, and §13 explicitly orders search by
 * relevance first while §14 starts from the customer's location.
 */
const SURFACES = {
  SEARCH: 'SEARCH',
  NEAR_ME: 'NEAR_ME',
  HOME: 'HOME',
  CATEGORY: 'CATEGORY',
  ENDING_SOON: 'ENDING_SOON',
};

const SURFACE_KEYS = Object.keys(SURFACES);

/** Promotional spaces (§6, §11). Featured content is always one of these. */
const PLACEMENT_TYPES = {
  HOME_FEATURED: 'HOME_FEATURED',
  CATEGORY_FEATURED: 'CATEGORY_FEATURED',
  NEAR_ME_FEATURED: 'NEAR_ME_FEATURED',
  SEASONAL_CAMPAIGN: 'SEASONAL_CAMPAIGN',
  ENDING_SOON_FEATURED: 'ENDING_SOON_FEATURED',
};

const PLACEMENT_TYPE_KEYS = Object.keys(PLACEMENT_TYPES);

/** Which surface a placement decorates, so one lookup serves both rails. */
const SURFACE_FOR_PLACEMENT = {
  HOME_FEATURED: SURFACES.HOME,
  CATEGORY_FEATURED: SURFACES.CATEGORY,
  NEAR_ME_FEATURED: SURFACES.NEAR_ME,
  SEASONAL_CAMPAIGN: SURFACES.HOME,
  ENDING_SOON_FEATURED: SURFACES.ENDING_SOON,
};

// ---------------------------------------------------------------------------
// Visibility levels (§2.5, §5)

/**
 * §5 is explicit that subscription is "one ranking factor, not an absolute
 * ordering rule", so a level is a *score contribution*, never a sort key. The
 * numbers below are what the SUBSCRIPTION factor scores before its weight is
 * applied; the weight itself is what keeps a Premium listing from outranking a
 * far more relevant Free one (§3, §21).
 */
const VISIBILITY_LEVELS = {
  BASIC: { key: 'BASIC', rank: 0, score: 0, label: 'Basic' },
  ENHANCED: { key: 'ENHANCED', rank: 1, score: 0.55, label: 'Enhanced' },
  PRIORITY: { key: 'PRIORITY', rank: 2, score: 1, label: 'Priority' },
};

const LEVEL_FOR_PLAN = { FREE: 'BASIC', BUSINESS: 'ENHANCED', PREMIUM: 'PRIORITY' };
const LEVEL_BY_RANK = ['BASIC', 'ENHANCED', 'PRIORITY'];

/**
 * §21: the merchant-facing wording is fixed here rather than left to each
 * screen, because the one thing the platform must never say is "guaranteed
 * #1" - and a promise like that is only ever one hurried UI copy edit away.
 *
 * `VISIBILITY_PROMISE` is §21's text verbatim, which is written for Premium. It
 * is the right thing to show on a pricing or upgrade screen, where Premium is
 * what is being described.
 *
 * It is the wrong thing to show a merchant who is *on* Business: telling them
 * "your Premium plan increases your eligibility" is simply false, and a
 * merchant who reads it either thinks they are paying for something they are
 * not, or stops believing the rest of the screen. So anywhere a shop is known,
 * `promiseFor(level)` is served instead. The disclaimer is common to all three:
 * the thing that must never be promised must never be promised at any tier.
 */
const DISCLAIMER =
  'Priority visibility is an opportunity, not a guaranteed position. Highly relevant nearby ' +
  'listings can rank above promoted ones.';

const VISIBILITY_PROMISE = {
  headline: 'Premium gives your shop priority visibility across relevant discovery areas.',
  explanation:
    'Your Premium plan increases your eligibility for prominent discovery. Actual placement is ' +
    'dynamically optimized based on customer location, relevance, freshness, engagement and ' +
    'marketplace fairness.',
  disclaimer: DISCLAIMER,
};

const PROMISE_BY_LEVEL = {
  PRIORITY: VISIBILITY_PROMISE,
  ENHANCED: {
    headline: 'Business gives your shop enhanced visibility across relevant discovery areas.',
    explanation:
      'Your Business plan increases your eligibility for prominent discovery. Actual placement is ' +
      'dynamically optimized based on customer location, relevance, freshness, engagement and ' +
      'marketplace fairness.',
    disclaimer: DISCLAIMER,
  },
  BASIC: {
    headline: 'Your offers appear in search, Near Me and category browsing.',
    explanation:
      'Placement is decided by how relevant and how near your offer is to each customer, how ' +
      'complete it is, and how people engage with it. A paid plan increases your eligibility for ' +
      'prominent discovery; it does not replace those factors.',
    disclaimer: DISCLAIMER,
  },
};

/** The wording for a merchant actually on this level. */
const promiseFor = (level) => PROMISE_BY_LEVEL[level] ?? PROMISE_BY_LEVEL.BASIC;

// ---------------------------------------------------------------------------
// Ranking factors (§4)

const FACTORS = {
  RELEVANCE: 'RELEVANCE',
  DISTANCE: 'DISTANCE',
  FRESHNESS: 'FRESHNESS',
  ENGAGEMENT: 'ENGAGEMENT',
  OFFER_QUALITY: 'OFFER_QUALITY',
  SUBSCRIPTION: 'SUBSCRIPTION',
  CUSTOMER_PREFERENCE: 'CUSTOMER_PREFERENCE',
  AVAILABILITY: 'AVAILABILITY',
  PLACEMENT: 'PLACEMENT',
};

const FACTOR_KEYS = Object.keys(FACTORS);

const FACTOR_LABELS = {
  RELEVANCE: 'Relevance',
  DISTANCE: 'Distance',
  FRESHNESS: 'Freshness',
  ENGAGEMENT: 'Engagement',
  OFFER_QUALITY: 'Offer quality',
  SUBSCRIPTION: 'Subscription priority',
  CUSTOMER_PREFERENCE: 'Customer preference',
  AVAILABILITY: 'Availability',
  PLACEMENT: 'Placement eligibility',
};

/**
 * Default weights per surface, following §13's recommended search priority
 * (relevance, location, validity, preference, quality, engagement,
 * subscription, freshness) and §14's location-first Near Me flow.
 *
 * Two properties are deliberate and worth preserving through any retune:
 *
 *   - SUBSCRIPTION is never the largest weight on any surface. §26 says the
 *     customer must not feel "the shop with the most expensive plan is always
 *     shown first", and the only way to guarantee that is to make it
 *     arithmetically impossible for the plan alone to win.
 *   - RELEVANCE + DISTANCE together always outweigh SUBSCRIPTION + PLACEMENT,
 *     which is what makes §5's worked example true: a Free offer 500 m away
 *     can beat a Premium one 5 km away.
 */
const DEFAULT_WEIGHTS = {
  SEARCH: {
    RELEVANCE: 3.0,
    DISTANCE: 1.6,
    FRESHNESS: 0.5,
    ENGAGEMENT: 0.8,
    OFFER_QUALITY: 1.0,
    SUBSCRIPTION: 0.7,
    CUSTOMER_PREFERENCE: 1.2,
    AVAILABILITY: 1.4,
    PLACEMENT: 0.4,
  },
  NEAR_ME: {
    RELEVANCE: 1.2,
    DISTANCE: 3.0,
    FRESHNESS: 0.6,
    ENGAGEMENT: 0.9,
    OFFER_QUALITY: 1.0,
    SUBSCRIPTION: 0.9,
    CUSTOMER_PREFERENCE: 1.0,
    AVAILABILITY: 1.4,
    PLACEMENT: 0.5,
  },
  HOME: {
    RELEVANCE: 1.0,
    DISTANCE: 1.8,
    FRESHNESS: 1.2,
    ENGAGEMENT: 1.1,
    OFFER_QUALITY: 1.1,
    // 0.8, not 0.9. At 0.9 a Premium listing 5 km away edged out a Free one
    // 500 m away on this surface - §5's worked example, inverted. The home
    // feed is the least location-specific surface there is, which is exactly
    // why its distance weight needs the most protection.
    SUBSCRIPTION: 0.8,
    CUSTOMER_PREFERENCE: 1.6,
    AVAILABILITY: 1.4,
    PLACEMENT: 0.6,
  },
  CATEGORY: {
    RELEVANCE: 2.0,
    DISTANCE: 1.8,
    FRESHNESS: 0.8,
    ENGAGEMENT: 1.0,
    OFFER_QUALITY: 1.1,
    SUBSCRIPTION: 0.8,
    CUSTOMER_PREFERENCE: 1.2,
    AVAILABILITY: 1.4,
    PLACEMENT: 0.5,
  },
  // §12: the section exists because an offer is about to disappear, so time
  // remaining dominates - but only among listings that are already eligible.
  ENDING_SOON: {
    RELEVANCE: 1.0,
    DISTANCE: 1.6,
    FRESHNESS: 0.2,
    ENGAGEMENT: 0.8,
    OFFER_QUALITY: 0.9,
    SUBSCRIPTION: 0.7,
    CUSTOMER_PREFERENCE: 0.9,
    AVAILABILITY: 3.0,
    PLACEMENT: 0.4,
  },
};

// ---------------------------------------------------------------------------
// Tunable rules (§2.3, §2.6, §10, §18, §19)

/**
 * Everything the scorer needs that is not a weight: the shape of each decay
 * curve and the fairness limits. Stored in `visibility_rules` as one row per
 * key so a Super Admin can retune the curve as well as the weight - halving
 * `freshnessHalfLifeDays` is a very different change from halving the
 * FRESHNESS weight, and §22 asks for both.
 */
const DEFAULT_RULES = {
  // §2.3 "advantage should gradually reduce over time". An exponential half
  // life rather than a cliff: a 3-day-old offer keeps ~50% of its boost, a
  // 9-day-old one ~12%, and nothing ever jumps when a threshold is crossed.
  freshnessHalfLifeDays: 3,
  // Beyond this an offer counts as not fresh at all, so the curve's long tail
  // does not keep a stale listing marginally ahead of a new one forever.
  freshnessMaxDays: 30,

  // §2.2. Distance scores 1 / (1 + km/decay): 1.0 at the door, 0.5 at the
  // decay distance, and still non-zero far out, so a distant listing is
  // penalised rather than excluded.
  distanceDecayKm: 3,
  // What an unlocatable listing (online-only, or a branch with no pin) scores.
  // Not 0 - that would bury every online offer - and not high enough to beat a
  // real nearby shop.
  distanceUnknownScore: 0.35,
  // §24: Near Me must not rank a listing whose location is invalid, so on that
  // surface an unknown distance is excluded outright instead of scored.
  nearMeRequiresLocation: true,
  defaultRadiusKm: 15,
  maxRadiusKm: 100,

  // §2.4 / §4: "raw impressions alone should not create a large ranking
  // advantage". Impressions are counted at a tenth of a view, and verified
  // redemptions - "a particularly strong quality signal" - at fifty times one.
  engagementWeights: {
    impressions: 0.1,
    views: 1,
    saves: 4,
    claims: 10,
    redemptions: 50,
    searchClicks: 2,
    profileViews: 2,
    directionsClicks: 6,
  },
  // How much of a listing's impression volume can count, expressed as a
  // multiple of the engagement it actually produced. 1 means "impressions may
  // contribute at most as much as views, saves, claims and redemptions
  // combined" - so a listing shown fifty thousand times that nobody ever
  // opened scores nothing for the reach.
  engagementImpressionCapRatio: 1,
  // The engagement score is log-scaled against this: a listing hitting the
  // saturation point scores ~1, so a runaway hit cannot crowd out an entire
  // category the way a linear count would.
  engagementSaturation: 400,
  // How far back engagement is counted. A listing that did well last quarter
  // should not coast on it.
  engagementWindowDays: 30,

  // §4: the completeness checklist. Each present item contributes its share of
  // a 0-1 score; the weights say which omissions actually hurt a customer.
  qualityWeights: {
    title: 1,
    description: 1,
    discountValue: 1.5,
    image: 2,
    category: 1,
    location: 1.5,
    validDates: 1,
    shopProfile: 1,
  },
  // A brand-new listing has no engagement history, which would otherwise mean
  // nothing new can ever rank. It is scored at this until it has data.
  coldStartEngagementScore: 0.25,

  // §16's "visibility by location" needs a coarse place name for the customer,
  // and neither the app nor the web client knows one - a device fix is a pair of
  // coordinates, not a city. Reverse geocoding every impression is not an option
  // (the provider allows about one request a second), so the city of the nearest
  // branch the customer was actually shown stands in for it.
  //
  // Only within this radius. Beyond it the nearest shop says nothing about where
  // the customer is, and labelling someone 60 km away with that city would put a
  // confident wrong answer in front of a merchant - worse than the blank it
  // replaces. Outside the radius the impression keeps its coordinates and no city.
  cityAttributionRadiusKm: 25,

  // §9's "required promotional content is complete", as a quality threshold.
  // Below this a listing is not considered fit for a prominent position, no
  // matter what its shop is paying.
  placementQualityFloor: 0.6,

  // §19. No more than this many listings from one shop inside any window of
  // `diversityWindow` consecutive results, so a merchant cannot own the fold.
  diversityMaxPerShop: 1,
  diversityWindow: 3,
  // Category diversity is looser: a clothing search legitimately returns
  // clothing, so this only stops one subcategory filling the first screen.
  diversityMaxPerCategory: 4,
  diversityCategoryWindow: 8,

  // §10, §28. Scores this close together count as a tie, and ties are rotated
  // rather than settled by id - which is what stops "Shop A -> #1 forever".
  rotationTieBand: 0.04,
  // How long one rotation bucket lasts. Every listing in a tie band keeps its
  // order for this long, then the band re-shuffles: long enough that a
  // customer scrolling does not see results dance, short enough that exposure
  // actually circulates.
  rotationBucketMinutes: 15,
  // How much recent prominent exposure costs a listing, at most, in score.
  // Applied only inside a tie band, so rotation can never override relevance.
  rotationExposurePenalty: 0.03,
  rotationExposureWindowHours: 24,

  // §18. Defaults; per-scope rows in `frequency_limits` override these.
  frequencySameOfferImpressions: 6,
  frequencySameShopImpressions: 10,
  frequencyWindowMinutes: 1440,
  // Rather than hiding a fatigued listing completely - which would make a
  // customer's feed shrink the more they use the app - it loses this fraction
  // of its score and falls down the page naturally.
  frequencyFatiguePenalty: 0.5,

  // §25. A single account or device producing more than this many countable
  // events on one listing inside the window is inflating a signal, not using
  // the app; the excess is dropped from ranking aggregates.
  antiManipulationMaxEventsPerUserPerListing: 20,
  antiManipulationWindowHours: 24,
  // Ranking engagement counts distinct customers as well as raw events, and
  // blends them at this ratio. 100 views from 100 people and 100 views from
  // one person should not score the same.
  antiManipulationDistinctWeight: 0.5,

  // §33. How long a resolved weight/rule set is cached in-process. Short: a
  // Super Admin retuning weights wants to see the effect, not wait a shift.
  configCacheSeconds: 60,
  // How many candidates the scorer pulls per requested result. Scoring happens
  // in JS over a bounded pool, so this is the trade between ranking quality
  // and query cost.
  candidateOverfetch: 6,
  candidatePoolMax: 400,
};

// ---------------------------------------------------------------------------
// Featured slots (§9, §10, §11)

/**
 * The slots a fresh install starts with. `capacity` is how many campaigns may
 * occupy the slot at once - the rest of the eligible pool rotates through it
 * (§10), which is the mechanism behind "prefer A, B, C, A" over "A, A, A, A".
 */
const DEFAULT_SLOTS = [
  {
    code: 'HOME_FEATURED',
    placementType: PLACEMENT_TYPES.HOME_FEATURED,
    name: 'Home Featured',
    description: 'Prominent promotional area on the home page.',
    capacity: 5,
    minPlanRank: 2,
  },
  {
    code: 'CATEGORY_FEATURED',
    placementType: PLACEMENT_TYPES.CATEGORY_FEATURED,
    name: 'Category Featured',
    description: 'Featured listings inside a category.',
    capacity: 4,
    minPlanRank: 2,
  },
  {
    code: 'NEAR_ME_FEATURED',
    placementType: PLACEMENT_TYPES.NEAR_ME_FEATURED,
    name: 'Near Me Featured',
    description: 'Promotional listings relevant to the customer location.',
    capacity: 4,
    minPlanRank: 2,
  },
  {
    code: 'SEASONAL_CAMPAIGN',
    placementType: PLACEMENT_TYPES.SEASONAL_CAMPAIGN,
    name: 'Seasonal Campaign',
    description: 'Diwali, Christmas, New Year, Pongal, Weekend Sale.',
    capacity: 6,
    minPlanRank: 2,
  },
  {
    code: 'ENDING_SOON_FEATURED',
    placementType: PLACEMENT_TYPES.ENDING_SOON_FEATURED,
    name: 'Ending Soon Featured',
    description: 'Dedicated visibility for offers approaching expiry.',
    capacity: 4,
    // §12 makes Ending Soon a Business *and* Premium placement, unlike the
    // Premium-only featured spaces above.
    minPlanRank: 1,
  },
];

/** §18's starting limits, one row per scope. */
const DEFAULT_FREQUENCY_LIMITS = [
  {
    scope: 'offer',
    placementType: null,
    appliesTo: 'user',
    maxImpressions: DEFAULT_RULES.frequencySameOfferImpressions,
    windowMinutes: DEFAULT_RULES.frequencyWindowMinutes,
  },
  {
    scope: 'shop',
    placementType: null,
    appliesTo: 'user',
    maxImpressions: DEFAULT_RULES.frequencySameShopImpressions,
    windowMinutes: DEFAULT_RULES.frequencyWindowMinutes,
  },
  // §18: "Featured content should be subject to these controls" - and more
  // tightly, because a promoted card is the most fatiguing thing on the page.
  {
    scope: 'campaign',
    placementType: null,
    appliesTo: 'user',
    maxImpressions: 4,
    windowMinutes: DEFAULT_RULES.frequencyWindowMinutes,
  },
];

// ---------------------------------------------------------------------------
// Events (§32)

/**
 * The visibility event vocabulary. These are separate from
 * `services/analyticsEvents.js`: that stream answers "how is my shop doing",
 * this one answers "where was this listing shown, in what position, and did it
 * work" - which needs surface, placement and rank on every row, and feeds
 * ranking as well as reporting (§32).
 */
const EVENT_TYPES = {
  IMPRESSION: 'IMPRESSION',
  VIEW: 'VIEW',
  SAVE: 'SAVE',
  CLAIM: 'CLAIM',
  REDEMPTION: 'REDEMPTION',
  SEARCH_CLICK: 'SEARCH_CLICK',
  PROFILE_VIEW: 'PROFILE_VIEW',
  DIRECTIONS_CLICK: 'DIRECTIONS_CLICK',
  FEATURED_IMPRESSION: 'FEATURED_IMPRESSION',
  FEATURED_CLICK: 'FEATURED_CLICK',
};

const EVENT_TYPE_KEYS = Object.keys(EVENT_TYPES);

/**
 * Events a client may post. Every one of these is something only the customer's
 * device witnesses. REDEMPTION is absent on purpose: it is the strongest
 * ranking signal there is (§2.4), so it is only ever written server-side by the
 * redemption flow, where a merchant has actually verified a code (§24).
 */
const CLIENT_EVENT_TYPES = [
  EVENT_TYPES.IMPRESSION,
  EVENT_TYPES.VIEW,
  EVENT_TYPES.SEARCH_CLICK,
  EVENT_TYPES.PROFILE_VIEW,
  EVENT_TYPES.DIRECTIONS_CLICK,
  EVENT_TYPES.FEATURED_IMPRESSION,
  EVENT_TYPES.FEATURED_CLICK,
];

/** Which engagement bucket each event feeds when ranking (§2.4). */
const EVENT_SIGNAL = {
  IMPRESSION: 'impressions',
  FEATURED_IMPRESSION: 'impressions',
  VIEW: 'views',
  SAVE: 'saves',
  CLAIM: 'claims',
  REDEMPTION: 'redemptions',
  SEARCH_CLICK: 'searchClicks',
  FEATURED_CLICK: 'searchClicks',
  PROFILE_VIEW: 'profileViews',
  DIRECTIONS_CLICK: 'directionsClicks',
};

/** Listing kinds the visibility system can rank and promote. */
const LISTING_TYPES = { OFFER: 'offer', SERVICE_OFFER: 'service_offer', SHOP: 'shop' };

const CAMPAIGN_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'active',
  'paused',
  'completed',
  'rejected',
  'archived',
];

module.exports = {
  SURFACES,
  SURFACE_KEYS,
  PLACEMENT_TYPES,
  PLACEMENT_TYPE_KEYS,
  SURFACE_FOR_PLACEMENT,
  VISIBILITY_LEVELS,
  LEVEL_FOR_PLAN,
  LEVEL_BY_RANK,
  VISIBILITY_PROMISE,
  PROMISE_BY_LEVEL,
  promiseFor,
  FACTORS,
  FACTOR_KEYS,
  FACTOR_LABELS,
  DEFAULT_WEIGHTS,
  DEFAULT_RULES,
  DEFAULT_SLOTS,
  DEFAULT_FREQUENCY_LIMITS,
  EVENT_TYPES,
  EVENT_TYPE_KEYS,
  CLIENT_EVENT_TYPES,
  EVENT_SIGNAL,
  LISTING_TYPES,
  CAMPAIGN_STATUSES,
};
