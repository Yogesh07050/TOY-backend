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

module.exports = { dayKey, dayKeysBetween, MAX_DAYS };
