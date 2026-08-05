// Tests for the first-post gate: holding a link/attachment from a new or
// first-time poster for review, exempting moderators and privacy-excluded
// channels, the approve/reject review outcomes, unreviewed expiry, and the
// Enka-approved configuration gate. Runs against a temp data dir since the
// gate consults the real message-archive.js for the "first message" signal.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOYOFETCH_DATA_DIR = mkdtempSync(
  join(tmpdir(), "hoyofetch-post-gate-test-")
);

const { createPostGate, ENKA_APPROVER_USER_ID } =
  await import("../post-gate.js");
const { recordMessage } = await import("../message-archive.js");

const SERVER_ID = "SERVER123";
const SOURCE_CHANNEL_ID = "SOURCECHANNEL123";
const REVIEW_CHANNEL_ID = "REVIEWCHANNEL123";
const EXCLUDED_CHANNEL_ID = "EXCLUDEDCHANNEL123";
const BOT_ID = "BOT123";
const OWNER_ID = "OWNER123";
const NEW_USER_ID = "NEWUSER123";
const ESTABLISHED_USER_ID = "OLDUSER123";
const MOD_USER_ID = "MODUSER123";
const APPROVER_ID = ENKA_APPROVER_USER_ID;
const DM_ID = "DMCHANNEL123";

const MANAGE_MESSAGES_BIT = 2 ** 23;
const TIMEOUT_MEMBERS_BIT = 2 ** 8;

function makeStore({ moderationLevel = 1 } = {}) {
  const config = new Map();
  const queue = new Map();
  const strikes = new Map();
  const excludedChannels = new Set([EXCLUDED_CHANNEL_ID]);
  return {
    config,
    queue,
    strikes,
    getModerationLevel: () => ({
      level: moderationLevel,
      tenureDays: 7,
      updatedAt: null,
      updatedBy: null,
    }),
    getPostGateConfig(serverId) {
      return (
        config.get(serverId) ?? {
          mode: "off",
          reviewChannelId: null,
          updatedAt: null,
        }
      );
    },
    setPostGateConfig(serverId, patch) {
      const previous = this.getPostGateConfig(serverId);
      const current = { ...previous, ...patch, updatedAt: "now" };
      config.set(serverId, current);
      return { previous, current };
    },
    isChannelExcluded: (channelId) => excludedChannels.has(channelId),
    createHeldPost(record) {
      queue.set(record.queueId, structuredClone(record));
      return structuredClone(record);
    },
    getHeldPost(queueId) {
      const record = queue.get(queueId);
      return record ? structuredClone(record) : null;
    },
    updateHeldPost(queueId, patch) {
      const record = queue.get(queueId);
      if (!record) return null;
      const updated = { ...record, ...structuredClone(patch) };
      queue.set(queueId, updated);
      return structuredClone(updated);
    },
    findHeldPostByReviewMessage(reviewMessageId) {
      const record = [...queue.values()].find(
        (entry) => entry.reviewMessageId === reviewMessageId
      );
      return record ? structuredClone(record) : null;
    },
    getPendingHeldPosts(serverId) {
      return [...queue.values()]
        .filter(
          (entry) => entry.serverId === serverId && entry.status === "pending"
        )
        .map((entry) => structuredClone(entry));
    },
    getExpiredPendingPosts(now) {
      return [...queue.values()]
        .filter((entry) => entry.status === "pending" && entry.expiresAt <= now)
        .map((entry) => structuredClone(entry));
    },
    prunePostGateQueue() {
      return [];
    },
    getAutomodStrike(serverId, userId) {
      const record = strikes.get(`${serverId}:${userId}`);
      return record ? structuredClone(record) : null;
    },
    setAutomodStrike(serverId, userId, record) {
      const stored = { serverId, userId, ...structuredClone(record) };
      strikes.set(`${serverId}:${userId}`, stored);
      return structuredClone(stored);
    },
    clearAutomodStrike(serverId, userId) {
      return strikes.delete(`${serverId}:${userId}`);
    },
  };
}

