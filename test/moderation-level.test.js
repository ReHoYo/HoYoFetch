// Tests for /Level: the three moderation postures, the typed confirmation and
// automod-log-channel preconditions that guard lockdown, and level 3's two
// enforcement paths — kicking new joins and restricting sub-tenure members.
// The kick and the delete are both destructive, so most of these tests are
// about the cases where enforcement must NOT happen.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOYOFETCH_DATA_DIR = mkdtempSync(
  join(tmpdir(), "hoyofetch-moderation-level-test-")
);

const { createModerationLevel, STRIKE_COOLDOWN_MS } =
  await import("../moderation-level.js");
const { MODERATION_LEVEL_POLICIES, policyFor } =
  await import("../moderation-policy.js");

const SERVER_ID = "SERVER123";
const CHANNEL_ID = "CHANNEL123";
const LOG_CHANNEL_ID = "LOGCHANNEL123";
const EXCLUDED_CHANNEL_ID = "EXCLUDEDCHANNEL123";
const BOT_ID = "BOT123";
const OWNER_ID = "OWNER123";
const ADMIN_ID = "ADMIN123";
const JOINER_ID = "JOINER123";
const MOD_ID = "MODUSER123";
const DAY = 24 * 60 * 60 * 1_000;

const TIMEOUT_MEMBERS_BIT = 2 ** 8;

function makeStore({
  level = 1,
  tenureDays = 7,
  logChannelId = LOG_CHANNEL_ID,
} = {}) {
  const levels = new Map([
    [SERVER_ID, { level, tenureDays, updatedAt: null, updatedBy: null }],
  ]);
  const strikes = new Map();
  return {
    levels,
    strikes,
    getModerationLevel(serverId) {
      return (
        levels.get(serverId) ?? {
          level: 1,
          tenureDays: 7,
          updatedAt: null,
          updatedBy: null,
        }
      );
    },
    setModerationLevel(serverId, patch) {
      const previous = this.getModerationLevel(serverId);
      const current = { ...previous, ...patch, updatedAt: "now" };
      levels.set(serverId, current);
      return { previous, current };
    },
    getAutomodConfig() {
      return { mode: "enforce", logChannelId, quorum: 2, updatedAt: null };
    },
    isChannelExcluded: (channelId) => channelId === EXCLUDED_CHANNEL_ID,
    getAutomodStrike(serverId, userId) {
      const record = strikes.get(`${serverId}:${userId}`);
      return record ? structuredClone(record) : null;
    },
    setAutomodStrike(serverId, userId, record) {
      const stored = { serverId, userId, ...structuredClone(record) };
      strikes.set(`${serverId}:${userId}`, stored);
      return structuredClone(stored);
    },
  };
}

function makeHarness({
  level = 1,
  tenureDays = 7,
  logChannelId = LOG_CHANNEL_ID,
  clock = 1_800_000_000_000,
  memberFetchFails = false,
  kickFails = false,
} = {}) {
  let current = clock;
  const store = makeStore({ level, tenureDays, logChannelId });
  const requests = [];
  const protectedLogs = [];

  const client = {
    user: { id: BOT_ID },
    users: new Map(),
    api: {
      async get(path) {
        if (path === `/servers/${SERVER_ID}`) {
          return {
            _id: SERVER_ID,
            owner: OWNER_ID,
            default_permissions: 0,
            roles: {
              MODROLE: {
                rank: 1,
                permissions: { a: TIMEOUT_MEMBERS_BIT, d: 0 },
              },
            },
          };
        }
        const memberMatch = path.match(
          new RegExp(`^/servers/${SERVER_ID}/members/([A-Za-z0-9]+)$`)
        );
        if (memberMatch) {
          if (memberFetchFails) throw new Error("member fetch unavailable");
          const userId = memberMatch[1];
          return {
            _id: { server: SERVER_ID, user: userId },
            joined_at: new Date(current - 2 * DAY).toISOString(),
            roles: userId === MOD_ID ? ["MODROLE"] : [],
          };
        }
        const channelMatch = path.match(/^\/channels\/([A-Za-z0-9]+)$/);
        if (channelMatch) {
          return {
            _id: channelMatch[1],
            channel_type: "TextChannel",
            server: SERVER_ID,
            default_permissions: { a: 0, d: 0 },
            role_permissions: {},
          };
        }
        const userMatch = path.match(/^\/users\/([A-Za-z0-9]+)$/);
        if (userMatch) {
          return {
            _id: userMatch[1],
            ...(userMatch[1] === "BOTJOINER123"
              ? { bot: { owner: OWNER_ID } }
              : {}),
          };
        }
        throw new Error(`unexpected path ${path}`);
      },
    },
  };

  const moderationLevel = createModerationLevel(client, {
    sendProtected: async (channelId, payload) => {
      protectedLogs.push({ channelId, payload });
      return { _id: `PROTECTED${protectedLogs.length}` };
    },
    request: async (method, path, body) => {
      requests.push({ method, path, body });
      if (method === "DELETE" && path.includes("/members/")) {
        return kickFails ? { ok: false, status: 403 } : { ok: true };
      }
      return { ok: true };
    },
    store,
    logger: { log() {}, warn() {} },
    now: () => current,
  });

  return {
    moderationLevel,
    store,
    requests,
    protectedLogs,
    kicks: () =>
      requests.filter(
        (entry) => entry.method === "DELETE" && entry.path.includes("/members/")
      ),
    deletedMessages: () =>
      requests.filter(
        (entry) =>
          entry.method === "DELETE" && entry.path.includes("/messages/")
      ),
    advance(ms) {
      current += ms;
    },
    now: () => current,
  };
}

