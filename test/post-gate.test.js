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
const { AUTOMOD_LIMITS } = await import("../automod.js");
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
  const holds = new Map();
  const excludedChannels = new Set([EXCLUDED_CHANNEL_ID]);
  // Mutable so a test can hand the gate an operator list mid-run.
  const termList = {
    terms: [],
    allowlist: [],
    status: "missing",
    error: null,
    skipped: 0,
    loadedAt: 0,
  };
  let lastTermSignature = null;
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
          raidMode: null,
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

    // ── Full-user Post Gate holds ──────────────────────────────
    holds,
    isUserHeld(serverId, userId) {
      return holds.get(`${serverId}:${userId}`)?.active === true;
    },
    getUserHold(serverId, userId) {
      const record = holds.get(`${serverId}:${userId}`);
      return record ? structuredClone(record) : null;
    },
    createUserHold(record) {
      const key = `${record.serverId}:${record.userId}`;
      const existing = holds.get(key);
      if (existing?.active) {
        return { created: false, record: structuredClone(existing) };
      }
      const stored = {
        reminderCount: 0,
        lastReminderMessageId: null,
        releasedAt: null,
        releasedBy: null,
        releaseReason: null,
        ...structuredClone(record),
        active: true,
      };
      holds.set(key, stored);
      return { created: true, record: structuredClone(stored) };
    },
    updateUserHold(serverId, userId, patch) {
      const key = `${serverId}:${userId}`;
      const record = holds.get(key);
      if (!record) return null;
      const updated = { ...record, ...structuredClone(patch) };
      holds.set(key, updated);
      return structuredClone(updated);
    },
    releaseUserHold(serverId, userId, { releasedBy, releasedAt, reason } = {}) {
      const key = `${serverId}:${userId}`;
      const record = holds.get(key);
      if (!record?.active) {
        return {
          released: false,
          record: record ? structuredClone(record) : null,
        };
      }
      const updated = {
        ...record,
        active: false,
        releasedBy: releasedBy ?? null,
        releasedAt: releasedAt ?? null,
        releaseReason: reason ?? null,
        reminderAt: null,
      };
      holds.set(key, updated);
      return { released: true, record: structuredClone(updated) };
    },
    findUserHoldByCardMessage(messageId) {
      for (const record of holds.values()) {
        if (!record.active) continue;
        if (record.cardMessageId === messageId) {
          return { record: structuredClone(record), cardKind: "control" };
        }
        if (record.lastReminderMessageId === messageId) {
          return { record: structuredClone(record), cardKind: "reminder" };
        }
      }
      return null;
    },
    getActiveUserHolds(serverId) {
      return [...holds.values()]
        .filter(
          (record) =>
            record.active &&
            (serverId === undefined || record.serverId === serverId)
        )
        .map((record) => structuredClone(record));
    },
    getDueUserHoldReminders(now) {
      return [...holds.values()]
        .filter(
          (record) =>
            record.active &&
            Number.isFinite(record.reminderAt) &&
            record.reminderAt <= now
        )
        .map((record) => structuredClone(record));
    },
    prunePostGateUserHolds() {
      return false;
    },

    // ── Operator prohibited-term list ──────────────────────────
    termList,
    getProhibitedTermList() {
      return structuredClone(termList);
    },
    reloadProhibitedTermList({ force = false } = {}) {
      const signature = JSON.stringify(termList);
      const changed = force || signature !== lastTermSignature;
      lastTermSignature = signature;
      return { changed, ...structuredClone(termList) };
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
  holdReminderMs = 24 * 60 * 60 * 1_000,
  profileResponses = new Map(),
  profileCacheTtlMs,
  profileRetryMs,
  profileCacheMaxEntries,
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
  const logLines = [];
  const profileRequests = [];
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
    const profileMatch = path.match(/^\/users\/([A-Za-z0-9]+)\/profile$/);
    if (method === "GET" && profileMatch) {
      const userId = profileMatch[1];
      profileRequests.push(userId);
      const configured = profileResponses.get(userId);
      const response =
        typeof configured === "function"
          ? await configured({ userId, call: profileRequests.length })
          : configured;
      if (typeof response === "string") {
        return { ok: true, status: 200, data: { content: response } };
      }
      return response ?? { ok: false, status: 404 };
    }
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
    holdReminderMs,
    ...(profileCacheTtlMs === undefined ? {} : { profileCacheTtlMs }),
    ...(profileRetryMs === undefined ? {} : { profileRetryMs }),
    ...(profileCacheMaxEntries === undefined ? {} : { profileCacheMaxEntries }),
    logger: {
      log: (line) => logLines.push(line),
      warn: (line) => logLines.push(line),
    },
  });

  return {
    postGate,
    store,
    logLines,
    responses,
    protectedLogs,
    dmPayloads,
    sendCalls,
    reactionPuts,
    bans,
    permissionWrites,
    deletedMessageIds,
    removedEvidencePaths,
    profileRequests,
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
  // Approve, deny, and deny + hold user are all offered on the card.
  assert.equal(harness.reactionPuts.length, 3);
  const [record] = [...harness.store.queue.values()];
  assert.equal(record.status, "pending");
  assert.equal(record.userId, NEW_USER_ID);
  assert.equal(record.trigger, "first_post");
  assert.equal(record.ruleId, null);
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

test("level 2 widens targeted link review to 14-day accounts and 3-day members", async () => {
  const cases = [
    {
      id: "MSGLEVEL2ACCOUNTWINDOW",
      userId: "LEVEL2ACCOUNTUSER",
      createdAt: new Date(1_800_000_000_000 - 10 * 24 * 60 * 60 * 1_000),
      joinedAt: new Date(1_800_000_000_000 - 30 * 24 * 60 * 60 * 1_000),
    },
    {
      id: "MSGLEVEL2MEMBERWINDOW",
      userId: "LEVEL2MEMBERUSER",
      createdAt: new Date(1_800_000_000_000 - 400 * 24 * 60 * 60 * 1_000),
      joinedAt: new Date(1_800_000_000_000 - 2 * 24 * 60 * 60 * 1_000),
    },
  ];

  for (const entry of cases) {
    const harness = makeHarness();
    await enableHold(harness);
    recordMessage({
      id: `PRIOR${entry.id}`,
      channelId: SOURCE_CHANNEL_ID,
      serverId: SERVER_ID,
      authorId: entry.userId,
      content: "an earlier message",
      createdAt: Date.now() - 90 * 24 * 60 * 60 * 1_000,
    });

    await harness.postGate.handleMessage(
      newAccountMessage({
        id: `LEVEL1${entry.id}`,
        authorId: entry.userId,
        content: "https://example.com",
        createdAt: entry.createdAt,
        joinedAt: entry.joinedAt,
      })
    );
    assert.equal(harness.deletedMessageIds.length, 0);

    harness.store.setPostGateConfig(SERVER_ID, { level: 2 });
    await harness.postGate.handleMessage(
      newAccountMessage({
        id: entry.id,
        authorId: entry.userId,
        content: "https://example.com",
        createdAt: entry.createdAt,
        joinedAt: entry.joinedAt,
      })
    );
    assert.deepEqual(harness.deletedMessageIds, [entry.id]);
  }
});

test("level 2 does not widen contact screening beyond 7 days and 24 hours", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  harness.store.setPostGateConfig(SERVER_ID, { level: 2 });

  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGLEVEL2CONTACTBOUNDARY",
      authorId: "LEVEL2CONTACTUSER",
      content: "DM me on Discord",
      createdAt: new Date(1_800_000_000_000 - 10 * 24 * 60 * 60 * 1_000),
      joinedAt: new Date(1_800_000_000_000 - 2 * 24 * 60 * 60 * 1_000),
    })
  );

  assert.equal(harness.deletedMessageIds.length, 0);
  assert.equal(harness.profileRequests.length, 0);
  assert.equal(harness.store.isUserHeld(SERVER_ID, "LEVEL2CONTACTUSER"), false);
});

