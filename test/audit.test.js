import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "revolt.js";

process.env.HOYOFETCH_DATA_DIR = mkdtempSync(
  join(tmpdir(), "hoyofetch-audit-test-")
);

const {
  avatarChangeState,
  buildMemberUpdateAuditSections,
  buildUserIdentityAuditSections,
  computeSuspects,
  createMessageCache,
  diffFields,
  emitUserIdentityUpdates,
  formatSuspects,
  handleAuditLogCommand,
  hydrateAuditMemberCache,
  parseChannelArg,
  snapshotMessage,
  truncate,
} = await import("../auditlog.js");
const { disableAuditLog, enableAuditLog, getAuditLogChannel } =
  await import("../store.js");
const {
  buildAuditBulkDeleteEmbed,
  buildAuditMessageDeleteEmbed,
  buildAuditMessageEditEmbed,
} = await import("../embeds.js");

const CHANNEL_ID = "01HZY3M6Q8V7N2K4J5T9W0XABC";

function avatar(id, url = `https://autumn.test/avatars/${id}`) {
  return { id, createFileURL: () => url };
}

test("bounded message cache evicts FIFO and refreshes existing keys", () => {
  const cache = createMessageCache(2);
  cache.set("one", { content: "first" });
  cache.set("two", { content: "second" });
  cache.set("one", { content: "updated" });
  cache.set("three", { content: "third" });
  assert.deepEqual([...cache.keys()], ["one", "three"]);
  assert.equal(cache.get("one").content, "updated");

  const snapshot = snapshotMessage(
    {
      id: "MESSAGE",
      channelId: CHANNEL_ID,
      authorId: "AUTHOR",
      author: { username: "Alice" },
      content: "hello",
      attachments: [{ filename: "proof.png", size: 1_024 }],
    },
    { id: CHANNEL_ID, serverId: "SERVER" }
  );
  assert.equal(snapshot.authorLabel, "@Alice");
  assert.deepEqual(snapshot.attachments, [
    { filename: "proof.png", size: 1_024 },
  ]);
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

test("avatar identity detects add, change, remove, and same-id no-ops", () => {
  assert.equal(avatarChangeState(null, avatar("AVATAR1")), "Added");
  assert.equal(
    avatarChangeState(avatar("AVATAR1"), avatar("AVATAR2")),
    "Changed"
  );
  assert.equal(avatarChangeState(avatar("AVATAR1"), null), "Removed");
  assert.equal(avatarChangeState(avatar("AVATAR1"), avatar("AVATAR1")), null);
  assert.equal(avatarChangeState({ malformed: true }, null), null);
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

test("user identity sections separate username and profile avatar changes", () => {
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
      avatar: avatar("NEWAVATAR"),
    },
    {
      username: "OldName",
      avatar: avatar("OLDAVATAR"),
      displayName: "Old Display",
    }
  );

  assert.deepEqual(
    sections.map(({ title }) => title),
    ["🪪 Username Changed", "🖼️ Profile Avatar Changed"]
  );
  assert.match(sections[0].lines.join("\n"), /NewˋName Bounded/);
  assert.match(sections[0].lines.join("\n"), /Actor.*Unavailable/);
  assert.equal(sections[1].iconUrl, "https://autumn.test/avatars/NEWAVATAR");
  assert.doesNotMatch(sections[1].lines.join("\n"), /OLDAVATAR|NEWAVATAR/);

  assert.deepEqual(
    buildUserIdentityAuditSections(
      client,
      { username: "Same", avatar: avatar("SAME"), status: "Online" },
      { username: "Same", avatar: avatar("SAME"), status: "Idle" }
    ),
    []
  );
  assert.equal(
    buildUserIdentityAuditSections(
      client,
      { username: "Same", avatar: avatar("NEW", "https://evil.test/NEW") },
      { username: "Same", avatar: avatar("OLD") }
    )[0].iconUrl,
    null
  );
});

test("global identity updates route only to confirmed audited memberships", () => {
  enableAuditLog("SERVER_A", "CHANNEL_A");
  enableAuditLog("SERVER_B", "CHANNEL_B");
  const currentUser = {
    id: "USER1",
    username: "NewName",
    avatar: avatar("NEWAVATAR"),
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
      { username: "OldName", avatar: avatar("OLDAVATAR") },
      (serverId, embed) => emitted.push({ serverId, embed })
    );
    assert.equal(count, 2);
    assert.deepEqual(
      emitted.map(({ serverId }) => serverId),
      ["SERVER_A", "SERVER_A"]
    );
    assert.deepEqual(
      emitted.map(({ embed }) => embed.title),
      ["🪪 Username Changed", "🖼️ Profile Avatar Changed"]
    );
    assert.doesNotMatch(
      emitted[1].embed.description,
      /OLDAVATAR|NEWAVATAR|https:\/\//
    );
    assert.equal(
      emitted[1].embed.icon_url,
      "https://autumn.test/avatars/NEWAVATAR"
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

test("server avatar changes coexist with nickname and role changes", () => {
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
      avatar: avatar("SERVER_NEW"),
      roles: ["ROLE_NEW"],
      timeout: null,
    },
    {
      nickname: "Old Nick",
      avatar: avatar("SERVER_OLD"),
      roles: ["ROLE_OLD"],
      timeout: null,
    }
  );

  assert.deepEqual(
    sections.map(({ title }) => title),
    [
      "✏️ Nickname Changed",
      "🖼️ Server Avatar Changed",
      "🎭 Member Roles Changed",
    ]
  );
  assert.equal(
    sections.find(({ title }) => title.includes("Server Avatar")).iconUrl,
    "https://autumn.test/avatars/SERVER_NEW"
  );
  assert.deepEqual(
    buildMemberUpdateAuditSections(
      client,
      {
        id: { server: "SERVER_A", user: "USER1" },
        nickname: null,
        avatar: avatar("SAME"),
        roles: [],
        timeout: null,
      },
      {
        nickname: null,
        avatar: avatar("SAME"),
        roles: [],
        timeout: null,
      }
    ),
    []
  );
  const removal = buildMemberUpdateAuditSections(
    client,
    {
      id: { server: "SERVER_A", user: "USER1" },
      nickname: null,
      avatar: null,
      roles: [],
      timeout: null,
    },
    {
      nickname: null,
      avatar: avatar("REMOVED"),
      roles: [],
      timeout: null,
    }
  )[0];
  assert.match(removal.lines.join("\n"), /Change:\*\* Removed/);
  assert.equal(removal.iconUrl, null);
});

test("parseChannelArg preserves valid bare and mentioned ULIDs", () => {
  assert.equal(parseChannelArg(CHANNEL_ID), CHANNEL_ID);
  assert.equal(parseChannelArg(`<#${CHANNEL_ID}>`), CHANNEL_ID);
  assert.equal(parseChannelArg("not-a-channel"), null);
  assert.equal(parseChannelArg("<#01HZY3M6Q8V7N2K4J5T9W0XABI>"), null);
});

test("unified AuditLog command validates and stores a case-preserved target", () => {
  const channel = {
    id: CHANNEL_ID,
    serverId: "SERVER",
    type: "TextChannel",
    havePermission: (permission) => permission === "SendMessage",
  };
  const client = { channels: new Map([[CHANNEL_ID, channel]]) };
  const message = {
    server: { id: "SERVER" },
    channel,
    channelId: CHANNEL_ID,
  };

  const enabled = handleAuditLogCommand(client, message, [CHANNEL_ID]);
  assert.equal(enabled.title, "✅ Audit Log Enabled");
  assert.equal(getAuditLogChannel("SERVER"), CHANNEL_ID);

  const disabled = handleAuditLogCommand(client, message, ["off"]);
  assert.equal(disabled.title, "🔕 Audit Log Disabled");
  assert.equal(getAuditLogChannel("SERVER"), null);
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
