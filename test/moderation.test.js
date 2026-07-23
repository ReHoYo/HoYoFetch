import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOYOFETCH_DATA_DIR = mkdtempSync(
  join(tmpdir(), "hoyofetch-moderation-test-")
);

const {
  createModeration,
  MODERATION_CONFIRM_EMOJI,
  MODERATION_UNDO_EMOJI,
  parseModerationCommand,
  rateLimitWaitMs,
} = await import("../moderation.js");

const SERVER_ID = "SERVER123";
const CHANNEL_ID = "CHANNEL123";
const SECOND_CHANNEL_ID = "CHANNEL456";
const AUDIT_CHANNEL_ID = "AUDIT123";
const TARGET_ID = "TARGET123";
const MOD_ID = "MOD123";
const OTHER_MOD_ID = "MOD456";
const BOT_ID = "BOT123";
const OWNER_ID = "OWNER123";
const CONFIRM_TITLES = new Set([
  "🔨 Confirm Ban",
  "👢 Confirm Kick",
  "🔇 Confirm Mute",
]);
const ALL_MOD_BITS =
  2 ** 6 + // KickMembers
  2 ** 7 + // BanMembers
  2 ** 8 + // TimeoutMembers
  2 ** 23; // ManageMessages

// Seeding a prompt's reactions is a request too, so state assertions look at
// the calls that actually change a member or a message.
function mutations(harness) {
  return harness.requests.filter(
    (entry) => !entry.path.includes("/reactions/")
  );
}

function memoryStore({ audit = true } = {}) {
  const actions = new Map();
  const strikes = new Map([[`${SERVER_ID}:${TARGET_ID}`, { level: 3 }]]);
  return {
    actions,
    strikes,
    getAuditLogChannel() {
      return audit ? AUDIT_CHANNEL_ID : null;
    },
    createModerationAction(record) {
      actions.set(record.actionId, structuredClone(record));
      return structuredClone(record);
    },
    findModerationActionByMessage(messageId) {
      const record = [...actions.values()].find(
        (entry) => entry.logMessageId === messageId
      );
      return record ? structuredClone(record) : null;
    },
    updateModerationAction(actionId, patch) {
      const record = actions.get(actionId);
      if (!record) return null;
      const next = { ...record, ...structuredClone(patch) };
      actions.set(actionId, next);
      return structuredClone(next);
    },
    pruneModerationActions() {},
    clearAutomodStrike(serverId, userId) {
      return strikes.delete(`${serverId}:${userId}`);
    },
  };
}

