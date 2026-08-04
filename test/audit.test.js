import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "revolt.js";
import { ulid } from "ulid";

process.env.HOYOFETCH_DATA_DIR = mkdtempSync(
  join(tmpdir(), "hoyofetch-audit-test-")
);

const {
  buildMemberUpdateAuditSections,
  buildUserIdentityAuditSections,
  claimMemberEvent,
  computeSuspects,
  createMessageCache,
  diffFields,
  emitUserIdentityUpdates,
  formatSuspects,
  getAuditDiagnostics,
  hydrateAuditMemberCache,
  initAuditLog,
  memberIdsFromRawEvent,
  parseChannelArg,
  truncate,
} = await import("../auditlog.js");
const { addProtectedMessage, disableAuditLog, enableAuditLog } =
  await import("../store.js");
const {
  buildAuditBulkDeleteEmbed,
  buildAuditMessageDeleteEmbed,
  buildAuditMessageEditEmbed,
} = await import("../embeds.js");

const CHANNEL_ID = "01HZY3M6Q8V7N2K4J5T9W0XABC";

test("bounded message cache evicts FIFO and refreshes existing keys", () => {
  const cache = createMessageCache(2);
  cache.set("one", { content: "first" });
  cache.set("two", { content: "second" });
  cache.set("one", { content: "updated" });
  cache.set("three", { content: "third" });
  assert.deepEqual([...cache.keys()], ["one", "three"]);
  assert.equal(cache.get("one").content, "updated");
});

test("diffFields omits no-ops and reports selected changes", () => {
  assert.deepEqual(
    diffFields({ name: "general" }, { name: "general" }, ["name"]),
    []
  );
  assert.deepEqual(
    diffFields({ name: "general", nsfw: false }, { name: "chat", nsfw: true }, [
      "name",
      "nsfw",
    ]),
    [
      { field: "name", before: "general", after: "chat" },
      { field: "nsfw", before: false, after: true },
    ]
  );
});

test("audit member hydration enables real SDK nickname and user updates", async () => {
  const client = new Client();
  const serverId = "CACHE_SERVER";
  const userId = "CACHE_USER";
  client.servers.getOrCreate(serverId, {
    _id: serverId,
    owner: userId,
    name: "Cache Test",
    channels: [],
    roles: {},
    default_permissions: 0,
  });
  client.api.get = async (path) => {
    assert.equal(path, `/servers/${serverId}/members`);
    return {
      members: [
        {
          _id: { server: serverId, user: userId },
          joined_at: new Date().toISOString(),
          nickname: "Before",
          roles: [],
        },
      ],
      users: [
        {
          _id: userId,
          username: "OldName",
          discriminator: "0001",
        },
      ],
    };
  };

  assert.equal(
    client.serverMembers.hasByKey({ server: serverId, user: userId }),
    false
  );
  const hydration = await hydrateAuditMemberCache(client, serverId);
  assert.equal(hydration.ok, true);
  assert.equal(hydration.members.length, 1);
  assert.equal(client.users.has(userId), true);
  assert.equal(
    client.serverMembers.hasByKey({ server: serverId, user: userId }),
    true
  );

  const received = [];
  client.on("serverMemberUpdate", (member, previous) =>
    received.push({ type: "member", member, previous })
  );
  client.on("userUpdate", (user, previous) =>
    received.push({ type: "user", user, previous })
  );
  await client.events.emit("event", {
    type: "ServerMemberUpdate",
    id: { server: serverId, user: userId },
    data: { nickname: "After" },
  });
  await client.events.emit("event", {
    type: "UserUpdate",
    id: userId,
    data: { username: "NewName" },
  });

  assert.equal(received[0].type, "member");
  assert.equal(received[0].previous.nickname, "Before");
  assert.equal(received[0].member.nickname, "After");
  assert.equal(received[1].type, "user");
  assert.equal(received[1].previous.username, "OldName");
  assert.equal(received[1].user.username, "NewName");
});

test("user identity sections report username changes", () => {
  const client = {
    configuration: {
      features: { autumn: { url: "https://autumn.test", enabled: true } },
    },
  };
  const sections = buildUserIdentityAuditSections(
    client,
    {
      id: "USER1",
      username: "New`Name\nBounded",
    },
    {
      username: "OldName",
      displayName: "Old Display",
    }
  );

  assert.deepEqual(
    sections.map(({ title }) => title),
    ["🪪 Username Changed"]
  );
  assert.match(sections[0].lines.join("\n"), /NewˋName Bounded/);
  assert.match(sections[0].lines.join("\n"), /Actor.*Unavailable/);

  assert.deepEqual(
    buildUserIdentityAuditSections(
      client,
      { username: "Same", status: "Online" },
      { username: "Same", status: "Idle" }
    ),
    []
  );
});

