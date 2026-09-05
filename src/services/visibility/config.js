'use strict';

const { query, execute } = require('../../db/pool');
const logger = require('../../utils/logger');
const defaults = require('../../config/visibility');

/**
 * Runtime ranking configuration (§4, §22).
 *
 * §4 requires the weights to be "configurable from the backend rather than
 * permanently hard-coded", and §22 puts ranking weights, rotation rules and
 * frequency limits in the Super Admin's hands. That means every ranked request
 * needs the current values - and a ranked request is the hottest path in the
 * app, so reading three config tables per search is not an option.
 *
 * This module is the compromise: one short-lived in-process cache, refreshed
 * lazily. A weight change is live within `configCacheSeconds` (60 by default)
 * on every instance, without a deploy and without a shared cache to operate.
 *
 * ## Failure behaviour
 *
 * Every read falls back to `config/visibility.js`. If the database is
 * unreachable, or a Super Admin deletes a row, ranking degrades to the seeded
 * defaults rather than scoring the missing factor as zero - which would
 * silently switch a factor off and be very hard to notice from the outside.
 */

let cache = null;
let cachedAt = 0;
let inflight = null;

/** Cache lifetime, itself a rule - but read from the defaults to avoid a cycle. */
const ttlMs = () => (cache?.rules?.configCacheSeconds ?? defaults.DEFAULT_RULES.configCacheSeconds) * 1000;

/**
 * Merges the DB rows over the coded defaults.
 *
 * Deliberately a merge rather than a replacement: a factor added to
 * `config/visibility.js` in a later release starts working on the next deploy
 * at its default weight, without waiting for a migration to insert its row.
 */
function mergeWeights(rows) {
  const weights = {};
  for (const surface of defaults.SURFACE_KEYS) {
    weights[surface] = { ...defaults.DEFAULT_WEIGHTS[surface] };
  }
  for (const row of rows) {
    const surface = weights[row.surface];
    if (!surface) continue;
    if (!(row.factor in surface)) continue;
    // An inactive factor scores nothing, but the tuned weight stays in the row
    // so switching it back on restores the value rather than a guess.
    surface[row.factor] = row.is_active ? Number(row.weight) : 0;
  }
  return weights;
}

function mergeRules(rows) {
  const rules = { ...defaults.DEFAULT_RULES };
  for (const row of rows) {
    if (!row.is_active) continue;
    if (!(row.rule_key in rules)) continue;
    if (row.value_json !== null && row.value_json !== undefined) {
      const parsed = typeof row.value_json === 'string' ? safeJson(row.value_json) : row.value_json;
      // An object rule (the engagement weight map) is merged key by key, so a
      // partial override does not wipe the signals it did not mention.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rules[row.rule_key] =
          typeof rules[row.rule_key] === 'object' ? { ...rules[row.rule_key], ...parsed } : parsed;
        continue;
      }
      if (parsed !== null) rules[row.rule_key] = parsed;
      continue;
    }
    if (row.value_number !== null) rules[row.rule_key] = Number(row.value_number);
  }
  return rules;
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function load() {
  const [weightRows, ruleRows, limitRows] = await Promise.all([
    query('SELECT surface, factor, weight, is_active FROM ranking_weights'),
    query('SELECT rule_key, value_number, value_json, is_active FROM visibility_rules'),
    query(
      `SELECT scope, placement_type, applies_to, max_impressions, window_minutes
         FROM frequency_limits WHERE status = 'active'`,
    ),
  ]);

  return {
    weights: mergeWeights(weightRows),
    rules: mergeRules(ruleRows),
    frequencyLimits: limitRows.map((row) => ({
      scope: row.scope,
      placementType: row.placement_type,
      appliesTo: row.applies_to,
      maxImpressions: Number(row.max_impressions),
      windowMinutes: Number(row.window_minutes),
    })),
  };
}

/**
 * The current configuration, cached.
 *
 * Concurrent callers share one load: a cold cache under load would otherwise
 * fire one identical three-table read per in-flight request.
 */
async function get() {
  if (cache && Date.now() - cachedAt < ttlMs()) return cache;
  if (inflight) return inflight;

  inflight = load()
    .then((loaded) => {
      cache = loaded;
      cachedAt = Date.now();
      return loaded;
    })
    .catch((error) => {
      logger.warn(
        {
          event: 'VISIBILITY_CONFIG_LOAD_FAILED',
          category: 'DATABASE',
          dependency: 'DATABASE',
          err_message: error.message,
        },
        'Falling back to default visibility configuration',
      );
      // Serving stale config beats serving none: an old weight set still ranks
      // sensibly, whereas throwing here would take down every discovery
      // endpoint over a transient database blip.
      return (
        cache ?? {
          weights: mergeWeights([]),
          rules: mergeRules([]),
          frequencyLimits: defaults.DEFAULT_FREQUENCY_LIMITS,
        }
      );
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** Drops the cache so the next read sees a just-saved change immediately. */
function invalidate() {
  cache = null;
  cachedAt = 0;
}

// ---------------------------------------------------------------------------
// Writes (§22, all audited by the routes that call these)

async function setWeight(surface, factor, weight, isActive, userId) {
  await execute(
    `INSERT INTO ranking_weights (surface, factor, weight, is_active, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE weight = VALUES(weight), is_active = VALUES(is_active),
                             updated_by = VALUES(updated_by)`,
    [surface, factor, weight, isActive ? 1 : 0, userId ?? null],
  );
  invalidate();
}

async function setRule(ruleKey, { valueNumber = null, valueJson = null, isActive = true }, userId) {
  await execute(
    `INSERT INTO visibility_rules (rule_key, value_number, value_json, is_active, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE value_number = VALUES(value_number), value_json = VALUES(value_json),
                             is_active = VALUES(is_active), updated_by = VALUES(updated_by)`,
    [ruleKey, valueNumber, valueJson === null ? null : JSON.stringify(valueJson), isActive ? 1 : 0, userId ?? null],
  );
  invalidate();
}

/**
 * Restores one surface (or every surface) to the coded defaults.
 *
 * Worth having as a first-class operation rather than "edit nine numbers back":
 * the fastest way to find out whether a bad week is the ranking's fault is to
 * put it back exactly as it shipped, and doing that by hand invites a typo at
 * the worst moment.
 */
async function resetWeights(surface, userId) {
  const surfaces = surface ? [surface] : defaults.SURFACE_KEYS;
  for (const key of surfaces) {
    for (const [factor, weight] of Object.entries(defaults.DEFAULT_WEIGHTS[key] ?? {})) {
      await setWeight(key, factor, weight, true, userId);
    }
  }
  invalidate();
  return surfaces;
}

/** The weights for one surface, falling back to HOME for an unknown name. */
function weightsFor(config, surface) {
  return config.weights[surface] ?? config.weights[defaults.SURFACES.HOME];
}

module.exports = {
  get,
  invalidate,
  setWeight,
  setRule,
  resetWeights,
  weightsFor,
};