function makeHarness({
  audit = true,
  messages: initialMessages = [],
  permissionBits = ALL_MOD_BITS,
  requestOverride,
  // Real pacing would make every cleanup test wait seconds; the pacing itself
  // is asserted separately.
  deletePacingMs = 0,
  rateLimitCooldownMs = 0,
  cleanupRateLimitRetries = 1,
} = {}) {
  let clock = 1_900_000_000_000;
  let messageCounter = 0;
  let messages = initialMessages;
  const store = memoryStore({ audit });
  const requests = [];
  const sent = [];
  const protectedLogs = [];
  const reconciled = [];
  const timeouts = new Map();
  const channels = [CHANNEL_ID, SECOND_CHANNEL_ID, AUDIT_CHANNEL_ID];
  const client = {
    user: { id: BOT_ID },
    events: new EventEmitter(),
    api: {
      async get(path) {
        if (path === `/servers/${SERVER_ID}`) {
          return {
            _id: SERVER_ID,
            owner: OWNER_ID,
            default_permissions: permissionBits,
            roles: {},
          };
        }
        const member = path.match(
          /^\/servers\/SERVER123\/members\/([A-Za-z0-9]+)$/
        );
        if (member) {
          return {
            _id: { server: SERVER_ID, user: member[1] },
            roles: [],
            timeout: timeouts.get(member[1]) ?? null,
          };
        }
        const channel = path.match(/^\/channels\/([A-Za-z0-9]+)$/);
        if (channel && channels.includes(channel[1])) {
          return {
            _id: channel[1],
            channel_type: "TextChannel",
            server: SERVER_ID,
            default_permissions: { a: 0, d: 0 },
            role_permissions: {},
          };
        }
        const user = path.match(/^\/users\/([A-Za-z0-9]+)$/);
        if (user) {
          return {
            _id: user[1],
            ...(user[1] === BOT_ID ? { bot: { owner: OWNER_ID } } : {}),
          };
        }
        throw new Error(`unexpected GET ${path}`);
      },
    },
  };
  const request = async (method, path, body) => {
    requests.push({ method, path, body: structuredClone(body) });
    const overridden = await requestOverride?.({
      method,
      path,
      body,
      attempt: requests.length,
    });
    if (overridden) return overridden;
    const timeoutTarget = path.match(/\/members\/([A-Za-z0-9]+)$/);
    if (method === "PATCH" && timeoutTarget) {
      if (body?.remove?.includes("Timeout")) timeouts.delete(timeoutTarget[1]);
      else if (body?.timeout) timeouts.set(timeoutTarget[1], body.timeout);
    }
    return { ok: true, status: 200, data: {} };
  };
  const moderation = createModeration(client, {
    send: async (channelId, payload) => {
      messageCounter += 1;
      const result = { _id: `SENT${messageCounter}` };
      sent.push({ channelId, payload, result });
      return result;
    },
    sendProtected: async (channelId, payload) => {
      messageCounter += 1;
      const result = { _id: `LOG${messageCounter}` };
      protectedLogs.push({ channelId, payload, result });
      return result;
    },
    request,
    store,
    archive: {
      findArchivedMessages({ serverId, authorId, since, until }) {
        return messages.filter(
          (entry) =>
            entry.serverId === serverId &&
            entry.authorId === authorId &&
            entry.createdAt >= since &&
            entry.createdAt <= until
        );
      },
      getArchiveCoverage() {
        return {
          count: messages.length,
          earliestAt: messages[0]?.createdAt ?? null,
          latestAt: messages.at(-1)?.createdAt ?? null,
        };
      },
      markMessagesDeleted(ids) {
        reconciled.push(...ids);
        // Mirror the real archive: a deleted entry stops being selectable.
        messages = messages.filter((entry) => !ids.includes(entry.id));
        return ids.length;
      },
    },
    now: () => clock,
    actionIdFactory: () => "MDACTION123",
    attach: false,
    deletePacingMs,
    rateLimitCooldownMs,
    cleanupRateLimitRetries,
    logger: { log() {}, warn() {} },
  });
  const message = {
    id: "COMMAND123",
    authorId: MOD_ID,
    channelId: CHANNEL_ID,
    channel: { serverId: SERVER_ID },
    server: { id: SERVER_ID, ownerId: OWNER_ID },
  };
  const harness = {
    moderation,
    message,
    requests,
    sent,
    protectedLogs,
    reconciled,
    store,
    timeouts,
    setNow(value) {
      clock = value;
    },
    // Ban, kick, and typed-duration mutes pause for an invoker-only ✅ before
    // acting. Tests that assert on the action itself answer that prompt here so
    // they stay about the action rather than the gate.
    async run(command, args) {
      await moderation.handleCommand(message, command, args);
      const prompt = sent.at(-1);
      if (!CONFIRM_TITLES.has(prompt?.payload?.embeds?.[0]?.title)) return null;
      await moderation.handleRawEvent({
        type: "MessageReact",
        id: prompt.result._id,
        user_id: message.authorId,
        emoji_id: MODERATION_CONFIRM_EMOJI,
      });
      return prompt.result._id;
    },
  };
  return harness;
}

test("moderation parser still accepts the legacy delimiter contracts", () => {
  assert.deepEqual(
    parseModerationCommand("ban", [
      `<@${TARGET_ID}>`,
      "delete:1d",
      "reason:",
      "spam",
    ]),
    {
      ok: true,
      command: "ban",
      targetId: TARGET_ID,
      reason: "spam",
      deleteWindow: "1d",
    }
  );
  assert.equal(
    parseModerationCommand("mute", [TARGET_ID, "1h", "reason:testing"])
      .duration,
    "1h"
  );
  assert.equal(
    parseModerationCommand("purge-user", [
      TARGET_ID,
      "window:7d",
      "reason:",
      "cleanup",
    ]).window,
    "7d"
  );
});

