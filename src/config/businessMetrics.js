'use strict';

const events = require('../services/analyticsEvents');

/**
 * Definitions behind the Business Dashboard (Business §5-§26).
 *
 * The requirements say the same thing in five different places: "the exact
 * definition should be configurable and consistently used" (§11.1), "the
 * dashboard must clearly define which claims are counted as eligible" (§10),
 * "use a clearly defined eligibility window" (§19), "retention rules must be
 * consistent and documented" (§16), "do not mix the definitions" (§26).
 *
 * So every one of those decisions is declared here, once, and the API serves
 * this file to the dashboard alongside the numbers - which is what lets a card
 * show what it actually counted rather than leaving the reader to guess.
 *
 * Nothing here is a display string; labels live with the metrics they annotate.
 */

const { EVENT_TYPES } = events;

// ---------------------------------------------------------------------------
// §5.1 / §6 - what makes a customer "active"
// ---------------------------------------------------------------------------

/**
 * The generic events that count as meaningful customer activity.
 *
 * §5.1 lists App Open, Website Visit, Offer View, Service View, Search, Map
 * Use, Claim and Save. Offer views, claims and saves have dedicated tables
 * (`offer_views`, `offer_claims`, `favorites`) and are unioned in by the query
 * rather than named here; this list covers what lands in `analytics_events`.
 *
 * Deliberately excluded: impressions. An impression is the app deciding to
 * draw a card, not the customer deciding to look at one - counting it would
 * make DAU a measure of how many rails a screen renders.
 */
const ACTIVE_USER_EVENTS = [
  EVENT_TYPES.APP_OPEN,
  EVENT_TYPES.WEB_VISIT,
  EVENT_TYPES.MAP_USE,
  EVENT_TYPES.SEARCH,
  EVENT_TYPES.CATEGORY_VIEW,
  EVENT_TYPES.SHOP_VIEW,
  EVENT_TYPES.LOCATION_SEARCH,
  EVENT_TYPES.NEARBY_OFFER_VIEW,
  EVENT_TYPES.SERVICE_VIEW,
  EVENT_TYPES.SERVICE_SAVE,
  EVENT_TYPES.SERVICE_ENQUIRE,
  EVENT_TYPES.SERVICE_BOOK,
  EVENT_TYPES.SERVICE_CLAIM,
  EVENT_TYPES.SERVICE_OFFER_VIEW,
  EVENT_TYPES.SERVICE_OFFER_CLAIM,
  EVENT_TYPES.OFFER_CLAIM_VIEW,
];

/**
 * §5.1: "Do not count automated/background activity as active-user activity."
 *
 * Everything server-recorded on the *merchant's* behalf is excluded by not
 * being in the list above; this names the ones a reader would expect to see
 * there, so the omission reads as a decision rather than an oversight.
 */
const EXCLUDED_FROM_ACTIVITY = [
  EVENT_TYPES.OFFER_IMPRESSION,
  EVENT_TYPES.PERSONALIZED_OFFER_IMPRESSION,
  EVENT_TYPES.BANNER_IMPRESSION,
  EVENT_TYPES.CLAIM_VERIFICATION_ATTEMPT,
  EVENT_TYPES.CLAIM_VERIFICATION_SUCCESS,
  EVENT_TYPES.CLAIM_VERIFICATION_FAILURE,
];

// ---------------------------------------------------------------------------
// §11.1 - what makes a merchant "active"
// ---------------------------------------------------------------------------

/**
 * Each key is one activity from §11.1's list, and each maps to a SQL fragment
 * answering "did shop `s.id` do this between :from and :to?".
 *
 * Turning an activity off is a matter of dropping its key from
 * `ACTIVE_MERCHANT_ACTIVITIES` - the query is assembled from whatever survives,
 * so the definition and the SQL can never drift.
 *
 * §11.1's closing rule - "do not count a merchant as active merely because an
 * account exists" - is what makes this a list of *actions* rather than a
 * status check on `shops`.
 */
