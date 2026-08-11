import test from "node:test";
import assert from "node:assert/strict";
import {
  MODERATION_LEVEL_POLICIES,
  resolveModerationPolicy,
} from "../moderation-policy.js";

const NOW = 1_800_000_000_000;

test("manual levels remain authoritative over the automatic Level 2 floor", () => {
  for (const [configured, expected] of [
    [1, 2],
    [2, 2],
    [3, 3],
    [4, 4],
  ]) {
    const policy = resolveModerationPolicy(
      {
        mode: "hold",
        level: configured,
        raidMode: {
          startedAt: NOW - 1_000,
          lastRefreshAt: NOW - 1_000,
          expiresAt: NOW + 1_000,
        },
      },
      NOW
    );
    assert.equal(policy.configuredLevel, configured);
    assert.equal(policy.effectiveLevel, expected);
  }
});

test("an expired raid window immediately resolves to the configured baseline", () => {
  const policy = resolveModerationPolicy(
    {
      mode: "hold",
      level: 1,
      raidMode: {
        startedAt: NOW - 10_000,
        lastRefreshAt: NOW - 10_000,
        expiresAt: NOW,
      },
    },
    NOW
  );
  assert.equal(policy.raidActive, false);
  assert.equal(policy.effectiveLevel, 1);
});

test("Level 2 widens only the shared identity windows and keeps score two", () => {
  const standard = MODERATION_LEVEL_POLICIES[1];
  const heightened = MODERATION_LEVEL_POLICIES[2];
  assert.equal(standard.recentAccountMs, 7 * 24 * 60 * 60 * 1_000);
  assert.equal(standard.recentMemberMs, 24 * 60 * 60 * 1_000);
  assert.equal(heightened.recentAccountMs, 14 * 24 * 60 * 60 * 1_000);
  assert.equal(heightened.recentMemberMs, 3 * 24 * 60 * 60 * 1_000);
  assert.equal(heightened.scoreThreshold, 2);
});

test("Post Gate off still exposes an active Level 2 policy to Automod", () => {
  const policy = resolveModerationPolicy(
    {
      mode: "off",
      level: 0,
      raidMode: {
        startedAt: NOW,
        lastRefreshAt: NOW,
        expiresAt: NOW + 1_000,
      },
    },
    NOW
  );
  assert.equal(policy.configuredLevel, 0);
  assert.equal(policy.effectiveLevel, 2);
});
