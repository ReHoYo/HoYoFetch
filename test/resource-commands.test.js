import test from "node:test";
import assert from "node:assert/strict";
import { createAuditLogCommand } from "../audit-log-command.js";
import { createAutoFetchCommand } from "../auto-fetch-command.js";
import { createEmojiCommand } from "../emoji-command.js";

function message(serverId = "SERVER1", channelId = "CHANNEL1") {
  return {
    channelId,
    channel: { id: channelId, serverId },
    server: { id: serverId, name: "Test Server" },
  };
}

test("Auto-Fetch status, enable, update, and off share one resource controller", async () => {
  const records = new Map();
  const sent = [];
  const store = {
    isChannelEnabled: (id) => records.get(id)?.enabled === true,
    getChannelScope: (id) => records.get(id)?.scope ?? "all",
    enableChannel(id, scope) {
      const previous = records.get(id);
      records.set(id, { enabled: true, scope });
      return {
        wasEnabled: previous?.enabled === true,
        previousScope: previous?.scope ?? "all",
        currentScope: scope,
        changed: previous?.enabled !== true || previous?.scope !== scope,
      };
    },
    disableChannel(id) {
      records.set(id, { ...records.get(id), enabled: false });
    },
  };
  const controller = createAutoFetchCommand({
    sendProtected: async (_channel, payload) => sent.push(payload),
    store,
  });

  assert.equal(
    (await controller.handleCommand(message(), ["status"])).enabled,
    false
  );
  assert.equal(
    (await controller.handleCommand(message(), ["enable", "hoyo"])).outcome,
    "enabled"
  );
  assert.equal(records.get("CHANNEL1").scope, "hoyo");
  assert.equal(
    (await controller.handleCommand(message(), ["enable", "hoyo"])).outcome,
    "no_change"
  );
  assert.equal(
    (await controller.handleCommand(message(), ["off"])).outcome,
    "disabled"
  );
  assert.match(sent.at(-1).embeds[0].title, /Disabled/);
});

test("Auto-Fetch rejects legacy-shaped and extra arguments without mutation", async () => {
  let mutations = 0;
  const controller = createAutoFetchCommand({
    sendProtected: async () => {},
    store: {
      isChannelEnabled: () => false,
      getChannelScope: () => "all",
      enableChannel: () => {
        mutations += 1;
      },
      disableChannel: () => {
        mutations += 1;
      },
    },
  });
  assert.equal(
    (await controller.handleCommand(message(), ["hoyo"])).outcome,
    "invalid_command"
  );
  assert.equal(
    (await controller.handleCommand(message(), ["enable", "hoyo", "extra"]))
      .outcome,
    "invalid_scope"
  );
  assert.equal(mutations, 0);
});

test("Emoji combines status and mode while provisioning remains hub-only", async () => {
  let mode = "unicode";
  let provisionCalls = 0;
  const sent = [];
  const controller = createEmojiCommand({
    client: {},
    send: async (_channel, payload) => sent.push(payload),
    emojiHubServerId: "HUB1",
    manifestLength: 3,
    getEmojiMode: () => mode,
    setEmojiMode(value) {
      if (value !== "unicode" && value !== "custom") return false;
      mode = value;
      return true;
    },
    getRegistry: () => ({ one: ":ID:" }),
    provision: async () => {
      provisionCalls += 1;
      return {
        ok: true,
        created: [],
        reused: [],
        skipped: [],
        failed: [],
        capacity: { used: 1, limit: 100 },
      };
    },
  });

  assert.equal(
    (await controller.handleCommand(message(), ["mode", "custom"])).mode,
    "custom"
  );
  assert.equal(
    (await controller.handleCommand(message(), ["provision"])).outcome,
    "status"
  );
  assert.equal(provisionCalls, 0);
  assert.equal(
    (await controller.handleCommand(message("HUB1"), ["provision"])).outcome,
    "provisioned"
  );
  assert.equal(provisionCalls, 1);
  assert.match(sent.at(-1).embeds[0].title, /Complete/);
});

test("AuditLog facade routes privacy and pending privacy confirmations", async () => {
  const calls = [];
  let privacyPending = false;
  const auditLogConfiguration = {
    handleCommand: async (_message, args) => {
      calls.push(["audit", args]);
      return { outcome: "audit" };
    },
  };
  const channelExclusion = {
    getPending: () => (privacyPending ? { kind: "channel_exclusion" } : null),
    handleCommand: async (_message, args) => {
      calls.push(["privacy", args]);
      return { outcome: "privacy" };
    },
  };
  const controller = createAuditLogCommand({
    auditLogConfiguration,
    channelExclusion,
  });

  await controller.handleCommand(message(), ["privacy", "status"]);
  privacyPending = true;
  await controller.handleCommand(message(), ["confirm", "123456"]);
  privacyPending = false;
  await controller.handleCommand(message(), ["confirm", "123456"]);
  assert.deepEqual(calls, [
    ["privacy", ["status"]],
    ["privacy", ["confirm", "123456"]],
    ["audit", ["confirm", "123456"]],
  ]);
});