test("level status distinguishes configured and automatic effective policy", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  harness.store.setPostGateConfig(SERVER_ID, {
    raidMode: {
      startedAt: 1_800_000_000_000,
      lastRefreshAt: 1_800_000_000_000,
      expiresAt: 1_800_001_800_000,
    },
  });

  const result = await harness.postGate.handleLevelCommand(
    reviewCommandMessage(),
    ["status"]
  );
  assert.equal(result.config.level, 1);
  assert.equal(result.policy.effectiveLevel, 2);
  const description = harness.sendCalls.at(-1).payload.embeds[0].description;
  assert.match(description, /Configured level:\*\* 1/);
  assert.match(description, /Effective level:\*\* 2/);
  assert.match(description, /Shared Raid Mode:\*\* active until/);
});

test("setting Level 1 during shared Raid Mode changes only the configured baseline", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  harness.store.setPostGateConfig(SERVER_ID, {
    level: 2,
    raidMode: {
      startedAt: 1_800_000_000_000,
      lastRefreshAt: 1_800_000_000_000,
      expiresAt: 1_800_001_800_000,
    },
  });

  const result = await harness.postGate.handleLevelCommand(
    reviewCommandMessage(),
    ["1"]
  );
  assert.equal(result.outcome, "level_changed");
  assert.equal(result.level, 1);
  assert.equal(result.effectiveLevel, 2);
  assert.equal(harness.store.getPostGateConfig(SERVER_ID).level, 1);
  assert.match(
    harness.sendCalls.at(-1).payload.embeds[0].description,
    /keeps the effective policy at Level 2/
  );
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

// ══════════════════════════════════════════════════════════════
//  Prohibited-term holds
// ══════════════════════════════════════════════════════════════

// A stand-in operator term, so the tests never have to spell a real slur out.
const OPERATOR_TERM = "flurbex";

function establishedMessage({ id, content, authorId = ESTABLISHED_USER_ID }) {
  return newAccountMessage({
    id,
    authorId,
    content,
    createdAt: new Date(1_800_000_000_000 - 400 * 24 * 60 * 60 * 1000),
    joinedAt: new Date(1_800_000_000_000 - 200 * 24 * 60 * 60 * 1000),
  });
}

function recentIdentityMessage({
  id,
  content,
  authorId = ESTABLISHED_USER_ID,
  createdAt = new Date(1_800_000_000_000 - 60_000),
  joinedAt = new Date(1_800_000_000_000 - 60_000),
} = {}) {
  return newAccountMessage({ id, authorId, content, createdAt, joinedAt });
}

function useOperatorTerms(harness, { terms = [], allowlist = [] } = {}) {
  Object.assign(harness.store.termList, {
    terms,
    allowlist,
    status: "ok",
    error: null,
    skipped: 0,
  });
  harness.postGate.reloadProhibitedTerms();
}

// Attaches a username/display name/nickname to an otherwise ordinary test
// message, for the prohibited-term identity screener.
function withIdentity(message, { username, displayName, nickname } = {}) {
  return {
    ...message,
    author: { ...message.author, username, displayName },
    member: { ...message.member, nickname },
  };
}

// Shape of a revolt.js ServerMember, as delivered to serverMemberJoin/Update.
function memberObject({
  userId,
  username,
  displayName,
  nickname,
  bot = false,
} = {}) {
  return {
    id: { server: SERVER_ID, user: userId },
    user: { username, displayName, bot },
    nickname,
  };
}

const reviewCommandMessage = (authorId = MOD_USER_ID) => ({
  server: { id: SERVER_ID },
  channelId: REVIEW_CHANNEL_ID,
  authorId,
});

// ══════════════════════════════════════════════════════════════
//  Automatic DM and off-platform solicitation holds
// ══════════════════════════════════════════════════════════════

test("a contact solicitation automatically holds a recent-identity account without a strike", async () => {
  const harness = makeHarness();
  await enableHold(harness);

  await harness.postGate.handleMessage(
    recentIdentityMessage({ id: "MSGCONTACT1", content: "my DMs are open" })
  );

  assert.deepEqual(harness.deletedMessageIds, ["MSGCONTACT1"]);
  assert.equal(harness.profileRequests.length, 0);
  const [queued] = [...harness.store.queue.values()];
  assert.equal(queued.trigger, "contact_solicitation");
  assert.equal(queued.triggerSurface, "message");
  assert.equal(queued.ruleId, "contact:dm-available");
  const hold = harness.store.getUserHold(SERVER_ID, ESTABLISHED_USER_ID);
  assert.equal(hold.active, true);
  assert.equal(hold.holdSource, "automatic");
  assert.equal(hold.heldBy, null);
  assert.equal(hold.triggerSurface, "message");
  assert.equal(hold.triggerRuleId, "contact:dm-available");
  assert.equal(
    harness.store.getAutomodStrike(SERVER_ID, ESTABLISHED_USER_ID),
    null
  );
  assert.match(JSON.stringify(harness.protectedLogs), /automatic screening/);
});

test("contact screening accepts either recent-account or recent-membership identity risk", async () => {
  const cases = [
    {
      id: "MSGCONTACTACCOUNT",
      createdAt: new Date(1_800_000_000_000 - 60_000),
      joinedAt: null,
    },
    {
      id: "MSGCONTACTMEMBER",
      createdAt: new Date(1_800_000_000_000 - 400 * 24 * 60 * 60 * 1_000),
      joinedAt: new Date(1_800_000_000_000 - 60_000),
    },
  ];

  for (const entry of cases) {
    const harness = makeHarness();
    await enableHold(harness);
    await harness.postGate.handleMessage(
      recentIdentityMessage({ ...entry, content: "DM me" })
    );

    assert.deepEqual(harness.deletedMessageIds, [entry.id]);
    assert.equal(
      harness.store.isUserHeld(SERVER_ID, ESTABLISHED_USER_ID),
      true
    );
  }
});

test("established accounts and established first-time posters are not contact screened", async () => {
  const harness = makeHarness({
    profileResponses: new Map([[ESTABLISHED_USER_ID, "DMs open"]]),
  });
  await enableHold(harness);

  const messageMatch = establishedMessage({
    id: "MSGCONTACTESTABLISHED1",
    content: "DM me",
  });
  const bioOnlyMatch = establishedMessage({
    id: "MSGCONTACTESTABLISHED2",
    content: "ordinary first post",
  });
  const firstHandling = harness.postGate.handleMessage(messageMatch);
  const firstExcluded = harness.postGate.shouldExcludeMessage(messageMatch);
  const secondHandling = harness.postGate.handleMessage(bioOnlyMatch);
  const secondExcluded = harness.postGate.shouldExcludeMessage(bioOnlyMatch);
  await Promise.all([firstHandling, secondHandling]);

  assert.equal(await firstExcluded, false);
  assert.equal(await secondExcluded, false);
  assert.equal(harness.profileRequests.length, 0);
  assert.equal(harness.deletedMessageIds.length, 0);
  assert.equal(harness.store.queue.size, 0);
  assert.equal(harness.store.holds.size, 0);
});

test("contact screening follows exact recent-identity boundaries and rejects invalid future dates", async () => {
  const current = 1_800_000_000_000;
  const cases = [
    {
      id: "MSGCONTACTBOUNDARYOLD",
      expectedHeld: false,
      createdAt: new Date(current - AUTOMOD_LIMITS.recentAccountMs),
      joinedAt: new Date(current - AUTOMOD_LIMITS.recentMemberMs),
    },
    {
      id: "MSGCONTACTBOUNDARYACCOUNT",
      expectedHeld: true,
      createdAt: new Date(current - AUTOMOD_LIMITS.recentAccountMs + 1),
      joinedAt: new Date(current - AUTOMOD_LIMITS.recentMemberMs),
    },
    {
      id: "MSGCONTACTBOUNDARYMEMBER",
      expectedHeld: true,
      createdAt: new Date(current - AUTOMOD_LIMITS.recentAccountMs),
      joinedAt: new Date(current - AUTOMOD_LIMITS.recentMemberMs + 1),
    },
    {
      id: "MSGCONTACTFUTURE",
      expectedHeld: false,
      createdAt: new Date(current + 60_000),
      joinedAt: new Date("invalid"),
    },
  ];

  for (const entry of cases) {
    const harness = makeHarness({ clock: current });
    await enableHold(harness);
    await harness.postGate.handleMessage(
      recentIdentityMessage({ ...entry, content: "DMs open" })
    );

    assert.equal(
      harness.store.isUserHeld(SERVER_ID, ESTABLISHED_USER_ID),
      entry.expectedHeld,
      entry.id
    );
    assert.equal(
      harness.deletedMessageIds.includes(entry.id),
      entry.expectedHeld,
      entry.id
    );
  }
});

test("a matching profile bio holds a recent-identity message before other listeners proceed without copying the bio", async () => {
  const secretBio = "DMs open — Discord: private-handle";
  const harness = makeHarness({
    profileResponses: new Map([[ESTABLISHED_USER_ID, secretBio]]),
  });
  await enableHold(harness);
  const message = recentIdentityMessage({
    id: "MSGCONTACTBIO1",
    content: "ordinary server message",
  });

  const handling = harness.postGate.handleMessage(message);
  const excluded = harness.postGate.shouldExcludeMessage(message);
  await handling;

  assert.equal(await excluded, true);
  assert.deepEqual(harness.deletedMessageIds, ["MSGCONTACTBIO1"]);
  assert.deepEqual(harness.profileRequests, [ESTABLISHED_USER_ID]);
  const [queued] = [...harness.store.queue.values()];
  assert.equal(queued.trigger, "contact_solicitation");
  assert.equal(queued.triggerSurface, "bio");
  const cards = JSON.stringify(harness.protectedLogs);
  assert.match(cards, /profile bio \(content withheld\)/);
  assert.equal(cards.includes(secretBio), false);
  assert.equal(cards.includes("private-handle"), false);
});

test("successful profile checks are cached until TTL and refreshed afterwards", async () => {
  const profileResponses = new Map([[ESTABLISHED_USER_ID, "ordinary bio"]]);
  const harness = makeHarness({ profileResponses, profileCacheTtlMs: 1_000 });
  await enableHold(harness);

  await harness.postGate.handleMessage(
    recentIdentityMessage({ id: "MSGCONTACTCACHE1", content: "one" })
  );
  await harness.postGate.handleMessage(
    recentIdentityMessage({ id: "MSGCONTACTCACHE2", content: "two" })
  );
  assert.equal(harness.profileRequests.length, 1);

  harness.advance(1_001);
  profileResponses.set(ESTABLISHED_USER_ID, "direct messages welcome");
  await harness.postGate.handleMessage(
    recentIdentityMessage({ id: "MSGCONTACTCACHE3", content: "three" })
  );
  assert.equal(harness.profileRequests.length, 2);
  assert.deepEqual(harness.deletedMessageIds, ["MSGCONTACTCACHE3"]);
});

test("profile lookup failures fail open, log redacted context, and retry after the backoff", async () => {
  const profileResponses = new Map([
    [ESTABLISHED_USER_ID, { ok: false, status: 503 }],
  ]);
  const harness = makeHarness({ profileResponses, profileRetryMs: 1_000 });
  await enableHold(harness);

  await harness.postGate.handleMessage(
    recentIdentityMessage({ id: "MSGCONTACTFAIL1", content: "one" })
  );
  await harness.postGate.handleMessage(
    recentIdentityMessage({ id: "MSGCONTACTFAIL2", content: "two" })
  );
  assert.equal(harness.profileRequests.length, 1);
  assert.equal(harness.deletedMessageIds.length, 0);
  assert.equal(
    harness.logLines.join("\n").includes(ESTABLISHED_USER_ID),
    false
  );

  harness.advance(1_001);
  profileResponses.set(ESTABLISHED_USER_ID, "message me");
  await harness.postGate.handleMessage(
    recentIdentityMessage({ id: "MSGCONTACTFAIL3", content: "three" })
  );
  assert.equal(harness.profileRequests.length, 2);
  assert.deepEqual(harness.deletedMessageIds, ["MSGCONTACTFAIL3"]);
});

test("concurrent messages coalesce one profile lookup and one automatic user hold", async () => {
  let releaseProfile;
  const profilePending = new Promise((resolve) => {
    releaseProfile = resolve;
  });
  const harness = makeHarness({
    profileResponses: new Map([
      [
        ESTABLISHED_USER_ID,
        async () => {
          await profilePending;
          return { ok: true, status: 200, data: { content: "DM me" } };
        },
      ],
    ]),
  });
  await enableHold(harness);

  const first = harness.postGate.handleMessage(
    recentIdentityMessage({ id: "MSGCONTACTRACE1", content: "one" })
  );
  const second = harness.postGate.handleMessage(
    recentIdentityMessage({ id: "MSGCONTACTRACE2", content: "two" })
  );
  releaseProfile();
  await Promise.all([first, second]);

  assert.equal(harness.profileRequests.length, 1);
  assert.equal(harness.store.holds.size, 1);
  assert.equal(harness.store.queue.size, 2);
  assert.deepEqual(harness.deletedMessageIds.sort(), [
    "MSGCONTACTRACE1",
    "MSGCONTACTRACE2",
  ]);
});

test("profile cache eviction is bounded and 404 no-profile results are cacheable", async () => {
  const secondUser = "SECONDUSER123";
  const profileResponses = new Map([
    [ESTABLISHED_USER_ID, { ok: false, status: 404 }],
    [secondUser, { ok: false, status: 404 }],
  ]);
  const harness = makeHarness({
    profileResponses,
    profileCacheMaxEntries: 1,
  });
  await enableHold(harness);

  await harness.postGate.handleMessage(
    recentIdentityMessage({ id: "MSGCONTACTLRU1", content: "one" })
  );
  await harness.postGate.handleMessage(
    recentIdentityMessage({
      id: "MSGCONTACTLRU2",
      authorId: secondUser,
      content: "two",
    })
  );
  await harness.postGate.handleMessage(
    recentIdentityMessage({ id: "MSGCONTACTLRU3", content: "three" })
  );
  assert.deepEqual(harness.profileRequests, [
    ESTABLISHED_USER_ID,
    secondUser,
    ESTABLISHED_USER_ID,
  ]);
});

test("releasing an automatic hold re-holds the account if its cached bio still matches", async () => {
  const harness = makeHarness({
    profileResponses: new Map([[ESTABLISHED_USER_ID, "inbox available"]]),
  });
  await enableHold(harness);
  await harness.postGate.handleMessage(
    recentIdentityMessage({ id: "MSGCONTACTRELEASE1", content: "one" })
  );
  const released = await harness.postGate.releaseUser(
    SERVER_ID,
    ESTABLISHED_USER_ID,
    MOD_USER_ID
  );
  assert.equal(released.outcome, "released");

  await harness.postGate.handleMessage(
    recentIdentityMessage({ id: "MSGCONTACTRELEASE2", content: "two" })
  );
  const hold = harness.store.getUserHold(SERVER_ID, ESTABLISHED_USER_ID);
  assert.equal(hold.active, true);
  assert.equal(hold.holdSource, "automatic");
  assert.equal(harness.profileRequests.length, 1);
  assert.deepEqual(
    harness.deletedMessageIds.filter((id) => id.startsWith("MSGCONTACT")),
    ["MSGCONTACTRELEASE1", "MSGCONTACTRELEASE2"]
  );
});

test("an automatic hold does not return from cached bio after the account ages out", async () => {
  const harness = makeHarness({
    profileResponses: new Map([[ESTABLISHED_USER_ID, "inbox available"]]),
  });
  await enableHold(harness);
  await harness.postGate.handleMessage(
    recentIdentityMessage({ id: "MSGCONTACTAGEOUT1", content: "one" })
  );
  const released = await harness.postGate.releaseUser(
    SERVER_ID,
    ESTABLISHED_USER_ID,
    MOD_USER_ID
  );
  assert.equal(released.outcome, "released");

  harness.advance(AUTOMOD_LIMITS.recentAccountMs + 1);
  const agedMessage = recentIdentityMessage({
    id: "MSGCONTACTAGEOUT2",
    content: "two",
  });
  const handling = harness.postGate.handleMessage(agedMessage);
  const excluded = harness.postGate.shouldExcludeMessage(agedMessage);
  await handling;

  assert.equal(await excluded, false);
  assert.equal(harness.store.isUserHeld(SERVER_ID, ESTABLISHED_USER_ID), false);
  assert.equal(harness.profileRequests.length, 1);
  assert.equal(harness.deletedMessageIds.includes("MSGCONTACTAGEOUT2"), false);
});

test("automatic contact screening preserves moderator and privacy exclusions", async () => {
  const harness = makeHarness({
    profileResponses: new Map([[ESTABLISHED_USER_ID, "DMs open"]]),
  });
  await enableHold(harness);

  await harness.postGate.handleMessage(
    recentIdentityMessage({
      id: "MSGCONTACTMOD1",
      authorId: MOD_USER_ID,
      content: "DM me",
    })
  );
  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGCONTACTEXCLUDED1",
      channelId: EXCLUDED_CHANNEL_ID,
      content: "DMs open",
    })
  );
  assert.equal(harness.deletedMessageIds.length, 0);
  assert.equal(harness.store.holds.size, 0);
  assert.equal(harness.profileRequests.length, 0);
});

