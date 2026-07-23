import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_CHALLENGE_TTL_MS,
  createEnkaApprovalGate,
  ENKA_APPROVER_USER_ID,
} from "../approval-gate.js";
import { createAuditLogConfiguration } from "../audit-log-configuration.js";

const SERVER_ID = "01AAAAAAAAAAAAAAAAAAAAAAAA";
const SOURCE_ID = "01BBBBBBBBBBBBBBBBBBBBBBBB";
const TARGET_ID = "01CCCCCCCCCCCCCCCCCCCCCCCC";
const OTHER_ID = "01DDDDDDDDDDDDDDDDDDDDDDDD";
const DM_ID = "01EEEEEEEEEEEEEEEEEEEEEEEE";
const MOD_ID = "01FFFFFFFFFFFFFFFFFFFFFFFF";
const OTHER_USER_ID = "01GGGGGGGGGGGGGGGGGGGGGGGG";

function makeHarness({
  initialChannelId = null,
  dmFails = false,
  dmOpenThrows = false,
  clock = 1_800_000_000_000,
} = {}) {
  let current = clock;
  let auditChannelId = initialChannelId;
  let configurationChanges = 0;
  let targetCanSend = true;
  const responses = [];
  const protectedLogs = [];
  const dmPayloads = [];
  const requests = [];
  const channels = new Map([
    [
      SOURCE_ID,
      {
        id: SOURCE_ID,
        serverId: SERVER_ID,
        type: "TextChannel",
        name: "operations",
        havePermission: (permission) => permission === "SendMessage",
      },
    ],
    [
      TARGET_ID,
      {
        id: TARGET_ID,
        serverId: SERVER_ID,
        type: "TextChannel",
        name: "audit-new",
        havePermission: (permission) =>
          permission === "SendMessage" && targetCanSend,
      },
    ],
    [
      OTHER_ID,
      {
        id: OTHER_ID,
        serverId: "01HHHHHHHHHHHHHHHHHHHHHHHH",
        type: "TextChannel",
        name: "elsewhere",
        havePermission: () => true,
      },
    ],
  ]);
  const client = {
    channels,
    users: new Map([
      [ENKA_APPROVER_USER_ID, { username: "Enka" }],
      [MOD_ID, { username: "moderator" }],
    ]),
    servers: new Map([[SERVER_ID, { name: "Test Server" }]]),
  };
  let nextMessage = 0;
  const request = async (method, path, body) => {
    requests.push({ method, path });
    if (method === "GET" && path === `/users/${ENKA_APPROVER_USER_ID}/dm`) {
      if (dmOpenThrows) throw new Error("DM unavailable");
      return { ok: true, data: { _id: DM_ID } };
    }
    if (method === "POST" && path === `/channels/${DM_ID}/messages`) {
      dmPayloads.push(body);
      return dmFails
        ? { ok: false, status: 403 }
        : { ok: true, data: { _id: `DMMESSAGE${++nextMessage}` } };
    }
    return { ok: false, status: 404 };
  };
  const gate = createEnkaApprovalGate(client, {
    request,
    now: () => current,
    codeFactory: () => "123456",
    scheduleTimeout: () => ({ unref() {} }),
    logger: { log() {}, warn() {} },
  });
  const store = {
    getAuditLogChannel: () => auditChannelId,
    enableAuditLog(_serverId, channelId) {
      const previousChannelId = auditChannelId;
      const wasEnabled = Boolean(previousChannelId);
      auditChannelId = channelId;
      return {
        changed: previousChannelId !== channelId,
        wasEnabled,
        previousChannelId,
        channelId,
      };
    },
    disableAuditLog() {
      const previousChannelId = auditChannelId;
      auditChannelId = null;
      return { changed: Boolean(previousChannelId), previousChannelId };
    },
  };
  const coordinator = createAuditLogConfiguration(client, {
    send: async (channelId, payload) => {
      responses.push({ channelId, payload });
      return { _id: `RESPONSE${++nextMessage}` };
    },
    sendProtected: async (channelId, payload) => {
      protectedLogs.push({ channelId, payload });
      return { _id: `PROTECTED${++nextMessage}` };
    },
    approvalGate: gate,
    store,
    requestIdFactory: () => "AL123456",
    configurationChanged: async () => {
      configurationChanges += 1;
    },
    logger: { log() {}, warn() {} },
  });

  return {
    coordinator,
    gate,
    responses,
    protectedLogs,
    dmPayloads,
    requests,
    get auditChannelId() {
      return auditChannelId;
    },
    setAuditChannel(channelId) {
      auditChannelId = channelId;
    },
    get configurationChanges() {
      return configurationChanges;
    },
    setTargetCanSend(value) {
      targetCanSend = value;
    },
    advance(ms) {
      current += ms;
    },
  };
}

