'use strict';

const plans = require('./plans');

/**
 * The controlled feature catalogue a Super Admin may grant from (§11D, §11J).
 *
 * Two kinds of key live here:
 *
 *   feature - a named flag from `config/plans.js`. Granting it adds the flag
 *             to the shop's effective feature set.
 *   limit   - lifts a plan *limit* rather than switching a flag on. The Free
 *             plan's "1 offer per month" is a number, not a feature, so
 *             "give this merchant unlimited offers" needs its own key.
 *
 * Nothing outside this file may be granted: `feature_overrides` rows are
 * validated against it, which is what stops an invented feature name from
 * being stored and then silently never matching anything (§11J).
 */

/** Grouping shown on the Super Admin override screen. */
const CATEGORY_FOR = {
  OFFER_SCHEDULING: 'Publishing',
  RECURRING_OFFERS: 'Publishing',
  FEATURED_BANNERS: 'Publishing',
  BANNER_SCHEDULING: 'Publishing',
  ENDING_SOON: 'Discovery',
  CAMPAIGNS: 'Publishing',
  PRIORITY_DISCOVERY: 'Discovery',
  ENHANCED_DISCOVERY: 'Discovery',
  FEATURED_PLACEMENTS: 'Discovery',
  NOTIFICATIONS_ADVANCED: 'Engagement',
  PRIORITY_SUPPORT: 'Support',
  SERVICE_SCHEDULING: 'Services',
  SERVICE_ANALYTICS_BASIC: 'Services',
  SERVICE_ANALYTICS_ADVANCED: 'Services',
};

const analyticsKeys = new Set([
  'ANALYTICS_STANDARD',
  'ANALYTICS_ADVANCED',
  'CUSTOMER_ANALYTICS_BASIC',
  'CUSTOMER_ANALYTICS_ADVANCED',
  'LOCATION_ANALYTICS_BASIC',
  'LOCATION_ANALYTICS_ADVANCED',
  'BRANCH_ANALYTICS',
  'CATEGORY_INSIGHTS',
  'CUSTOMER_TRENDS',
  'OFFER_COMPARISON',
  'FUNNEL_BASIC',
  'FUNNEL_ADVANCED',
  'CLAIMS_ANALYTICS',
  'CAMPAIGN_ANALYTICS',
  'OFFER_INTELLIGENCE',
  'ROI_DASHBOARD',
  'ANALYTICS_EXPORT',
  'VISIBILITY_ANALYTICS',
  'VISIBILITY_ANALYTICS_ADVANCED',
]);

/**
 * Limit-lifting keys (§11D: UNLIMITED_OFFERS, MULTIPLE_BRANCHES,
 * UNLIMITED_CATEGORIES). `limitKey` names the entry in a plan's `limits`;
 * `value` is what the limit becomes while the override is active, with
 * `null` meaning unlimited.
 */
const LIMIT_OVERRIDES = {
  UNLIMITED_OFFERS: {
    name: 'Unlimited offers',
    description: 'Removes the monthly published-offer cap.',
    limitKey: 'offersPerMonth',
    value: null,
  },
  UNLIMITED_SERVICES: {
    name: 'Unlimited services',
    description: 'Removes the monthly published-service cap.',
    limitKey: 'servicesPerMonth',
    value: null,
  },
  MULTIPLE_BRANCHES: {
    name: 'Unlimited branches',
    description: 'Removes the branch cap for this shop.',
    limitKey: 'branches',
    value: null,
  },
  UNLIMITED_CATEGORIES: {
    name: 'Unlimited categories',
    description: 'Removes the category cap for this shop.',
    limitKey: 'categories',
    value: null,
  },
  UNLIMITED_BANNERS: {
    name: 'Unlimited banners',
    description: 'Removes the featured-banner cap for this shop.',
    limitKey: 'banners',
    value: null,
  },
  UNLIMITED_EXPORTS: {
    name: 'Unlimited analytics exports',
    description: 'Removes the monthly analytics export cap.',
    limitKey: 'exportsPerMonth',
    value: null,
  },
};

function categoryFor(key) {
  if (LIMIT_OVERRIDES[key]) return 'Limits';
  if (analyticsKeys.has(key)) return 'Analytics';
  return CATEGORY_FOR[key] ?? 'General';
}

/** Every grantable key, in the shape the catalogue table and API use. */
const CATALOGUE = [
  ...Object.keys(plans.FEATURES).map((key) => ({
    featureKey: key,
    name: plans.FEATURE_LABELS[key] ?? key,
    description: `Grants ${plans.FEATURE_LABELS[key] ?? key} independently of the shop's plan.`,
    category: categoryFor(key),
    kind: 'feature',
  })),
  ...Object.entries(LIMIT_OVERRIDES).map(([key, entry]) => ({
    featureKey: key,
    name: entry.name,
    description: entry.description,
    category: 'Limits',
    kind: 'limit',
    limitKey: entry.limitKey,
  })),
];

const CATALOGUE_KEYS = CATALOGUE.map((entry) => entry.featureKey);
const BY_KEY = new Map(CATALOGUE.map((entry) => [entry.featureKey, entry]));

const isGrantable = (key) => BY_KEY.has(key);
const entryFor = (key) => BY_KEY.get(key) ?? null;

/** The limit this key lifts, or null when it is a plain feature flag. */
const limitOverrideFor = (key) => LIMIT_OVERRIDES[key] ?? null;

module.exports = {
  CATALOGUE,
  CATALOGUE_KEYS,
  LIMIT_OVERRIDES,
  isGrantable,
  entryFor,
  limitOverrideFor,
};