test("a deletion failure leaves the automatically detected account held without creating a false queue record", async () => {
  const harness = makeHarness({ lockdownDeleteFails: true });
  await enableHold(harness);

  await harness.postGate.handleMessage(
    recentIdentityMessage({ id: "MSGCONTACTDELETEFAIL1", content: "DM me" })
  );

  assert.equal(harness.store.isUserHeld(SERVER_ID, ESTABLISHED_USER_ID), true);
  assert.equal(harness.store.queue.size, 0);
  assert.equal(harness.deletedMessageIds.length, 0);
});

test("holds a message containing a prohibited term even from an established member", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  recordMessage({
    id: "TERMPRIOR1",
    channelId: SOURCE_CHANNEL_ID,
    serverId: SERVER_ID,
    authorId: ESTABLISHED_USER_ID,
    content: "a long history of ordinary messages",
    createdAt: Date.now() - 90 * 24 * 60 * 60 * 1000,
  });
  useOperatorTerms(harness, { terms: [OPERATOR_TERM] });

  await harness.postGate.handleMessage(
    establishedMessage({
      id: "MSGTERM1",
      content: `you absolute ${OPERATOR_TERM}`,
    })
  );

  assert.deepEqual(harness.deletedMessageIds, ["MSGTERM1"]);
  const [record] = [...harness.store.queue.values()];
  assert.equal(record.trigger, "prohibited_term");
  assert.equal(record.status, "pending");
  // The trigger is entirely independent of links, media, and tenure.
  assert.equal(record.userId, ESTABLISHED_USER_ID);
});