test("global identity updates route only to confirmed audited memberships", () => {
  enableAuditLog("SERVER_A", "CHANNEL_A");
  enableAuditLog("SERVER_B", "CHANNEL_B");
  const currentUser = {
    id: "USER1",
    username: "NewName",
  };
  const client = {
    user: { id: "BOT" },
    users: new Map([["USER1", currentUser]]),
    serverMembers: {
      hasByKey: ({ server, user }) => server === "SERVER_A" && user === "USER1",
    },
    configuration: {
      features: { autumn: { url: "https://autumn.test", enabled: true } },
    },
  };
  const emitted = [];

  try {
    const count = emitUserIdentityUpdates(
      client,
      currentUser,
      { username: "OldName" },
      (serverId, embed) => emitted.push({ serverId, embed })
    );
    assert.equal(count, 1);
    assert.deepEqual(
      emitted.map(({ serverId }) => serverId),
      ["SERVER_A"]
    );
    assert.deepEqual(
      emitted.map(({ embed }) => embed.title),
      ["🪪 Username Changed"]
    );

    assert.equal(
      emitUserIdentityUpdates(
        { ...client, user: { id: "USER1" } },
        currentUser,
        { username: "OldName" },
        () => assert.fail("self updates must not emit")
      ),
      0
    );
    assert.equal(
      emitUserIdentityUpdates(
        { ...client, serverMembers: { hasByKey: () => false } },
        currentUser,
        { username: "OldName" },
        () => assert.fail("unconfirmed memberships must not emit")
      ),
      0
    );
  } finally {
    disableAuditLog("SERVER_A");
    disableAuditLog("SERVER_B");
  }
});

test("nickname changes coexist with role changes", () => {
  const client = {
    servers: new Map([
      [
        "SERVER_A",
        {
          roles: new Map([
            ["ROLE_OLD", { name: "Old Role" }],
            ["ROLE_NEW", { name: "New Role" }],
          ]),
        },
      ],
    ]),
    configuration: {
      features: { autumn: { url: "https://autumn.test", enabled: true } },
    },
  };
  const sections = buildMemberUpdateAuditSections(
    client,
    {
      id: { server: "SERVER_A", user: "USER1" },
      nickname: "New Nick",
      roles: ["ROLE_NEW"],
      timeout: null,
    },
    {
      nickname: "Old Nick",
      roles: ["ROLE_OLD"],
      timeout: null,
    }
  );

  assert.deepEqual(
    sections.map(({ title }) => title),
    ["✏️ Nickname Changed", "🎭 Member Roles Changed"]
  );
  assert.deepEqual(
    buildMemberUpdateAuditSections(
      client,
      {
        id: { server: "SERVER_A", user: "USER1" },
        nickname: null,
        roles: [],
        timeout: null,
      },
      {
        nickname: null,
        roles: [],
        timeout: null,
      }
    ),
    []
  );
});

test("parseChannelArg preserves valid bare and mentioned ULIDs", () => {
  assert.equal(parseChannelArg(CHANNEL_ID), CHANNEL_ID);
  assert.equal(parseChannelArg(`<#${CHANNEL_ID}>`), CHANNEL_ID);
  assert.equal(parseChannelArg("not-a-channel"), null);
  assert.equal(parseChannelArg("<#01HZY3M6Q8V7N2K4J5T9W0XABI>"), null);
});

test("formatSuspects caps labels and degrades honestly", () => {
  const moderators = Array.from(
    { length: 12 },
    (_, index) => `Mod${index + 1}`
  );
  const result = formatSuspects("Alice", moderators, 6);
  assert.match(
    result,
    /^the author \(Alice\), or one of 12 members with Manage Messages:/
  );
  assert.match(result, /Mod1, Mod2, Mod3, Mod4, Mod5, … \(\+7 more\)$/);
  assert.equal(formatSuspects(null, []), "the author or a moderator");
});

