import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOYOFETCH_DATA_DIR = mkdtempSync(
  join(tmpdir(), "hoyofetch-channel-exclusion-")
);

const { EXCLUSION_CHALLENGE_TTL_MS, createChannelExclusion } =
  await import("../channel-exclusion.js");

const SERVER_ID = "01AAAAAAAAAAAAAAAAAAAAAAAA";
const SOURCE_ID = "01BBBBBBBBBBBBBBBBBBBBBBBB";
const TARGET_ID = "01CCCCCCCCCCCCCCCCCCCCCCCC";
const AUDIT_ID = "01DDDDDDDDDDDDDDDDDDDDDDDD";
const DM_ID = "01EEEEEEEEEEEEEEEEEEEEEEEE";
const OWNER_ID = "01FFFFFFFFFFFFFFFFFFFFFFFF";
const MOD_ID = "01GGGGGGGGGGGGGGGGGGGGGGGG";
const OTHER_ID = "01HHHHHHHHHHHHHHHHHHHHHHHH";

function makeStore() {
  const exclusions = new Map();
  return {
    exclusions,
    getAuditLogChannel: () => AUDIT_ID,
    isChannelExcluded: (channelId) => exclusions.has(channelId),
    getExcludedChannels: (serverId) =>
      [...exclusions.values()]
        .filter((record) => record.serverId === serverId)
        .map((record) => structuredClone(record)),
    getAllChannelExclusions: () =>
      [...exclusions.values()].map((record) => structuredClone(record)),
    addChannelExclusion(record) {
      exclusions.set(record.channelId, structuredClone(record));
      return structuredClone(record);
    },
    removeChannelExclusion(channelId) {
      const record = exclusions.get(channelId) ?? null;
      exclusions.delete(channelId);
      return record;
    },
  };
}

function makeHarness({ dmFails = false, clock = 1_800_000_000_000 } = {}) {
  let current = clock;
  const store = makeStore();
  const responses = [];
  const protectedLogs = [];
  const dmPayloads = [];
  const purgedChannels = [];
  const channels = new Map([
    [
      SOURCE_ID,
      { id: SOURCE_ID, serverId: SERVER_ID, type: "TextChannel", name: "ops" },
    ],
    [
      TARGET_ID,
      {
        id: TARGET_ID,
        serverId: SERVER_ID,
        type: "TextChannel",
        name: "private",
      },
    ],
    [
      AUDIT_ID,
      {
        id: AUDIT_ID,
        serverId: SERVER_ID,
        type: "TextChannel",
        name: "audit",
      },
    ],
  ]);
  const client = {
    user: { id: "01IIIIIIIIIIIIIIIIIIIIIIII" },
    channels,
    users: new Map([
      [OWNER_ID, { username: "owner" }],
      [MOD_ID, { username: "moderator" }],
    ]),
    servers: new Map([[SERVER_ID, { name: "Test Server" }]]),
  };
  let nextMessage = 0;
  const request = async (method, path, body) => {
    if (method === "GET" && path === `/users/${OWNER_ID}/dm`) {
      return { ok: true, status: 200, data: { _id: DM_ID } };
    }
    if (method === "POST" && path === `/channels/${DM_ID}/messages`) {
      dmPayloads.push(body);
      return dmFails
        ? { ok: false, status: 403 }
        : {
            ok: true,
            status: 200,
            data: { _id: `DMMESSAGE${++nextMessage}` },
          };
    }
    return { ok: false, status: 404 };
  };
  const coordinator = createChannelExclusion(client, {
    send: async (channelId, payload) => {
      responses.push({ channelId, payload });
      return { _id: `RESPONSE${++nextMessage}` };
    },
    sendProtected: async (channelId, payload) => {
      protectedLogs.push({ channelId, payload });
      return { _id: `PROTECTED${++nextMessage}` };
    },
    request,
    store,
    configuredCustodianId: OWNER_ID,
    now: () => current,
    codeFactory: () => "123456",
    requestIdFactory: () => "CE123456",
    purgeArchive: (channelId) => {
      purgedChannels.push(channelId);
      return [];
    },
    removeEvidence: () => true,
    scheduleTimeout: () => ({ unref() {} }),
    scheduleInterval: () => ({ unref() {} }),
    logger: { log() {}, warn() {} },
  });

  return {
    coordinator,
    store,
    responses,
    protectedLogs,
    dmPayloads,
    purgedChannels,
    advance(ms) {
      current += ms;
    },
  };
}

function serverMessage(authorId = MOD_ID, channelId = SOURCE_ID) {
  return {
    id: "01JJJJJJJJJJJJJJJJJJJJJJJJ",
    authorId,
    channelId,
    channel: { id: channelId, serverId: SERVER_ID },
    server: { id: SERVER_ID },
  };
}

function directMessage(authorId, content) {
  return {
    id: "01KKKKKKKKKKKKKKKKKKKKKKKK",
    authorId,
    channelId: DM_ID,
    channel: { id: DM_ID },
    content,
  };
}