function serverMessage(authorId = MOD_ID, channelId = SOURCE_ID) {
  return {
    authorId,
    channelId,
    channel: { id: channelId, serverId: SERVER_ID },
    server: { id: SERVER_ID },
  };
}

function directMessage(authorId, content) {
  return {
    authorId,
    channelId: DM_ID,
    channel: { id: DM_ID },
    content,
  };
}

test("canonical enable waits for relayed Enka approval", async () => {
  const harness = makeHarness();
  const requested = await harness.coordinator.handleCommand(serverMessage(), [
    TARGET_ID,
  ]);
  assert.equal(requested.outcome, "requested");
  assert.equal(harness.auditChannelId, null);
  assert.equal(harness.configurationChanges, 0);

  const approved = await harness.coordinator.handleCommand(serverMessage(), [
    "confirm",
    "123456",
  ]);
  assert.equal(approved.outcome, "enabled");
  assert.equal(harness.auditChannelId, TARGET_ID);
  assert.equal(harness.configurationChanges, 1);
  assert.ok(
    harness.protectedLogs.some(
      ({ channelId, payload }) =>
        channelId === TARGET_ID &&
        payload.embeds?.[0]?.title === "✅ Audit Log Enabled"
    )
  );
});

test("legacy enable and disable aliases use fresh challenges", async () => {
  const harness = makeHarness();
  assert.equal(
    (await harness.coordinator.handleLegacyEnable(serverMessage())).outcome,
    "requested"
  );
  assert.equal(harness.auditChannelId, null);
  await harness.gate.handleDirectMessage(
    directMessage(ENKA_APPROVER_USER_ID, "approve 123456")
  );
  assert.equal(harness.auditChannelId, SOURCE_ID);

  assert.equal(
    (await harness.coordinator.handleLegacyDisable(serverMessage())).outcome,
    "requested"
  );
  assert.equal(harness.auditChannelId, SOURCE_ID);
  await harness.gate.handleDirectMessage(
    directMessage(ENKA_APPROVER_USER_ID, "123456")
  );
  assert.equal(harness.auditChannelId, null);
  assert.equal(harness.configurationChanges, 2);
});

test("moving and disabling preserve the old destination until approval", async () => {
  const harness = makeHarness({ initialChannelId: SOURCE_ID });
  await harness.coordinator.handleCommand(serverMessage(), [TARGET_ID]);
  assert.equal(harness.auditChannelId, SOURCE_ID);
  assert.ok(
    harness.protectedLogs.some(
      ({ channelId, payload }) =>
        channelId === SOURCE_ID &&
        payload.embeds?.[0]?.title === "🔐 Audit Log Change Requested"
    )
  );
  await harness.coordinator.handleCommand(serverMessage(), [
    "confirm",
    "123456",
  ]);
  assert.equal(harness.auditChannelId, TARGET_ID);

  await harness.coordinator.handleCommand(serverMessage(), ["off"]);
  assert.equal(harness.auditChannelId, TARGET_ID);
  await harness.coordinator.handleCommand(serverMessage(), [
    "confirm",
    "123456",
  ]);
  assert.equal(harness.auditChannelId, null);
  assert.ok(
    harness.protectedLogs.some(
      ({ channelId, payload }) =>
        channelId === TARGET_ID &&
        payload.embeds?.[0]?.title === "🔕 Audit Log Disable Approved"
    )
  );
});

test("status and no-op mutations do not generate approval codes", async () => {
  const harness = makeHarness({ initialChannelId: SOURCE_ID });
  assert.equal(
    (await harness.coordinator.handleCommand(serverMessage(), ["status"]))
      .outcome,
    "status"
  );
  assert.equal(
    (await harness.coordinator.handleCommand(serverMessage(), ["here"]))
      .outcome,
    "no_change"
  );
  assert.equal(harness.dmPayloads.length, 0);

  const disabled = makeHarness();
  assert.equal(
    (await disabled.coordinator.handleCommand(serverMessage(), ["off"]))
      .outcome,
    "no_change"
  );
  assert.equal(disabled.dmPayloads.length, 0);
});

test("only Enka DMs can approve or deny an audit change", async () => {
  const harness = makeHarness();
  await harness.coordinator.handleCommand(serverMessage(), [TARGET_ID]);
  assert.equal(
    await harness.gate.handleDirectMessage(
      directMessage(OTHER_USER_ID, "123456")
    ),
    false
  );
  assert.equal(harness.auditChannelId, null);
  assert.ok(harness.coordinator.getPending(SERVER_ID));

  assert.equal(
    await harness.gate.handleDirectMessage(
      directMessage(ENKA_APPROVER_USER_ID, "deny 123456")
    ),
    true
  );
  assert.equal(harness.auditChannelId, null);
  assert.equal(harness.coordinator.getPending(SERVER_ID), null);
});