test("computeSuspects uses effective channel permissions and excludes bot and author", async () => {
  const users = new Map([
    ["AUTHOR", { username: "Alice" }],
    ["OWNER", { username: "Owner" }],
    ["MOD", { username: "Moderator" }],
    ["BOT", { username: "HoyoFetch" }],
  ]);
  const channel = { id: CHANNEL_ID, serverId: "SERVER", type: "TextChannel" };
  const makeMember = (userId, canManage) => ({
    id: { server: "SERVER", user: userId },
    hasPermission(target, permission) {
      return target === channel && permission === "ManageMessages" && canManage;
    },
  });
  const server = {
    id: "SERVER",
    ownerId: "OWNER",
    async fetchMembers() {
      return {
        members: [
          makeMember("AUTHOR", true),
          makeMember("OWNER", false),
          makeMember("MOD", true),
          makeMember("BOT", true),
        ],
      };
    },
  };
  channel.server = server;
  const client = {
    user: { id: "BOT" },
    users,
    servers: new Map([[server.id, server]]),
    serverMembers: { values: () => [][Symbol.iterator]() },
  };

  assert.deepEqual(await computeSuspects(client, channel, "AUTHOR"), {
    authorLabel: "@Alice",
    moderatorLabels: ["@Moderator", "@Owner"],
  });
});

test("audit message builders bound content and explain uncached deletes", () => {
  const edited = buildAuditMessageEditEmbed({
    author: "@Alice",
    channelId: CHANNEL_ID,
    before: "a".repeat(2_000),
    after: "b".repeat(2_000),
  });
  assert.ok(edited.description.length <= 2_000);

  const deleted = buildAuditMessageDeleteEmbed({
    channelId: CHANNEL_ID,
    messageId: "MESSAGE123",
    content: undefined,
  });
  assert.match(
    deleted.description,
    /content unavailable — sent before the bot started or expired from cache/
  );
  assert.match(deleted.description, /Possible deleter \(heuristic/);
  assert.ok(deleted.description.length <= 2_000);
  assert.equal(truncate("abcdef", 3), "abc… *(truncated)*");
});

test("bulk delete embeds show at most five cached entries", () => {
  const embed = buildAuditBulkDeleteEmbed({
    channelId: CHANNEL_ID,
    count: 8,
    entries: Array.from({ length: 8 }, (_, index) => `entry-${index + 1}`),
    suspects: "a moderator",
  });
  assert.match(embed.description, /entry-5/);
  assert.doesNotMatch(embed.description, /entry-6/);
  assert.match(embed.description, /…and 3 more/);
});

async function waitForSend(sent, count = 1, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (sent.length < count) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for send");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("bulk delete references Stoat archive cards without re-uploading", async () => {
  const serverId = "BULKATTACH_SERVER";
  const sourceChannelId = "BULKATTACH_SOURCE";
  const auditChannelId = "BULKATTACH_AUDIT";

  const rawListeners = [];
  const listeners = new Map();
  const client = {
    user: { id: "BOT1" },
    users: new Map(),
    servers: new Map(),
    channels: new Map([
      [sourceChannelId, { id: sourceChannelId, serverId, type: "TextChannel" }],
    ]),
    configuration: { features: { autumn: { url: "https://autumn.test" } } },
    authenticationHeader: ["X-Bot-Token", "secret"],
    events: {
      on(name, listener) {
        if (name === "event") rawListeners.push(listener);
      },
    },
    on(name, listener) {
      const existing = listeners.get(name) ?? [];
      existing.push(listener);
      listeners.set(name, existing);
    },
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args);
    },
    emitRaw(event) {
      return Promise.all(rawListeners.map((listener) => listener(event)));
    },
  };

  enableAuditLog(serverId, auditChannelId);
  const sent = [];
  let uploadCount = 0;
  initAuditLog(client, {
    sendProtected: async (chId, payload) => {
      sent.push({ chId, payload });
      const result = { _id: `SENT${sent.length}` };
      addProtectedMessage(chId, result._id, payload);
      return result;
    },
    request: async () => ({ ok: false, status: 404, data: undefined }),
    fetchImpl: async (url, options) => {
      if (options?.method === "POST") {
        uploadCount += 1;
        return { ok: true, json: async () => ({ id: `NEWATT${uploadCount}` }) };
      }
      return {
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("fake-bytes").buffer,
      };
    },
  });

  const MESSAGE_COUNT = 12;
  const ids = [];
  for (let i = 1; i <= MESSAGE_COUNT; i++) {
    const id = `BULKMSG${i}`;
    ids.push(id);
    client.emit("messageCreate", {
      id,
      channelId: sourceChannelId,
      authorId: "SPAMMER1",
      content: "",
      attachments: [
        {
          id: `ATT${i}`,
          filename: `proof${i}.png`,
          size: 500,
          contentType: "image/png",
          url: `https://autumn.test/attachments/ATT${i}`,
        },
      ],
    });
  }
  await client.emitRaw({
    type: "BulkMessageDelete",
    channel: sourceChannelId,
    ids,
  });
  await waitForSend(sent, MESSAGE_COUNT);
  const deadline = Date.now() + 1_000;
  while (!sent.some(({ payload }) => /Bulk/.test(payload.embeds?.[0]?.title))) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for bulk log");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(uploadCount, MESSAGE_COUNT);
  assert.equal(
    sent.filter(({ payload }) => payload.attachments?.length === 1).length,
    MESSAGE_COUNT
  );
  const { payload } = sent.find(({ payload }) =>
    /Bulk/.test(payload.embeds?.[0]?.title)
  );
  const description = payload.embeds[0].description;
  assert.match(description, /\*\*Attachments:\*\*/);
  assert.equal(payload.attachments, undefined);
  assert.equal(payload.replies.length, 5);
  assert.match(description, /archived in Logger record/);

  disableAuditLog(serverId);
});

