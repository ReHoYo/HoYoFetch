import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "hoyofetch-settings-monitor-"));
process.env.HOYOFETCH_DATA_DIR = dataDir;

const store = await import("../store.js");
const { createSettingsMonitor, diffSettingsSnapshots } =
  await import("../settings-monitor.js");

const SERVER_ID = "SERVERSETTINGS1";
const LOG_CHANNEL_ID = "AUDITCHANNEL1";
const GENERAL_ID = "GENERALCHANNEL1";

function makeServer({
  name = "Before",
  defaultPermissions = 0,
  rolePermissions = { a: 0, d: 0 },
} = {}) {
  return {
    _id: SERVER_ID,
    owner: "OWNER1",
    name,
    description: "Description",
    channels: [
      {
        _id: GENERAL_ID,
        channel_type: "TextChannel",
        server: SERVER_ID,
        name: "general",
        default_permissions: { a: 0, d: 0 },
        role_permissions: { ROLE1: rolePermissions },
      },
      {
        _id: LOG_CHANNEL_ID,
        channel_type: "TextChannel",
        server: SERVER_ID,
        name: "audit-log",
      },
    ],
    categories: [
      {
        id: "CATEGORY1",
        title: "Text",
        channels: [GENERAL_ID, LOG_CHANNEL_ID],
      },
    ],
    system_messages: { user_joined: GENERAL_ID },
    roles: {
      ROLE1: {
        name: "Moderator",
        rank: 1,
        permissions: { a: 0, d: 0 },
      },
    },
    default_permissions: defaultPermissions,
  };
}

