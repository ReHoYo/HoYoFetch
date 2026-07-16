import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Load every application module only after assigning a hermetic data dir.
process.env.HOYOFETCH_DATA_DIR = mkdtempSync(
  join(tmpdir(), "hoyofetch-tamper-")
);
process.env.AUDITLOG_EVIDENCE_BUDGET_MB = "0";

const storeModule = await import("../store.js");
const { buildTamperNotice, buildRestoredEmbed } = await import("../embeds.js");
const { createTamperProtection } = await import("../tamper-protection.js");
const { initAuditLog, runAuditLogTest } = await import("../auditlog.js");

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const silentLogger = { log() {}, warn() {}, error() {} };

function makeRecord(overrides = {}) {
  return {
    recordId: "REC1",
    channelId: "CHANNEL1",
    messageId: "MESSAGE1",
    payload: { embeds: [{ title: "t", description: "d" }] },
    restorations: 0,
    createdAt: NOW,
    lastVerifiedAt: NOW,
    failures: 0,
    nextAttemptAt: 0,
    channelMissing: false,
    ...overrides,
  };
}

function makeMemoryStore({ clock = () => NOW, backoffMs = 10 } = {}) {
  const records = new Map();
  const messageIndex = new Map();

  return {
    addProtectedMessage(channelId, messageId, payload) {
      const record = makeRecord({
        recordId: messageId,
        channelId,
        messageId,
        payload: structuredClone(payload),
        createdAt: clock(),
        lastVerifiedAt: clock(),
      });
      records.set(record.recordId, record);
      messageIndex.set(messageId, record.recordId);
      return record;
    },
    getProtectedMessageByMessageId(messageId) {
      return records.get(messageIndex.get(messageId));
    },
    updateProtectedMessage(recordId, patch) {
      const record = records.get(recordId);
      if (!record) return undefined;
      if (patch.messageId && patch.messageId !== record.messageId) {
        messageIndex.delete(record.messageId);
        messageIndex.set(patch.messageId, recordId);
      }
      Object.assign(record, patch);
      return record;
    },
    removeProtectedMessage(recordId) {
      const record = records.get(recordId);
      if (!record) return;
      messageIndex.delete(record.messageId);
      records.delete(recordId);
    },
    getAllProtectedMessages() {
      return [...records.values()];
    },
    markChannelMissing(channelId) {
      for (const record of records.values()) {
        if (record.channelId === channelId) record.channelMissing = true;
      }
    },
    computeBackoffMs() {
      return backoffMs;
    },
    selectDueRecords: storeModule.selectDueRecords,
  };
}

function makeClient() {
  const rawListeners = [];
  const listeners = new Map();
  return {
    user: { id: "BOT1" },
    users: new Map(),
    serverMembers: { hasByKey: () => false },
    servers: new Map(),
    channels: new Map(),
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
    emitRaw(event) {
      for (const listener of rawListeners) listener(event);
    },
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args);
    },
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("computeBackoffMs is monotonic across failure counts and capped", () => {
  const samples = [1, 2, 3, 4, 5, 10, 20].map((failures) =>
    storeModule.computeBackoffMs(failures)
  );
  for (const ms of samples) {
    assert.ok(ms > 0);
    assert.ok(ms <= 15 * 60 * 1000);
  }
  assert.ok(samples[samples.length - 1] >= samples[0] * 0.5);
});

test("shouldVerify excludes missing channels and records still on backoff", () => {
  assert.equal(
    storeModule.shouldVerify(makeRecord({ channelMissing: true }), NOW + DAY),
    false
  );
  assert.equal(
    storeModule.shouldVerify(
      makeRecord({ nextAttemptAt: NOW + 1_000 }),
      NOW + 500
    ),
    false
  );
});

test("shouldVerify checks fresh records every sweep but throttles old ones", () => {
  assert.equal(storeModule.shouldVerify(makeRecord(), NOW + 1_000), true);
  const monthOld = makeRecord({
    createdAt: NOW - 40 * DAY,
    lastVerifiedAt: NOW - 1_000,
  });
  assert.equal(storeModule.shouldVerify(monthOld, NOW), false);
  assert.equal(storeModule.shouldVerify(monthOld, NOW - 1_000 + DAY), true);
});

