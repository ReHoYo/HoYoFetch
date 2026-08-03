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
  computeSuspects,
  createMessageCache,
  diffFields,
  emitUserIdentityUpdates,
  formatSuspects,
  hydrateAuditMemberCache,
  initAuditLog,
  parseChannelArg,
  truncate,
} = await import("../auditlog.js");
const { disableAuditLog, enableAuditLog } = await import("../store.js");
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

test("bulk delete preserves attachment evidence up to a per-event cap", async () => {
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
      for (const listener of rawListeners) listener(event);
    },
  };

  enableAuditLog(serverId, auditChannelId);
  const sent = [];
  let uploadCount = 0;
  initAuditLog(client, {
    sendProtected: async (chId, payload) => {
      sent.push({ chId, payload });
      return { _id: `SENT${sent.length}` };
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
  // messageCreate's handler is async but emit() doesn't await it, so give
  // evidence capture a few turns to finish before the bulk delete fires.
  await new Promise((resolve) => setTimeout(resolve, 20));

  client.emitRaw({ type: "BulkMessageDelete", channel: sourceChannelId, ids });
  await waitForSend(sent, 1);

  const { payload } = sent[0];
  const description = payload.embeds[0].description;
  assert.match(description, /\*\*Attachments:\*\*/);
  assert.equal(payload.attachments.length, 10);
  assert.match(description, /re-upload limit was already reached/);

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
