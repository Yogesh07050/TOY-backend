'use strict';

/**
 * Customer-facing "deal type" vocabulary (V2 §8). Deliberately separate from
 * offers.offer_type's ENUM ('percentage','flat','buy_x_get_y','price_drop',
 * 'up_to','other') - that enum describes how an offer's price is computed,
 * this describes how a customer thinks about deals, and includes shapes
 * (cashback, combo, clearance, app-exclusive) the offer schema has no column
 * for at all. No DB enum/FK for the same reason analytics_events.event_type
 * is a plain VARCHAR: adding a value should never require a migration.
 */
const OFFER_TYPE_PREFERENCES = [
  'PERCENTAGE_DISCOUNT',
  'BUY_ONE_GET_ONE',
  'BUY_TWO_GET_ONE',
  'FLAT_DISCOUNT',
  'CASHBACK',
  'FREE_ITEM',
  'COMBO_OFFER',
  'CLEARANCE_SALE',
  'APP_EXCLUSIVE',
];

const MIN_CATEGORY_PREFERENCES = 5;

module.exports = { OFFER_TYPE_PREFERENCES, MIN_CATEGORY_PREFERENCES };