test("moderation parser reads plain sentences in any order", () => {
  assert.deepEqual(
    parseModerationCommand(
      "ban",
      `<@${TARGET_ID}> for spamming and stuff`.split(" ")
    ),
    {
      ok: true,
      command: "ban",
      targetId: TARGET_ID,
      reason: "spamming and stuff",
      deleteWindow: null,
    }
  );

  // Options may lead, and free text after the reason starts is never eaten.
  const mute = parseModerationCommand(
    "mute",
    `1h <@${TARGET_ID}> because they argued for 3d straight`.split(" ")
  );
  assert.equal(mute.duration, "1h");
  assert.equal(mute.reason, "they argued for 3d straight");
  assert.equal(mute.deleteWindow, null);

  const purge = parseModerationCommand(
    "purge-user",
    `<@${TARGET_ID}> because of spam`.split(" ")
  );
  assert.equal(purge.window, null);
  assert.equal(purge.reason, "spam");

  assert.equal(
    parseModerationCommand("mute", [`<@${TARGET_ID}>`, "29d", "noisy"])
      .deleteWindow,
    "29d"
  );
  assert.equal(
    parseModerationCommand("automod-release", [
      `<@${TARGET_ID}>`,
      "false",
      "positive",
    ]).reason,
    "false positive"
  );
});

test("moderation parser rejects missing reasons, targets, and unknown options", () => {
  assert.equal(parseModerationCommand("kick", [TARGET_ID]).ok, false);
  assert.equal(
    parseModerationCommand("ban", [`<@${TARGET_ID}>`, "for"]).ok,
    false
  );
  assert.equal(parseModerationCommand("kick", ["for", "raiding"]).ok, false);
  assert.equal(
    parseModerationCommand("mute", [TARGET_ID, "duration:2h", "x"]).ok,
    false
  );
  assert.equal(
    parseModerationCommand("ban", [TARGET_ID, "delete:99d", "x"]).ok,
    false
  );
  assert.equal(parseModerationCommand("unknown", [TARGET_ID, "x"]).ok, false);
});

test("ban waits for the invoker's own confirmation before acting", async () => {
  const harness = makeHarness();
  await harness.moderation.handleCommand(harness.message, "ban", [
    `<@${TARGET_ID}>`,
    "for",
    "spamming",
    "and",
    "stuff",
  ]);
  const confirmation = harness.sent.at(-1);
  assert.match(confirmation.payload.embeds[0].title, /Confirm Ban/);
  // The prompt is the typo guard, so it has to name who and why.
  assert.match(
    confirmation.payload.embeds[0].description,
    new RegExp(`<@${TARGET_ID}>[\\s\\S]*spamming and stuff`)
  );
  // Seeding the ✅/❌ reactions is the only traffic so far.
  assert.equal(mutations(harness).length, 0);

  // Another moderator cannot answer someone else's prompt.
  await harness.moderation.handleRawEvent({
    type: "MessageReact",
    id: confirmation.result._id,
    user_id: OTHER_MOD_ID,
    emoji_id: MODERATION_CONFIRM_EMOJI,
  });
  assert.equal(
    harness.requests.some((entry) => entry.path.includes("/bans/")),
    false
  );

  await harness.moderation.handleRawEvent({
    type: "MessageReact",
    id: confirmation.result._id,
    user_id: MOD_ID,
    emoji_id: MODERATION_CONFIRM_EMOJI,
  });
  assert.ok(
    harness.requests.some(
      (entry) => entry.method === "PUT" && entry.path.includes("/bans/")
    )
  );
});

test("declining or ignoring the confirmation leaves the member untouched", async () => {
  const harness = makeHarness();
  await harness.moderation.handleCommand(harness.message, "kick", [
    `<@${TARGET_ID}>`,
    "for",
    "raiding",
  ]);
  await harness.moderation.handleRawEvent({
    type: "MessageReact",
    id: harness.sent.at(-1).result._id,
    user_id: MOD_ID,
    emoji_id: "❌",
  });
  assert.equal(mutations(harness).length, 0);
  assert.equal(harness.store.actions.size, 0);
  assert.match(harness.sent.at(-1).payload.embeds[0].title, /Cancelled/);

  // An expired prompt is dead even for the invoker.
  await harness.moderation.handleCommand(harness.message, "mute", [
    `<@${TARGET_ID}>`,
    "1h",
    "cooldown",
  ]);
  const stale = harness.sent.at(-1);
  assert.match(stale.payload.embeds[0].title, /Confirm Mute/);
  harness.setNow(1_900_000_000_000 + 3 * 60_000);
  await harness.moderation.handleRawEvent({
    type: "MessageReact",
    id: stale.result._id,
    user_id: MOD_ID,
    emoji_id: MODERATION_CONFIRM_EMOJI,
  });
  assert.equal(harness.timeouts.has(TARGET_ID), false);
});

