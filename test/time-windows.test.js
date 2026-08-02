// Tests for calendar-aware window arithmetic — the day-of-month clamping and
// leap-year behavior that message-archive.js and moderation.js rely on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { subtractMonths, subtractYears } from "../time-windows.js";

test("subtractMonths walks back a normal month without clamping", () => {
  const result = subtractMonths(Date.UTC(2025, 5, 15), 3); // 2025-06-15 − 3mo
  assert.equal(result, Date.UTC(2025, 2, 15)); // 2025-03-15
});

test("subtractMonths(x, 0) is a no-op", () => {
  const ts = Date.UTC(2025, 5, 15, 12, 30);
  assert.equal(subtractMonths(ts, 0), ts);
});

test("subtractMonths clamps day-of-month into a shorter target month", () => {
  // 2025-03-31 − 1mo would overflow into March if not clamped; 2025 is not
  // a leap year, so February has 28 days.
  const result = subtractMonths(Date.UTC(2025, 2, 31), 1);
  assert.equal(result, Date.UTC(2025, 1, 28));
});

test("subtractMonths clamps into a leap February", () => {
  // 2024 is a leap year, so the clamp target is Feb 29, not Feb 28.
  const result = subtractMonths(Date.UTC(2024, 2, 31), 1);
  assert.equal(result, Date.UTC(2024, 1, 29));
});

test("subtractYears crossing a leap day yields a calendar-correct 366-day span", () => {
  // 2028-03-01 − 1y must land on 2027-03-01. That interval contains Feb 29
  // 2028 (2028 is a leap year), so it spans 366 days — fixed 365-day
  // arithmetic would instead land a day later, on 2027-03-02.
  const now = Date.UTC(2028, 2, 1);
  const cutoff = subtractYears(now, 1);
  assert.equal(cutoff, Date.UTC(2027, 2, 1));
  assert.notEqual(cutoff, now - 365 * 24 * 60 * 60 * 1000);
});

test("subtractYears(2024-02-29, 1) clamps to 2023-02-28", () => {
  const result = subtractYears(Date.UTC(2024, 1, 29), 1);
  assert.equal(result, Date.UTC(2023, 1, 28));
});

test("subtractMonths(x, 12) equals subtractYears(x, 1)", () => {
  const now = Date.UTC(2026, 7, 2, 10, 0);
  assert.equal(subtractMonths(now, 12), subtractYears(now, 1));
});
