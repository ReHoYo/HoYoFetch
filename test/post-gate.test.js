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
const MANAGE_PERMISSIONS_BIT = 2 ** 2;
const BAN_MEMBERS_BIT = 2 ** 7;
const TIMEOUT_MEMBERS_BIT = 2 ** 8;
const VIEW_CHANNEL_BIT = 2 ** 20;
const SEND_MESSAGE_BIT = 2 ** 22;
const UNRELATED_PERMISSION_BIT = 2 ** 16;

function makeStore() {
  const config = new Map();
  const queue = new Map();
  const strikes = new Map();
  const excludedChannels = new Set([EXCLUDED_CHANNEL_ID]);
  return {
    config,
    queue,
    strikes,
    getPostGateConfig(serverId) {
      return (
        config.get(serverId) ?? {
          mode: "off",
          level: 0,
          defaultSendLock: null,
          reviewChannelId: null,
          updatedAt: null,
        }
      );
    },
    setPostGateConfig(serverId, patch) {
      const previous = this.getPostGateConfig(serverId);
      const current = {
        ...previous,
        ...patch,
        level:
          patch.mode === "off"
            ? 0
            : patch.mode === "hold" && !patch.level
              ? previous.level || 1
              : (patch.level ?? previous.level),
        updatedAt: `now-${Date.now()}-${Math.random()}`,
      };
      config.set(serverId, current);
      return { previous, current };
    },
    getAllPostGateConfigs() {
      return [...config.entries()].map(([serverId, value]) => ({
        serverId,
        ...structuredClone(value),
      }));
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
  permissionRefreshFails = false,
  permissionUpdateFails = false,
  permissionUpdateFailsAfter = permissionUpdateFails
    ? 0
    : Number.POSITIVE_INFINITY,
  botRetainsControl = true,
  botCanDelete = true,
  reviewChannelGrantsManageMessages = true,
  initialDefaultPermissions = SEND_MESSAGE_BIT,
  runPermissionEventImmediately = false,
  lockdownDeleteFails = false,
  lockdownBanFails = false,
  onMessageDeleted = () => {},
} = {}) {
  let current = clock;
  const store = makeStore();
  const responses = [];
  const protectedLogs = [];
  const dmPayloads = [];
  const sendCalls = [];
  const reactionPuts = [];
  const bans = [];
  const permissionWrites = [];
  const deletedMessageIds = [];
  const removedEvidencePaths = [];
  let attachmentUploads = 0;
  let serverDefaultPermissions = initialDefaultPermissions;

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
        if (permissionRefreshFails) throw new Error("permission API down");
        const memberMatch = path.match(
          new RegExp(`^/servers/${SERVER_ID}/members/([A-Za-z0-9]+)$`)
        );
        if (path === `/servers/${SERVER_ID}`) {
          return {
            _id: SERVER_ID,
            owner: OWNER_ID,
            default_permissions: serverDefaultPermissions,
            roles: {
              MODROLE: {
                rank: 1,
                permissions: { a: TIMEOUT_MEMBERS_BIT, d: 0 },
              },
              BOTROLE: {
                rank: 1,
                permissions: {
                  a:
                    BAN_MEMBERS_BIT |
                    MANAGE_PERMISSIONS_BIT |
                    (botCanDelete ? MANAGE_MESSAGES_BIT : 0) |
                    VIEW_CHANNEL_BIT |
                    (botRetainsControl ? SEND_MESSAGE_BIT : 0),
                  d: 0,
                },
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
            roles:
              userId === MOD_USER_ID
                ? ["MODROLE"]
                : userId === BOT_ID
                  ? ["BOTROLE"]
                  : [],
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
            default_permissions: {
              a: reviewChannelGrantsManageMessages ? MANAGE_MESSAGES_BIT : 0,
              d: 0,
            },
            role_permissions: {},
          };
        }
        if (path === `/channels/${EXCLUDED_CHANNEL_ID}`) {
          return {
            _id: EXCLUDED_CHANNEL_ID,
            channel_type: "TextChannel",
            server: SERVER_ID,
            default_permissions: { a: 0, d: 0 },
            role_permissions: {},
          };
        }
        const userMatch = path.match(/^\/users\/([A-Za-z0-9]+)$/);
        if (userMatch) {
          return { _id: userMatch[1], bot: userMatch[1] === BOT_ID };
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
      if (lockdownDeleteFails) return { ok: false, status: 403 };
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
    if (method === "PUT" && path.includes("/bans/")) {
      if (lockdownBanFails) return { ok: false, status: 503 };
      bans.push({ path, body });
      return { ok: true, status: 200 };
    }
    if (
      method === "PUT" &&
      path === `/servers/${SERVER_ID}/permissions/default`
    ) {
      permissionWrites.push(body.permissions);
      if (permissionWrites.length > permissionUpdateFailsAfter) {
        return { ok: false, status: 403 };
      }
      serverDefaultPermissions = body.permissions;
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
    scheduleTimeout: (callback, delay) => {
      if (runPermissionEventImmediately && delay === 500) {
        queueMicrotask(callback);
      }
      return { unref() {} };
    },
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
    bans,
    permissionWrites,
    deletedMessageIds,
    removedEvidencePaths,
    get attachmentUploads() {
      return attachmentUploads;
    },
    get serverDefaultPermissions() {
      return serverDefaultPermissions;
    },
    set serverDefaultPermissions(value) {
      serverDefaultPermissions = value;
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
    level: 1,
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

test("levels 1 and 2 hold common obfuscated link forms without rewriting evidence", async () => {
  const variants = [
    "h t t p s : / / example . com / login",
    "hxxps://example.com/login",
    "w w w . example . com",
    "example [.] com",
    "example (dot) com",
    "example { dot } com",
    "example\u3002com",
    "exa\u200Bmple.com",
    "ｅｘａｍｐｌｅ．ｃｏｍ",
    "discord [.] gg / invite",
    "192 . 0 . 2 . 1 : 8080 / login",
    "shop.example.xn--p1ai",
  ];

  for (const level of [1, 2]) {
    for (const [index, content] of variants.entries()) {
      const harness = makeHarness();
      await enableHold(harness);
      harness.store.setPostGateConfig(SERVER_ID, { level });
      const messageId = `MSGOBFUSCATED${level}${index}`;

      await harness.postGate.handleMessage(
        newAccountMessage({ id: messageId, content })
      );

      assert.deepEqual(harness.deletedMessageIds, [messageId], content);
      assert.equal(harness.store.queue.size, 1, content);
      const [record] = [...harness.store.queue.values()];
      assert.equal(record.content, content, content);
    }
  }
});

test("broad link normalization still allows ordinary non-link prose", async () => {
  const examples = [
    "hello everyone!",
    "please dot the i and cross the t",
    "version 1.2.3 is ready",
    "this sentence is fine. No worries here.",
    "we discussed protocols and domains today",
  ];

  for (const [index, content] of examples.entries()) {
    const harness = makeHarness();
    await enableHold(harness);
    await harness.postGate.handleMessage(
      newAccountMessage({ id: `MSGPROSE${index}`, content })
    );
    assert.equal(harness.deletedMessageIds.length, 0, content);
    assert.equal(harness.store.queue.size, 0, content);
  }
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
  const harness = makeHarness();
  await enableHold(harness);
  harness.store.setPostGateConfig(SERVER_ID, { level: 2 });

  await harness.postGate.handleMessage(
    newAccountMessage({ id: "MSGLEVEL2", content: "hey everyone" })
  );

  assert.equal(harness.deletedMessageIds.length, 0);
  assert.equal(harness.store.queue.size, 0);
});

test("moderation level 2 still exempts an established member", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  harness.store.setPostGateConfig(SERVER_ID, { level: 2 });
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

test("level 2 retains the new-member link and media review policy", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  harness.store.setPostGateConfig(SERVER_ID, { level: 2 });

  await harness.postGate.handleMessage(
    newAccountMessage({ id: "MSGLEVEL2", content: "https://example.com" })
  );

  assert.deepEqual(harness.deletedMessageIds, ["MSGLEVEL2"]);
  assert.equal(harness.store.queue.size, 1);
  assert.equal(harness.protectedLogs.length, 1);
  assert.equal(harness.permissionWrites.length, 0);
});

test("level 3 denies every regular-member message without queue or evidence", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  harness.store.setPostGateConfig(SERVER_ID, { level: 3 });
  const messages = [
    newAccountMessage({ id: "MSGLOCKTEXT", content: "hello" }),
    newAccountMessage({
      id: "MSGLOCKLINK",
      content: "https://example.com",
    }),
    newAccountMessage({
      id: "MSGLOCKMEDIA",
      attachments: [{ id: "ATTLOCK", filename: "x.png", size: 5 }],
    }),
    newAccountMessage({
      id: "MSGLOCKPRIVATE",
      channelId: EXCLUDED_CHANNEL_ID,
      content: "private text",
    }),
  ];

  for (const message of messages) {
    const excluded = harness.postGate.shouldExcludeMessage(message);
    await harness.postGate.handleMessage(message);
    assert.equal(await excluded, true);
  }

  assert.deepEqual(harness.deletedMessageIds, [
    "MSGLOCKTEXT",
    "MSGLOCKLINK",
    "MSGLOCKMEDIA",
    "MSGLOCKPRIVATE",
  ]);
  assert.equal(harness.store.queue.size, 0);
  assert.equal(harness.protectedLogs.length, 0);
  assert.equal(harness.attachmentUploads, 0);
});

test("level 3 exempts verified moderators and fails safe on refresh errors", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  harness.store.setPostGateConfig(SERVER_ID, { level: 3 });
  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGLOCKMOD",
      authorId: MOD_USER_ID,
      content: "moderator update",
    })
  );
  assert.equal(harness.deletedMessageIds.length, 0);

  const failed = makeHarness({ permissionRefreshFails: true });
  await enableHold(failed);
  failed.store.setPostGateConfig(SERVER_ID, { level: 3 });
  const message = newAccountMessage({
    id: "MSGLOCKUNKNOWN",
    content: "could be staff",
  });
  const excluded = failed.postGate.shouldExcludeMessage(message);
  await failed.postGate.handleMessage(message);
  assert.equal(await excluded, false);
  assert.equal(failed.deletedMessageIds.length, 0);
});

test("level 3 activation posts one transition notice and no-op changes stay quiet", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  const command = {
    server: { id: SERVER_ID },
    channelId: REVIEW_CHANNEL_ID,
    authorId: MOD_USER_ID,
  };

  const changed = await harness.postGate.handleLevelCommand(command, ["3"]);
  assert.equal(changed.outcome, "level_changed");
  assert.equal(harness.store.getPostGateConfig(SERVER_ID).level, 3);
  assert.deepEqual(harness.permissionWrites, [0]);
  assert.equal(harness.serverDefaultPermissions & SEND_MESSAGE_BIT, 0);
  assert.equal(
    harness.store.getPostGateConfig(SERVER_ID).defaultSendLock.restoreOnUnlock,
    true
  );
  assert.equal(harness.protectedLogs.length, 1);
  assert.match(
    harness.protectedLogs[0].payload.embeds[0].description,
    /avoid flooding the moderation queue/
  );

  const unchanged = await harness.postGate.handleLevelCommand(command, ["3"]);
  assert.equal(unchanged.outcome, "no_change");
  assert.equal(harness.protectedLogs.length, 1);
});

test("level 3 refuses activation when the permission lock cannot be applied", async () => {
  const failedUpdate = makeHarness({ permissionUpdateFails: true });
  await enableHold(failedUpdate);
  const command = {
    server: { id: SERVER_ID },
    channelId: REVIEW_CHANNEL_ID,
    authorId: MOD_USER_ID,
  };

  const failed = await failedUpdate.postGate.handleLevelCommand(command, ["3"]);
  assert.equal(failed.outcome, "permission_update_failed");
  assert.equal(failedUpdate.store.getPostGateConfig(SERVER_ID).level, 1);
  assert.equal(
    failedUpdate.store.getPostGateConfig(SERVER_ID).defaultSendLock,
    null
  );

  const losesControl = makeHarness({ botRetainsControl: false });
  await enableHold(losesControl);
  const unsafe = await losesControl.postGate.handleLevelCommand(command, ["3"]);
  assert.equal(unsafe.outcome, "control_access_required");
  assert.equal(losesControl.store.getPostGateConfig(SERVER_ID).level, 1);
  assert.equal(losesControl.permissionWrites.length, 0);

  const unverified = makeHarness({ permissionRefreshFails: true });
  await enableHold(unverified);
  const denied = await unverified.postGate.handleLevelCommand(command, ["3"]);
  assert.equal(denied.outcome, "unauthorized");
  assert.equal(unverified.store.getPostGateConfig(SERVER_ID).level, 1);
  assert.equal(unverified.permissionWrites.length, 0);
});

test("level 3 warns but still locks when deletion fallback is unavailable", async () => {
  const harness = makeHarness({
    botCanDelete: false,
    reviewChannelGrantsManageMessages: false,
  });
  await enableHold(harness);
  const command = {
    server: { id: SERVER_ID },
    channelId: REVIEW_CHANNEL_ID,
    authorId: MOD_USER_ID,
  };

  const changed = await harness.postGate.handleLevelCommand(command, ["3"]);

  assert.equal(changed.outcome, "level_changed");
  assert.equal(harness.store.getPostGateConfig(SERVER_ID).level, 3);
  assert.equal(harness.serverDefaultPermissions & SEND_MESSAGE_BIT, 0);
  assert.match(
    harness.protectedLogs[0].payload.embeds[0].description,
    /deletion of any slipped messages is best effort/
  );
});

test("unlock restores only the default Send Messages bit Irminsul removed", async () => {
  const harness = makeHarness({
    initialDefaultPermissions: SEND_MESSAGE_BIT | UNRELATED_PERMISSION_BIT,
  });
  await enableHold(harness);
  const command = {
    server: { id: SERVER_ID },
    channelId: REVIEW_CHANNEL_ID,
    authorId: MOD_USER_ID,
  };

  await harness.postGate.handleLevelCommand(command, ["3"]);
  const permissionAddedDuringLockdown = 2 ** 17;
  harness.serverDefaultPermissions |= permissionAddedDuringLockdown;
  const changed = await harness.postGate.handleLevelCommand(command, ["2"]);

  assert.equal(changed.outcome, "level_changed");
  assert.equal(harness.store.getPostGateConfig(SERVER_ID).level, 2);
  assert.equal(
    harness.store.getPostGateConfig(SERVER_ID).defaultSendLock,
    null
  );
  assert.equal(
    harness.serverDefaultPermissions,
    SEND_MESSAGE_BIT | UNRELATED_PERMISSION_BIT | permissionAddedDuringLockdown
  );
});

test("unlock leaves Send Messages disabled when it was already disabled", async () => {
  const harness = makeHarness({
    initialDefaultPermissions: UNRELATED_PERMISSION_BIT,
  });
  await enableHold(harness);
  const command = {
    server: { id: SERVER_ID },
    channelId: REVIEW_CHANNEL_ID,
    authorId: MOD_USER_ID,
  };

  await harness.postGate.handleLevelCommand(command, ["3"]);
  assert.equal(harness.permissionWrites.length, 0);
  assert.equal(
    harness.store.getPostGateConfig(SERVER_ID).defaultSendLock.restoreOnUnlock,
    false
  );
  await harness.postGate.handleLevelCommand(command, ["1"]);

  assert.equal(harness.serverDefaultPermissions, UNRELATED_PERMISSION_BIT);
  assert.equal(harness.permissionWrites.length, 0);
  assert.equal(
    harness.store.getPostGateConfig(SERVER_ID).defaultSendLock,
    null
  );
});

test("a failed unlock keeps lockdown active and retains restoration metadata", async () => {
  const harness = makeHarness({ permissionUpdateFailsAfter: 1 });
  await enableHold(harness);
  const command = {
    server: { id: SERVER_ID },
    channelId: REVIEW_CHANNEL_ID,
    authorId: MOD_USER_ID,
  };

  await harness.postGate.handleLevelCommand(command, ["3"]);
  const failed = await harness.postGate.handleLevelCommand(command, ["2"]);

  assert.equal(failed.outcome, "permission_restore_failed");
  assert.equal(harness.store.getPostGateConfig(SERVER_ID).level, 3);
  assert.equal(
    harness.store.getPostGateConfig(SERVER_ID).defaultSendLock.restoreOnUnlock,
    true
  );
  assert.equal(harness.serverDefaultPermissions & SEND_MESSAGE_BIT, 0);
});

test("permission reconciliation repairs lockdown drift and preserves other bits", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  const command = {
    server: { id: SERVER_ID },
    channelId: REVIEW_CHANNEL_ID,
    authorId: MOD_USER_ID,
  };
  await harness.postGate.handleLevelCommand(command, ["3"]);

  harness.serverDefaultPermissions =
    SEND_MESSAGE_BIT | UNRELATED_PERMISSION_BIT;
  const repaired = await harness.postGate.reconcilePermissionLock(SERVER_ID);

  assert.equal(repaired.ok, true);
  assert.equal(repaired.changed, true);
  assert.equal(harness.serverDefaultPermissions, UNRELATED_PERMISSION_BIT);
  assert.deepEqual(harness.permissionWrites, [0, UNRELATED_PERMISSION_BIT]);
});