const MERCHANT_ACTIVITY_SQL = {
  PUBLISHED_OFFER: `EXISTS (SELECT 1 FROM offers o
                             WHERE o.shop_id = s.id AND o.created_at BETWEEN ? AND ?
                               AND o.status <> 'draft')`,
  PUBLISHED_SERVICE: `EXISTS (SELECT 1 FROM services sv
                               WHERE sv.shop_id = s.id AND sv.created_at BETWEEN ? AND ?
                                 AND sv.status <> 'draft')`,
  // "Edited listing" is any touch of an offer or service that is not its
  // creation, which is what distinguishes tending a catalogue from filling one.
  EDITED_LISTING: `(EXISTS (SELECT 1 FROM offers o
                             WHERE o.shop_id = s.id AND o.updated_at BETWEEN ? AND ?
                               AND o.updated_at > o.created_at)
                 OR EXISTS (SELECT 1 FROM services sv
                             WHERE sv.shop_id = s.id AND sv.updated_at BETWEEN ? AND ?
                               AND sv.updated_at > sv.created_at))`,
  RECEIVED_CLAIM: `EXISTS (SELECT 1 FROM offer_claims c
                            WHERE c.shop_id = s.id AND c.claimed_at BETWEEN ? AND ?)`,
  RECEIVED_REDEMPTION: `EXISTS (SELECT 1 FROM offer_claims c
                                 WHERE c.shop_id = s.id AND c.redeemed_at BETWEEN ? AND ?)`,
  // A merchant reading their own numbers is the cheapest possible signal of
  // life, and the only one available to a shop with no traffic yet.
  VIEWED_DASHBOARD: `EXISTS (SELECT 1 FROM audit_logs al
                              JOIN shop_members sm ON sm.user_id = al.user_id
                                                  AND sm.shop_id = s.id
                                                  AND sm.status = 'active'
                             WHERE al.created_at BETWEEN ? AND ?)`,
};

/** How many `?` placeholders each fragment above consumes. */
const MERCHANT_ACTIVITY_PARAMS = {
  PUBLISHED_OFFER: 2,
  PUBLISHED_SERVICE: 2,
  EDITED_LISTING: 4,
  RECEIVED_CLAIM: 2,
  RECEIVED_REDEMPTION: 2,
  VIEWED_DASHBOARD: 2,
};

/** The activities currently in force. Order is presentational only. */
const ACTIVE_MERCHANT_ACTIVITIES = [
  'PUBLISHED_OFFER',
  'PUBLISHED_SERVICE',
  'EDITED_LISTING',
  'RECEIVED_CLAIM',
  'RECEIVED_REDEMPTION',
  'VIEWED_DASHBOARD',
];

const MERCHANT_ACTIVITY_LABELS = {
  PUBLISHED_OFFER: 'Published an offer',
  PUBLISHED_SERVICE: 'Published a service',
  EDITED_LISTING: 'Edited a listing',
  RECEIVED_CLAIM: 'Received a claim',
  RECEIVED_REDEMPTION: 'Received a redemption',
  VIEWED_DASHBOARD: 'Viewed the merchant dashboard',
};

/**
 * Builds `(a OR b OR ...)` for the enabled activities, with the window's
 * `from`/`to` repeated as many times as the fragments need.
 */
function activeMerchantClause(from, to, activities = ACTIVE_MERCHANT_ACTIVITIES) {
  const enabled = activities.filter((key) => MERCHANT_ACTIVITY_SQL[key]);
  if (enabled.length === 0) return { sql: '1 = 0', params: [] };

  const params = [];
  for (const key of enabled) {
    for (let i = 0; i < MERCHANT_ACTIVITY_PARAMS[key] / 2; i += 1) params.push(from, to);
  }
  return { sql: `(${enabled.map((key) => MERCHANT_ACTIVITY_SQL[key]).join('\n OR ')})`, params };
}

// ---------------------------------------------------------------------------
// §10 - which claims are eligible for the redemption rate
// ---------------------------------------------------------------------------

/**
 * §10: "The dashboard must clearly define which claims are counted as
 * eligible. Pending, still-valid claims may remain separate from expired/failed
 * claims."
 *
 * A claim is eligible once its fate is settled: it was redeemed, or it ran out
 * of time, or someone cancelled or revoked it. A claim still inside its window
 * has not yet had its chance, and counting it as a miss would make the rate a
 * measure of how recently the offers were published.
 */
const ELIGIBLE_CLAIM_SQL = `(c.status IN ('redeemed', 'expired', 'cancelled', 'revoked')
                             OR c.expires_at < NOW())`;

/** Claims still in play - reported next to the rate rather than inside it. */
const PENDING_CLAIM_SQL = `(c.status = 'claimed' AND c.expires_at >= NOW())`;

/** A redemption only counts once a merchant verified it at the counter. */
const VERIFIED_REDEMPTION_SQL = `(c.status = 'redeemed' AND c.redeemed_at IS NOT NULL)`;

// ---------------------------------------------------------------------------
// §16, §17 - merchant retention cohorts
// ---------------------------------------------------------------------------

