import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOYOFETCH_DATA_DIR = mkdtempSync(
  join(tmpdir(), "hoyofetch-audit-test-")
);

const {
  computeSuspects,
  createMessageCache,
  diffFields,
  formatSuspects,
  handleAuditLogCommand,
  parseChannelArg,
  snapshotMessage,
  truncate,
} = await import("../auditlog.js");
const { getAuditLogChannel } = await import("../store.js");
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