test("ServerUpdate triggers permission reconciliation for active lockdown", async () => {
  const harness = makeHarness({ runPermissionEventImmediately: true });
  await enableHold(harness);
  const command = {
    server: { id: SERVER_ID },
    channelId: REVIEW_CHANNEL_ID,
    authorId: MOD_USER_ID,
  };
  await harness.postGate.handleLevelCommand(command, ["3"]);
  harness.serverDefaultPermissions = SEND_MESSAGE_BIT;

  await harness.postGate.handleRawEvent({
    type: "ServerUpdate",
    id: SERVER_ID,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.serverDefaultPermissions & SEND_MESSAGE_BIT, 0);
  assert.equal(harness.permissionWrites.length, 2);
});

test("legacy lockdown stays deletion-only when reconciliation is degraded", async () => {
  const harness = makeHarness({ permissionUpdateFails: true });
  await enableHold(harness);
  harness.store.setPostGateConfig(SERVER_ID, { level: 3 });

  const result = await harness.postGate.reconcilePermissionLocks();

  assert.equal(result[0].outcome, "permission_update_failed");
  assert.equal(harness.store.getPostGateConfig(SERVER_ID).level, 3);
  assert.equal(
    harness.store.getPostGateConfig(SERVER_ID).defaultSendLock,
    null
  );
  assert.equal(harness.protectedLogs.length, 1);
  assert.match(
    harness.protectedLogs[0].payload.embeds[0].description,
    /Reactive deletion remains active/
  );
});

test("lockdown enforcement failures throttle protected alerts", async () => {
  const harness = makeHarness({ lockdownDeleteFails: true });
  await enableHold(harness);
  harness.store.setPostGateConfig(SERVER_ID, { level: 3 });

  for (const id of ["MSGFAIL1", "MSGFAIL2", "MSGFAIL3"]) {
    await harness.postGate.handleMessage(
      newAccountMessage({ id, content: "blocked" })
    );
  }
  assert.equal(harness.protectedLogs.length, 1);
  assert.match(
    harness.protectedLogs[0].payload.embeds[0].title,
    /Enforcement Degraded/
  );

  harness.advance(10 * 60 * 1000 + 1);
  await harness.postGate.handleMessage(
    newAccountMessage({ id: "MSGFAIL4", content: "blocked again" })
  );
  assert.equal(harness.protectedLogs.length, 2);
});

test("level 4 requires an invoker-only reaction and bans each poster once", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  const command = {
    server: { id: SERVER_ID },
    channelId: REVIEW_CHANNEL_ID,
    authorId: MOD_USER_ID,
  };

  const requested = await harness.postGate.handleLevelCommand(command, [
    "4",
    "confirm",
  ]);
  assert.equal(requested.outcome, "confirmation_requested");
  assert.equal(harness.store.getPostGateConfig(SERVER_ID).level, 1);

  await harness.postGate.handleRawEvent({
    type: "MessageReact",
    id: requested.promptMessageId,
    user_id: NEW_USER_ID,
    emoji_id: "✅",
  });
  assert.equal(harness.store.getPostGateConfig(SERVER_ID).level, 1);

  await harness.postGate.handleRawEvent({
    type: "MessageReact",
    id: requested.promptMessageId,
    user_id: MOD_USER_ID,
    emoji_id: "✅",
  });
  assert.equal(harness.store.getPostGateConfig(SERVER_ID).level, 4);

  await harness.postGate.handleMessage(
    newAccountMessage({ id: "MSGLEVEL4A", content: "first attempt" })
  );
  await harness.postGate.handleMessage(
    newAccountMessage({ id: "MSGLEVEL4B", content: "second attempt" })
  );
  assert.deepEqual(harness.deletedMessageIds, ["MSGLEVEL4A", "MSGLEVEL4B"]);
  assert.equal(harness.bans.length, 1);
  assert.match(harness.bans[0].body.reason, /Level 4 lockdown/);
  assert.equal(harness.store.queue.size, 0);
});

test("level 4 confirmation expires or becomes stale without changing level", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  const command = {
    server: { id: SERVER_ID },
    channelId: REVIEW_CHANNEL_ID,
    authorId: MOD_USER_ID,
  };
  const expired = await harness.postGate.handleLevelCommand(command, [
    "4",
    "confirm",
  ]);
  harness.advance(2 * 60 * 1000 + 1);
  await harness.postGate.handleRawEvent({
    type: "MessageReact",
    id: expired.promptMessageId,
    user_id: MOD_USER_ID,
    emoji_id: "✅",
  });
  assert.equal(harness.store.getPostGateConfig(SERVER_ID).level, 1);

  const stale = await harness.postGate.handleLevelCommand(command, [
    "4",
    "confirm",
  ]);
  harness.store.setPostGateConfig(SERVER_ID, { level: 2 });
  await harness.postGate.handleRawEvent({
    type: "MessageReact",
    id: stale.promptMessageId,
    user_id: MOD_USER_ID,
    emoji_id: "✅",
  });
  assert.equal(harness.store.getPostGateConfig(SERVER_ID).level, 2);
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

test("rejecting a held post discards it and increases the automod strike stage", async () => {
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