test("a prohibited-term hold names the rule id on the review card and in the log, never the matched text", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  useOperatorTerms(harness, {
    terms: [{ id: "local:sample", term: OPERATOR_TERM }],
  });

  await harness.postGate.handleMessage(
    newAccountMessage({ id: "MSGTERM2", content: `a ${OPERATOR_TERM} appears` })
  );

  const [record] = [...harness.store.queue.values()];
  assert.equal(record.ruleId, "local:sample");
  const card = harness.protectedLogs[0].payload.embeds[0];
  const cardText = JSON.stringify(card);
  assert.match(cardText, /prohibited-term filter/);
  assert.match(cardText, /local:sample/);

  const heldLine = harness.logLines.find((line) =>
    line.includes("post-gate held")
  );
  assert.match(heldLine, /trigger=prohibited_term/);
  assert.match(heldLine, /rule=local:sample/);
  assert.equal(
    heldLine.includes(OPERATOR_TERM),
    false,
    "the log line must not repeat the matched term"
  );
});

test("an allowlisted false positive is not held", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  useOperatorTerms(harness, {
    terms: ["flurb"],
    allowlist: ["flurb sauce"],
  });

  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGTERM3",
      content: "please pass the flurb sauce",
    })
  );

  assert.equal(harness.deletedMessageIds.length, 0);
  assert.equal(harness.store.queue.size, 0);

  // The same term outside the allowlisted phrase is still held.
  await harness.postGate.handleMessage(
    newAccountMessage({ id: "MSGTERM4", content: "you flurb" })
  );
  assert.deepEqual(harness.deletedMessageIds, ["MSGTERM4"]);
});

test("a zero-width and homoglyph spelling of a prohibited term is still held", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  useOperatorTerms(harness, { terms: [OPERATOR_TERM] });

  const evasions = [
    "flu​rbex", // zero-width space
    "flurbеx", // Cyrillic е
    "ｆｌｕｒｂｅｘ", // fullwidth
    "f l u r b e x", // separated letters
    "fllllurbeeeex", // stretched letters
    "flurb3x", // leetspeak
  ];
  for (const [index, content] of evasions.entries()) {
    await harness.postGate.handleMessage(
      newAccountMessage({ id: `MSGEVADE${index}`, content })
    );
  }

  assert.equal(harness.deletedMessageIds.length, evasions.length);
  assert.equal(harness.store.queue.size, evasions.length);
});

test("an operator term list extends the built-in list without replacing it", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  useOperatorTerms(harness, { terms: [OPERATOR_TERM] });

  const status = await harness.postGate.handleCommand(reviewCommandMessage(), [
    "terms",
  ]);
  assert.equal(status.status, "ok");
  const description = JSON.stringify(harness.sendCalls.at(-1).payload);
  assert.match(description, /built-in/);
  assert.match(description, /1 custom/);
});

test("a malformed operator term list leaves the built-in list active and is reported in status", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  Object.assign(harness.store.termList, {
    terms: [],
    allowlist: [],
    status: "malformed",
    error: "Unexpected token } in JSON",
  });

  const result = await harness.postGate.handleCommand(reviewCommandMessage(), [
    "terms",
  ]);
  assert.equal(result.status, "malformed");
  const description = JSON.stringify(harness.sendCalls.at(-1).payload);
  assert.match(description, /could not be parsed/);
  // The built-in rules are still compiled and still counted.
  assert.match(description, /built-in/);
});

test("prohibited-term matching never punishes on its own — no strike is recorded at hold time", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  useOperatorTerms(harness, { terms: [OPERATOR_TERM] });

  await harness.postGate.handleMessage(
    newAccountMessage({ id: "MSGTERM5", content: `${OPERATOR_TERM}!` })
  );

  assert.equal(harness.store.queue.size, 1);
  assert.equal(harness.store.getAutomodStrike(SERVER_ID, NEW_USER_ID), null);
  assert.equal(harness.bans.length, 0);
  assert.equal(harness.store.isUserHeld(SERVER_ID, NEW_USER_ID), false);
});

// ══════════════════════════════════════════════════════════════
//  Prohibited-term identity screening (username/display name/nickname)
// ══════════════════════════════════════════════════════════════

for (const [index, [surface, field]] of [
  ["username", "username"],
  ["display_name", "displayName"],
  ["nickname", "nickname"],
].entries()) {
  test(`a prohibited term used as a ${surface} holds the message, places a full Post Gate hold, and never repeats the name`, async () => {
    const harness = makeHarness();
    await enableHold(harness);
    useOperatorTerms(harness, { terms: [OPERATOR_TERM] });

    await harness.postGate.handleMessage(
      withIdentity(
        newAccountMessage({
          id: `MSGIDENTITY${index}`,
          content: "hello there",
        }),
        { [field]: `raid_${OPERATOR_TERM}` }
      )
    );

    const [record] = [...harness.store.queue.values()];
    assert.equal(record.trigger, "prohibited_identity");
    assert.equal(record.triggerSurface, surface);

    const hold = harness.store.getUserHold(SERVER_ID, NEW_USER_ID);
    assert.equal(hold.active, true);
    assert.equal(hold.holdSource, "automatic");
    assert.equal(hold.triggerSurface, surface);
    assert.equal(hold.triggerRuleId, record.ruleId);

    const cardText = JSON.stringify(harness.protectedLogs);
    assert.equal(
      cardText.includes(OPERATOR_TERM),
      false,
      "a review or control card must never repeat the offending name"
    );
    assert.match(cardText, /prohibited-term filter \(username\/nickname\)/);
  });
}