test("selectDueRecords respects its budget and verification order", () => {
  const records = [
    makeRecord({ recordId: "A", lastVerifiedAt: NOW - 3_000 }),
    makeRecord({ recordId: "B", lastVerifiedAt: NOW - 1_000 }),
    makeRecord({ recordId: "C", lastVerifiedAt: NOW - 5_000 }),
    makeRecord({
      recordId: "D",
      channelMissing: true,
      lastVerifiedAt: NOW - 9_000,
    }),
  ];
  assert.deepEqual(
    storeModule
      .selectDueRecords(records, NOW, 2)
      .map((record) => record.recordId),
    ["C", "A"]
  );
});

test("restoration formatting preserves pristine embeds and one notice", () => {
  assert.match(buildTamperNotice(3), /Restoration #3/);
  const original = { title: "Codes", description: "line one", colour: "#fff" };
  const first = buildRestoredEmbed(original, 1);
  const second = buildRestoredEmbed(original, 2);

  assert.equal(original.description, "line one");
  assert.equal(first.title, "Codes");
  assert.equal(first.colour, "#fff");
  assert.equal((first.description.match(/Restoration #/g) || []).length, 1);
  assert.equal((second.description.match(/Restoration #/g) || []).length, 1);
  assert.match(second.description, /Restoration #2/);
});

test("restoration formatting retains its notice under the embed limit", () => {
  const restored = buildRestoredEmbed(
    { title: "Codes", description: "x".repeat(2_500) },
    5
  );
  assert.ok(restored.description.length <= 2_000);
  assert.match(restored.description, /Restoration #5/);
});

test("protected sends persist the exact wire payload", async () => {
  const memoryStore = makeMemoryStore();
  const sent = [];
  const protection = createTamperProtection(makeClient(), {
    store: memoryStore,
    send: async (channelId, payload) => {
      sent.push({ channelId, payload });
      return { _id: "MESSAGE1" };
    },
    request: async () => ({ ok: true, status: 200, data: {} }),
    logger: silentLogger,
  });

  await protection.sendProtected("CHANNEL1", {
    embeds: [{ title: "Audit entry", description: "evidence" }],
  });

  assert.equal(sent[0].payload.content, " ");
  const record = memoryStore.getProtectedMessageByMessageId("MESSAGE1");
  assert.equal(record.channelId, "CHANNEL1");
  assert.deepEqual(record.payload, sent[0].payload);
});

test("a send without a valid message id is reported as unprotected", async () => {
  const memoryStore = makeMemoryStore();
  const protection = createTamperProtection(makeClient(), {
    store: memoryStore,
    send: async () => ({}),
    request: async () => ({ ok: true, status: 200, data: {} }),
    logger: silentLogger,
  });

  const result = await protection.sendProtected("CHANNEL1", {
    content: "audit",
  });
  assert.equal(result, undefined);
  assert.equal(memoryStore.getAllProtectedMessages().length, 0);
});

test("raw deletes restore uncached messages repeatedly and replace the live id", async () => {
  const memoryStore = makeMemoryStore();
  const client = makeClient();
  const restoredPayloads = [];
  const replacementIds = ["MESSAGE2", "MESSAGE3"];
  const protection = createTamperProtection(client, {
    store: memoryStore,
    send: async () => ({ _id: "MESSAGE1" }),
    request: async (method, _path, payload) => {
      assert.equal(method, "POST");
      restoredPayloads.push(payload);
      return { ok: true, status: 200, data: { _id: replacementIds.shift() } };
    },
    restoreFloorMs: 0,
    logger: silentLogger,
  });

  await protection.sendProtected("CHANNEL1", {
    embeds: [{ title: "Audit entry", description: "original" }],
  });
  client.emitRaw({
    type: "MessageDelete",
    id: "MESSAGE1",
    channel: "CHANNEL1",
  });
  await waitFor(
    () =>
      memoryStore.getProtectedMessageByMessageId("MESSAGE2")?.restorations === 1
  );

  client.emitRaw({
    type: "MessageDelete",
    id: "MESSAGE2",
    channel: "CHANNEL1",
  });
  await waitFor(
    () =>
      memoryStore.getProtectedMessageByMessageId("MESSAGE3")?.restorations === 2
  );

  assert.equal(restoredPayloads.length, 2);
  assert.match(restoredPayloads[0].embeds[0].description, /Restoration #1/);
  assert.match(restoredPayloads[1].embeds[0].description, /Restoration #2/);
  assert.equal(
    (restoredPayloads[1].embeds[0].description.match(/Restoration #/g) || [])
      .length,
    1
  );
});

test("raw bulk deletes restore each protected record once", async () => {
  const memoryStore = makeMemoryStore();
  const posts = [];
  let sendNumber = 0;
  const protection = createTamperProtection(makeClient(), {
    store: memoryStore,
    send: async () => ({ _id: `MESSAGE${++sendNumber}` }),
    request: async (_method, path) => {
      posts.push(path);
      return {
        ok: true,
        status: 200,
        data: { _id: `RESTORED${posts.length}` },
      };
    },
    restoreFloorMs: 0,
    logger: silentLogger,
  });

  await protection.sendProtected("CHANNEL1", { content: "first" });
  await protection.sendProtected("CHANNEL1", { content: "second" });
  await protection.handleRawEvent({
    type: "BulkMessageDelete",
    channel: "CHANNEL1",
    ids: ["MESSAGE1", "MESSAGE1", "UNKNOWN", "MESSAGE2"],
  });

  assert.equal(posts.length, 2);
  assert.equal(memoryStore.getAllProtectedMessages()[0].restorations, 1);
  assert.equal(memoryStore.getAllProtectedMessages()[1].restorations, 1);
});

test("intentional bot deletes are neither restored nor left tracked", async () => {
  const memoryStore = makeMemoryStore();
  let reposts = 0;
  const protection = createTamperProtection(makeClient(), {
    store: memoryStore,
    send: async () => ({ _id: "MESSAGE1" }),
    request: async () => {
      reposts++;
      return { ok: true, status: 200, data: { _id: "MESSAGE2" } };
    },
    logger: silentLogger,
  });

  await protection.sendProtected("CHANNEL1", { content: "temporary" });
  await protection.runIntentionalDelete("MESSAGE1", async () => {
    await protection.handleRawEvent({
      type: "MessageDelete",
      id: "MESSAGE1",
      channel: "CHANNEL1",
    });
    return true;
  });

  assert.equal(reposts, 0);
  assert.equal(memoryStore.getAllProtectedMessages().length, 0);
});

test("failed reposts retain state and retry after backoff", async () => {
  let currentTime = NOW;
  const memoryStore = makeMemoryStore({
    clock: () => currentTime,
    backoffMs: 10,
  });
  const scheduled = [];
  let attempts = 0;
  const protection = createTamperProtection(makeClient(), {
    store: memoryStore,
    send: async () => ({ _id: "MESSAGE1" }),
    request: async () => {
      attempts++;
      return attempts === 1
        ? { ok: false, status: 500 }
        : { ok: true, status: 200, data: { _id: "MESSAGE2" } };
    },
    now: () => currentTime,
    scheduleTimeout(callback, delay) {
      scheduled.push({ callback, delay, unref() {} });
      return scheduled.at(-1);
    },
    restoreFloorMs: 0,
    logger: silentLogger,
  });

  await protection.sendProtected("CHANNEL1", { content: "audit" });
  await protection.handleRawEvent({ type: "MessageDelete", id: "MESSAGE1" });
  const failed = memoryStore.getProtectedMessageByMessageId("MESSAGE1");
  assert.equal(failed.failures, 1);
  assert.equal(failed.nextAttemptAt, NOW + 10);
  assert.equal(scheduled[0].delay, 10);

  currentTime += 10;
  scheduled[0].callback();
  await waitFor(() => memoryStore.getProtectedMessageByMessageId("MESSAGE2"));
  assert.equal(attempts, 2);
});

test("reconciliation restores offline deletes but not transient API failures", async () => {
  let currentTime = NOW;
  const memoryStore = makeMemoryStore({ clock: () => currentTime });
  let mode = "missing";
  let posts = 0;
  const protection = createTamperProtection(makeClient(), {
    store: memoryStore,
    send: async () => ({ _id: "MESSAGE1" }),
    request: async (method) => {
      if (method === "POST") {
        posts++;
        return { ok: true, status: 200, data: { _id: "MESSAGE2" } };
      }
      return mode === "missing"
        ? { ok: false, status: 404 }
        : { ok: false, status: 503 };
    },
    now: () => currentTime,
    scheduleInterval() {
      return { unref() {} };
    },
    restoreFloorMs: 0,
    logger: silentLogger,
  });

  await protection.sendProtected("CHANNEL1", { content: "audit" });
  currentTime += 1;
  await protection.start();
  assert.equal(posts, 1);
  assert.ok(memoryStore.getProtectedMessageByMessageId("MESSAGE2"));

  mode = "unavailable";
  currentTime += 1;
  await protection.sweepNow();
  assert.equal(posts, 1, "503 is not proof that the message was deleted");
});

test("existing protected-message records reload without migration", async () => {
  storeModule.addProtectedMessage("CHANNEL9", "PERSISTED1", {
    embeds: [{ title: "Older audit entry", description: "kept" }],
  });

  const reloaded = await import("../store.js?tamper-reload=1");
  const record = reloaded.getProtectedMessageByMessageId("PERSISTED1");
  assert.equal(record.recordId, "PERSISTED1");
  assert.equal(record.channelId, "CHANNEL9");
  assert.equal(record.payload.embeds[0].title, "Older audit entry");
});

test("legacy embed records restore with a valid wire payload", async () => {
  const memoryStore = makeMemoryStore();
  memoryStore.addProtectedMessage("CHANNEL1", "LEGACY1", {
    embeds: [{ title: "Old entry", description: "before canonicalisation" }],
  });
  let restoredPayload;
  const protection = createTamperProtection(makeClient(), {
    store: memoryStore,
    send: async () => ({ _id: "UNUSED1" }),
    request: async (_method, _path, payload) => {
      restoredPayload = payload;
      return { ok: true, status: 200, data: { _id: "LEGACY2" } };
    },
    restoreFloorMs: 0,
    logger: silentLogger,
  });

  await protection.handleRawEvent({ type: "MessageDelete", id: "LEGACY1" });
  assert.equal(restoredPayload.content, " ");
  assert.match(restoredPayload.embeds[0].description, /Restoration #1/);
});

test("tamper diagnostics never expose raw message or channel ids", async () => {
  const memoryStore = makeMemoryStore();
  const output = [];
  const logger = {
    log(message) {
      output.push(message);
    },
    warn(message) {
      output.push(message);
    },
    error(message) {
      output.push(message);
    },
  };
  const protection = createTamperProtection(makeClient(), {
    store: memoryStore,
    send: async () => ({ _id: "SECRETMESSAGE1" }),
    request: async () => ({
      ok: true,
      status: 200,
      data: { _id: "SECRETMESSAGE2" },
    }),
    restoreFloorMs: 0,
    logger,
  });

  await protection.sendProtected("SECRETCHANNEL1", { content: "audit" });
  await protection.handleRawEvent({
    type: "MessageDelete",
    id: "SECRETMESSAGE1",
  });

  const combined = output.join("\n");
  assert.doesNotMatch(combined, /SECRETMESSAGE1|SECRETMESSAGE2|SECRETCHANNEL1/);
  assert.match(combined, /record=[a-f0-9]{12}/);
  assert.match(combined, /channel=[a-f0-9]{12}/);
});

test("the audit pipeline requires and uses a protected sender", async () => {
  const client = makeClient();
  assert.throws(
    () => initAuditLog(client, { send: async () => ({ _id: "WRONG" }) }),
    /protected sender/i
  );

  let nextId = 0;
  const protection = createTamperProtection(client, {
    send: async () => ({ _id: `AUDITMESSAGE${++nextId}` }),
    request: async () => ({ ok: true, status: 200, data: {} }),
    logger: silentLogger,
  });
  storeModule.enableAuditLog("SERVER1", "CHANNEL1");
  initAuditLog(client, {
    sendProtected: protection.sendProtected,
    request: async () => ({ ok: true, status: 200, data: {} }),
  });

  const status = runAuditLogTest("SERVER1");
  assert.equal(status.queuedTest, true);
  await waitFor(() =>
    storeModule
      .getAllProtectedMessages()
      .some(
        (record) => record.payload.embeds?.[0]?.title === "🧪 Audit Log Test"
      )
  );
});

test("live user identity events enter the protected audit pipeline", async () => {
  const client = makeClient();
  const serverId = "IDENTITYSERVER";
  const channelId = "IDENTITYCHANNEL";
  const user = { id: "IDENTITYUSER", username: "After" };
  client.users.set(user.id, user);
  client.serverMembers.hasByKey = ({ server, user: memberUser }) =>
    server === serverId && memberUser === user.id;

  let nextId = 0;
  const protection = createTamperProtection(client, {
    send: async () => ({ _id: `IDENTITYAUDIT${++nextId}` }),
    request: async () => ({ ok: true, status: 200, data: {} }),
    logger: silentLogger,
  });
  storeModule.enableAuditLog(serverId, channelId);
  initAuditLog(client, {
    sendProtected: protection.sendProtected,
    request: async () => ({ ok: true, status: 200, data: {} }),
  });

  client.emit("userUpdate", user, {
    username: "Before",
  });

  await waitFor(
    () =>
      storeModule
        .getAllProtectedMessages()
        .filter((record) => record.channelId === channelId).length === 1
  );
  const identityRecords = storeModule
    .getAllProtectedMessages()
    .filter((record) => record.channelId === channelId);
  assert.deepEqual(
    identityRecords.map((record) => record.payload.embeds[0].title),
    ["🪪 Username Changed"]
  );
  storeModule.disableAuditLog(serverId);
});

test("audit startup and enablement hydrate member caches before monitoring", async () => {
  const client = makeClient();
  const serverId = "HYDRATIONSERVER";
  const channelId = "HYDRATIONCHANNEL";
  let fetches = 0;
  client.servers.set(serverId, {
    async fetchMembers() {
      fetches++;
      return { members: [], users: [] };
    },
  });
  const monitor = initAuditLog(client, {
    sendProtected: async () => ({ _id: "UNUSED" }),
    request: async () => ({ ok: false, status: 404, data: undefined }),
  });

  storeModule.enableAuditLog(serverId, channelId);
  await monitor.configurationChanged(serverId);
  assert.equal(fetches, 1);
  await monitor.start();
  assert.equal(fetches, 2);
  storeModule.disableAuditLog(serverId);
});

test("a reconciled settings change stays protected through deletion and restoration", async () => {
  const client = makeClient();
  const serverId = "SERVERSETTINGS2";
  const channelId = "CHANNELSETTINGS2";
  let serverName = "Before";
  let nextId = 0;
  const request = async (method, path) => {
    if (method === "GET" && path.startsWith(`/servers/${serverId}?`)) {
      return {
        ok: true,
        status: 200,
        data: {
          _id: serverId,
          owner: "OWNER2",
          name: serverName,
          channels: [
            {
              _id: channelId,
              channel_type: "TextChannel",
              server: serverId,
              name: "audit-log",
            },
          ],
          roles: {},
          default_permissions: 0,
        },
      };
    }
    if (
      method === "GET" &&
      (path === `/servers/${serverId}/emojis` ||
        path === `/servers/${serverId}/invites` ||
        path === `/channels/${channelId}/webhooks`)
    ) {
      return { ok: true, status: 200, data: [] };
    }
    if (method === "POST" && path === `/channels/${channelId}/messages`) {
      return {
        ok: true,
        status: 200,
        data: { _id: `RESTOREDSETTING${++nextId}` },
      };
    }
    return { ok: false, status: 404 };
  };
  const protection = createTamperProtection(client, {
    send: async () => ({ _id: `SETTINGAUDIT${++nextId}` }),
    request,
    restoreFloorMs: 0,
    logger: silentLogger,
  });
  storeModule.enableAuditLog(serverId, channelId);
  const monitor = initAuditLog(client, {
    sendProtected: protection.sendProtected,
    request,
  });

  await monitor.reconcileServer(serverId);
  serverName = "After";
  await monitor.reconcileServer(serverId);
  await waitFor(() =>
    storeModule
      .getAllProtectedMessages()
      .some(
        (record) =>
          record.payload.embeds?.[0]?.title === "⚙️ Server Settings Updated"
      )
  );

  const record = storeModule
    .getAllProtectedMessages()
    .find(
      (entry) =>
        entry.payload.embeds?.[0]?.title === "⚙️ Server Settings Updated"
    );
  await protection.handleRawEvent({
    type: "MessageDelete",
    id: record.messageId,
  });
  assert.equal(
    storeModule
      .getAllProtectedMessages()
      .find((entry) => entry.recordId === record.recordId).restorations,
    1
  );
});