test("the enriched join log carries account details and flips to review on signals", async () => {
  const client = new Client();
  const serverId = "JOIN_SERVER";
  const channelId = "JOIN_LOG_CHANNEL";
  const cleanUserId = "01HZY3M6Q8V7N2K4J5T9W0XABD";

  enableAuditLog(serverId, channelId);
  const sent = [];
  initAuditLog(client, {
    sendProtected: async (chId, payload) => {
      sent.push({ chId, payload });
      return { _id: `SENT${sent.length}` };
    },
    request: async () => ({ ok: false, status: 404, data: undefined }),
  });

  client.users.getOrCreate(cleanUserId, {
    _id: cleanUserId,
    username: "EstablishedMember",
    discriminator: "0001",
    avatar: { _id: "FILE1", tag: "avatars" },
  });
  const cleanMember = client.serverMembers.getOrCreate(
    { server: serverId, user: cleanUserId },
    {
      _id: { server: serverId, user: cleanUserId },
      joined_at: new Date().toISOString(),
      roles: [],
    }
  );

  client.emit("serverMemberJoin", cleanMember);
  await waitForSend(sent, 1);

  const cleanEmbed = sent[0].payload.embeds[0];
  assert.equal(cleanEmbed.title, "📥 Member Joined");
  assert.match(cleanEmbed.description, /\*\*Account created:\*\*/);
  assert.match(cleanEmbed.description, /\*\*Joined this server:\*\*/);
  assert.doesNotMatch(cleanEmbed.description, /⚠️ Signals/);
  // The join log stays compact (verbose: false) and cache-only — it must
  // never render /Get-Info's archive-backed message count, which would
  // require a full archive scan on every join.
  assert.doesNotMatch(cleanEmbed.description, /Messages sent/);
  assert.doesNotMatch(cleanEmbed.description, /\*\*User ID:\*\*/);

  const freshUserId = ulid(); // minted "now" so the recent-account signal fires
  client.users.getOrCreate(freshUserId, {
    _id: freshUserId,
    username: "BrandNewAccount",
    discriminator: "0002",
  });
  const freshMember = client.serverMembers.getOrCreate(
    { server: serverId, user: freshUserId },
    {
      _id: { server: serverId, user: freshUserId },
      joined_at: new Date().toISOString(),
      roles: [],
    }
  );

  client.emit("serverMemberJoin", freshMember);
  await waitForSend(sent, 2);

  const flaggedEmbed = sent[1].payload.embeds[0];
  assert.equal(flaggedEmbed.title, "📥 Member Joined — review");
  assert.match(flaggedEmbed.description, /⚠️ Signals/);
  assert.match(flaggedEmbed.description, /Using the default avatar/);

  disableAuditLog(serverId);
});

// ── Member joins and leaves ─────────────────────────
// Both paths reach the audit channel from two independent sources (the raw
// gateway stream and revolt.js's hydrated listener), because either one can
// silently swallow the event. These cover the raw source, the fallbacks, the
// dedupe between them, and the drop accounting that makes a miss visible.

function createMemberEventClient() {
  const rawListeners = [];
  const listeners = new Map();
  return {
    user: { id: "BOT1" },
    users: new Map(),
    servers: new Map(),
    channels: new Map(),
    events: {
      on(name, listener) {
        if (name === "event") rawListeners.push(listener);
      },
    },
    on(name, listener) {
      const existing = listeners.get(name) ?? [];
      existing.push(listener);
      listeners.set(name, existing);
    },
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args);
    },
    emitRaw(event) {
      return Promise.all(rawListeners.map((listener) => listener(event)));
    },
  };
}

