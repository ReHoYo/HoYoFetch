import test from "node:test";
import assert from "node:assert/strict";
import { provisionEmoji } from "../emoji-provision.js";

const TEST_MANIFEST = [
  {
    keyword: "primogem",
    name: "primogem",
    tier: 1,
    url: "https://icons.test/primogem.png",
  },
  {
    keyword: "mora",
    name: "mora",
    tier: 1,
    url: "https://icons.test/mora.png",
  },
  {
    keyword: "resin",
    name: "resin",
    tier: 3,
    url: "https://icons.test/resin.png",
  },
  {
    keyword: "hero's wit",
    name: "heros_wit",
    tier: 2,
    url: "https://icons.test/heros_wit.png",
  },
  {
    keyword: "adventurer's experience",
    name: "adventurers_experience",
    tier: 2,
    url: "https://icons.test/adv_exp.png",
  },
];

function makeServer({ id = "HUBSERVER", name = "Hub", existing = [] } = {}) {
  const existingEmoji = existing.map((entry, i) => ({
    id: `EXIST${i}`,
    name: entry,
  }));
  return { id, name, fetchEmojis: async () => existingEmoji };
}

function makeClient(server, serverId = "HUBSERVER") {
  return {
    servers: { get: (id) => (id === serverId ? server : undefined) },
    configuration: { features: { autumn: { url: "https://autumn.test" } } },
    authenticationHeader: ["X-Bot-Token", "secret"],
    // Real code no longer calls server.createEmoji() (see emoji-provision.js
    // for why); tests inject createEmojiImpl directly instead, so client.api
    // only needs to exist for the one test that exercises the real default.
  };
}

async function fakeFetchImpl() {
  return {
    ok: true,
    headers: { get: () => "image/png" },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  };
}

async function fakeUploadImpl({ filename }) {
  return `AUTUMN_${filename}`;
}

async function fakeCreateEmojiImpl({ name }) {
  return `NEW_${name}`;
}

test("provisionEmoji uploads only the manifest entries missing from the hub", async () => {
  const server = makeServer({ existing: ["primogem", "mora"] });
  const client = makeClient(server);
  const createCalls = [];

  const summary = await provisionEmoji({
    client,
    serverId: "HUBSERVER",
    manifest: TEST_MANIFEST,
    fetchImpl: fakeFetchImpl,
    uploadImpl: fakeUploadImpl,
    createEmojiImpl: async ({ name }) => {
      createCalls.push(name);
      return `NEW_${name}`;
    },
    loadRegistry: () => ({ entries: {} }),
    saveRegistry: () => {},
  });

  assert.equal(summary.ok, true);
  assert.deepEqual(summary.reused.sort(), ["mora", "primogem"]);
  assert.deepEqual(createCalls.sort(), [
    "adventurers_experience",
    "heros_wit",
    "resin",
  ]);
  assert.equal(summary.created.length, 3);
});

test("provisionEmoji makes no network calls when everything is already provisioned", async () => {
  const server = makeServer({ existing: TEST_MANIFEST.map((e) => e.name) });
  const client = makeClient(server);
  let fetchCount = 0;

  const summary = await provisionEmoji({
    client,
    serverId: "HUBSERVER",
    manifest: TEST_MANIFEST,
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("should not fetch");
    },
    uploadImpl: async () => {
      throw new Error("should not upload");
    },
    createEmojiImpl: async () => {
      throw new Error("should not create");
    },
    loadRegistry: () => ({ entries: {} }),
    saveRegistry: () => {},
  });

  assert.equal(fetchCount, 0);
  assert.equal(summary.created.length, 0);
  assert.equal(summary.reused.length, TEST_MANIFEST.length);
});

test("provisionEmoji reports a failed download without aborting the rest", async () => {
  const server = makeServer();
  const client = makeClient(server);

  const summary = await provisionEmoji({
    client,
    serverId: "HUBSERVER",
    manifest: TEST_MANIFEST,
    fetchImpl: async (url) => {
      if (url.includes("mora")) return { ok: false, status: 404 };
      return fakeFetchImpl(url);
    },
    uploadImpl: fakeUploadImpl,
    createEmojiImpl: fakeCreateEmojiImpl,
    loadRegistry: () => ({ entries: {} }),
    saveRegistry: () => {},
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].name, "mora");
  assert.equal(summary.failed[0].reason, "download_failed (HTTP 404)");
  assert.equal(summary.created.length, 4);
});

test("provisionEmoji skips an icon over the size cap without uploading it", async () => {
  const server = makeServer();
  const client = makeClient(server);
  let uploadCount = 0;

  const summary = await provisionEmoji({
    client,
    serverId: "HUBSERVER",
    manifest: TEST_MANIFEST,
    fetchImpl: fakeFetchImpl,
    uploadImpl: async (opts) => {
      uploadCount += 1;
      return fakeUploadImpl(opts);
    },
    createEmojiImpl: fakeCreateEmojiImpl,
    maxIconBytes: 1, // fakeFetchImpl's body is 3 bytes
    loadRegistry: () => ({ entries: {} }),
    saveRegistry: () => {},
  });

  assert.equal(uploadCount, 0);
  assert.equal(summary.skipped.length, TEST_MANIFEST.length);
  assert.ok(summary.skipped.every((s) => s.reason === "too_large"));
});