function makeHarness({
  clock = 1_800_000_000_000,
  attachmentDownloadFails = false,
  attachmentUploadFails = false,
  moderationLevel = 1,
  onMessageDeleted = () => {},
} = {}) {
  let current = clock;
  const store = makeStore({ moderationLevel });
  const responses = [];
  const protectedLogs = [];
  const dmPayloads = [];
  const sendCalls = [];
  const reactionPuts = [];
  const deletedMessageIds = [];
  const removedEvidencePaths = [];
  let attachmentUploads = 0;

  const channels = new Map([
    [
      SOURCE_CHANNEL_ID,
      { id: SOURCE_CHANNEL_ID, serverId: SERVER_ID, type: "TextChannel" },
    ],
    [
      REVIEW_CHANNEL_ID,
      { id: REVIEW_CHANNEL_ID, serverId: SERVER_ID, type: "TextChannel" },
    ],
    [
      EXCLUDED_CHANNEL_ID,
      { id: EXCLUDED_CHANNEL_ID, serverId: SERVER_ID, type: "TextChannel" },
    ],
  ]);
  const client = {
    user: { id: BOT_ID },
    channels,
    users: new Map([
      [APPROVER_ID, { username: "Enka", discriminator: "4961" }],
    ]),
    servers: new Map([[SERVER_ID, { name: "Test Server" }]]),
    configuration: {
      features: { autumn: { url: "https://autumn.test" } },
    },
    authenticationHeader: ["X-Bot-Token", "secret"],
    api: {
      async get(path) {
        const memberMatch = path.match(
          new RegExp(`^/servers/${SERVER_ID}/members/([A-Za-z0-9]+)$`)
        );
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
        if (memberMatch) {
          const userId = memberMatch[1];
          return {
            _id: { server: SERVER_ID, user: userId },
            joined_at: new Date(
              current - 30 * 24 * 60 * 60 * 1_000
            ).toISOString(),
            roles: userId === MOD_USER_ID ? ["MODROLE"] : [],
          };
        }
        if (path === `/channels/${SOURCE_CHANNEL_ID}`) {
          return {
            _id: SOURCE_CHANNEL_ID,
            channel_type: "TextChannel",
            server: SERVER_ID,
            default_permissions: { a: 0, d: 0 },
            role_permissions: {},
          };
        }
        if (path === `/channels/${REVIEW_CHANNEL_ID}`) {
          return {
            _id: REVIEW_CHANNEL_ID,
            channel_type: "TextChannel",
            server: SERVER_ID,
            default_permissions: { a: MANAGE_MESSAGES_BIT, d: 0 },
            role_permissions: {},
          };
        }
        const userMatch = path.match(/^\/users\/([A-Za-z0-9]+)$/);
        if (userMatch) {
          return { _id: userMatch[1] };
        }
        throw new Error(`unexpected path ${path}`);
      },
    },
  };

  const request = async (method, path, body) => {
    if (
      method === "DELETE" &&
      /^\/channels\/[^/]+\/messages\/[^/]+$/.test(path)
    ) {
      const deletedId = path.split("/").pop();
      deletedMessageIds.push(deletedId);
      // Mirrors revolt.js: the server's MessageDelete gateway event (fired in
      // response to our own DELETE) clears the client's message collection,
      // so any live-getter reads off the Message object after this point see
      // undefined. Tests that pass a volatile message use this to simulate
      // that race deterministically.
      onMessageDeleted(deletedId);
      return { ok: true, status: 200 };
    }
    if (method === "PUT" && path.includes("/reactions/")) {
      reactionPuts.push(path);
      return { ok: true, status: 200 };
    }
    if (method === "GET" && path === `/users/${APPROVER_ID}/dm`) {
      return { ok: true, status: 200, data: { _id: DM_ID } };
    }
    if (method === "POST" && path === `/channels/${DM_ID}/messages`) {
      dmPayloads.push(body);
      return { ok: true, status: 200, data: { _id: `DM${dmPayloads.length}` } };
    }
    return { ok: false, status: 404 };
  };

  let nextId = 0;
  const postGate = createPostGate(client, {
    send: async (channelId, payload) => {
      sendCalls.push({ channelId, payload });
      return { _id: `SEND${++nextId}` };
    },
    sendProtected: async (channelId, payload) => {
      protectedLogs.push({ channelId, payload });
      return { _id: `PROTECTED${++nextId}` };
    },
    request,
    fetchImpl: async (_url, options) => {
      if (options?.method === "POST") {
        attachmentUploads += 1;
        if (attachmentUploadFails) {
          return { ok: false, status: 503 };
        }
        return {
          ok: true,
          json: async () => ({ id: `HELDATT${attachmentUploads}` }),
        };
      }
      if (attachmentDownloadFails) return { ok: false, status: 404 };
      return {
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("bytes").buffer,
      };
    },
    store,
    now: () => current,
    codeFactory: () => "123456",
    queueIdFactory: () => `PGQUEUE${++nextId}`,
    requestIdFactory: () => `PGREQ${++nextId}`,
    runIntentionalDelete: async (_messageId, operation) => operation(),
    scheduleTimeout: () => ({ unref() {} }),
    scheduleInterval: () => ({ unref() {} }),
    logger: { log() {}, warn() {} },
  });

  return {
    postGate,
    store,
    responses,
    protectedLogs,
    dmPayloads,
    sendCalls,
    reactionPuts,
    deletedMessageIds,
    removedEvidencePaths,
    get attachmentUploads() {
      return attachmentUploads;
    },
    advance(ms) {
      current += ms;
    },
    setClock(ms) {
      current = ms;
    },
  };
}