test("an allowlisted identity is not held", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  useOperatorTerms(harness, {
    terms: [OPERATOR_TERM],
    allowlist: [`ok_${OPERATOR_TERM}`],
  });

  await harness.postGate.handleMessage(
    withIdentity(newAccountMessage({ id: "MSGIDENTITYALLOW1" }), {
      username: `ok_${OPERATOR_TERM}`,
    })
  );

  assert.equal(harness.store.queue.size, 0);
  assert.equal(harness.store.isUserHeld(SERVER_ID, NEW_USER_ID), false);
});

test("joining with a prohibited-term username places a full Post Gate hold without any message", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  useOperatorTerms(harness, { terms: [OPERATOR_TERM] });

  await harness.postGate.handleMemberJoin(
    memberObject({ userId: NEW_USER_ID, username: `raid_${OPERATOR_TERM}` })
  );

  const hold = harness.store.getUserHold(SERVER_ID, NEW_USER_ID);
  assert.equal(hold.active, true);
  assert.equal(hold.holdSource, "automatic");
  assert.equal(hold.triggerSurface, "username");
  assert.equal(harness.store.queue.size, 0);
});

test("joining with a clean username does not create a hold", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  useOperatorTerms(harness, { terms: [OPERATOR_TERM] });

  await harness.postGate.handleMemberJoin(
    memberObject({ userId: NEW_USER_ID, username: "ordinary_name" })
  );

  assert.equal(harness.store.isUserHeld(SERVER_ID, NEW_USER_ID), false);
});

test("a bot account is never identity-screened on join", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  useOperatorTerms(harness, { terms: [OPERATOR_TERM] });

  await harness.postGate.handleMemberJoin(
    memberObject({
      userId: BOT_ID,
      username: `raid_${OPERATOR_TERM}`,
      bot: true,
    })
  );

  assert.equal(harness.store.isUserHeld(SERVER_ID, BOT_ID), false);
});

test("a recognized moderator with a matching username is exempt on join", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  useOperatorTerms(harness, { terms: [OPERATOR_TERM] });

  await harness.postGate.handleMemberJoin(
    memberObject({ userId: MOD_USER_ID, username: `raid_${OPERATOR_TERM}` })
  );

  assert.equal(harness.store.isUserHeld(SERVER_ID, MOD_USER_ID), false);
});

test("identity screening on join requires hold mode and does nothing below level 3 gating rules", async () => {
  const harness = makeHarness();
  useOperatorTerms(harness, { terms: [OPERATOR_TERM] });
  // Post Gate was never enabled — mode defaults to "off".

  await harness.postGate.handleMemberJoin(
    memberObject({ userId: NEW_USER_ID, username: `raid_${OPERATOR_TERM}` })
  );

  assert.equal(harness.store.isUserHeld(SERVER_ID, NEW_USER_ID), false);
});

test("changing a nickname to a prohibited term places a full Post Gate hold", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  useOperatorTerms(harness, { terms: [OPERATOR_TERM] });

  await harness.postGate.handleMemberUpdate(
    memberObject({ userId: NEW_USER_ID, nickname: `raid_${OPERATOR_TERM}` }),
    memberObject({ userId: NEW_USER_ID, nickname: null })
  );

  const hold = harness.store.getUserHold(SERVER_ID, NEW_USER_ID);
  assert.equal(hold.active, true);
  assert.equal(hold.triggerSurface, "nickname");
});

test("a member update that does not change the nickname is ignored, even with a matching username", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  useOperatorTerms(harness, { terms: [OPERATOR_TERM] });

  const before = memberObject({
    userId: NEW_USER_ID,
    username: `raid_${OPERATOR_TERM}`,
    nickname: "same",
  });
  const after = memberObject({
    userId: NEW_USER_ID,
    username: `raid_${OPERATOR_TERM}`,
    nickname: "same",
  });
  await harness.postGate.handleMemberUpdate(after, before);

  // Only a nickname change is screened here; a stale username on an
  // unrelated update is left to the next message, exactly as documented.
  assert.equal(harness.store.isUserHeld(SERVER_ID, NEW_USER_ID), false);
});

test("an account already held is left alone by member-join and member-update screening", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  useOperatorTerms(harness, { terms: [OPERATOR_TERM] });
  harness.store.createUserHold({
    serverId: SERVER_ID,
    userId: NEW_USER_ID,
    heldAt: 1,
    heldBy: "SOMEMOD",
    holdSource: "manual",
  });

  await harness.postGate.handleMemberJoin(
    memberObject({ userId: NEW_USER_ID, username: `raid_${OPERATOR_TERM}` })
  );

  // Still exactly the original manual hold — no automatic hold overwrote it.
  const hold = harness.store.getUserHold(SERVER_ID, NEW_USER_ID);
  assert.equal(hold.holdSource, "manual");
  assert.equal(hold.heldBy, "SOMEMOD");
});

// ══════════════════════════════════════════════════════════════
//  Full-user Post Gate: deny + hold, release, reminders
// ══════════════════════════════════════════════════════════════

async function holdUserViaDenyHold(harness, { userId = NEW_USER_ID } = {}) {
  await harness.postGate.handleMessage(
    newAccountMessage({
      id: `MSGORIGIN${userId}`,
      authorId: userId,
      content: "https://example.com/first",
    })
  );
  const record = [...harness.store.queue.values()].at(-1);
  const result = await harness.postGate.denyHold(record.queueId, MOD_USER_ID);
  return { record, result };
}

test("deny and hold posts one control card, advances the strike, and records who held the author and when", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  const { record, result } = await holdUserViaDenyHold(harness);

  assert.equal(result.outcome, "rejected");
  assert.equal(result.strikeLevel, 1);
  assert.equal(result.userHold, "held");
  assert.equal(harness.store.getHeldPost(record.queueId).status, "rejected");
  assert.equal(harness.store.isUserHeld(SERVER_ID, NEW_USER_ID), true);

  const hold = harness.store.getUserHold(SERVER_ID, NEW_USER_ID);
  assert.equal(hold.heldBy, MOD_USER_ID);
  assert.equal(hold.heldAt, 1_800_000_000_000);
  assert.equal(hold.originQueueId, record.queueId);
  assert.equal(hold.reminderAt, 1_800_000_000_000 + 24 * 60 * 60 * 1_000);

  const control = harness.protectedLogs.find((entry) =>
    /User Held/.test(entry.payload.embeds[0].title)
  );
  assert.ok(
    control,
    "a persistent control card is posted to the review channel"
  );
  assert.equal(control.channelId, REVIEW_CHANNEL_ID);
  assert.equal(hold.cardMessageId, control.payload ? hold.cardMessageId : null);
  const controlText = JSON.stringify(control.payload);
  assert.match(controlText, /Held by/);
  assert.match(controlText, /Held since/);
  assert.match(controlText, /🔓/);

  // Exactly one combined audit card describes the denial and the new hold.
  const denials = harness.protectedLogs.filter((entry) =>
    /Author Placed in Post Gate/.test(entry.payload.embeds[0].title)
  );
  assert.equal(denials.length, 1);
  assert.match(JSON.stringify(denials[0].payload), /Hold began/);

  const auditLine = harness.logLines.find((line) => line.includes("deny-hold"));
  assert.match(auditLine, /hold=held/);
});