/**
 * §16: retention is measured against the *activity* definition above, at fixed
 * offsets from the month the merchant joined. A merchant counts as retained at
 * offset N if they were active in the 30-day window ending N days after they
 * signed up - not merely at some point since, which would make retention rise
 * with the age of the cohort.
 */
const RETENTION_OFFSETS = [
  { key: 'd30', label: '30-Day', days: 30 },
  { key: 'd60', label: '60-Day', days: 60 },
  { key: 'd90', label: '90-Day', days: 90 },
  { key: 'm6', label: '6-Month', days: 180 },
  { key: 'm12', label: '12-Month', days: 365 },
];

/** The cohort chart's x-axis (§17), in months since the merchant joined. */
const COHORT_MONTHS = [0, 1, 2, 3, 6];

/** How wide a window around each offset counts as "still active". */
const RETENTION_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// §19, §20 - subscription conversion eligibility
// ---------------------------------------------------------------------------

/**
 * §19/§20 both hinge on "eligible" merchants, which they leave to us to pin
 * down. A merchant is eligible to upgrade out of a plan during a period if they
 * were on that plan at the *start* of it - someone who signed up yesterday has
 * not had a fair chance to convert and would only dilute the rate.
 *
 * `minDaysOnPlan` keeps that honest for merchants who joined mid-period: they
 * enter the denominator only once they have been on the plan this long.
 */
const CONVERSION_ELIGIBILITY = {
  minDaysOnPlan: 7,
  description:
    'Merchants who were on the plan at the start of the period, or joined it at ' +
    'least 7 days before the period ended.',
};

// ---------------------------------------------------------------------------
// §22, §26 - revenue
// ---------------------------------------------------------------------------

/**
 * §22: MRR counts only active paid subscriptions, normalised to a month.
 *
 * A yearly subscription contributes a twelfth of its price per month, which is
 * what stops an annual renewal from showing up as a one-month revenue spike.
 * Everything §22 says not to count - one-off fees, failed payments, refunds,
 * cancelled subscriptions with no remaining entitlement - is excluded by the
 * query's status filter rather than adjusted for afterwards.
 */
const MRR_ACTIVE_STATUSES = ['active', 'past_due'];

/**
 * §22 puts `past_due` in an awkward spot: the merchant still has their features
 * (they are inside the grace window, §10 of the payments spec) but the money
 * has not arrived. It is counted, and reported separately as "at risk" so the
 * figure can be read either way without two contradictory MRRs existing.
 */
const MRR_AT_RISK_STATUSES = ['past_due'];

const BILLING_CYCLE_MONTHS = { monthly: 1, yearly: 12 };

/**
 * §26: "The dashboard should clearly label whether the figure is Average
 * Revenue per Paying Merchant or per All Active Merchant. Do not mix the
 * definitions." Both are computed; the payload names which is which and the UI
 * prints that name.
 */
const ARPM_BASIS = {
  PAYING: {
    key: 'PAYING',
    label: 'Average revenue per paying merchant',
    hint: 'MRR divided by merchants on an active paid plan.',
  },
  ALL_ACTIVE: {
    key: 'ALL_ACTIVE',
    label: 'Average revenue per all active merchants',
    hint: 'MRR divided by every merchant active in the period, Free included.',
  },
};

// ---------------------------------------------------------------------------
// §59 - alert thresholds
// ---------------------------------------------------------------------------

/**
 * A spike is judged against the same-length window immediately before it
 * rather than a fixed count, so a busy Saturday does not page anyone. Both
 * conditions must hold: enough failures to matter, and a big enough jump to be
 * a change rather than noise.
 */
const ALERT_RULES = {
  windowMinutes: 15,
  /** Below this many failures in the window, nothing is reported at all. */
  minimumEvents: 5,
  /** Multiple of the previous window's count that counts as a spike. */
  spikeMultiplier: 3,
};

module.exports = {
  ACTIVE_USER_EVENTS,
  EXCLUDED_FROM_ACTIVITY,
  MERCHANT_ACTIVITY_SQL,
  ACTIVE_MERCHANT_ACTIVITIES,
  MERCHANT_ACTIVITY_LABELS,
  activeMerchantClause,
  ELIGIBLE_CLAIM_SQL,
  PENDING_CLAIM_SQL,
  VERIFIED_REDEMPTION_SQL,
  RETENTION_OFFSETS,
  COHORT_MONTHS,
  RETENTION_WINDOW_DAYS,
  CONVERSION_ELIGIBILITY,
  MRR_ACTIVE_STATUSES,
  MRR_AT_RISK_STATUSES,
  BILLING_CYCLE_MONTHS,
  ARPM_BASIS,
  ALERT_RULES,
};