function newAccountMessage({
  id,
  authorId = NEW_USER_ID,
  channelId = SOURCE_CHANNEL_ID,
  content = "",
  attachments = [],
  createdAt = new Date(1_800_000_000_000 - 60_000),
  joinedAt = new Date(1_800_000_000_000 - 60_000),
} = {}) {
  return {
    id,
    channelId,
    serverId: SERVER_ID,
    server: { id: SERVER_ID },
    authorId,
    author: { createdAt },
    member: { joinedAt },
    content,
    attachments,
  };
}

// Reproduces revolt.js's live-getter Message shape: authorId/content/
// attachments read from a mutable backing store, exactly like
// `Collection#getUnderlyingObject`. Calling `evict()` empties that store,
// simulating the client's MessageDelete handler wiping the collection entry
// after the bot's own DELETE request. A test wires `evict` to the harness's
// `onMessageDeleted` hook to reproduce the race deterministically.
function volatileAccountMessage({
  id,
  authorId = NEW_USER_ID,
  channelId = SOURCE_CHANNEL_ID,
  content = "",
  attachments = [],
  createdAt = new Date(1_800_000_000_000 - 60_000),
  joinedAt = new Date(1_800_000_000_000 - 60_000),
} = {}) {
  let backing = { authorId, content, attachments };
  return {
    id,
    channelId,
    serverId: SERVER_ID,
    server: { id: SERVER_ID },
    author: { createdAt },
    member: { joinedAt },
    get authorId() {
      return backing.authorId;
    },
    get content() {
      // Matches revolt.js's own `?? ""` fallback on the content getter, so
      // post-eviction content reads back as "" rather than undefined.
      return backing.content ?? "";
    },
    get attachments() {
      return backing.attachments;
    },
    evict() {
      backing = {};
    },
  };
}

async function enableHold(harness) {
  harness.store.setPostGateConfig(SERVER_ID, {
    mode: "hold",
    reviewChannelId: REVIEW_CHANNEL_ID,
  });
}

test("holds a first-post link from a brand-new account", async () => {
  const harness = makeHarness();
  await enableHold(harness);

  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGLINK1",
      content: "check out https://evil.example/free-nitro",
    })
  );

  assert.deepEqual(harness.deletedMessageIds, ["MSGLINK1"]);
  assert.equal(harness.protectedLogs.length, 1);
  assert.match(
    harness.protectedLogs[0].payload.embeds[0].title,
    /Held First Post/
  );
  assert.equal(harness.reactionPuts.length, 2);
  const [record] = [...harness.store.queue.values()];
  assert.equal(record.status, "pending");
  assert.equal(record.userId, NEW_USER_ID);
});

