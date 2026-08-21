'use strict';

/**
 * Second-line fact check on generated copy (§23, §40).
 *
 * The Python service already runs a thorough guard and repairs or drops what
 * fails. This is the independent check on the last hop before Angular: the rule
 * "never trust AI-generated discount values without validation" is not satisfied
 * by trusting another service to have validated them.
 *
 * It is deliberately narrower than the Python one - percentages, money and
 * quantity pairs, the three that turn into a promise the merchant must honour.
 */

const PERCENT = /(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi;
const MONEY = /(?:₹|rs\.?|inr|\$)\s*(\d[\d,]*(?:\.\d+)?)/gi;
const BUY_GET = /buy\s*(\d+)[^.\n]{0,24}?\bget\s*(\d+)/gi;

const normalise = (value) => {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/,/g, '').trim();
  const number = Number(text);
  if (!Number.isFinite(number)) return text.toLowerCase();
  return Number.isInteger(number) ? String(number) : String(number);
};

/** Every number the merchant themselves put on this offer. */
function allowedNumbers(facts) {
  const values = new Set();
  const add = (value) => {
    const normalised = normalise(value);
    if (normalised) values.add(normalised);
  };

  add(facts.discountValue);
  add(facts.originalPrice);
  add(facts.discountedPrice);
  add(facts.buyQuantity);
  add(facts.getQuantity);
  add(facts.minPurchase);

  // A saving implied by the merchant's own prices is still their number.
  if (facts.originalPrice != null && facts.discountedPrice != null) {
    add(facts.originalPrice - facts.discountedPrice);
    if (facts.originalPrice > 0) {
      add(Math.round(((facts.originalPrice - facts.discountedPrice) / facts.originalPrice) * 100));
    }
  }

  for (const field of [
    facts.title,
    facts.offerText,
    facts.productName,
    facts.applicableProducts,
    facts.termsConditions,
    facts.eligibility,
    facts.usageRestrictions,
  ]) {
    for (const match of String(field ?? '').matchAll(/\d[\d,]*(?:\.\d+)?/g)) add(match[0]);
  }

  return values;
}

/** @returns {string[]} one message per unsupported claim, empty when clean. */
function checkText(text, facts, allowed) {
  if (!text) return [];
  const problems = [];

  for (const match of String(text).matchAll(PERCENT)) {
    const value = normalise(match[1]);
    if (!allowed.has(value) || (facts.discountType !== 'percentage' && value === '100')) {
      problems.push(`unsupported discount "${value}%"`);
    }
  }

  for (const match of String(text).matchAll(MONEY)) {
    if (!allowed.has(normalise(match[1]))) problems.push(`unsupported price "${match[1]}"`);
  }

  if (facts.buyQuantity && facts.getQuantity) {
    const expected = `${normalise(facts.buyQuantity)}/${normalise(facts.getQuantity)}`;
    for (const match of String(text).matchAll(BUY_GET)) {
      if (`${normalise(match[1])}/${normalise(match[2])}` !== expected) {
        problems.push(`unsupported quantities "buy ${match[1]} get ${match[2]}"`);
      }
    }
  }

  return problems;
}

/**
 * Filters a `{ section: [variant, ...] }` map down to the variants that check
 * out. A section left with nothing is removed entirely - showing no copy beats
 * showing copy that misstates the offer.
 */
function filterSections(sections, facts) {
  const allowed = allowedNumbers(facts);
  const kept = {};
  const rejected = [];

  for (const [section, variants] of Object.entries(sections ?? {})) {
    const surviving = [];
    for (const variant of variants) {
      const problems = checkText(variant, facts, allowed);
      if (problems.length) rejected.push(`${section}: ${problems[0]}`);
      else surviving.push(variant);
    }
    if (surviving.length) kept[section] = surviving;
  }

  return { sections: kept, rejected };
}

/** Same check for the single fields the improver returns. */
function filterFields(fields, facts) {
  const allowed = allowedNumbers(facts);
  const kept = {};
  const rejected = [];

  for (const [name, value] of Object.entries(fields ?? {})) {
    if (!value) {
      kept[name] = null;
      continue;
    }
    const problems = checkText(value, facts, allowed);
    if (problems.length) {
      rejected.push(`${name}: ${problems[0]}`);
      kept[name] = null;
    } else {
      kept[name] = value;
    }
  }

  return { fields: kept, rejected };
}

module.exports = { allowedNumbers, checkText, filterSections, filterFields };
