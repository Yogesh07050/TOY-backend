'use strict';

/**
 * Subscription plans (V3 §2, §3).
 *
 * This file is the only place plan pricing, feature entitlements and usage
 * limits are declared. The API serves it to the frontend so the pricing table,
 * the upgrade prompts and the server-side checks can never drift apart.
 *
 * Enforcement lives in `middleware/subscription.js`; hiding a control in the
 * UI is never the access check (§30).
 */

/** Named feature flags. Referenced by name everywhere, so typos surface early. */
const FEATURES = {
  // Publishing
  OFFER_SCHEDULING: 'OFFER_SCHEDULING',
  RECURRING_OFFERS: 'RECURRING_OFFERS',
  FEATURED_BANNERS: 'FEATURED_BANNERS',
  BANNER_SCHEDULING: 'BANNER_SCHEDULING',
  ENDING_SOON: 'ENDING_SOON',
  CAMPAIGNS: 'CAMPAIGNS',

  // Analytics
  ANALYTICS_STANDARD: 'ANALYTICS_STANDARD',
  ANALYTICS_ADVANCED: 'ANALYTICS_ADVANCED',
  CUSTOMER_ANALYTICS_BASIC: 'CUSTOMER_ANALYTICS_BASIC',
  CUSTOMER_ANALYTICS_ADVANCED: 'CUSTOMER_ANALYTICS_ADVANCED',
  LOCATION_ANALYTICS_BASIC: 'LOCATION_ANALYTICS_BASIC',
  LOCATION_ANALYTICS_ADVANCED: 'LOCATION_ANALYTICS_ADVANCED',
  BRANCH_ANALYTICS: 'BRANCH_ANALYTICS',
  CATEGORY_INSIGHTS: 'CATEGORY_INSIGHTS',
  CUSTOMER_TRENDS: 'CUSTOMER_TRENDS',
  OFFER_COMPARISON: 'OFFER_COMPARISON',
  FUNNEL_BASIC: 'FUNNEL_BASIC',
  FUNNEL_ADVANCED: 'FUNNEL_ADVANCED',
  CLAIMS_ANALYTICS: 'CLAIMS_ANALYTICS',
  CAMPAIGN_ANALYTICS: 'CAMPAIGN_ANALYTICS',
  OFFER_INTELLIGENCE: 'OFFER_INTELLIGENCE',
  ROI_DASHBOARD: 'ROI_DASHBOARD',
  ANALYTICS_EXPORT: 'ANALYTICS_EXPORT',

  // Reach and support
  NOTIFICATIONS_ADVANCED: 'NOTIFICATIONS_ADVANCED',
  PRIORITY_SUPPORT: 'PRIORITY_SUPPORT',
  PRIORITY_DISCOVERY: 'PRIORITY_DISCOVERY',
};

const FEATURE_LABELS = {
  OFFER_SCHEDULING: 'Offer scheduling',
  RECURRING_OFFERS: 'Recurring offers',
  FEATURED_BANNERS: 'Featured banners',
  BANNER_SCHEDULING: 'Banner scheduling',
  ENDING_SOON: 'Ending Soon placement',
  CAMPAIGNS: 'Campaigns',
  ANALYTICS_STANDARD: 'Standard offer analytics',
  ANALYTICS_ADVANCED: 'Advanced offer analytics',
  CUSTOMER_ANALYTICS_BASIC: 'Basic customer engagement analytics',
  CUSTOMER_ANALYTICS_ADVANCED: 'Advanced customer engagement analytics',
  LOCATION_ANALYTICS_BASIC: 'Basic location analytics',
  LOCATION_ANALYTICS_ADVANCED: 'Advanced location intelligence',
  BRANCH_ANALYTICS: 'Branch performance analytics',
  CATEGORY_INSIGHTS: 'Category & market insights',
  CUSTOMER_TRENDS: 'Customer trends',
  OFFER_COMPARISON: 'Offer performance comparison',
  FUNNEL_BASIC: 'Basic offer funnel',
  FUNNEL_ADVANCED: 'Advanced offer funnel',
  CLAIMS_ANALYTICS: 'Claims & redemption analytics',
  CAMPAIGN_ANALYTICS: 'Campaign performance analytics',
  OFFER_INTELLIGENCE: 'Offer intelligence & recommendations',
  ROI_DASHBOARD: 'ROI / campaign value',
  ANALYTICS_EXPORT: 'CSV + Excel analytics export',
  NOTIFICATIONS_ADVANCED: 'Advanced notifications',
  PRIORITY_SUPPORT: 'Priority support',
  PRIORITY_DISCOVERY: 'Priority customer app discovery',
};