test("captures author id and content even when the deletion clears the live message object first", async () => {
  // Regression test for the "Author: <@undefined>" bug: revolt.js Message
  // fields are live getters, and the client clears its collection entry in
  // response to the server's MessageDelete event fired by our own DELETE.
  // `onMessageDeleted` simulates that race landing as early as possible —
  // right when the DELETE call resolves, before the queue record is built.
  const harness = makeHarness({
    onMessageDeleted: (deletedId) => {
      if (deletedId === "MSGVOLATILE1") volatileMessage.evict();
    },
  });
  await enableHold(harness);

  const volatileMessage = volatileAccountMessage({
    id: "MSGVOLATILE1",
    content: "check out https://evil.example/free-nitro",
  });
  await harness.postGate.handleMessage(volatileMessage);

  assert.deepEqual(harness.deletedMessageIds, ["MSGVOLATILE1"]);
  const [record] = [...harness.store.queue.values()];
  assert.equal(record.userId, NEW_USER_ID);
  assert.equal(record.content, "check out https://evil.example/free-nitro");

  const embed = harness.protectedLogs[0].payload.embeds[0];
  const embedText = JSON.stringify(embed);
  assert.match(embedText, new RegExp(`<@${NEW_USER_ID}>`));
  assert.doesNotMatch(embedText, /undefined/);
});

test("holds a first-post attachment from a brand-new account", async () => {
  const harness = makeHarness();
  await enableHold(harness);

  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGATT1",
      content: "",
      attachments: [
        {
          id: "ATT1",
          filename: "proof.png",
          size: 500,
          contentType: "image/png",
          url: "https://autumn.test/attachments/ATT1",
        },
      ],
    })
  );

  assert.deepEqual(harness.deletedMessageIds, ["MSGATT1"]);
  const [record] = [...harness.store.queue.values()];
  assert.equal(record.attachments.length, 1);
  assert.equal(record.attachments[0].archiveAttachmentId, "HELDATT1");
  assert.equal(record.attachments[0].archiveRecordId, record.reviewMessageId);
  assert.deepEqual(harness.protectedLogs[0].payload.attachments, ["HELDATT1"]);
});

test("approving held media removes the review card without republishing the attachment", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGMEDIAAPPROVE",
      attachments: [
        {
          id: "ATTAPPROVE",
          filename: "proof.png",
          size: 5,
          contentType: "image/png",
          url: "https://autumn.test/attachments/ATTAPPROVE",
        },
      ],
    })
  );
  const [record] = [...harness.store.queue.values()];
  // Only the hold itself uploads: the copy on the review card is evidence.
  assert.equal(harness.attachmentUploads, 1);
  const result = await harness.postGate.handleCommand(
    {
      server: { id: SERVER_ID },
      channelId: REVIEW_CHANNEL_ID,
      authorId: MOD_USER_ID,
    },
    ["approve", record.queueId]
  );

  assert.equal(result.outcome, "approved");
  // Approval must not re-upload the attachment or send anything to the
  // channel the held message came from.
  assert.equal(harness.attachmentUploads, 1);
  assert.equal(
    harness.sendCalls.some((call) => call.channelId === SOURCE_CHANNEL_ID),
    false
  );
  assert.ok(harness.deletedMessageIds.includes(record.reviewMessageId));
});