function adminMessage(args = []) {
  return { message: { server: { id: SERVER_ID }, authorId: ADMIN_ID }, args };
}

function memberMessage({
  id = "MSG1",
  authorId = JOINER_ID,
  channelId = CHANNEL_ID,
  joinedAgoMs = 2 * DAY,
  clock = 1_800_000_000_000,
} = {}) {
  return {
    id,
    channelId,
    server: { id: SERVER_ID },
    authorId,
    content: "hello",
    member: { joinedAt: new Date(clock - joinedAgoMs) },
  };
}

// ── Policy table ─────────────────────────────────────────────

test("an unknown or corrupt stored level resolves to standard, never lockdown", () => {
  for (const value of [
    undefined,
    null,
    {},
    { level: 0 },
    { level: 4 },
    { level: "3" },
  ]) {
    assert.equal(policyFor(value).level, 1);
    assert.equal(policyFor(value).kickNewJoins, false);
  }
  assert.equal(policyFor({ level: 3, tenureDays: 5 }).tenureMs, 5 * DAY);
});

test("each level is strictly stricter than the one below it", () => {
  const [one, two, three] = [1, 2, 3].map(
    (level) => MODERATION_LEVEL_POLICIES[level]
  );
  assert.equal(one.holdEveryMessage, false);
  assert.equal(two.holdEveryMessage, false);
  assert.equal(three.holdEveryMessage, false);
  assert.ok(two.recentAccountMs > one.recentAccountMs);
  assert.ok(two.scoreThreshold < one.scoreThreshold);
  assert.ok(two.joinSurgeCount < one.joinSurgeCount);
  assert.equal(one.kickNewJoins, false);
  assert.equal(two.kickNewJoins, false);
  assert.equal(three.kickNewJoins, true);
  assert.equal(three.restrictSubTenure, true);
});

// ── Command ──────────────────────────────────────────────────

test("level 3 refuses to apply without the literal confirmation", async () => {
  const harness = makeHarness();
  const { message } = adminMessage();

  const embed = await harness.moderationLevel.handleCommand(message, ["3"]);
  assert.match(embed.title, /Requires Confirmation/);
  assert.equal(harness.store.getModerationLevel(SERVER_ID).level, 1);
  assert.equal(harness.protectedLogs.length, 0);

  const confirmed = await harness.moderationLevel.handleCommand(message, [
    "3",
    "confirm",
  ]);
  assert.match(confirmed.title, /Lockdown Enabled/);
  assert.equal(harness.store.getModerationLevel(SERVER_ID).level, 3);
  assert.equal(harness.protectedLogs.length, 1);
  assert.match(
    harness.protectedLogs[0].payload.embeds[0].title,
    /Moderation Level Set/
  );
});