test("in-server confirmation persists an exclusion and purges its archive", async () => {
  const harness = makeHarness();
  const requested = await harness.coordinator.handleCommand(serverMessage(), [
    TARGET_ID,
  ]);
  assert.equal(requested.outcome, "requested");
  assert.equal(harness.store.isChannelExcluded(TARGET_ID), false);
  const pending = harness.coordinator.getPending(SERVER_ID);
  assert.ok(Buffer.isBuffer(pending.codeHash));
  assert.equal(Object.hasOwn(pending, "code"), false);

  const result = await harness.coordinator.handleCommand(serverMessage(), [
    "confirm",
    "123456",
  ]);
  assert.equal(result.outcome, "excluded");
  assert.equal(harness.store.isChannelExcluded(TARGET_ID), true);
  assert.deepEqual(harness.purgedChannels, [TARGET_ID]);
  assert.equal(harness.coordinator.getPending(SERVER_ID), null);
});

test("three wrong codes destroy the pending challenge", async () => {
  const harness = makeHarness();
  await harness.coordinator.handleCommand(serverMessage(), [TARGET_ID]);
  for (const code of ["000000", "000001"]) {
    const result = await harness.coordinator.handleCommand(serverMessage(), [
      "confirm",
      code,
    ]);
    assert.equal(result.outcome, "wrong_code");
  }
  const final = await harness.coordinator.handleCommand(serverMessage(), [
    "confirm",
    "000002",
  ]);
  assert.equal(final.outcome, "attempts_exhausted");
  assert.equal(harness.coordinator.getPending(SERVER_ID), null);
  assert.equal(harness.store.isChannelExcluded(TARGET_ID), false);
});

test("expired codes are rejected without changing state", async () => {
  const harness = makeHarness();
  await harness.coordinator.handleCommand(serverMessage(), [TARGET_ID]);
  harness.advance(EXCLUSION_CHALLENGE_TTL_MS + 1);
  const result = await harness.coordinator.handleCommand(serverMessage(), [
    "confirm",
    "123456",
  ]);
  assert.equal(result.outcome, "no_pending");
  assert.equal(harness.store.isChannelExcluded(TARGET_ID), false);
});

test("bot owner can approve by DM with a bare code", async () => {
  const harness = makeHarness();
  await harness.coordinator.handleCommand(serverMessage(), [TARGET_ID]);
  assert.equal(
    await harness.coordinator.handleDirectMessage(
      directMessage(OWNER_ID, "123456")
    ),
    true
  );
  assert.equal(harness.store.isChannelExcluded(TARGET_ID), true);
});

test("non-custodian DMs are ignored even with a valid code", async () => {
  const harness = makeHarness();
  await harness.coordinator.handleCommand(serverMessage(), [TARGET_ID]);
  assert.equal(
    await harness.coordinator.handleDirectMessage(
      directMessage(OTHER_ID, "123456")
    ),
    false
  );
  assert.equal(harness.store.isChannelExcluded(TARGET_ID), false);
  assert.ok(harness.coordinator.getPending(SERVER_ID));
});

test("audit channel cannot be excluded and a second request is refused", async () => {
  const harness = makeHarness();
  const auditResult = await harness.coordinator.handleCommand(serverMessage(), [
    AUDIT_ID,
  ]);
  assert.equal(auditResult.outcome, "audit_channel");

  await harness.coordinator.handleCommand(serverMessage(), [TARGET_ID]);
  const second = await harness.coordinator.handleCommand(serverMessage(), [
    SOURCE_ID,
  ]);
  assert.equal(second.outcome, "pending_exists");
});

test("failed owner DM leaves no pending request or exclusion", async () => {
  const harness = makeHarness({ dmFails: true });
  const result = await harness.coordinator.handleCommand(serverMessage(), [
    TARGET_ID,
  ]);
  assert.equal(result.outcome, "dm_failed");
  assert.equal(harness.coordinator.getPending(SERVER_ID), null);
  assert.equal(harness.store.isChannelExcluded(TARGET_ID), false);
});

test("removing an exclusion requires a fresh challenge", async () => {
  const harness = makeHarness();
  await harness.coordinator.handleCommand(serverMessage(), [TARGET_ID]);
  await harness.coordinator.handleCommand(serverMessage(), [
    "confirm",
    "123456",
  ]);
  assert.equal(harness.store.isChannelExcluded(TARGET_ID), true);

  const requested = await harness.coordinator.handleCommand(serverMessage(), [
    "remove",
    TARGET_ID,
  ]);
  assert.equal(requested.outcome, "requested");
  assert.equal(harness.store.isChannelExcluded(TARGET_ID), true);

  const removed = await harness.coordinator.handleDirectMessage(
    directMessage(OWNER_ID, "approve 123456")
  );
  assert.equal(removed, true);
  assert.equal(harness.store.isChannelExcluded(TARGET_ID), false);
});