test("ban records a protected reversible action and authorized reaction unbans", async () => {
  const harness = makeHarness();
  await harness.run("ban", [TARGET_ID, "reason:", "raid"]);
  assert.ok(
    harness.requests.some(
      (entry) => entry.method === "PUT" && entry.path.includes("/bans/")
    )
  );
  assert.equal(harness.protectedLogs.length, 1);
  const record = harness.store.actions.get("MDACTION123");
  assert.equal(record.type, "ban");
  await harness.moderation.handleRawEvent({
    type: "MessageReact",
    id: record.logMessageId,
    user_id: OTHER_MOD_ID,
    emoji_id: MODERATION_UNDO_EMOJI,
  });
  assert.ok(
    harness.requests.some(
      (entry) => entry.method === "DELETE" && entry.path.includes("/bans/")
    )
  );
  assert.equal(harness.store.actions.get("MDACTION123").status, "undone");
});

test("mute duration picker is invoker-only and applies the chosen timeout", async () => {
  const harness = makeHarness();
  await harness.run("mute", [TARGET_ID, "reason:", "cooldown"]);
  const pickerId = harness.sent[0].result._id;
  await harness.moderation.handleRawEvent({
    type: "MessageReact",
    id: pickerId,
    user_id: OTHER_MOD_ID,
    emoji_id: "3️⃣",
  });
  assert.equal(harness.timeouts.has(TARGET_ID), false);
  await harness.moderation.handleRawEvent({
    type: "MessageReact",
    id: pickerId,
    user_id: MOD_ID,
    emoji_id: "3️⃣",
  });
  assert.equal(harness.timeouts.has(TARGET_ID), true);
  assert.equal(harness.store.actions.get("MDACTION123").type, "mute");
  // Picking a duration is already a deliberate second act, so there is no
  // separate confirmation on this path.
  assert.equal(
    harness.sent.some((entry) =>
      CONFIRM_TITLES.has(entry.payload.embeds[0].title)
    ),
    false
  );
});

test("kick is immediate, logged, and intentionally has no undo record", async () => {
  const harness = makeHarness();
  await harness.run("kick", [TARGET_ID, "reason:", "rules"]);
  assert.ok(
    harness.requests.some(
      (entry) => entry.method === "DELETE" && entry.path.includes("/members/")
    )
  );
  assert.equal(harness.protectedLogs.length, 1);
  assert.equal(harness.store.actions.size, 0);
});

test("confirmed purge batches known messages by channel", async () => {
  const now = 1_900_000_000_000;
  const messages = Array.from({ length: 205 }, (_, index) => ({
    id: `MESSAGE${index}`,
    channelId: index < 150 ? CHANNEL_ID : SECOND_CHANNEL_ID,
    serverId: SERVER_ID,
    authorId: TARGET_ID,
    createdAt: now - 30 * 60_000,
  }));
  const harness = makeHarness({ messages });
  await harness.run("purge-user", [TARGET_ID, "window:1h", "reason:", "spam"]);
  const confirmationId = harness.sent[0].result._id;
  await harness.moderation.handleRawEvent({
    type: "MessageReact",
    id: confirmationId,
    user_id: MOD_ID,
    emoji_id: MODERATION_CONFIRM_EMOJI,
  });
  const batches = harness.requests.filter((entry) =>
    entry.path.endsWith("/messages/bulk")
  );
  assert.deepEqual(
    batches.map((entry) => entry.body.ids.length),
    [100, 50, 55]
  );
  assert.match(
    harness.protectedLogs.at(-1).payload.embeds[0].description,
    /205\/205 known message\(s\) deleted across 2 channel\(s\)/
  );
});

test("purge-user picks its window by reaction and then confirms", async () => {
  const now = 1_900_000_000_000;
  const harness = makeHarness({
    messages: [
      {
        id: "MESSAGE1",
        channelId: CHANNEL_ID,
        serverId: SERVER_ID,
        authorId: TARGET_ID,
        createdAt: now - 30 * 60_000,
      },
    ],
  });
  await harness.run("purge-user", [TARGET_ID, "because", "of", "spam"]);
  assert.match(harness.sent[0].payload.embeds[0].title, /Choose Purge Window/);

  // A different moderator's reaction is ignored.
  await harness.moderation.handleRawEvent({
    type: "MessageReact",
    id: harness.sent[0].result._id,
    user_id: OTHER_MOD_ID,
    emoji_id: "1️⃣",
  });
  assert.equal(harness.sent.length, 1);

  await harness.moderation.handleRawEvent({
    type: "MessageReact",
    id: harness.sent[0].result._id,
    user_id: MOD_ID,
    emoji_id: "1️⃣",
  });
  assert.match(harness.sent[1].payload.embeds[0].title, /Confirm User Purge/);
  await harness.moderation.handleRawEvent({
    type: "MessageReact",
    id: harness.sent[1].result._id,
    user_id: MOD_ID,
    emoji_id: MODERATION_CONFIRM_EMOJI,
  });
  assert.ok(
    harness.requests.some((entry) => entry.path.endsWith("/messages/bulk"))
  );
});