test("lockdown is refused when automod has no log channel to record kicks in", async () => {
  const harness = makeHarness({ logChannelId: null });
  const { message } = adminMessage();

  const embed = await harness.moderationLevel.handleCommand(message, [
    "3",
    "confirm",
  ]);
  assert.match(embed.title, /Lockdown Unavailable/);
  assert.equal(harness.store.getModerationLevel(SERVER_ID).level, 1);
});

test("levels 1 and 2 apply without confirmation and announce the change", async () => {
  const harness = makeHarness();
  const { message } = adminMessage();

  const raised = await harness.moderationLevel.handleCommand(message, ["2"]);
  assert.match(raised.title, /Heightened/);
  assert.equal(harness.store.getModerationLevel(SERVER_ID).level, 2);

  const stood_down = await harness.moderationLevel.handleCommand(message, [
    "1",
  ]);
  assert.match(stood_down.title, /Standard/);
  assert.equal(harness.store.getModerationLevel(SERVER_ID).level, 1);
  assert.equal(harness.protectedLogs.length, 2);
});

test("the tenure threshold is clamped to a sane range", async () => {
  const harness = makeHarness();
  const { message } = adminMessage();

  for (const bad of ["0", "31", "abc", "7.5"]) {
    const embed = await harness.moderationLevel.handleCommand(message, [
      "tenure",
      bad,
    ]);
    assert.match(embed.title, /Invalid Tenure Threshold/, `rejected ${bad}`);
  }
  assert.equal(harness.store.getModerationLevel(SERVER_ID).tenureDays, 7);

  const embed = await harness.moderationLevel.handleCommand(message, [
    "tenure",
    "14",
  ]);
  assert.match(embed.title, /Tenure Threshold Updated/);
  assert.equal(harness.store.getModerationLevel(SERVER_ID).tenureDays, 14);
});

test("status reports the active level without changing it", async () => {
  const harness = makeHarness({ level: 3, tenureDays: 10 });
  const { message } = adminMessage();

  const embed = await harness.moderationLevel.handleCommand(message, [
    "status",
  ]);
  assert.match(embed.description, /Level 3 — Lockdown/);
  assert.match(embed.description, /under 10d/);
  assert.equal(harness.store.getModerationLevel(SERVER_ID).level, 3);
  assert.equal(harness.protectedLogs.length, 0);
});

// ── Level 3: joins ───────────────────────────────────────────

test("lockdown kicks an ordinary new join and records it", async () => {
  const harness = makeHarness({ level: 3 });

  await harness.moderationLevel.handleMemberJoin({
    id: { server: SERVER_ID, user: JOINER_ID },
  });

  assert.deepEqual(
    harness.kicks().map((entry) => entry.path),
    [`/servers/${SERVER_ID}/members/${JOINER_ID}`]
  );
  assert.equal(harness.protectedLogs.length, 1);
  assert.match(
    harness.protectedLogs[0].payload.embeds[0].title,
    /Member Kicked/
  );
});

test("lockdown never kicks bots or verified moderators", async () => {
  const harness = makeHarness({ level: 3 });

  await harness.moderationLevel.handleMemberJoin({
    id: { server: SERVER_ID, user: "BOTJOINER123" },
    user: { bot: true },
  });
  await harness.moderationLevel.handleMemberJoin({
    id: { server: SERVER_ID, user: MOD_ID },
  });

  assert.equal(harness.kicks().length, 0);
  assert.equal(harness.protectedLogs.length, 0);
});

test("an unverifiable joiner is reported rather than kicked", async () => {
  const harness = makeHarness({ level: 3, memberFetchFails: true });

  await harness.moderationLevel.handleMemberJoin({
    id: { server: SERVER_ID, user: JOINER_ID },
  });

  assert.equal(harness.kicks().length, 0);
  assert.equal(harness.protectedLogs.length, 1);
  assert.match(
    harness.protectedLogs[0].payload.embeds[0].title,
    /Join Not Actioned/
  );
});

test("a rejected kick is reported instead of being silently swallowed", async () => {
  const harness = makeHarness({ level: 3, kickFails: true });

  await harness.moderationLevel.handleMemberJoin({
    id: { server: SERVER_ID, user: JOINER_ID },
  });

  assert.equal(harness.kicks().length, 1);
  assert.match(harness.protectedLogs[0].payload.embeds[0].title, /Kick Failed/);
});

