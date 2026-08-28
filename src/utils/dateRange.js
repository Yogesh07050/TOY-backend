'use strict';

/**
 * Calendar-day helpers for the analytics series.
 *
 * The pool is configured with `timezone: 'Z'`, so every DATETIME crossing the
 * driver is a UTC instant and MySQL's `DATE(...)` buckets land on UTC calendar
 * days. These helpers work in UTC for the same reason: it is what keeps a key
 * generated here equal to the `YYYY-MM-DD` string a `GROUP BY day` gives back.
 */

/** Hard ceiling so an inverted or absurd range cannot build an endless list. */
const MAX_DAYS = 400;

/** `YYYY-MM-DD` for the UTC calendar day containing `value`. */
function dayKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

/**
 * Every UTC day key from `from` to `to`, inclusive.
 *
 * `GROUP BY day` only returns days that actually have rows, so a chart drawn
 * straight from a result set silently drops its quiet days and plots the rest
 * on a non-linear axis. Callers seed their map with these keys to get one
 * point per day instead.
 */
function dayKeysBetween(from, to) {
  const last = dayKey(to);
  const cursor = new Date(`${dayKey(from)}T00:00:00.000Z`);
  const keys = [];

  while (keys.length < MAX_DAYS) {
    const key = cursor.toISOString().slice(0, 10);
    keys.push(key);
    if (key >= last) break;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return keys;
}

/** The date presets every dashboard filter bar offers (V3 §27, Business §32). */
const DATE_PRESETS = [
  'today',
  'yesterday',
  'last7',
  'last30',
  'last90',
  'thisMonth',
  'lastMonth',
  'custom',
];

const startOfDay = (date) => {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
};

const endOfDay = (date) => {
  const value = new Date(date);
  value.setHours(23, 59, 59, 999);
  return value;
};

/**
 * Turns a preset (or an explicit custom range) into an absolute window, plus
 * the equally long window immediately before it.
 *
 * Every KPI card compares like-for-like periods, so the comparison window has
 * to be derived from the same place as the window itself - deriving it per
 * query is how "current: 30 days vs previous: last month" gets shipped, which
 * is exactly what Business §33 forbids.
 */
function resolvePresetRange(query = {}) {
  const now = new Date();
  let from;
  let to;

  switch (query.preset) {
    case 'today':
      from = startOfDay(now);
      to = endOfDay(now);
      break;
    case 'yesterday': {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      from = startOfDay(yesterday);
      to = endOfDay(yesterday);
      break;
    }
    case 'last7':
    case 'last30':
    case 'last90': {
      const days = { last7: 7, last30: 30, last90: 90 }[query.preset];
      to = endOfDay(now);
      from = startOfDay(new Date(now.getTime() - (days - 1) * 86400000));
      break;
    }
    case 'thisMonth':
      from = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
      to = endOfDay(now);
      break;
    case 'lastMonth':
      from = startOfDay(new Date(now.getFullYear(), now.getMonth() - 1, 1));
      to = endOfDay(new Date(now.getFullYear(), now.getMonth(), 0));
      break;
    case 'custom':
    default:
      if (!query.from || !query.to) {
        to = endOfDay(now);
        from = startOfDay(new Date(now.getTime() - 29 * 86400000));
      } else {
        from = startOfDay(query.from);
        to = endOfDay(query.to);
      }
  }

  const span = to.getTime() - from.getTime();
  return {
    from,
    to,
    previousFrom: new Date(from.getTime() - span - 1),
    previousTo: new Date(from.getTime() - 1),
    preset: query.preset ?? 'last30',
  };
}

module.exports = {
  dayKey,
  dayKeysBetween,
  MAX_DAYS,
  DATE_PRESETS,
  startOfDay,
  endOfDay,
  resolvePresetRange,
};