function attachMemberAudit(client) {
  const sent = [];
  initAuditLog(client, {
    sendProtected: async (chId, payload) => {
      sent.push({ chId, payload });
      return { _id: `SENT${sent.length}` };
    },
    request: async () => ({ ok: false, status: 404, data: undefined }),
  });
  return sent;
}

test("member ids are read from every ServerMemberLeave payload shape", () => {
  assert.deepEqual(memberIdsFromRawEvent({ id: "SRV", user: "USR" }), {
    serverId: "SRV",
    userId: "USR",
  });
  assert.deepEqual(
    memberIdsFromRawEvent({ id: { server: "SRV", user: "USR" } }),
    { serverId: "SRV", userId: "USR" }
  );
  assert.deepEqual(memberIdsFromRawEvent({ server: "SRV", user_id: "USR" }), {
    serverId: "SRV",
    userId: "USR",
  });
  assert.deepEqual(memberIdsFromRawEvent({ type: "ServerMemberLeave" }), {
    serverId: null,
    userId: null,
  });
});

test("a raw departure is logged with the verdict the server reported", async () => {
  const client = createMemberEventClient();
  const serverId = "LEAVE_SERVER";
  enableAuditLog(serverId, "LEAVE_LOG_CHANNEL");
  const sent = attachMemberAudit(client);

  await client.emitRaw({
    type: "ServerMemberLeave",
    id: serverId,
    user: "LEAVER1",
    reason: "Leave",
  });
  await client.emitRaw({
    type: "ServerMemberLeave",
    id: serverId,
    user: "LEAVER2",
    reason: "Kick",
  });
  await client.emitRaw({
    type: "ServerMemberLeave",
    id: serverId,
    user: "LEAVER3",
  });
  await waitForSend(sent, 3);

  assert.equal(sent[0].payload.embeds[0].title, "📤 Member Left");
  assert.equal(sent[1].payload.embeds[0].title, "🥾 Member Kicked");
  assert.equal(
    sent[2].payload.embeds[0].title,
    "📤 Member Left or Was Removed"
  );
  assert.match(
    sent[2].payload.embeds[0].description,
    /reason not provided by server/
  );
  assert.equal(sent[0].chId, "LEAVE_LOG_CHANNEL");

  disableAuditLog(serverId);
});

test("a departure carrying the composite id shape still logs", async () => {
  const client = createMemberEventClient();
  const serverId = "LEAVESHAPE_SERVER";
  enableAuditLog(serverId, "LEAVESHAPE_CHANNEL");
  const sent = attachMemberAudit(client);

  await client.emitRaw({
    type: "ServerMemberLeave",
    id: { server: serverId, user: "SHAPELEAVER" },
    reason: "Leave",
  });
  await waitForSend(sent, 1);

  assert.equal(sent[0].payload.embeds[0].title, "📤 Member Left");
  assert.match(sent[0].payload.embeds[0].description, /SHAPELEAVER/);

  disableAuditLog(serverId);
});

test("dropped departures are counted instead of vanishing", async () => {
  const client = createMemberEventClient();
  const serverId = "LEAVEDROP_SERVER";
  enableAuditLog(serverId, "LEAVEDROP_CHANNEL");
  const sent = attachMemberAudit(client);

  const before = getAuditDiagnostics(serverId).memberEvents.leavesDropped;

  // Unreadable payload — the failure the counter exists to surface.
  await client.emitRaw({ type: "ServerMemberLeave", id: serverId });
  await client.emitRaw({ type: "ServerMemberLeave", user: "NOSERVER" });
  // Expected non-events: the bot's own departure and an unaudited server must
  // not count, or a real malformed-payload drop is buried in the noise.
  await client.emitRaw({
    type: "ServerMemberLeave",
    id: serverId,
    user: "BOT1",
  });
  await client.emitRaw({
    type: "ServerMemberLeave",
    id: "NEVER_ENABLED_SERVER",
    user: "SOMEONE",
  });

  const after = getAuditDiagnostics(serverId).memberEvents;
  assert.equal(sent.length, 0);
  assert.equal(after.leavesDropped - before, 2);
  assert.equal(after.lastDropReason, "leave:no_server_id");
  assert.ok(after.lastLeaveSeenAt);

  disableAuditLog(serverId);
});

