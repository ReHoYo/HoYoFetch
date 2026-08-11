import test from "node:test";
import assert from "node:assert/strict";
import { createRaidModeCoordinator } from "../raid-mode.js";
import { RAID_MODE_POLICY } from "../moderation-policy.js";

const SERVER_ID = "RAIDSERVER123";
const REVIEW_ID = "RAIDREVIEW123";
const AUTOMOD_ID = "RAIDAUTOMOD123";
const START = 1_800_000_000_000;

function makeHarness({
  postGate = true,
  automod = "monitor",
  sameLog = false,
} = {}) {
  let clock = START;
  const configs = new Map([
    [
      SERVER_ID,
      {
        mode: postGate ? "hold" : "off",
        level: postGate ? 1 : 0,
        reviewChannelId: postGate ? REVIEW_ID : null,
        raidMode: null,
        updatedAt: "unchanged",
      },
    ],
  ]);
  const automodConfigs = new Map([
    [
      SERVER_ID,
      {
        mode: automod,
        logChannelId:
          automod === "off" ? null : sameLog ? REVIEW_ID : AUTOMOD_ID,
        quorum: 2,
      },
    ],
  ]);
  const notices = [];
  const timers = [];
  const store = {
    getPostGateConfig(serverId) {
      return structuredClone(
        configs.get(serverId) ?? {
          mode: "off",
          level: 0,
          reviewChannelId: null,
          raidMode: null,
        }
      );
    },
    getAllPostGateConfigs() {
      return [...configs].map(([serverId, config]) => ({
        serverId,
        ...structuredClone(config),
      }));
    },
    getAutomodConfig(serverId) {
      return structuredClone(
        automodConfigs.get(serverId) ?? {
          mode: "off",
          logChannelId: null,
          quorum: 2,
        }
      );
    },
    setPostGateRaidMode(serverId, raidMode) {
      const previous = this.getPostGateConfig(serverId);
      const current = { ...previous, raidMode: structuredClone(raidMode) };
      configs.set(serverId, current);
      return { previous, current };
    },
  };
  const coordinator = createRaidModeCoordinator({
    store,
    now: () => clock,
    sendProtected: async (channelId, payload) => {
      notices.push({ channelId, payload });
    },
    scheduleTimeout(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    logger: { log() {}, warn() {} },
  });

  return {
    coordinator,
    notices,
    store,
    timers,
    get clock() {
      return clock;
    },
    set clock(value) {
      clock = value;
    },
  };
}

function member(index, { bot = false } = {}) {
  return {
    id: { server: SERVER_ID, user: `RAIDUSER${index}` },
    user: bot ? { bot: {} } : {},
  };
}

test("the fifth unique join activates one persisted shared raid window", async () => {
  const harness = makeHarness();
  let result;
  for (let index = 0; index < 5; index += 1) {
    result = await harness.coordinator.handleMemberJoin(member(index));
    harness.clock += 1_000;
  }
  assert.equal(result.outcome, "activated");
  const config = harness.store.getPostGateConfig(SERVER_ID);
  assert.equal(config.raidMode.startedAt, START + 4_000);
  assert.equal(
    config.raidMode.expiresAt,
    START + 4_000 + RAID_MODE_POLICY.durationMs
  );
  assert.equal(result.policy.effectiveLevel, 2);
  assert.deepEqual(
    harness.notices.map((entry) => entry.channelId).sort(),
    [AUTOMOD_ID, REVIEW_ID].sort()
  );
  assert.match(
    harness.notices[0].payload.embeds[0].description,
    /No member was punished/
  );
});

test("duplicate delivery and bot joins do not advance the surge", async () => {
  const harness = makeHarness();
  assert.equal(
    (await harness.coordinator.handleMemberJoin(member(0, { bot: true })))
      .outcome,
    "ignored"
  );
  assert.equal(
    (await harness.coordinator.handleMemberJoin(member(1))).outcome,
    "recorded"
  );
  assert.equal(
    (await harness.coordinator.handleMemberJoin(member(1))).outcome,
    "duplicate"
  );
  for (let index = 2; index < 5; index += 1) {
    await harness.coordinator.handleMemberJoin(member(index));
  }
  assert.equal(harness.store.getPostGateConfig(SERVER_ID).raidMode, null);
});

test("both layers off disables detection while either layer alone enables it", async () => {
  const disabled = makeHarness({ postGate: false, automod: "off" });
  for (let index = 0; index < 5; index += 1) {
    assert.equal(
      (await disabled.coordinator.handleMemberJoin(member(index))).outcome,
      "ignored"
    );
  }
  assert.equal(disabled.store.getPostGateConfig(SERVER_ID).raidMode, null);

  const automodOnly = makeHarness({ postGate: false, automod: "monitor" });
  for (let index = 0; index < 5; index += 1) {
    await automodOnly.coordinator.handleMemberJoin(member(index));
  }
  assert.equal(automodOnly.coordinator.getPolicy(SERVER_ID).effectiveLevel, 2);
  assert.deepEqual(
    automodOnly.notices.map((entry) => entry.channelId),
    [AUTOMOD_ID]
  );
});

test("continuing bursts refresh at most once per minute and never repost activation", async () => {
  const harness = makeHarness();
  for (let index = 0; index < 5; index += 1) {
    await harness.coordinator.handleMemberJoin(member(index));
    harness.clock += 1_000;
  }
  const firstExpiry =
    harness.store.getPostGateConfig(SERVER_ID).raidMode.expiresAt;
  assert.equal(
    (await harness.coordinator.handleMemberJoin(member(5))).outcome,
    "active"
  );
  harness.clock += RAID_MODE_POLICY.refreshThrottleMs;
  let refreshed;
  for (let index = 6; index < 11; index += 1) {
    refreshed = await harness.coordinator.handleMemberJoin(member(index));
  }
  assert.equal(refreshed.outcome, "refreshed");
  assert.ok(refreshed.raidMode.expiresAt > firstExpiry);
  assert.equal(harness.notices.length, 2);
});

test("expiry clears persisted state and sends one deduplicated recovery notice", async () => {
  const harness = makeHarness({ sameLog: true });
  for (let index = 0; index < 5; index += 1) {
    await harness.coordinator.handleMemberJoin(member(index));
    harness.clock += 1_000;
  }
  assert.equal(harness.notices.length, 1);
  harness.clock = harness.store.getPostGateConfig(SERVER_ID).raidMode.expiresAt;
  const result = await harness.coordinator.expireServer(SERVER_ID);
  assert.equal(result.outcome, "expired");
  assert.equal(harness.store.getPostGateConfig(SERVER_ID).raidMode, null);
  assert.equal(harness.notices.length, 2);
  assert.equal(result.policy.effectiveLevel, 1);
});

test("startup preserves active state and cleans up expired state", async () => {
  const active = makeHarness();
  active.store.setPostGateRaidMode(SERVER_ID, {
    startedAt: START - 1_000,
    lastRefreshAt: START - 1_000,
    expiresAt: START + 10_000,
  });
  await active.coordinator.start();
  assert.equal(active.timers.at(-1).delay, 10_000);
  assert.equal(active.coordinator.getPolicy(SERVER_ID).effectiveLevel, 2);

  const expired = makeHarness();
  expired.store.setPostGateRaidMode(SERVER_ID, {
    startedAt: START - 20_000,
    lastRefreshAt: START - 20_000,
    expiresAt: START - 10_000,
  });
  await expired.coordinator.start();
  assert.equal(expired.store.getPostGateConfig(SERVER_ID).raidMode, null);
  assert.equal(expired.notices.length, 2);
});