/** `null` for a limit means unlimited. */
const PLANS = {
  FREE: {
    key: 'FREE',
    name: 'Free',
    tagline: 'Try Offers App',
    price: 0,
    currency: 'INR',
    rank: 0,
    description: 'Discover and try the platform with a single offer per month.',
    limits: {
      offersPerMonth: 1,
      branches: 1,
      categories: 1,
      banners: 0,
      exportsPerMonth: 0,
    },
    profile: 'Basic',
    visibility: { nearMe: 'Basic', search: 'Basic', discoveryBoost: 0 },
    features: [],
  },

  BUSINESS: {
    key: 'BUSINESS',
    name: 'Business',
    tagline: 'Publish & Promote',
    price: 999,
    currency: 'INR',
    rank: 1,
    description: 'For merchants who actively publish and promote offers.',
    limits: {
      offersPerMonth: null,
      branches: 2,
      categories: 5,
      banners: 0,
      exportsPerMonth: 0,
    },
    profile: 'Full',
    visibility: { nearMe: 'Standard', search: 'Enhanced', discoveryBoost: 1 },
    features: [
      FEATURES.OFFER_SCHEDULING,
      FEATURES.RECURRING_OFFERS,
      FEATURES.ENDING_SOON,
      FEATURES.ANALYTICS_STANDARD,
      FEATURES.CUSTOMER_ANALYTICS_BASIC,
      FEATURES.LOCATION_ANALYTICS_BASIC,
      FEATURES.FUNNEL_BASIC,
      FEATURES.CLAIMS_ANALYTICS,
    ],
  },

  PREMIUM: {
    key: 'PREMIUM',
    name: 'Premium',
    tagline: 'Grow with Data',
    price: 2500,
    currency: 'INR',
    rank: 2,
    description:
      'Promotion plus customer, location and campaign intelligence with actionable recommendations.',
    limits: {
      offersPerMonth: null,
      branches: null,
      categories: null,
      banners: null,
      exportsPerMonth: null,
    },
    profile: 'Enhanced',
    visibility: { nearMe: 'Priority', search: 'Priority', discoveryBoost: 2 },
    features: [
      FEATURES.OFFER_SCHEDULING,
      FEATURES.RECURRING_OFFERS,
      FEATURES.FEATURED_BANNERS,
      FEATURES.BANNER_SCHEDULING,
      FEATURES.ENDING_SOON,
      FEATURES.CAMPAIGNS,
      FEATURES.ANALYTICS_STANDARD,
      FEATURES.ANALYTICS_ADVANCED,
      FEATURES.CUSTOMER_ANALYTICS_BASIC,
      FEATURES.CUSTOMER_ANALYTICS_ADVANCED,
      FEATURES.LOCATION_ANALYTICS_BASIC,
      FEATURES.LOCATION_ANALYTICS_ADVANCED,
      FEATURES.BRANCH_ANALYTICS,
      FEATURES.CATEGORY_INSIGHTS,
      FEATURES.CUSTOMER_TRENDS,
      FEATURES.OFFER_COMPARISON,
      FEATURES.FUNNEL_BASIC,
      FEATURES.FUNNEL_ADVANCED,
      FEATURES.CLAIMS_ANALYTICS,
      FEATURES.CAMPAIGN_ANALYTICS,
      FEATURES.OFFER_INTELLIGENCE,
      FEATURES.ROI_DASHBOARD,
      FEATURES.ANALYTICS_EXPORT,
      FEATURES.NOTIFICATIONS_ADVANCED,
      FEATURES.PRIORITY_SUPPORT,
      FEATURES.PRIORITY_DISCOVERY,
    ],
  },
};

const PLAN_KEYS = Object.keys(PLANS);

/** Lowest plan that grants `feature`, used to word the upgrade prompt (§31). */
function minimumPlanFor(feature) {
  return (
    PLAN_KEYS.map((key) => PLANS[key])
      .sort((a, b) => a.rank - b.rank)
      .find((plan) => plan.features.includes(feature)) ?? PLANS.PREMIUM
  );
}

/** Lowest plan whose `limitKey` allows at least `needed`. */
function minimumPlanForLimit(limitKey, needed) {
  return (
    PLAN_KEYS.map((key) => PLANS[key])
      .sort((a, b) => a.rank - b.rank)
      .find((plan) => {
        const limit = plan.limits[limitKey];
        return limit === null || limit >= needed;
      }) ?? PLANS.PREMIUM
  );
}

function planFor(key) {
  return PLANS[key] ?? PLANS.FREE;
}

/**
 * The comparison matrix from §3, served to the pricing and upgrade screens.
 * Rows are declared here rather than in the UI so a plan change is one edit.
 */
const COMPARISON_MATRIX = [
  { label: 'Monthly price', values: ['₹0', '₹999', '₹2,500'] },
  { label: 'Offers per month', values: ['1', 'Unlimited', 'Unlimited'] },
  { label: 'Shop profile', values: ['Basic', 'Full', 'Enhanced'] },
  { label: 'Branches', values: ['1', 'Up to 2', 'Unlimited'] },
  { label: 'Categories', values: ['1', '5', 'Unlimited'] },
  { label: 'Near Me visibility', values: ['Basic', 'Standard', 'Priority'] },
  { label: 'Search visibility', values: ['Basic', 'Enhanced', 'Priority'] },
  { label: 'Ending Soon section', values: [false, true, true] },
  { label: 'Featured banners', values: [false, false, 'Unlimited'] },
  { label: 'Banner scheduling', values: [false, false, true] },
  { label: 'Offer scheduling', values: [false, true, true] },
  { label: 'Recurring offers', values: [false, true, true] },
  { label: 'Offer analytics', values: ['Basic views', 'Standard', 'Advanced'] },
  { label: 'Customer engagement analytics', values: [false, 'Basic', 'Advanced'] },
  { label: 'Location analytics', values: [false, 'Basic', 'Advanced'] },
  { label: 'Branch analytics', values: [false, false, true] },
  { label: 'Competitor / category insights', values: [false, false, true] },
  { label: 'Customer trends', values: [false, false, true] },
  { label: 'Export analytics', values: [false, false, 'CSV + Excel'] },
  { label: 'Offer performance comparison', values: [false, false, true] },
  { label: 'Offer funnel', values: [false, 'Basic', 'Advanced'] },
  { label: 'Claims / redemptions', values: [false, true, true] },
  { label: 'Notifications', values: ['Basic', 'Standard', 'Advanced'] },
  { label: 'Priority support', values: [false, 'Standard', 'Priority'] },
  { label: 'Customer app exposure', values: [true, true, 'Priority discovery'] },
];

module.exports = {
  FEATURES,
  FEATURE_LABELS,
  PLANS,
  PLAN_KEYS,
  COMPARISON_MATRIX,
  planFor,
  minimumPlanFor,
  minimumPlanForLimit,
};