test("the raw stream logs a join revolt.js never emitted", async () => {
  const client = createMemberEventClient();
  const serverId = "RAWJOIN_SERVER";
  const userId = "01HZY3M6Q8V7N2K4J5T9W0XABE";
  enableAuditLog(serverId, "RAWJOIN_CHANNEL");
  const sent = attachMemberAudit(client);

  client.users.set(userId, {
    id: userId,
    username: "RawJoiner",
    avatar: { _id: "FILE1", tag: "avatars" },
  });

  // No client.emit("serverMemberJoin") — this is the case where revolt.js
  // dropped the hydrated event because users.fetch() rejected.
  await client.emitRaw({
    type: "ServerMemberJoin",
    id: serverId,
    user: userId,
  });
  await waitForSend(sent, 1, 3_000);

  assert.equal(sent[0].payload.embeds[0].title, "📥 Member Joined");
  assert.match(sent[0].payload.embeds[0].description, /@RawJoiner/);
  assert.ok(getAuditDiagnostics(serverId).memberEvents.lastJoinPostedAt);

  disableAuditLog(serverId);
});

test("a join delivered by both sources is logged exactly once", async () => {
  const client = createMemberEventClient();
  const serverId = "DEDUPEJOIN_SERVER";
  const userId = "01HZY3M6Q8V7N2K4J5T9W0XABF";
  enableAuditLog(serverId, "DEDUPEJOIN_CHANNEL");
  const sent = attachMemberAudit(client);

  client.users.set(userId, {
    id: userId,
    username: "DoubleJoiner",
    avatar: { _id: "FILE1", tag: "avatars" },
  });

  client.emit("serverMemberJoin", {
    id: { server: serverId, user: userId },
    joinedAt: new Date(),
    roles: [],
  });
  await waitForSend(sent, 1);
  await client.emitRaw({
    type: "ServerMemberJoin",
    id: serverId,
    user: userId,
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.embeds[0].title, "📥 Member Joined");

  disableAuditLog(serverId);
});

test("a departure delivered by both sources is logged exactly once", async () => {
  const client = createMemberEventClient();
  const serverId = "DEDUPELEAVE_SERVER";
  enableAuditLog(serverId, "DEDUPELEAVE_CHANNEL");
  const sent = attachMemberAudit(client);

  await client.emitRaw({
    type: "ServerMemberLeave",
    id: serverId,
    user: "DOUBLELEAVER",
    reason: "Leave",
  });
  await waitForSend(sent, 1);
  client.emit("serverMemberLeave", {
    id: { server: serverId, user: "DOUBLELEAVER" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sent.length, 1);

  disableAuditLog(serverId);
});

test("a throwing member listener is reported instead of lost", async () => {
  const client = createMemberEventClient();
  const serverId = "GUARD_SERVER";
  enableAuditLog(serverId, "GUARD_CHANNEL");
  attachMemberAudit(client);

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    // A member object with no id at all is the shape that used to throw
    // straight past revolt.js into an unhandled rejection.
    assert.doesNotThrow(() => client.emit("serverMemberUpdate", null, {}));
  } finally {
    console.error = originalError;
  }

  assert.ok(
    errors.some((line) => line.includes("member update handler failed"))
  );

  disableAuditLog(serverId);
});

test("the same departure delivered twice in a row is deduped", async () => {
  const client = createMemberEventClient();
  const serverId = "REJOIN_SERVER";
  const userId = "REVOLVING_MEMBER";
  enableAuditLog(serverId, "REJOIN_CHANNEL");
  const sent = attachMemberAudit(client);

  const leave = () =>
    client.emitRaw({
      type: "ServerMemberLeave",
      id: serverId,
      user: userId,
      reason: "Leave",
    });

  await leave();
  await waitForSend(sent, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await leave();

  assert.equal(sent.length, 1, "the same departure redelivered is deduped");

  disableAuditLog(serverId);
});

test("a member event claim expires so a rejoin is not deduped away", () => {
  const key = ["leave", "TTL_SERVER", "TTL_MEMBER"];
  const at = 1_000_000;

  assert.equal(claimMemberEvent(...key, at), true);
  // The second source for the same departure, moments later.
  assert.equal(claimMemberEvent(...key, at + 500), false);
  // A genuinely separate departure after the member rejoined. Keying on
  // server+user with no expiry would swallow this one.
  assert.equal(claimMemberEvent(...key, at + 60_000), true);
  assert.equal(claimMemberEvent(...key, at + 60_500), false);
});