test("ban offers a cleanup picker that only the invoker can use", async () => {
  const now = 1_900_000_000_000;
  const harness = makeHarness({
    messages: [
      {
        id: "MESSAGE1",
        channelId: CHANNEL_ID,
        serverId: SERVER_ID,
        authorId: TARGET_ID,
        createdAt: now - 60_000,
      },
    ],
  });
  await harness.run("ban", [
    `<@${TARGET_ID}>`,
    "for",
    "spamming",
    "and",
    "stuff",
  ]);
  assert.equal(
    harness.store.actions.get("MDACTION123").reason,
    "spamming and stuff"
  );
  const picker = harness.sent.at(-1);
  assert.match(picker.payload.embeds[0].title, /Delete Recent Messages/);

  await harness.moderation.handleRawEvent({
    type: "MessageReact",
    id: picker.result._id,
    user_id: OTHER_MOD_ID,
    emoji_id: "1️⃣",
  });
  assert.equal(
    harness.requests.some(
      (entry) => entry.method === "DELETE" && entry.path.includes("/messages")
    ),
    false
  );

  await harness.moderation.handleRawEvent({
    type: "MessageReact",
    id: picker.result._id,
    user_id: MOD_ID,
    emoji_id: "1️⃣",
  });
  assert.deepEqual(
    harness.requests
      .filter((entry) => entry.path.endsWith("/messages/bulk"))
      .map((entry) => entry.body.ids),
    [["MESSAGE1"]]
  );
  const cleanupLog = harness.protectedLogs.at(-1).payload.embeds[0];
  assert.match(cleanupLog.title, /History Cleanup/);
  assert.match(cleanupLog.description, /MDACTION123/);
  assert.equal(harness.store.actions.get("MDACTION123").cleanup.window, "1h");
});

test("declining the cleanup picker keeps the kick and deletes nothing", async () => {
  const harness = makeHarness();
  await harness.run("kick", [`<@${TARGET_ID}>`, "for", "raiding"]);
  const picker = harness.sent.at(-1);
  assert.match(picker.payload.embeds[0].title, /Delete Recent Messages/);
  await harness.moderation.handleRawEvent({
    type: "MessageReact",
    id: picker.result._id,
    user_id: MOD_ID,
    emoji_id: "❌",
  });
  assert.equal(
    harness.requests.some(
      (entry) => entry.method === "DELETE" && entry.path.includes("/messages")
    ),
    false
  );
  assert.match(harness.sent.at(-1).payload.embeds[0].description, /kick/);
});

test("a cleanup picker click without Manage Messages deletes nothing", async () => {
  const now = 1_900_000_000_000;
  const harness = makeHarness({
    permissionBits: 2 ** 8, // TimeoutMembers only
    messages: [
      {
        id: "MESSAGE1",
        channelId: CHANNEL_ID,
        serverId: SERVER_ID,
        authorId: TARGET_ID,
        createdAt: now - 60_000,
      },
    ],
  });
  await harness.run("mute", [`<@${TARGET_ID}>`, "1h", "cooldown"]);
  const picker = harness.sent.at(-1);
  await harness.moderation.handleRawEvent({
    type: "MessageReact",
    id: picker.result._id,
    user_id: MOD_ID,
    emoji_id: "3️⃣",
  });
  assert.equal(
    harness.requests.some(
      (entry) => entry.method === "DELETE" && entry.path.includes("/messages")
    ),
    false
  );
  assert.match(
    harness.sent.at(-1).payload.embeds[0].title,
    /Permission Denied/
  );
});