test("unavailable review media no longer blocks approving the author", async () => {
  // Approval used to re-download every held attachment before it could
  // complete, so a dead or tampered archive copy left the moderator unable to
  // clear the account. Nothing is republished now, so the copy is irrelevant.
  const harness = makeHarness({ attachmentDownloadFails: true });
  await enableHold(harness);
  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGMEDIAFAIL",
      content: "caption",
      attachments: [
        {
          id: "ATTFAIL",
          filename: "proof.png",
          size: 5,
          contentType: "image/png",
          url: "https://autumn.test/attachments/ATTFAIL",
        },
      ],
    })
  );
  const [record] = [...harness.store.queue.values()];
  const result = await harness.postGate.handleCommand(
    {
      server: { id: SERVER_ID },
      channelId: REVIEW_CHANNEL_ID,
      authorId: MOD_USER_ID,
    },
    ["approve", record.queueId]
  );
  assert.equal(result.outcome, "approved");
  assert.equal(harness.store.getHeldPost(record.queueId).status, "approved");
  assert.equal(
    harness.sendCalls.some((call) => call.channelId === SOURCE_CHANNEL_ID),
    false
  );
});

test("ignores a plain-text first post with no link or attachment", async () => {
  const harness = makeHarness();
  await enableHold(harness);

  await harness.postGate.handleMessage(
    newAccountMessage({ id: "MSGTEXT1", content: "hello everyone!" })
  );

  assert.equal(harness.deletedMessageIds.length, 0);
  assert.equal(harness.store.queue.size, 0);
});

test("ignores an established member even when the message has a link", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  recordMessage({
    id: "PRIORMSG1",
    channelId: SOURCE_CHANNEL_ID,
    serverId: SERVER_ID,
    authorId: ESTABLISHED_USER_ID,
    content: "an earlier message",
    createdAt: Date.now() - 90 * 24 * 60 * 60 * 1000,
  });

  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGOLD1",
      authorId: ESTABLISHED_USER_ID,
      content: "https://example.com",
      createdAt: new Date(1_800_000_000_000 - 400 * 24 * 60 * 60 * 1000),
      joinedAt: new Date(1_800_000_000_000 - 200 * 24 * 60 * 60 * 1000),
    })
  );

  assert.equal(harness.deletedMessageIds.length, 0);
  assert.equal(harness.store.queue.size, 0);
});

test("exempts a recognized moderator even on a brand-new account", async () => {
  const harness = makeHarness();
  await enableHold(harness);

  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGMOD1",
      authorId: MOD_USER_ID,
      content: "https://example.com",
    })
  );

  assert.equal(harness.deletedMessageIds.length, 0);
  assert.equal(harness.store.queue.size, 0);
});

test("moderation level 2 still ignores a plain-text first post with no link or attachment", async () => {
  // holdEveryMessage was retired at levels 2/3: mods reported that holding
  // every new-account message (not just links/attachments) chilled new
  // members and was an unsustainable review burden. All levels now share the
  // same link/attachment trigger; level 2 tightens who counts as "new" and
  // automod's trip threshold instead.
  const harness = makeHarness({ moderationLevel: 2 });
  await enableHold(harness);

  await harness.postGate.handleMessage(
    newAccountMessage({ id: "MSGLEVEL2", content: "hey everyone" })
  );

  assert.equal(harness.deletedMessageIds.length, 0);
  assert.equal(harness.store.queue.size, 0);
});

test("moderation level 2 still exempts an established member", async () => {
  const harness = makeHarness({ moderationLevel: 2 });
  await enableHold(harness);
  recordMessage({
    id: "PRIORMSGLEVEL2",
    channelId: SOURCE_CHANNEL_ID,
    serverId: SERVER_ID,
    authorId: ESTABLISHED_USER_ID,
    content: "an earlier message",
    createdAt: Date.now() - 90 * 24 * 60 * 60 * 1_000,
  });

  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGLEVEL2OLD",
      authorId: ESTABLISHED_USER_ID,
      content: "hey everyone",
      createdAt: new Date(1_800_000_000_000 - 400 * 24 * 60 * 60 * 1_000),
      joinedAt: new Date(1_800_000_000_000 - 400 * 24 * 60 * 60 * 1_000),
    })
  );

  assert.equal(harness.deletedMessageIds.length, 0);
  assert.equal(harness.store.queue.size, 0);
});