test("provisionEmoji continues after one createEmoji call fails, and still saves the successes", async () => {
  const server = makeServer();
  const client = makeClient(server);
  let savedRecord = null;

  const summary = await provisionEmoji({
    client,
    serverId: "HUBSERVER",
    manifest: TEST_MANIFEST,
    fetchImpl: fakeFetchImpl,
    uploadImpl: fakeUploadImpl,
    createEmojiImpl: async ({ name }) => {
      if (name === "mora") throw new Error("403 Forbidden");
      return `NEW_${name}`;
    },
    loadRegistry: () => ({ entries: {} }),
    saveRegistry: (record) => {
      savedRecord = record;
    },
  });

  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].name, "mora");
  assert.equal(summary.created.length, 4);
  assert.ok(savedRecord);
  assert.equal(Object.keys(savedRecord.entries).length, 4);
});

test("provisionEmoji respects the server emoji cap, provisioning lowest tier first", async () => {
  const server = makeServer({ existing: ["primogem"] });
  const client = makeClient(server);
  const createCalls = [];

  const summary = await provisionEmoji({
    client,
    serverId: "HUBSERVER",
    manifest: TEST_MANIFEST,
    fetchImpl: fakeFetchImpl,
    uploadImpl: fakeUploadImpl,
    createEmojiImpl: async ({ name }) => {
      createCalls.push(name);
      return `NEW_${name}`;
    },
    maxServerEmoji: 2, // budget = 2 - 1 existing = 1
    loadRegistry: () => ({ entries: {} }),
    saveRegistry: () => {},
  });

  assert.deepEqual(createCalls, ["mora"]); // lowest remaining tier
  assert.equal(
    summary.skipped.filter((s) => s.reason === "server_emoji_limit").length,
    3
  );
});

test("provisionEmoji returns hub_not_configured without any calls when serverId is blank", async () => {
  let called = false;
  const summary = await provisionEmoji({
    client: {
      servers: {
        get: () => {
          called = true;
        },
      },
    },
    serverId: "",
    manifest: TEST_MANIFEST,
    fetchImpl: async () => {
      called = true;
    },
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.error, "hub_not_configured");
  assert.equal(summary.serverId, null);
  assert.equal(called, false);
});

test("provisionEmoji returns hub_not_found when the bot isn't in that server", async () => {
  const summary = await provisionEmoji({
    client: { servers: { get: () => undefined } },
    serverId: "01ABCDEFGHJKMNPQRSTVWXYZ0",
    manifest: TEST_MANIFEST,
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.error, "hub_not_found");
  assert.equal(summary.serverId, "01ABCDEFGHJKMNPQRSTVWXYZ0");
});

test("provisionEmoji persists the documented registry shape with bare emoji ids", async () => {
  const server = makeServer();
  const client = makeClient(server);
  let saved = null;

  await provisionEmoji({
    client,
    serverId: "HUBSERVER",
    manifest: TEST_MANIFEST.slice(0, 1),
    fetchImpl: fakeFetchImpl,
    uploadImpl: fakeUploadImpl,
    createEmojiImpl: fakeCreateEmojiImpl,
    loadRegistry: () => ({ entries: {} }),
    saveRegistry: (record) => {
      saved = record;
    },
  });

  assert.equal(saved.version, 1);
  assert.equal(saved.serverId, "HUBSERVER");
  assert.equal(typeof saved.updatedAt, "number");

  const entry = saved.entries.primogem;
  assert.doesNotMatch(entry.emojiId, /:/);
  assert.equal(entry.name, "primogem");
  assert.equal(entry.iconUrl, TEST_MANIFEST[0].url);
  assert.equal(typeof entry.provisionedAt, "number");
});

// Regression: revolt.js's Server.createEmoji() hands whatever a PUT
// /custom/emoji/{id} response contains straight to its internal Solid.js
// store, which throws "Cannot read properties of undefined (reading
// 'partial')" whenever the response has no `_id` — which is exactly what
// happens when Stoat rejects the request (e.g. missing Manage
// Customisation) and responds with an error body, since revolt-api never
// checks the HTTP status before treating the body as success. This exercises
// the real (non-injected) createEmojiImpl default against a fake client.api
// to confirm the rejection surfaces as a normal per-item failure instead.
test("provisionEmoji surfaces a clear reason instead of crashing when Stoat rejects the create request", async () => {
  const server = makeServer();
  const client = makeClient(server);
  client.api = {
    put: async () => ({
      type: "MissingPermission",
      permission: "ManageCustomisation",
    }),
  };

  const summary = await provisionEmoji({
    client,
    serverId: "HUBSERVER",
    manifest: TEST_MANIFEST.slice(0, 1),
    fetchImpl: fakeFetchImpl,
    uploadImpl: fakeUploadImpl,
    // No createEmojiImpl override: this must exercise the real default.
    loadRegistry: () => ({ entries: {} }),
    saveRegistry: () => {},
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.created.length, 0);
  assert.equal(summary.failed.length, 1);
  assert.match(summary.failed[0].reason, /MissingPermission/);
  assert.match(summary.failed[0].reason, /Manage Customisation/);
  assert.doesNotMatch(summary.failed[0].reason, /partial/);
});

test("provisionEmoji surfaces a clear reason when Stoat's response has no _id and no type either", async () => {
  const server = makeServer();
  const client = makeClient(server);
  client.api = { put: async () => ({}) };

  const summary = await provisionEmoji({
    client,
    serverId: "HUBSERVER",
    manifest: TEST_MANIFEST.slice(0, 1),
    fetchImpl: fakeFetchImpl,
    uploadImpl: fakeUploadImpl,
    loadRegistry: () => ({ entries: {} }),
    saveRegistry: () => {},
  });

  assert.equal(summary.failed.length, 1);
  assert.match(summary.failed[0].reason, /did not return a created emoji id/);
});