test("cleanups older than the bulk window delete one message at a time", async () => {
  const now = 1_900_000_000_000;
  const day = 24 * 60 * 60_000;
  const harness = makeHarness({
    messages: [
      {
        id: "RECENT1",
        channelId: CHANNEL_ID,
        serverId: SERVER_ID,
        authorId: TARGET_ID,
        createdAt: now - 60_000,
      },
      {
        id: "OLD1",
        channelId: CHANNEL_ID,
        serverId: SERVER_ID,
        authorId: TARGET_ID,
        createdAt: now - 20 * day,
      },
      {
        id: "OLD2",
        channelId: CHANNEL_ID,
        serverId: SERVER_ID,
        authorId: TARGET_ID,
        createdAt: now - 28 * day,
      },
    ],
  });
  await harness.run("ban", [TARGET_ID, "delete:29d", "raid"]);
  assert.deepEqual(
    harness.requests
      .filter(
        (entry) => entry.method === "DELETE" && entry.path.includes("/messages")
      )
      .map((entry) => entry.path),
    [
      `/channels/${CHANNEL_ID}/messages/bulk`,
      `/channels/${CHANNEL_ID}/messages/OLD2`,
      `/channels/${CHANNEL_ID}/messages/OLD1`,
    ]
  );
  assert.match(
    harness.protectedLogs[0].payload.embeds[0].description,
    /3\/3 known message\(s\) deleted/
  );
});

test("a rejected bulk batch falls back to per-message deletes", async () => {
  const now = 1_900_000_000_000;
  const harness = makeHarness({
    messages: [
      {
        id: "MESSAGE1",
        channelId: CHANNEL_ID,
        serverId: SERVER_ID,
        authorId: TARGET_ID,
        createdAt: now - 1_000,
      },
    ],
    requestOverride: ({ method, path }) =>
      method === "DELETE" && path.endsWith("/messages/bulk")
        ? { ok: false, status: 400 }
        : null,
  });
  await harness.run("ban", [TARGET_ID, "delete:1h", "spam"]);
  assert.ok(
    harness.requests.some(
      (entry) => entry.path === `/channels/${CHANNEL_ID}/messages/MESSAGE1`
    )
  );
  assert.match(
    harness.protectedLogs[0].payload.embeds[0].description,
    /1\/1 known message\(s\) deleted/
  );
});

test("oversized cleanups stop at the safety cap and report the remainder", async () => {
  const now = 1_900_000_000_000;
  const messages = Array.from({ length: 2_050 }, (_, index) => ({
    id: `MESSAGE${index}`,
    channelId: CHANNEL_ID,
    serverId: SERVER_ID,
    authorId: TARGET_ID,
    createdAt: now - (2_050 - index) * 1_000,
  }));
  const harness = makeHarness({ messages });
  await harness.run("ban", [TARGET_ID, "delete:1h", "flood"]);
  const deleted = harness.requests
    .filter((entry) => entry.path.endsWith("/messages/bulk"))
    .reduce((total, entry) => total + entry.body.ids.length, 0);
  assert.equal(deleted, 2_000);
  assert.match(
    harness.protectedLogs[0].payload.embeds[0].description,
    /50 more were left untouched by the 2000-message safety cap/
  );
});

test("automod release removes timeout and resets strikes", async () => {
  const harness = makeHarness();
  harness.timeouts.set(TARGET_ID, new Date(1_900_000_600_000).toISOString());
  await harness.run("automod-release", [
    TARGET_ID,
    "reason:",
    "false positive",
  ]);
  assert.equal(harness.timeouts.has(TARGET_ID), false);
  assert.equal(harness.store.strikes.has(`${SERVER_ID}:${TARGET_ID}`), false);
});

test("manual moderation refuses to mutate without an audit logger", async () => {
  const harness = makeHarness({ audit: false });
  await harness.run("ban", [TARGET_ID, "reason:", "test"]);
  assert.equal(
    harness.requests.some((entry) => entry.path.includes("/bans/")),
    false
  );
  assert.match(harness.sent[0].payload.embeds[0].title, /Audit Log Required/);
});

test("ban cleanup preflight refuses the ban when Manage Messages is absent", async () => {
  const now = 1_900_000_000_000;
  const harness = makeHarness({
    permissionBits: 2 ** 7,
    messages: [
      {
        id: "MESSAGE1",
        channelId: CHANNEL_ID,
        serverId: SERVER_ID,
        authorId: TARGET_ID,
        createdAt: now - 1_000,
      },
    ],
  });
  await harness.run("ban", [TARGET_ID, "delete:1h", "reason:", "spam"]);
  assert.equal(
    harness.requests.some((entry) => entry.path.includes("/bans/")),
    false
  );
  assert.match(
    harness.sent.at(-1).payload.embeds[0].title,
    /Permission Denied/
  );
});