test("never gates a privacy-excluded channel", async () => {
  const harness = makeHarness();
  await enableHold(harness);

  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGEXCLUDED1",
      channelId: EXCLUDED_CHANNEL_ID,
      content: "https://example.com",
    })
  );

  assert.equal(harness.deletedMessageIds.length, 0);
  assert.equal(harness.store.queue.size, 0);
});

test("shouldExcludeMessage/shouldExcludeMessageDelete track the hold decision", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  const message = newAccountMessage({
    id: "MSGSEAM1",
    content: "https://example.com",
  });

  const decisionPromise = harness.postGate.shouldExcludeMessage(message);
  await harness.postGate.handleMessage(message);
  assert.equal(await decisionPromise, true);
  assert.equal(
    await harness.postGate.shouldExcludeMessageDelete("MSGSEAM1"),
    false
  );

  assert.equal(
    await harness.postGate.shouldExcludeMessage(
      newAccountMessage({ id: "MSGSEAM2", content: "no link here" })
    ),
    false
  );
});

test("approving a held post clears the queue entry without reposting", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGAPPROVE1",
      content: "https://example.com neat site",
    })
  );
  const [record] = [...harness.store.queue.values()];

  const result = await harness.postGate.handleCommand(
    {
      server: { id: SERVER_ID },
      channelId: REVIEW_CHANNEL_ID,
      authorId: MOD_USER_ID,
    },
    ["approve", record.queueId]
  );

  assert.equal(result.outcome, "approved");
  // The only send is the "✅ Post Approved" status reply to the reviewing
  // moderator. Approval clears the author, it does not republish content.
  assert.equal(harness.sendCalls.length, 1);
  assert.ok(
    harness.sendCalls.every((call) => call.channelId !== SOURCE_CHANNEL_ID)
  );
  assert.equal(harness.store.getHeldPost(record.queueId).status, "approved");
  assert.ok(harness.deletedMessageIds.includes(record.reviewMessageId));
});

test("approving a held post resets the author's automod strike", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  harness.store.setAutomodStrike(SERVER_ID, NEW_USER_ID, {
    level: 2,
    lastContainedAt: 1_800_000_000_000,
    timeoutUntil: null,
  });
  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGAPPROVESTRIKE",
      content: "https://example.com/second-chance",
    })
  );
  const [record] = [...harness.store.queue.values()];

  const result = await harness.postGate.handleCommand(
    {
      server: { id: SERVER_ID },
      channelId: REVIEW_CHANNEL_ID,
      authorId: MOD_USER_ID,
    },
    ["approve", record.queueId]
  );

  assert.equal(result.outcome, "approved");
  assert.equal(result.strikeCleared, true);
  assert.equal(harness.store.getAutomodStrike(SERVER_ID, NEW_USER_ID), null);
});

test("rejecting a held post discards it and increases the automod strike level", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await harness.postGate.handleMessage(
    newAccountMessage({ id: "MSGREJECT1", content: "https://example.com" })
  );
  const [record] = [...harness.store.queue.values()];

  const result = await harness.postGate.handleCommand(
    {
      server: { id: SERVER_ID },
      channelId: REVIEW_CHANNEL_ID,
      authorId: MOD_USER_ID,
    },
    ["reject", record.queueId]
  );

  assert.equal(result.outcome, "rejected");
  assert.equal(result.strikeLevel, 1);
  // The only send is the "❌ Post Rejected" status reply — rejection never
  // reposts to the original channel.
  assert.equal(harness.sendCalls.length, 1);
  assert.ok(
    harness.sendCalls.every((call) => call.channelId !== SOURCE_CHANNEL_ID)
  );
  assert.equal(harness.store.getHeldPost(record.queueId).status, "rejected");
  assert.ok(harness.deletedMessageIds.includes(record.reviewMessageId));
  assert.equal(harness.store.getAutomodStrike(SERVER_ID, NEW_USER_ID).level, 1);

  // A second offense within the quiet-reset window escalates further.
  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGREJECT2",
      content: "https://example.com/again",
    })
  );
  const [, second] = [...harness.store.queue.values()];
  await harness.postGate.handleCommand(
    {
      server: { id: SERVER_ID },
      channelId: REVIEW_CHANNEL_ID,
      authorId: MOD_USER_ID,
    },
    ["reject", second.queueId]
  );
  assert.equal(harness.store.getAutomodStrike(SERVER_ID, NEW_USER_ID).level, 2);
});