function makeClient() {
  return {
    users: new Map([
      ["OWNER1", { username: "Owner" }],
      ["MOD1", { username: "Moderator" }],
    ]),
    channels: new Map(),
    events: new EventEmitter(),
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("snapshot diffs report detailed permission and actor-honest changes", () => {
  const before = {
    server: {
      name: "Before",
      defaultPermissions: 0,
      systemMessages: {},
      categories: [
        { id: "CAT1", title: "Before category", channels: [GENERAL_ID] },
      ],
    },
    channels: {
      [GENERAL_ID]: {
        id: GENERAL_ID,
        name: "general",
        type: "TextChannel",
        defaultPermissions: { a: 0, d: 0 },
        rolePermissions: {},
      },
    },
    roles: {},
    emojis: {},
    invites: {},
    webhooks: {},
    webhookScannedChannels: [],
  };
  const after = structuredClone(before);
  after.server.name = "After";
  after.server.defaultPermissions = 2;
  after.server.categories[0] = {
    id: "CAT1",
    title: "After category",
    channels: [],
  };
  after.channels[GENERAL_ID].defaultPermissions.a = 2 ** 23;
  after.emojis.EMOJI1 = {
    name: "wave",
    creatorId: "MOD1",
    animated: false,
    nsfw: false,
  };

  const changes = diffSettingsSnapshots(before, after);
  assert.ok(
    changes.some((change) => change.title === "⚙️ Server Settings Updated")
  );
  assert.ok(
    changes.some((change) =>
      change.lines.some((line) => line.includes("ManageMessages"))
    )
  );
  assert.ok(
    changes.some((change) =>
      change.lines.some((line) => line.includes("Category renamed"))
    )
  );
  const emoji = changes.find((change) => change.title === "😀 Emoji Created");
  assert.equal(emoji.actorId, "MOD1");
  assert.equal(emoji.actorSource, "Stoat emoji creator");
});

test("reconciliation seeds silently, detects offline changes, and redacts secrets", async () => {
  store.enableAuditLog(SERVER_ID, LOG_CHANNEL_ID);
  let server = makeServer();
  let invites = [];
  let emojis = [];
  const webhooks = new Map([
    [
      GENERAL_ID,
      [
        {
          id: "EXISTINGWEBHOOK",
          name: "Existing hook",
          channel_id: GENERAL_ID,
          permissions: 0,
          token: "EXISTINGSECRETTOKEN",
        },
      ],
    ],
    [LOG_CHANNEL_ID, []],
  ]);
  const embeds = [];
  const request = async (_method, path) => {
    if (path.startsWith(`/servers/${SERVER_ID}?`)) {
      return { ok: true, status: 200, data: structuredClone(server) };
    }
    if (path === `/servers/${SERVER_ID}/emojis`) {
      return { ok: true, status: 200, data: structuredClone(emojis) };
    }
    if (path === `/servers/${SERVER_ID}/invites`) {
      return { ok: true, status: 200, data: structuredClone(invites) };
    }
    const webhookMatch = path.match(/^\/channels\/([^/]+)\/webhooks$/);
    if (webhookMatch) {
      return {
        ok: true,
        status: 200,
        data: structuredClone(webhooks.get(webhookMatch[1]) ?? []),
      };
    }
    return { ok: false, status: 404 };
  };
  const monitor = createSettingsMonitor(makeClient(), {
    request,
    emit: (_serverId, embed) => embeds.push(embed),
    logger: { log() {}, warn() {}, error() {} },
    scheduleTimeout(callback) {
      queueMicrotask(callback);
      return { unref() {} };
    },
  });

  const seeded = await monitor.reconcileServer(SERVER_ID);
  assert.equal(seeded.seeded, true);
  assert.equal(embeds.length, 0);

  server = makeServer({
    name: "After",
    defaultPermissions: 2,
    rolePermissions: { a: 2 ** 23, d: 0 },
  });
  invites = [
    {
      type: "Server",
      _id: "SECRETINVITECODE",
      server: SERVER_ID,
      creator: "MOD1",
      channel: GENERAL_ID,
    },
  ];
  await monitor.reconcileServer(SERVER_ID);

  const serverEmbed = embeds.find(
    (embed) => embed.title === "⚙️ Server Settings Updated"
  );
  assert.match(serverEmbed.description, /Actor:\*\* Unavailable/);
  assert.match(serverEmbed.description, /Found during reconciliation/);
  const inviteEmbed = embeds.find(
    (embed) => embed.title === "✉️ Server Invite Created"
  );
  assert.match(inviteEmbed.description, /Verified actor:\*\* @Moderator/);
  assert.doesNotMatch(inviteEmbed.description, /SECRETINVITECODE/);

  const persisted = readFileSync(
    join(dataDir, "server_settings_snapshots.json"),
    "utf-8"
  );
  assert.doesNotMatch(persisted, /SECRETINVITECODE/);

  server = makeServer({ name: "Live gateway change" });
  monitor.handleRawEvent({ type: "ServerUpdate", id: SERVER_ID });
  await waitFor(() =>
    embeds.some(
      (embed) =>
        embed.title === "⚙️ Server Settings Updated" &&
        embed.description.includes("Live gateway change")
    )
  );
  const liveEmbed = embeds.find((embed) =>
    embed.description.includes("Live gateway change")
  );
  assert.doesNotMatch(liveEmbed.description, /Found during reconciliation/);

  webhooks.set(GENERAL_ID, [
    {
      id: "EXISTINGWEBHOOK",
      name: "Existing hook",
      channel_id: GENERAL_ID,
      permissions: 0,
      token: "EXISTINGSECRETTOKEN",
    },
    {
      id: "WEBHOOK1",
      name: "Deploy hook",
      channel_id: GENERAL_ID,
      creator_id: "MOD1",
      permissions: 2 ** 22,
      token: "SECRETWEBHOOKTOKEN",
    },
  ]);
  await monitor.reconcileServer(SERVER_ID);
  const webhookEmbed = embeds.find(
    (embed) => embed.title === "🪝 Webhook Created"
  );
  assert.match(webhookEmbed.description, /Verified actor:\*\* @Moderator/);
  assert.doesNotMatch(webhookEmbed.description, /SECRETWEBHOOKTOKEN/);
  assert.doesNotMatch(
    readFileSync(join(dataDir, "server_settings_snapshots.json"), "utf-8"),
    /SECRETWEBHOOKTOKEN|EXISTINGSECRETTOKEN/
  );
});

test("failed reconciliation preserves the last good snapshot", async () => {
  const serverId = "SERVERFAILURE1";
  store.enableAuditLog(serverId, LOG_CHANNEL_ID);
  store.setServerSettingsSnapshot(serverId, {
    version: 1,
    capturedAt: 123,
    server: { id: serverId, name: "Known" },
    channels: {},
    roles: {},
    emojis: {},
    invites: {},
    webhooks: {},
    webhookScannedChannels: [],
    webhookCursor: 0,
  });
  const monitor = createSettingsMonitor(makeClient(), {
    request: async () => ({ ok: false, status: 503 }),
    emit() {},
    logger: { log() {}, warn() {}, error() {} },
  });

  const result = await monitor.reconcileServer(serverId);
  assert.equal(result.failed, true);
  assert.equal(store.getServerSettingsSnapshot(serverId).server.name, "Known");
});

test("disabling audit monitoring removes its settings baseline", async () => {
  const serverId = "SERVERDISABLED1";
  store.enableAuditLog(serverId, LOG_CHANNEL_ID);
  store.setServerSettingsSnapshot(serverId, {
    version: 1,
    server: { id: serverId },
  });
  const monitor = createSettingsMonitor(makeClient(), {
    request: async () => ({ ok: false, status: 503 }),
    emit() {},
  });
  store.disableAuditLog(serverId);
  await monitor.configurationChanged(serverId);
  assert.equal(store.getServerSettingsSnapshot(serverId), null);
});