test("failed Enka DM opening or delivery leaves configuration unchanged", async () => {
  for (const options of [{ dmFails: true }, { dmOpenThrows: true }]) {
    const harness = makeHarness({
      initialChannelId: SOURCE_ID,
      ...options,
    });
    const result = await harness.coordinator.handleCommand(serverMessage(), [
      "off",
    ]);
    assert.equal(result.outcome, "dm_failed");
    assert.equal(harness.auditChannelId, SOURCE_ID);
    assert.equal(harness.coordinator.getPending(SERVER_ID), null);
  }
});

test("wrong and expired codes cannot change audit configuration", async () => {
  const harness = makeHarness();
  await harness.coordinator.handleCommand(serverMessage(), [TARGET_ID]);
  for (const code of ["000000", "000001"]) {
    assert.equal(
      (
        await harness.coordinator.handleCommand(serverMessage(), [
          "confirm",
          code,
        ])
      ).outcome,
      "wrong_code"
    );
  }
  assert.equal(
    (
      await harness.coordinator.handleCommand(serverMessage(), [
        "confirm",
        "000002",
      ])
    ).outcome,
    "attempts_exhausted"
  );
  assert.equal(harness.auditChannelId, null);

  await harness.coordinator.handleCommand(serverMessage(), [TARGET_ID]);
  harness.advance(APPROVAL_CHALLENGE_TTL_MS + 1);
  assert.equal(
    (
      await harness.coordinator.handleCommand(serverMessage(), [
        "confirm",
        "123456",
      ])
    ).outcome,
    "no_pending"
  );
  assert.equal(harness.auditChannelId, null);
});

test("only the requester or Enka can cancel an audit request", async () => {
  const harness = makeHarness();
  await harness.coordinator.handleCommand(serverMessage(), [TARGET_ID]);
  assert.equal(
    (
      await harness.coordinator.handleCommand(serverMessage(OTHER_USER_ID), [
        "cancel",
      ])
    ).outcome,
    "not_requester"
  );
  assert.ok(harness.coordinator.getPending(SERVER_ID));
  assert.equal(
    (
      await harness.coordinator.handleCommand(
        serverMessage(ENKA_APPROVER_USER_ID),
        ["cancel"]
      )
    ).outcome,
    "cancelled"
  );
  assert.equal(harness.auditChannelId, null);
});

test("approval revalidates the previous state and target permission", async () => {
  const staleState = makeHarness();
  await staleState.coordinator.handleCommand(serverMessage(), [TARGET_ID]);
  staleState.setAuditChannel(SOURCE_ID);
  assert.equal(
    (
      await staleState.coordinator.handleCommand(serverMessage(), [
        "confirm",
        "123456",
      ])
    ).outcome,
    "stale"
  );
  assert.equal(staleState.auditChannelId, SOURCE_ID);
  assert.equal(staleState.configurationChanges, 0);

  const staleTarget = makeHarness();
  await staleTarget.coordinator.handleCommand(serverMessage(), [TARGET_ID]);
  staleTarget.setTargetCanSend(false);
  assert.equal(
    (
      await staleTarget.coordinator.handleCommand(serverMessage(), [
        "confirm",
        "123456",
      ])
    ).outcome,
    "stale"
  );
  assert.equal(staleTarget.auditChannelId, null);
});

test("one shared gate rejects conflicting protected actions per server", async () => {
  const harness = makeHarness();
  await harness.gate.requestChallenge({
    kind: "channel_exclusion",
    requestId: "CE123456",
    serverId: SERVER_ID,
    requestedBy: MOD_ID,
    requestChannelId: SOURCE_ID,
    data: {},
    buildDmPayload: () => ({ content: "privacy request" }),
    onApproved: async () => ({ outcome: "excluded" }),
  });
  const result = await harness.coordinator.handleCommand(serverMessage(), [
    TARGET_ID,
  ]);
  assert.equal(result.outcome, "pending_exists");
  assert.equal(harness.auditChannelId, null);
});

test("default DM lookup is pinned to Enka and never uses bot-owner lookup", async () => {
  const harness = makeHarness();
  await harness.coordinator.handleCommand(serverMessage(), [TARGET_ID]);
  assert.ok(
    harness.requests.some(
      ({ method, path }) =>
        method === "GET" && path === `/users/${ENKA_APPROVER_USER_ID}/dm`
    )
  );
  assert.equal(
    harness.requests.some(({ path }) => path === "/users/@me"),
    false
  );
});
