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
  };
}

function makeHarness({ clock = 1_800_000_000_000 } = {}) {
  let current = clock;
  const store = makeStore();
  const responses = [];
  const protectedLogs = [];
  const dmPayloads = [];
  const sendCalls = [];
  const reactionPuts = [];
  const deletedMessageIds = [];
  const removedEvidencePaths = [];

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
      deletedMessageIds.push(path.split("/").pop());
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
    store,
    now: () => current,
    codeFactory: () => "123456",
    queueIdFactory: () => `PGQUEUE${++nextId}`,
    requestIdFactory: () => `PGREQ${++nextId}`,
    removeEvidence: (path) => {
      removedEvidencePaths.push(path);
      return true;
    },
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

test("approving a held post reposts it and clears the queue entry", async () => {
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
  // One send reposts the held content to its original channel; the other
  // is the "✅ Post Approved" status reply to the reviewing moderator.
  assert.equal(harness.sendCalls.length, 2);
  const repost = harness.sendCalls.find(
    (call) => call.channelId === SOURCE_CHANNEL_ID
  );
  assert.ok(repost);
  assert.match(repost.payload.content, /neat site/);
  assert.equal(harness.store.getHeldPost(record.queueId).status, "approved");
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
