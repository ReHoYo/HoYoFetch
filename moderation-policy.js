// moderation-policy.js — the three server moderation postures
// ────────────────────────────────────────────────────────────────────────────
// Every detection threshold in this bot used to be a frozen constant, so a
// server had exactly one posture no matter what was happening to it. These
// policies are the dial: automod.js, post-gate.js and moderation-level.js all
// read the active one instead of hardcoding limits.
//
// This module deliberately imports nothing. automod.js and post-gate.js both
// consume it, and moderation-level.js consumes automod.js — keeping the table
// dependency-free is what stops that from becoming an import cycle.

const MINUTE = 60 * 1_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Level 1 is the historical policy: its numbers are the same ones that used to
 * live in AUTOMOD_LIMITS, so a server that never runs /Level behaves exactly as
 * it did before levels existed.
 *
 * Levels 2 and 3 keep `scoreThreshold` paired with automod's behavioural-signal
 * requirement rather than replacing it. One signal is enough at level 2, but
 * identity alone (a new account, a raid-window join) still cannot trigger
 * containment at any level — nobody is punished merely for being new.
 */
export const MODERATION_LEVEL_POLICIES = Object.freeze({
  1: Object.freeze({
    level: 1,
    name: "Standard",
    summary:
      "Baseline protection. Links and attachments from new or first-time posters are held for review.",
    holdEveryMessage: false,
    recentAccountMs: 7 * DAY,
    recentMemberMs: DAY,
    scoreThreshold: 2,
    joinSurgeCount: 5,
    raidModeMs: 10 * MINUTE,
    kickNewJoins: false,
    restrictSubTenure: false,
  }),
  2: Object.freeze({
    level: 2,
    name: "Heightened",
    summary:
      "Every message from a new account is held, the new-account window widens, and automod trips on a single behavioural signal.",
    holdEveryMessage: true,
    recentAccountMs: 30 * DAY,
    recentMemberMs: 7 * DAY,
    scoreThreshold: 1,
    joinSurgeCount: 3,
    raidModeMs: 30 * MINUTE,
    kickNewJoins: false,
    restrictSubTenure: false,
  }),
  3: Object.freeze({
    level: 3,
    name: "Lockdown",
    summary:
      "Everything in level 2, plus every new join is kicked and members below the tenure threshold cannot post.",
    holdEveryMessage: true,
    recentAccountMs: 30 * DAY,
    recentMemberMs: 7 * DAY,
    scoreThreshold: 1,
    joinSurgeCount: 3,
    raidModeMs: 30 * MINUTE,
    kickNewJoins: true,
    restrictSubTenure: true,
  }),
});

export const DEFAULT_POLICY = MODERATION_LEVEL_POLICIES[1];

/**
 * Resolve a stored { level, tenureDays } record into an active policy.
 * Anything unrecognised resolves to level 1 — a corrupt record must never be
 * able to put a server into lockdown.
 *
 * @param  {{level?: number, tenureDays?: number}} [config]
 * @return {Object} frozen policy, with the server's tenure threshold applied
 */
export function policyFor(config) {
  // Object keys stringify, so a bare `POLICIES[config.level]` would accept the
  // string "3" as lockdown. Require an actual integer.
  const level = config?.level;
  const base = Number.isInteger(level)
    ? (MODERATION_LEVEL_POLICIES[level] ?? DEFAULT_POLICY)
    : DEFAULT_POLICY;
  const tenureDays = Number(config?.tenureDays);
  const days = Number.isFinite(tenureDays) ? tenureDays : 7;
  return Object.freeze({
    ...base,
    tenureDays: days,
    tenureMs: days * DAY,
  });
}