test("runtime cleanup failures keep the ban and report partial results", async () => {
  const now = 1_900_000_000_000;
  const harness = makeHarness({
    messages: [
      {
        id: "MESSAGE1",
        channelId: CHANNEL_ID,
        serverId: SERVER_ID,
        authorId: TARGET_ID,
        createdAt: now - 1_000,
      },
    ],
    requestOverride: ({ method, path }) =>
      method === "DELETE" && path.includes("/messages")
        ? { ok: false, status: 403 }
        : null,
  });
  await harness.run("ban", [TARGET_ID, "delete:1h", "reason:", "spam"]);
  assert.ok(harness.requests.some((entry) => entry.path.includes("/bans/")));
  const summary = harness.protectedLogs[0].payload.embeds[0].description;
  assert.match(
    summary,
    /0\/1 known message\(s\) deleted across 1 channel\(s\)/
  );
  // A permission problem is actionable, so it is named rather than folded into
  // an undifferentiated failure count.
  assert.match(
    summary,
    /1 could not be deleted because I lack Manage Messages/
  );
});

test("messages already gone from Stoat reconcile instead of failing", async () => {
  const now = 1_900_000_000_000;
  const harness = makeHarness({
    messages: [
      {
        id: "MESSAGE1",
        channelId: CHANNEL_ID,
        serverId: SERVER_ID,
        authorId: TARGET_ID,
        createdAt: now - 1_000,
      },
      {
        id: "MESSAGE2",
        channelId: CHANNEL_ID,
        serverId: SERVER_ID,
        authorId: TARGET_ID,
        createdAt: now - 2_000,
      },
    ],
    requestOverride: ({ method, path }) => {
      if (method !== "DELETE" || !path.includes("/messages")) return null;
      // The bulk route refuses the batch, then MESSAGE1 turns out to be gone.
      if (path.endsWith("/bulk")) return { ok: false, status: 400 };
      return path.endsWith("MESSAGE1")
        ? { ok: false, status: 404 }
        : { ok: true, status: 204 };
    },
  });
  await harness.run("purge-user", [TARGET_ID, "window:1h", "reason:", "spam"]);
  await harness.moderation.handleRawEvent({
    type: "MessageReact",
    id: harness.sent.at(-1).result._id,
    user_id: MOD_ID,
    emoji_id: MODERATION_CONFIRM_EMOJI,
  });
  const summary = harness.protectedLogs.at(-1).payload.embeds[0].description;
  assert.match(summary, /1\/2 known message\(s\) deleted/);
  assert.match(summary, /0 failed/, "an absent message is not a failure");
  assert.match(
    summary,
    /1 were already gone from Stoat and have been reconciled/
  );
  // Both the deleted and the absent message are written back, so a later
  // cleanup stops selecting an ID that can never be deleted.
  assert.deepEqual(harness.reconciled.sort(), ["MESSAGE1", "MESSAGE2"]);
});

test("rate-limited messages get one more pass before being reported", async () => {
  const now = 1_900_000_000_000;
  const day = 24 * 60 * 60_000;
  const attempts = new Map();
  const harness = makeHarness({
    messages: ["OLD1", "OLD2"].map((id, index) => ({
      id,
      channelId: CHANNEL_ID,
      serverId: SERVER_ID,
      authorId: TARGET_ID,
      // Older than the bulk window, so each goes one at a time.
      createdAt: now - (20 + index) * day,
    })),
    requestOverride: ({ method, path }) => {
      if (method !== "DELETE" || !path.includes("/messages")) return null;
      const id = path.split("/").pop();
      const seen = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, seen);
      const limited = {
        ok: false,
        status: 429,
        headers: { "x-ratelimit-reset-after": "1" },
      };
      // OLD1 clears on the second pass; OLD2 never does.
      if (id === "OLD2") return limited;
      return seen === 1 ? limited : { ok: true, status: 204 };
    },
  });
  await harness.run("ban", [TARGET_ID, "delete:29d", "reason:", "raid"]);
  const summary = harness.protectedLogs[0].payload.embeds[0].description;
  assert.match(summary, /1\/2 known message\(s\) deleted/);
  assert.match(
    summary,
    /1 were still rate limited after a retry; run the cleanup again to finish them/
  );
  assert.ok(
    attempts.get("OLD1") > 1,
    "a rate-limited message is retried, not written off"
  );
});

