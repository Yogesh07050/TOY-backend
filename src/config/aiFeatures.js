'use strict';

/**
 * AI feature catalogue and the plans shipped by the seeder (TOY.md §3, §32).
 *
 * The numbers here are only the *starting* values. Once seeded they live in
 * `subscription_plans` and a Super Admin edits them through the API, which is
 * what "usage limits should be configurable rather than hardcoded" requires.
 */

/** Feature identifiers, exactly as §32 names them. */
const AI_FEATURES = {
  AI_OFFER_ASSISTANT: 'AI_OFFER_ASSISTANT',
  AI_CONTENT_GENERATOR: 'AI_CONTENT_GENERATOR',
  AI_OFFER_OPTIMIZER: 'AI_OFFER_OPTIMIZER',
};

const AI_FEATURE_NAMES = Object.values(AI_FEATURES);

/**
 * Which plan column decides each feature. Keeping the mapping in one place is
 * what lets `subscriptions.js` stay generic over the three features.
 */
const FEATURE_COLUMNS = {
  [AI_FEATURES.AI_OFFER_ASSISTANT]: {
    enabled: 'ai_assistant_enabled',
    limit: 'ai_assistant_monthly_limit',
    label: 'AI Offer Assistant',
    permission: 'USE_AI_ASSISTANT',
  },
  [AI_FEATURES.AI_CONTENT_GENERATOR]: {
    enabled: 'ai_content_enabled',
    limit: 'ai_content_monthly_limit',
    label: 'AI Content Generator',
    permission: 'USE_AI_CONTENT',
  },
  [AI_FEATURES.AI_OFFER_OPTIMIZER]: {
    enabled: 'ai_optimizer_enabled',
    limit: 'ai_optimizer_monthly_limit',
    label: 'AI Offer Optimisation',
    permission: 'USE_AI_CONTENT',
  },
};

/**
 * §3's three tiers. `null` on a limit means unlimited; 0 means off.
 * FREE is also the fallback for any shop with no subscription row at all.
 */
const DEFAULT_PLANS = [
  {
    code: 'FREE',
    name: 'Free',
    description: 'Post offers and reach customers. AI features are not included.',
    priceMonthly: 0,
    aiAssistantEnabled: false,
    aiContentEnabled: false,
    aiOptimizerEnabled: false,
    historicalInsights: false,
    locationInsights: false,
    timingInsights: false,
    socialCaptionEnabled: false,
    aiAssistantMonthlyLimit: 0,
    aiContentMonthlyLimit: 0,
    aiOptimizerMonthlyLimit: 0,
    displayOrder: 1,
  },
  {
    code: 'BUSINESS',
    name: 'Business',
    description:
      'Everything in Free, plus AI-written offer content with a monthly allowance.',
    priceMonthly: 999,
    aiAssistantEnabled: false,
    aiContentEnabled: true,
    aiOptimizerEnabled: false,
    historicalInsights: false,
    locationInsights: false,
    timingInsights: false,
    socialCaptionEnabled: false,
    aiAssistantMonthlyLimit: 0,
    // §3's recommended starting allowance.
    aiContentMonthlyLimit: 10,
    aiOptimizerMonthlyLimit: 0,
    displayOrder: 2,
  },
  {
    code: 'PREMIUM',
    name: 'Premium',
    description:
      'The full AI suite: the offer assistant, unlimited content, optimisation, '
      + 'and recommendations informed by your own performance history.',
    priceMonthly: 2500,
    aiAssistantEnabled: true,
    aiContentEnabled: true,
    aiOptimizerEnabled: true,
    historicalInsights: true,
    locationInsights: true,
    timingInsights: true,
    socialCaptionEnabled: true,
    aiAssistantMonthlyLimit: null,
    aiContentMonthlyLimit: null,
    aiOptimizerMonthlyLimit: null,
    displayOrder: 3,
  },
];

const FREE_PLAN_CODE = 'FREE';

/** Content sections the generator can produce (§16). */
const CONTENT_SECTIONS = [
  'title',
  'shortDescription',
  'detailedDescription',
  'bannerText',
  'pushNotification',
  'socialCaption',
];

/** Sections that only Premium may generate (§22). */
const PREMIUM_ONLY_SECTIONS = ['socialCaption'];

module.exports = {
  AI_FEATURES,
  AI_FEATURE_NAMES,
  FEATURE_COLUMNS,
  DEFAULT_PLANS,
  FREE_PLAN_CODE,
  CONTENT_SECTIONS,
  PREMIUM_ONLY_SECTIONS,
};