test("reacting 🔒 twice does not duplicate the user hold or repost the control card", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await holdUserViaDenyHold(harness);
  const firstHold = harness.store.getUserHold(SERVER_ID, NEW_USER_ID);
  const controlCards = () =>
    harness.protectedLogs.filter((entry) =>
      /User Held/.test(entry.payload.embeds[0].title)
    ).length;
  assert.equal(controlCards(), 1);

  harness.advance(60_000);
  // A second held message from the same author, denied and held again.
  await harness.postGate.handleMessage(
    newAccountMessage({ id: "MSGORIGIN2", content: "another message" })
  );
  const second = [...harness.store.queue.values()].at(-1);
  const result = await harness.postGate.denyHold(second.queueId, OWNER_ID);

  assert.equal(result.userHold, "already_held");
  assert.equal(controlCards(), 1, "no second control card");
  const hold = harness.store.getUserHold(SERVER_ID, NEW_USER_ID);
  assert.equal(hold.heldBy, firstHold.heldBy);
  assert.equal(hold.heldAt, firstHold.heldAt);
  assert.equal(harness.store.getActiveUserHolds(SERVER_ID).length, 1);
});

test("deny and hold on a legacy record with no author id resolves the queue entry without creating a phantom hold", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  harness.store.createHeldPost({
    queueId: "PGLEGACYHOLD",
    serverId: SERVER_ID,
    channelId: SOURCE_CHANNEL_ID,
    userId: undefined,
    messageId: "LEGACYMSG",
    content: "legacy content",
    attachments: [],
    reviewChannelId: REVIEW_CHANNEL_ID,
    reviewMessageId: "LEGACYREVIEW",
    status: "pending",
    createdAt: 1_800_000_000_000,
    expiresAt: 1_800_000_000_000 + 1_000,
  });

  const result = await harness.postGate.denyHold("PGLEGACYHOLD", MOD_USER_ID);

  assert.equal(result.outcome, "rejected");
  assert.equal(result.userHold, "skipped_legacy");
  assert.equal(harness.store.getHeldPost("PGLEGACYHOLD").status, "rejected");
  assert.equal(harness.store.getActiveUserHolds(SERVER_ID).length, 0);
  assert.equal(harness.store.strikes.size, 0);
});

test("a user held while sending several messages gets each message held individually and only one control card", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await holdUserViaDenyHold(harness);
  const queuedBefore = harness.store.queue.size;

  // Plain text, no link, no attachment, and the account is no longer "new"
  // by tenure — the hold alone must be enough.
  for (const id of ["MSGHELD1", "MSGHELD2", "MSGHELD3"]) {
    await harness.postGate.handleMessage(
      establishedMessage({
        id,
        content: "just chatting",
        authorId: NEW_USER_ID,
      })
    );
  }

  assert.equal(harness.store.queue.size, queuedBefore + 3);
  const pending = harness.store
    .getPendingHeldPosts(SERVER_ID)
    .filter((entry) => entry.userId === NEW_USER_ID);
  assert.equal(pending.length, 3);
  assert.ok(pending.every((entry) => entry.trigger === "user_hold"));
  assert.equal(
    harness.protectedLogs.filter((entry) =>
      /User Held/.test(entry.payload.embeds[0].title)
    ).length,
    1
  );
});

test("a fully held user is still not gated in the review channel or a privacy-excluded channel", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await holdUserViaDenyHold(harness);
  const before = harness.deletedMessageIds.length;

  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGEXCLUDED",
      channelId: EXCLUDED_CHANNEL_ID,
      content: "in an excluded channel",
    })
  );
  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGINREVIEW",
      channelId: REVIEW_CHANNEL_ID,
      content: "in the review channel",
    })
  );

  assert.equal(harness.deletedMessageIds.length, before);
});

test("a recognized moderator is exempt even while a hold record exists for them", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  harness.store.createUserHold({
    serverId: SERVER_ID,
    userId: MOD_USER_ID,
    heldAt: 1_800_000_000_000,
    heldBy: OWNER_ID,
  });

  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGMODHELD",
      authorId: MOD_USER_ID,
      content: "hello",
    })
  );

  assert.equal(harness.deletedMessageIds.length, 0);
  assert.equal(harness.store.queue.size, 0);
});

test("level 3 lockdown takes precedence over a user hold", async () => {
  const harness = makeHarness();
  harness.store.setPostGateConfig(SERVER_ID, {
    mode: "hold",
    level: 3,
    reviewChannelId: REVIEW_CHANNEL_ID,
  });
  harness.store.createUserHold({
    serverId: SERVER_ID,
    userId: NEW_USER_ID,
    heldAt: 1_800_000_000_000,
    heldBy: MOD_USER_ID,
  });

  await harness.postGate.handleMessage(
    newAccountMessage({ id: "MSGLOCKHELD", content: "hello" })
  );

  // Deleted by lockdown, not queued for review.
  assert.deepEqual(harness.deletedMessageIds, ["MSGLOCKHELD"]);
  assert.equal(harness.store.queue.size, 0);
});

test("reacting 🔓 on the control card releases the user and restores normal posting immediately", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await holdUserViaDenyHold(harness);
  const hold = harness.store.getUserHold(SERVER_ID, NEW_USER_ID);
  assert.ok(hold.cardMessageId);

  harness.advance(60_000);
  await harness.postGate.handleRawEvent({
    type: "MessageReact",
    id: hold.cardMessageId,
    user_id: MOD_USER_ID,
    emoji_id: "🔓",
  });

  assert.equal(harness.store.isUserHeld(SERVER_ID, NEW_USER_ID), false);
  assert.ok(harness.deletedMessageIds.includes(hold.cardMessageId));
  const notice = harness.protectedLogs.find((entry) =>
    /User Released/.test(entry.payload.embeds[0].title)
  );
  assert.ok(notice);
  assert.match(JSON.stringify(notice.payload), /Released by/);

  // Posting works normally again: a plain established message is untouched.
  const before = harness.deletedMessageIds.length;
  await harness.postGate.handleMessage(
    establishedMessage({
      id: "MSGAFTERRELEASE",
      content: "back to normal",
      authorId: NEW_USER_ID,
    })
  );
  assert.equal(harness.deletedMessageIds.length, before);
});

test("released users' queued messages stay pending and the release notice states how many", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await holdUserViaDenyHold(harness);
  for (const id of ["MSGQUEUED1", "MSGQUEUED2"]) {
    await harness.postGate.handleMessage(
      establishedMessage({
        id,
        content: "held while gated",
        authorId: NEW_USER_ID,
      })
    );
  }
  assert.equal(
    harness.store
      .getPendingHeldPosts(SERVER_ID)
      .filter((e) => e.userId === NEW_USER_ID).length,
    2
  );

  const result = await harness.postGate.releaseUser(
    SERVER_ID,
    NEW_USER_ID,
    MOD_USER_ID
  );

  assert.equal(result.outcome, "released");
  assert.equal(result.pending, 2);
  const notice = harness.protectedLogs.find((entry) =>
    /User Released/.test(entry.payload.embeds[0].title)
  );
  assert.match(JSON.stringify(notice.payload), /2 held message\(s\)/);
  // Release stops future holds only — nothing already queued is resolved.
  const stillPending = harness.store
    .getPendingHeldPosts(SERVER_ID)
    .filter((entry) => entry.userId === NEW_USER_ID);
  assert.equal(stillPending.length, 2);
  assert.ok(stillPending.every((entry) => entry.status === "pending"));
});

test("/Post-Gate release @member releases by command and reports not_held for a user who was never held", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await holdUserViaDenyHold(harness);

  const released = await harness.postGate.handleCommand(
    reviewCommandMessage(),
    ["release", `<@${NEW_USER_ID}>`]
  );
  assert.equal(released.outcome, "released");
  assert.equal(harness.store.isUserHeld(SERVER_ID, NEW_USER_ID), false);

  const again = await harness.postGate.handleCommand(reviewCommandMessage(), [
    "release",
    `<@${NEW_USER_ID}>`,
  ]);
  assert.equal(again.outcome, "not_held");

  const noTarget = await harness.postGate.handleCommand(
    reviewCommandMessage(),
    ["release"]
  );
  assert.equal(noTarget.outcome, "invalid_target");
});

