// time-windows.js — calendar-aware window arithmetic. Fixed-millisecond math
// silently drifts across leap days, so anything measured in months or years
// walks the calendar instead. Operates in UTC to match how every timestamp
// in this codebase is stored (epoch ms) and rendered (toISOString()).

/**
 * Subtract a whole number of calendar months from a timestamp, clamping the
 * day-of-month to the target month's length. Without the clamp,
 * 2025-03-31 − 1mo would roll forward into March instead of landing on
 * Feb 28; this is also what makes leap years fall out correctly in both
 * directions (2024-02-29 − 1y → 2023-02-28).
 * @param {number} timestamp epoch ms
 * @param {number} months
 * @return {number} epoch ms
 */
export function subtractMonths(timestamp, months) {
  const date = new Date(timestamp);
  const day = date.getUTCDate();

  // Move to the 1st first so setUTCMonth can't overflow into a later month
  // while walking back through months of varying length.
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);

  const lastDayOfTargetMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastDayOfTargetMonth));

  return date.getTime();
}

/**
 * Subtract a whole number of calendar years (= months * 12).
 * @param {number} timestamp epoch ms
 * @param {number} years
 * @return {number} epoch ms
 */
export function subtractYears(timestamp, years) {
  return subtractMonths(timestamp, years * 12);
}