test("Stoat hierarchy rejection fails closed without a success log", async () => {
  const harness = makeHarness({
    requestOverride: ({ method, path }) =>
      method === "PUT" && path.includes("/bans/")
        ? { ok: false, status: 403 }
        : null,
  });
  await harness.run("ban", [TARGET_ID, "reason:", "test"]);
  assert.equal(harness.protectedLogs.length, 0);
  assert.match(harness.sent.at(-1).payload.embeds[0].title, /Ban Failed/);
});

test("individual deletes are paced so a long cleanup stays under the limit", async () => {
  const now = 1_900_000_000_000;
  const day = 24 * 60 * 60_000;
  const stamps = [];
  const harness = makeHarness({
    deletePacingMs: 40,
    messages: ["OLD1", "OLD2", "OLD3"].map((id, index) => ({
      id,
      channelId: CHANNEL_ID,
      serverId: SERVER_ID,
      authorId: TARGET_ID,
      createdAt: now - (20 + index) * day,
    })),
    requestOverride: ({ method, path }) => {
      if (method === "DELETE" && /\/messages\/OLD\d$/.test(path)) {
        stamps.push(process.hrtime.bigint());
      }
      return null;
    },
  });
  await harness.run("ban", [TARGET_ID, "delete:29d", "reason:", "raid"]);
  assert.equal(stamps.length, 3);
  const gaps = stamps
    .slice(1)
    .map((stamp, index) => Number(stamp - stamps[index]) / 1e6);
  for (const gap of gaps) {
    assert.ok(gap >= 35, `expected a pacing gap, saw ${gap.toFixed(1)}ms`);
  }
});

test("rate-limit backoff reads the wait from headers, not just the body", () => {
  // Stoat's own reset header is in milliseconds.
  assert.equal(
    rateLimitWaitMs({ headers: { "x-ratelimit-reset-after": "4000" } }),
    4_000
  );
  // The HTTP standard header is in seconds, so 2 means two thousand ms — the
  // original bug was reading only the body and silently waiting one second.
  assert.equal(rateLimitWaitMs({ headers: { "Retry-After": "2" } }), 2_000);
  assert.equal(rateLimitWaitMs({ data: { retry_after: 3_000 } }), 3_000);
  // Header wins over body when both are present.
  assert.equal(
    rateLimitWaitMs({
      headers: { "x-ratelimit-reset-after": "8000" },
      data: { retry_after: 1_000 },
    }),
    8_000
  );
  // With no signal at all the wait doubles instead of pinning at one second.
  assert.equal(rateLimitWaitMs({}, 0), 1_000);
  assert.equal(rateLimitWaitMs({}, 2), 4_000);
  // A long reset is honoured rather than truncated to the old 10s ceiling.
  assert.equal(
    rateLimitWaitMs({ headers: { "x-ratelimit-reset-after": "45000" } }),
    45_000
  );
  assert.equal(
    rateLimitWaitMs({ headers: { "x-ratelimit-reset-after": "999999" } }),
    60_000
  );
  // Unparseable values fall through instead of producing NaN.
  assert.equal(rateLimitWaitMs({ headers: { "retry-after": "" } }, 0), 1_000);
});

test("purge retries a rate-limited batch", async () => {
  const now = 1_900_000_000_000;
  let bulkAttempts = 0;
  const harness = makeHarness({
    messages: [
      {
        id: "MESSAGE1",
        channelId: CHANNEL_ID,
        serverId: SERVER_ID,
        authorId: TARGET_ID,
        createdAt: now - 1_000,
      },
    ],
    requestOverride: ({ method, path }) => {
      if (method !== "DELETE" || !path.endsWith("/messages/bulk")) return null;
      bulkAttempts += 1;
      return bulkAttempts === 1
        ? { ok: false, status: 429, data: { retry_after: 1 } }
        : { ok: true, status: 204 };
    },
  });
  await harness.run("purge-user", [TARGET_ID, "window:1h", "reason:", "spam"]);
  await harness.moderation.handleRawEvent({
    type: "MessageReact",
    id: harness.sent[0].result._id,
    user_id: MOD_ID,
    emoji_id: MODERATION_CONFIRM_EMOJI,
  });
  assert.equal(bulkAttempts, 2);
});