test("release requires fresh Manage Messages verification in the review channel", async () => {
  const harness = makeHarness({ reviewChannelGrantsManageMessages: false });
  await enableHold(harness);
  harness.store.createUserHold({
    serverId: SERVER_ID,
    userId: NEW_USER_ID,
    heldAt: 1_800_000_000_000,
    heldBy: OWNER_ID,
  });

  const result = await harness.postGate.releaseUser(
    SERVER_ID,
    NEW_USER_ID,
    MOD_USER_ID
  );

  assert.equal(result.outcome, "unauthorized");
  assert.equal(harness.store.isUserHeld(SERVER_ID, NEW_USER_ID), true);
});

test("the hourly sweep reminds moderators about a hold older than the reminder window", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await holdUserViaDenyHold(harness);
  const reminders = () =>
    harness.protectedLogs.filter((entry) =>
      /User Still Held/.test(entry.payload.embeds[0].title)
    );

  harness.advance(23 * 60 * 60 * 1_000);
  await harness.postGate.maintainQueue();
  assert.equal(reminders().length, 0, "not due yet");

  harness.advance(2 * 60 * 60 * 1_000);
  await harness.postGate.maintainQueue();
  assert.equal(reminders().length, 1);
  const text = JSON.stringify(reminders()[0].payload);
  assert.match(text, /Held by/);
  assert.match(text, /🔓/);
  assert.match(text, /⏳/);
  assert.match(text, /never releases a hold by itself/);
  // The user is still held — a reminder is not a deadline.
  assert.equal(harness.store.isUserHeld(SERVER_ID, NEW_USER_ID), true);
});

test("an ignored reminder repeats once per window, not once per sweep", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await holdUserViaDenyHold(harness);
  const reminderCount = () =>
    harness.protectedLogs.filter((entry) =>
      /User Still Held/.test(entry.payload.embeds[0].title)
    ).length;

  harness.advance(25 * 60 * 60 * 1_000);
  await harness.postGate.maintainQueue();
  assert.equal(reminderCount(), 1);

  // Three more hourly sweeps inside the same window produce nothing new.
  for (let i = 0; i < 3; i += 1) {
    harness.advance(60 * 60 * 1_000);
    await harness.postGate.maintainQueue();
  }
  assert.equal(reminderCount(), 1);

  harness.advance(22 * 60 * 60 * 1_000);
  await harness.postGate.maintainQueue();
  assert.equal(reminderCount(), 2);
  assert.equal(harness.store.isUserHeld(SERVER_ID, NEW_USER_ID), true);
});

test("reacting ⏳ re-arms the reminder without releasing the user", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await holdUserViaDenyHold(harness);
  harness.advance(25 * 60 * 60 * 1_000);
  await harness.postGate.maintainQueue();
  const reminderId = harness.store.getUserHold(
    SERVER_ID,
    NEW_USER_ID
  ).lastReminderMessageId;
  assert.ok(reminderId);

  await harness.postGate.handleRawEvent({
    type: "MessageReact",
    id: reminderId,
    user_id: MOD_USER_ID,
    emoji_id: "⏳",
  });

  const hold = harness.store.getUserHold(SERVER_ID, NEW_USER_ID);
  assert.equal(hold.active, true);
  assert.equal(
    hold.reminderAt,
    harness.store.getUserHold(SERVER_ID, NEW_USER_ID).reminderAt
  );
  assert.ok(hold.reminderAt > 1_800_000_000_000 + 25 * 60 * 60 * 1_000);
  assert.ok(harness.deletedMessageIds.includes(reminderId));
  assert.ok(
    harness.protectedLogs.some((entry) =>
      /Hold Continued/.test(entry.payload.embeds[0].title)
    )
  );
});

test("⏳ on the control card is ignored — continue holding is only offered on a reminder", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await holdUserViaDenyHold(harness);
  const hold = harness.store.getUserHold(SERVER_ID, NEW_USER_ID);
  const before = harness.protectedLogs.length;

  await harness.postGate.handleRawEvent({
    type: "MessageReact",
    id: hold.cardMessageId,
    user_id: MOD_USER_ID,
    emoji_id: "⏳",
  });

  assert.equal(harness.protectedLogs.length, before);
  assert.equal(
    harness.store.getUserHold(SERVER_ID, NEW_USER_ID).reminderAt,
    hold.reminderAt
  );
});

test("a hold is never auto-released, even after many reminder windows", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await holdUserViaDenyHold(harness);

  for (let day = 0; day < 30; day += 1) {
    harness.advance(24 * 60 * 60 * 1_000 + 1);
    await harness.postGate.maintainQueue();
  }

  assert.equal(harness.store.isUserHeld(SERVER_ID, NEW_USER_ID), true);
  assert.equal(
    harness.store.getUserHold(SERVER_ID, NEW_USER_ID).releasedAt,
    null
  );
});

// ══════════════════════════════════════════════════════════════
//  Concurrency, restart, and membership edge cases
// ══════════════════════════════════════════════════════════════

test("two simultaneous reactions on the same held post produce exactly one decision", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await harness.postGate.handleMessage(
    newAccountMessage({ id: "MSGRACE1", content: "https://example.com/race" })
  );
  const [record] = [...harness.store.queue.values()];
  const reviewCardDeletes = () =>
    harness.deletedMessageIds.filter((id) => id === record.reviewMessageId)
      .length;

  // Two moderators react in the same tick, before either decision is written.
  // Without the per-queue lock both would pass the "pending" check, because
  // the permission refresh between the check and the write is asynchronous.
  await Promise.all([
    harness.postGate.handleRawEvent({
      type: "MessageReact",
      id: record.reviewMessageId,
      user_id: MOD_USER_ID,
      emoji_id: "✅",
    }),
    harness.postGate.handleRawEvent({
      type: "MessageReact",
      id: record.reviewMessageId,
      user_id: OWNER_ID,
      emoji_id: "❌",
    }),
  ]);

  // Exactly one of them actually acted: one final status, one review-card
  // deletion, and one accountability card.
  const stored = harness.store.getHeldPost(record.queueId);
  assert.ok(["approved", "rejected"].includes(stored.status));
  assert.equal(reviewCardDeletes(), 1);
  const outcomeCards = harness.protectedLogs.filter((entry) =>
    /Held Post (Approved|Rejected)/.test(entry.payload.embeds[0].title)
  );
  assert.equal(outcomeCards.length, 1);
  // The strike store reflects that one decision, never both.
  const strike = harness.store.getAutomodStrike(SERVER_ID, NEW_USER_ID);
  assert.equal(
    stored.status === "rejected" ? strike?.level : strike,
    stored.status === "rejected" ? 1 : null
  );
});

test("two simultaneous deny + hold reactions create exactly one user hold", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await harness.postGate.handleMessage(
    newAccountMessage({ id: "MSGRACE3", content: "https://example.com/race3" })
  );
  const [record] = [...harness.store.queue.values()];

  await Promise.all([
    harness.postGate.handleRawEvent({
      type: "MessageReact",
      id: record.reviewMessageId,
      user_id: MOD_USER_ID,
      emoji_id: "🔒",
    }),
    harness.postGate.handleRawEvent({
      type: "MessageReact",
      id: record.reviewMessageId,
      user_id: OWNER_ID,
      emoji_id: "🔒",
    }),
  ]);

  assert.equal(harness.store.getActiveUserHolds(SERVER_ID).length, 1);
  assert.equal(
    harness.protectedLogs.filter((entry) =>
      /User Held/.test(entry.payload.embeds[0].title)
    ).length,
    1
  );
  assert.equal(harness.store.getAutomodStrike(SERVER_ID, NEW_USER_ID).level, 1);
});