test("rejecting a legacy queue entry with no recorded author id resolves it without striking a phantom user", async () => {
  // Simulates an entry created before the authorId-snapshot fix landed:
  // JSON.stringify drops `undefined`, so a broken entry on disk simply has
  // no userId key at all.
  const harness = makeHarness();
  await enableHold(harness);
  harness.store.queue.set("PGDLEGACY1", {
    queueId: "PGDLEGACY1",
    serverId: SERVER_ID,
    channelId: SOURCE_CHANNEL_ID,
    messageId: "MSGLEGACY1",
    content: "",
    attachments: [],
    reviewChannelId: REVIEW_CHANNEL_ID,
    reviewMessageId: null,
    status: "pending",
    createdAt: 1_800_000_000_000,
    expiresAt: 1_800_000_000_000 + 7 * 24 * 60 * 60 * 1_000,
  });

  const result = await harness.postGate.handleCommand(
    {
      server: { id: SERVER_ID },
      channelId: REVIEW_CHANNEL_ID,
      authorId: MOD_USER_ID,
    },
    ["reject", "PGDLEGACY1"]
  );

  assert.equal(result.outcome, "rejected");
  assert.equal(result.strikeLevel, null);
  assert.equal(harness.store.getHeldPost("PGDLEGACY1").status, "rejected");
  assert.equal(harness.store.strikes.has(`${SERVER_ID}:undefined`), false);
  assert.equal(harness.store.strikes.size, 0);

  const outcomeEmbed = harness.protectedLogs.at(-1).payload.embeds[0];
  assert.doesNotMatch(JSON.stringify(outcomeEmbed), /undefined/);
});

test("an unreviewed held post expires after 7 days with no strike", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await harness.postGate.handleMessage(
    newAccountMessage({ id: "MSGEXPIRE1", content: "https://example.com" })
  );
  const [record] = [...harness.store.queue.values()];

  harness.advance(8 * 24 * 60 * 60 * 1000);
  await harness.postGate.maintainQueue();

  assert.equal(harness.store.getHeldPost(record.queueId).status, "expired");
  assert.ok(harness.deletedMessageIds.includes(record.reviewMessageId));
  assert.equal(harness.store.getAutomodStrike(SERVER_ID, NEW_USER_ID), null);
});

test("enabling the post gate requires an Enka-approved code and leaves state unchanged when denied", async () => {
  const harness = makeHarness();
  const requested = await harness.postGate.handleCommand(
    {
      server: { id: SERVER_ID },
      channelId: SOURCE_CHANNEL_ID,
      authorId: MOD_USER_ID,
    },
    ["here"]
  );
  assert.equal(requested.outcome, "requested");
  assert.equal(harness.store.getPostGateConfig(SERVER_ID).mode, "off");

  const denied = await harness.postGate.handleDirectMessage({
    authorId: APPROVER_ID,
    channelId: DM_ID,
    content: "deny 123456",
  });
  assert.equal(denied, true);
  assert.equal(harness.store.getPostGateConfig(SERVER_ID).mode, "off");
});

test("enabling the post gate via a valid Enka code changes configuration", async () => {
  const harness = makeHarness();
  await harness.postGate.handleCommand(
    {
      server: { id: SERVER_ID },
      channelId: SOURCE_CHANNEL_ID,
      authorId: MOD_USER_ID,
    },
    ["here"]
  );

  const approved = await harness.postGate.handleDirectMessage({
    authorId: APPROVER_ID,
    channelId: DM_ID,
    content: "123456",
  });
  assert.equal(approved, true);
  const config = harness.store.getPostGateConfig(SERVER_ID);
  assert.equal(config.mode, "hold");
  assert.equal(config.reviewChannelId, SOURCE_CHANNEL_ID);
});