test("levels below 3 never touch a joining member", async () => {
  for (const level of [1, 2]) {
    const harness = makeHarness({ level });
    await harness.moderationLevel.handleMemberJoin({
      id: { server: SERVER_ID, user: JOINER_ID },
    });
    assert.equal(harness.kicks().length, 0, `level ${level}`);
    assert.equal(harness.protectedLogs.length, 0, `level ${level}`);
  }
});

// ── Level 3: sub-tenure messages ─────────────────────────────

test("lockdown deletes a sub-tenure message and raises one strike", async () => {
  const harness = makeHarness({ level: 3 });

  await harness.moderationLevel.handleMessage(memberMessage({ id: "MSGNEW1" }));

  assert.deepEqual(
    harness.deletedMessages().map((entry) => entry.path),
    [`/channels/${CHANNEL_ID}/messages/MSGNEW1`]
  );
  assert.equal(harness.store.getAutomodStrike(SERVER_ID, JOINER_ID).level, 1);
  assert.equal(harness.protectedLogs.length, 1);
  assert.match(
    harness.protectedLogs[0].payload.embeds[0].title,
    /Message Restricted/
  );
});

test("a burst of sub-tenure messages is deleted but escalates only once per window", async () => {
  const harness = makeHarness({ level: 3 });

  for (let index = 0; index < 4; index += 1) {
    await harness.moderationLevel.handleMessage(
      memberMessage({ id: `MSGBURST${index}` })
    );
    harness.advance(1_000);
  }

  assert.equal(harness.deletedMessages().length, 4);
  assert.equal(harness.store.getAutomodStrike(SERVER_ID, JOINER_ID).level, 1);
  assert.equal(harness.protectedLogs.length, 1);

  // Once the cooldown lapses, a further message escalates again.
  harness.advance(STRIKE_COOLDOWN_MS);
  await harness.moderationLevel.handleMessage(
    memberMessage({ id: "MSGAFTERCOOLDOWN", clock: harness.now() })
  );
  assert.equal(harness.store.getAutomodStrike(SERVER_ID, JOINER_ID).level, 2);
  assert.equal(harness.protectedLogs.length, 2);
});

test("lockdown leaves members past the tenure threshold alone", async () => {
  const harness = makeHarness({ level: 3, tenureDays: 7 });

  await harness.moderationLevel.handleMessage(
    memberMessage({ id: "MSGOLD1", joinedAgoMs: 30 * DAY })
  );

  assert.equal(harness.deletedMessages().length, 0);
  assert.equal(harness.store.getAutomodStrike(SERVER_ID, JOINER_ID), null);
});

test("lockdown does not act on an unknown join date, a moderator, or an excluded channel", async () => {
  const harness = makeHarness({ level: 3 });

  const unknownJoin = memberMessage({ id: "MSGUNKNOWN" });
  delete unknownJoin.member;
  await harness.moderationLevel.handleMessage(unknownJoin);
  await harness.moderationLevel.handleMessage(
    memberMessage({ id: "MSGMOD", authorId: MOD_ID })
  );
  await harness.moderationLevel.handleMessage(
    memberMessage({ id: "MSGEXCLUDED", channelId: EXCLUDED_CHANNEL_ID })
  );
  await harness.moderationLevel.handleMessage(
    memberMessage({ id: "MSGINLOG", channelId: LOG_CHANNEL_ID })
  );

  assert.equal(harness.deletedMessages().length, 0);
  assert.equal(harness.protectedLogs.length, 0);
});

test("an unverifiable author's message is left in place", async () => {
  const harness = makeHarness({ level: 3, memberFetchFails: true });

  await harness.moderationLevel.handleMessage(
    memberMessage({ id: "MSGUNVER" })
  );

  assert.equal(harness.deletedMessages().length, 0);
  assert.equal(harness.store.getAutomodStrike(SERVER_ID, JOINER_ID), null);
});

test("levels below 3 never restrict a sub-tenure member", async () => {
  for (const level of [1, 2]) {
    const harness = makeHarness({ level });
    await harness.moderationLevel.handleMessage(
      memberMessage({ id: `MSGLVL${level}` })
    );
    assert.equal(harness.deletedMessages().length, 0, `level ${level}`);
  }
});