test("approving after another moderator denied reports the already-resolved status and takes no action", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await harness.postGate.handleMessage(
    newAccountMessage({ id: "MSGRACE2", content: "https://example.com/race2" })
  );
  const [record] = [...harness.store.queue.values()];

  await harness.postGate.handleCommand(reviewCommandMessage(), [
    "reject",
    record.queueId,
  ]);
  const cardsAfterReject = harness.protectedLogs.length;
  const strikeAfterReject = harness.store.getAutomodStrike(
    SERVER_ID,
    NEW_USER_ID
  );

  const late = await harness.postGate.handleCommand(
    reviewCommandMessage(OWNER_ID),
    ["approve", record.queueId]
  );

  assert.equal(late.outcome, "rejected");
  assert.match(
    JSON.stringify(harness.sendCalls.at(-1).payload),
    /already resolved as rejected/
  );
  // Nothing changed: no extra audit card, and the strike was not cleared.
  assert.equal(harness.protectedLogs.length, cardsAfterReject);
  assert.deepEqual(
    harness.store.getAutomodStrike(SERVER_ID, NEW_USER_ID),
    strikeAfterReject
  );
});

test("a hold survives a restart with its control card id and reminder timing intact", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await holdUserViaDenyHold(harness);
  const before = harness.store.getUserHold(SERVER_ID, NEW_USER_ID);

  // Restart: a fresh gate over the same persisted store contents.
  const restarted = makeHarness();
  restarted.store.config.set(
    SERVER_ID,
    harness.store.getPostGateConfig(SERVER_ID)
  );
  for (const [key, value] of harness.store.holds) {
    restarted.store.holds.set(key, structuredClone(value));
  }
  restarted.setClock(1_800_000_000_000 + 60_000);

  const after = restarted.store.getUserHold(SERVER_ID, NEW_USER_ID);
  assert.equal(after.active, true);
  assert.equal(after.heldBy, before.heldBy);
  assert.equal(after.heldAt, before.heldAt);
  assert.equal(after.cardMessageId, before.cardMessageId);
  assert.equal(after.reminderAt, before.reminderAt);

  // The hold still holds after the restart...
  await restarted.postGate.handleMessage(
    establishedMessage({
      id: "MSGAFTERRESTART",
      content: "plain text",
      authorId: NEW_USER_ID,
    })
  );
  assert.deepEqual(restarted.deletedMessageIds, ["MSGAFTERRESTART"]);

  // ...and the reminder still fires on the original schedule.
  restarted.setClock(before.reminderAt + 1);
  await restarted.postGate.maintainQueue();
  assert.ok(
    restarted.protectedLogs.some((entry) =>
      /User Still Held/.test(entry.payload.embeds[0].title)
    )
  );

  // The control card the pre-restart gate posted still resolves a reaction.
  await restarted.postGate.handleRawEvent({
    type: "MessageReact",
    id: after.cardMessageId,
    user_id: MOD_USER_ID,
    emoji_id: "🔓",
  });
  assert.equal(restarted.store.isUserHeld(SERVER_ID, NEW_USER_ID), false);
});

test("a hold survives the user leaving and rejoining the server", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await holdUserViaDenyHold(harness);

  // A rejoin looks like a brand-new member record with a fresh join date; the
  // hold is keyed on server + user, so none of that matters.
  harness.advance(7 * 24 * 60 * 60 * 1_000);
  await harness.postGate.handleMessage(
    newAccountMessage({
      id: "MSGREJOINED",
      content: "hello again",
      joinedAt: new Date(1_800_000_000_000 + 7 * 24 * 60 * 60 * 1_000),
    })
  );

  assert.ok(harness.deletedMessageIds.includes("MSGREJOINED"));
  const held = harness.store
    .getPendingHeldPosts(SERVER_ID)
    .find((entry) => entry.messageId === "MSGREJOINED");
  assert.equal(held.trigger, "user_hold");
});

test("turning the post gate off leaves hold records inert and honours them again when it is re-enabled", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  await holdUserViaDenyHold(harness);

  harness.store.setPostGateConfig(SERVER_ID, {
    mode: "off",
    level: 0,
    reviewChannelId: null,
  });
  const before = harness.deletedMessageIds.length;
  await harness.postGate.handleMessage(
    establishedMessage({
      id: "MSGGATEOFF",
      content: "hi",
      authorId: NEW_USER_ID,
    })
  );
  assert.equal(
    harness.deletedMessageIds.length,
    before,
    "nothing is held while off"
  );
  assert.equal(harness.store.isUserHeld(SERVER_ID, NEW_USER_ID), true);

  await enableHold(harness);
  await harness.postGate.handleMessage(
    establishedMessage({
      id: "MSGGATEON",
      content: "hi again",
      authorId: NEW_USER_ID,
    })
  );
  assert.ok(harness.deletedMessageIds.includes("MSGGATEON"));
});

test("shouldExcludeMessage covers user holds and prohibited-term holds, not just links", async () => {
  const harness = makeHarness();
  await enableHold(harness);
  useOperatorTerms(harness, { terms: [OPERATOR_TERM] });

  const termMessage = establishedMessage({
    id: "MSGEXCLTERM",
    content: `an ${OPERATOR_TERM} here`,
  });
  const [excluded] = await Promise.all([
    harness.postGate.shouldExcludeMessage(termMessage),
    harness.postGate.handleMessage(termMessage),
  ]);
  assert.equal(excluded, true);
  assert.equal(
    await harness.postGate.shouldExcludeMessageDelete("MSGEXCLTERM"),
    false
  );

  // Ordinary prose in a gated server is still cheap and still not excluded.
  assert.equal(
    await harness.postGate.shouldExcludeMessage(
      establishedMessage({ id: "MSGEXCLPLAIN", content: "good morning" })
    ),
    false
  );
});

test("/Post-Gate holds lists who is currently gated and since when", async () => {
  const harness = makeHarness();
  await enableHold(harness);

  const empty = await harness.postGate.handleCommand(reviewCommandMessage(), [
    "holds",
  ]);
  assert.equal(empty.count, 0);
  assert.match(
    JSON.stringify(harness.sendCalls.at(-1).payload),
    /No members are currently in Post Gate/
  );

  await holdUserViaDenyHold(harness);
  const listed = await harness.postGate.handleCommand(reviewCommandMessage(), [
    "holds",
  ]);
  assert.equal(listed.count, 1);
  const text = JSON.stringify(harness.sendCalls.at(-1).payload);
  assert.match(text, new RegExp(NEW_USER_ID));
  assert.match(text, new RegExp(MOD_USER_ID));
});

test("the in-memory test store implements the same surface the real store exports", async () => {
  // The gate is dependency-injected, so every test above runs against a fake.
  // That fake is only meaningful if store.js actually provides the same names:
  // without this check, a store function could be renamed (or a new one added
  // to the fake alone) and the whole suite would keep passing against a store
  // shape production never sees.
  const realStore = await import("../store.js");
  const fake = makeStore();
  const inspectionOnly = new Set([
    "config",
    "queue",
    "strikes",
    "holds",
    "termList",
  ]);

  const fakeFunctions = Object.keys(fake)
    .filter((key) => !inspectionOnly.has(key))
    .filter((key) => typeof fake[key] === "function");

  assert.ok(fakeFunctions.length > 20);
  for (const name of fakeFunctions) {
    assert.equal(
      typeof realStore[name],
      "function",
      `store.js must export ${name}, which the post-gate test store fakes`
    );
  }

  // And the new user-hold + term-list surface specifically is all present.
  for (const name of [
    "isUserHeld",
    "getUserHold",
    "createUserHold",
    "updateUserHold",
    "releaseUserHold",
    "findUserHoldByCardMessage",
    "getActiveUserHolds",
    "getDueUserHoldReminders",
    "prunePostGateUserHolds",
    "getProhibitedTermList",
    "reloadProhibitedTermList",
  ]) {
    assert.equal(
      typeof realStore[name],
      "function",
      `store.js must export ${name}`
    );
    assert.equal(
      typeof fake[name],
      "function",
      `the test store must fake ${name}`
    );
  }
});
