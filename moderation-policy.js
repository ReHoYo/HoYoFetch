// moderation-policy.js — shared Post Gate and Automod posture
// ────────────────────────────────────────────────────────────────────────────
// Keep this module dependency-free. Both moderation engines and the shared
// raid coordinator consume it, so importing either engine here would create a
// cycle and make the effective policy harder to reason about.

const MINUTE = 60 * 1_000;
const DAY = 24 * 60 * MINUTE;

export const RAID_MODE_POLICY = Object.freeze({
  joinSurgeCount: 5,
  joinSurgeWindowMs: MINUTE,
  durationMs: 30 * MINUTE,
  refreshThrottleMs: MINUTE,
});

export const MODERATION_LEVEL_POLICIES = Object.freeze({
  1: Object.freeze({
    level: 1,
    name: "Standard",
    recentAccountMs: 7 * DAY,
    recentMemberMs: DAY,
    scoreThreshold: 2,
  }),
  2: Object.freeze({
    level: 2,
    name: "Heightened",
    recentAccountMs: 14 * DAY,
    recentMemberMs: 3 * DAY,
    scoreThreshold: 2,
  }),
  3: Object.freeze({
    level: 3,
    name: "Raid lockdown",
    recentAccountMs: 14 * DAY,
    recentMemberMs: 3 * DAY,
    scoreThreshold: 2,
  }),
  4: Object.freeze({
    level: 4,
    name: "Emergency lockdown",
    recentAccountMs: 14 * DAY,
    recentMemberMs: 3 * DAY,
    scoreThreshold: 2,
  }),
});

export const DEFAULT_MODERATION_POLICY = MODERATION_LEVEL_POLICIES[1];

export function isRaidModeActive(raidMode, now = Date.now()) {
  return (
    Number.isFinite(raidMode?.expiresAt) && Number(raidMode.expiresAt) > now
  );
}

/**
 * Resolve the manually configured Post Gate level and the automatic raid
 * floor into one policy. Post Gate being off keeps configuredLevel at zero,
 * but Automod can still consume the shared Level 2 policy while a persisted
 * raid window is active.
 */
export function resolveModerationPolicy(config = {}, now = Date.now()) {
  const configuredLevel =
    config.mode === "hold" && Number.isInteger(config.level)
      ? Math.min(4, Math.max(1, config.level))
      : 0;
  const raidActive = isRaidModeActive(config.raidMode, now);
  const baselineLevel = configuredLevel || 1;
  const effectiveLevel = Math.max(baselineLevel, raidActive ? 2 : 1);
  const policy =
    MODERATION_LEVEL_POLICIES[effectiveLevel] ?? DEFAULT_MODERATION_POLICY;

  return Object.freeze({
    ...policy,
    configuredLevel,
    effectiveLevel,
    raidActive,
    raidModeStartedAt: raidActive ? config.raidMode.startedAt : null,
    raidModeExpiresAt: raidActive ? config.raidMode.expiresAt : null,
    automaticFloor: raidActive ? 2 : null,
  });
}
