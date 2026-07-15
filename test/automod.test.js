import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOYOFETCH_DATA_DIR = mkdtempSync(
  join(tmpdir(), "hoyofetch-automod-test-")
);

const {
  AntiRaidDetector,
  AUTOMOD_BAN_EMOJI,
  AUTOMOD_LIMITS,
  buildEvidenceExcerpt,
  createAutomod,
  normalizeAutomodContent,
} = await import("../automod.js");

const SERVER_ID = "SERVER123";
const CHANNEL_ID = "CHANNEL123";
const TARGET_ID = "TARGET123";
const BOT_ID = "BOT123";
const VOTER_ONE = "VOTER123";
const VOTER_TWO = "VOTER456";
const OWNER_ID = "OWNER123";
const BAN_BIT = 2 ** 7;

function makeMemoryStore({ mode = "off", quorum = 2 } = {}) {
  const configs = new Map([
    [SERVER_ID, { mode, logChannelId: CHANNEL_ID, quorum, updatedAt: null }],
  ]);
  const cases = new Map();
  return {
    configs,
    cases,
    getAutomodConfig(serverId) {
      return (
        configs.get(serverId) ?? {
          mode: "off",
          logChannelId: null,
          quorum: 2,
          updatedAt: null,
        }
      );
    },
    setAutomodConfig(serverId, patch) {
      const previous = this.getAutomodConfig(serverId);
      const current = { ...previous, ...patch, updatedAt: "now" };
      configs.set(serverId, current);
      return { previous, current };
    },
    createAutomodCase(record) {
      cases.set(record.caseId, structuredClone(record));
      return structuredClone(record);
    },
    getAutomodCase(caseId) {
      const record = cases.get(caseId);
      return record ? structuredClone(record) : null;
    },
    updateAutomodCase(caseId, patch) {
      const record = cases.get(caseId);
      if (!record) return null;
      const updated = { ...record, ...structuredClone(patch) };
      cases.set(caseId, updated);
      return structuredClone(updated);
    },
    findAutomodCaseByPromptMessage(messageId) {
      const record = [...cases.values()].find(
        (entry) => entry.promptMessageId === messageId
      );
      return record ? structuredClone(record) : null;
    },
    findActiveAutomodCase(serverId, userId, now) {
      const record = [...cases.values()].find(
        (entry) =>
          entry.serverId === serverId &&
          entry.userId === userId &&
          entry.dedupeUntil > now
      );
      return record ? structuredClone(record) : null;
    },
    pruneAutomodCases(now) {
      for (const [caseId, record] of cases) {
        if (record.dedupeUntil <= now) cases.delete(caseId);
        else if (record.status === "pending" && record.expiresAt <= now) {
          cases.set(caseId, { ...record, status: "expired" });
        }
      }
    },
  };
}

function makeHarness({
  mode = "monitor",
  quorum = 2,
  failFreshFor = new Set(),
  deleteFails = false,
  timeoutFails = false,
} = {}) {
  let clock = 1_800_000_000_000;
  let promptCounter = 0;
  let evidenceCounter = 0;
  const store = makeMemoryStore({ mode, quorum });
  const requests = [];
  const prompts = [];
  const protectedLogs = [];
  const memberTimeouts = new Map();
  const memberRoles = new Map([
    [BOT_ID, ["ROLEBAN"]],
    [VOTER_ONE, ["ROLEBAN"]],
    [VOTER_TWO, ["ROLEBAN"]],
  ]);
  const serverObject = { id: SERVER_ID, ownerId: OWNER_ID };
  const channel = {
    id: CHANNEL_ID,
    serverId: SERVER_ID,
    server: serverObject,
    type: "TextChannel",
    havePermission: (permission) => permission === "SendMessage",
  };
  const client = {
    user: { id: BOT_ID },
    channels: new Map([[CHANNEL_ID, channel]]),
    api: {
      async get(path) {
        const memberMatch = path.match(
          /^\/servers\/SERVER123\/members\/([A-Za-z0-9]+)$/
        );
        if (memberMatch && failFreshFor.has(memberMatch[1])) {
          throw new Error("permission service unavailable");
        }
        if (path === `/servers/${SERVER_ID}`) {
          return {
            _id: SERVER_ID,
            owner: OWNER_ID,
            default_permissions: 0,
            roles: {
              ROLEBAN: {
                rank: 1,
                permissions: { a: BAN_BIT, d: 0 },
              },
            },
          };
        }
        if (memberMatch) {
          const userId = memberMatch[1];
          return {
            _id: { server: SERVER_ID, user: userId },
            joined_at: new Date(
              clock - 10 * 24 * 60 * 60 * 1_000
            ).toISOString(),
            roles: memberRoles.get(userId) ?? [],
            timeout: memberTimeouts.get(userId) ?? null,
          };
        }
        if (path === `/channels/${CHANNEL_ID}`) {
          return {
            _id: CHANNEL_ID,
            channel_type: "TextChannel",
            server: SERVER_ID,
            default_permissions: { a: 0, d: 0 },
            role_permissions: {},
          };
        }
        const userMatch = path.match(/^\/users\/([A-Za-z0-9]+)$/);
        if (userMatch) {
          return {
            _id: userMatch[1],
            ...(userMatch[1] === BOT_ID ? { bot: { owner: OWNER_ID } } : {}),
          };
        }
        throw new Error(`unexpected path ${path}`);
      },
    },
  };
  const request = async (method, path, body) => {
    requests.push({ method, path, body: structuredClone(body) });
    if (method === "PATCH" && path.includes(`/members/${TARGET_ID}`)) {
      if (timeoutFails) return { ok: false, status: 403 };
      memberTimeouts.set(TARGET_ID, body.timeout);
      return { ok: true, status: 200, data: {} };
    }
    if (method === "DELETE" && path.endsWith("/messages/bulk")) {
      return { ok: !deleteFails, status: deleteFails ? 403 : 204 };
    }
    return { ok: true, status: 200, data: {} };
  };
  const automod = createAutomod(client, {
    send: async (channelId, payload) => {
      prompts.push({ channelId, payload });
      promptCounter += 1;
      return { _id: `PROMPT${promptCounter}` };
    },
    sendProtected: async (channelId, payload) => {
      protectedLogs.push({ channelId, payload });
      evidenceCounter += 1;
      return { _id: `EVIDENCE${evidenceCounter}` };
    },
    request,
    store,
    now: () => clock,
    caseIdFactory: () => "AMCASE123",
    attach: false,
    logger: { log() {}, warn() {} },
  });

  function message({
    id,
    content,
    mentionIds = [],
    recent = false,
    userId = TARGET_ID,
  }) {
    return {
      id,
      content,
      mentionIds,
      authorId: userId,
      channelId: CHANNEL_ID,
      channel,
      server: serverObject,
      author: {
        createdAt: new Date(clock - (recent ? 1 : 10) * 24 * 60 * 60 * 1_000),
      },
      member: {
        joinedAt: new Date(clock - (recent ? 1 : 10) * 24 * 60 * 60 * 1_000),
      },
    };
  }

  async function sendDuplicates(prefix = "MSG") {
    for (let index = 0; index < 4; index += 1) {
      await automod.handleMessage(
        message({ id: `${prefix}${index}`, content: "same payload" })
      );
      clock += 1_000;
    }
  }

  return {
    automod,
    channel,
    client,
    get clock() {
      return clock;
    },
    set clock(value) {
      clock = value;
    },
    memberRoles,
    memberTimeouts,
    message,
    prompts,
    protectedLogs,
    requests,
    sendDuplicates,
    store,
  };
}

test("content normalization defeats whitespace, case, and zero-width drift", () => {
  assert.equal(
    normalizeAutomodContent("  SPAM\u200B   Payload  "),
    "spam payload"
  );
  assert.equal(
    buildEvidenceExcerpt("https://bad.example <@USER>"),
    "[url] <@​USER>"
  );
});

test("five rapid messages need a risk signal for an established member", () => {
  let now = 1_800_000_000_000;
  const established = new AntiRaidDetector({ now: () => now });
  let result;
  for (let index = 0; index < 5; index += 1) {
    result = established.recordMessage({
      serverId: SERVER_ID,
      userId: TARGET_ID,
      messageId: `EST${index}`,
      channelId: CHANNEL_ID,
      content: `unique ${index}`,
      accountCreatedAt: now - 10 * 24 * 60 * 60 * 1_000,
      joinedAt: now - 10 * 24 * 60 * 60 * 1_000,
    });
    now += 500;
  }
  assert.equal(result.signals.rapidBurst, true);
  assert.equal(result.score, 1);
  assert.equal(result.triggered, false);

  now = 1_800_000_000_000;
  const recent = new AntiRaidDetector({ now: () => now });
  for (let index = 0; index < 5; index += 1) {
    result = recent.recordMessage({
      serverId: SERVER_ID,
      userId: TARGET_ID,
      messageId: `NEW${index}`,
      channelId: CHANNEL_ID,
      content: `unique ${index}`,
      accountCreatedAt: now - 24 * 60 * 60 * 1_000,
      joinedAt: now - 24 * 60 * 60 * 1_000,
    });
    now += 500;
  }
  assert.equal(result.score, 2);
  assert.equal(result.triggered, true);
});

test("duplicate and mention floods independently reach the trigger threshold", () => {
  let now = 1_800_000_000_000;
  const detector = new AntiRaidDetector({ now: () => now });
  let duplicate;
  for (let index = 0; index < 4; index += 1) {
    duplicate = detector.recordMessage({
      serverId: SERVER_ID,
      userId: TARGET_ID,
      messageId: `DUP${index}`,
      channelId: CHANNEL_ID,
      content: index % 2 ? " SPAM  " : "spam",
      accountCreatedAt: now - 10 * AUTOMOD_LIMITS.recentAccountMs,
      joinedAt: now - 10 * AUTOMOD_LIMITS.recentMemberMs,
    });
    now += 1_000;
  }
  assert.equal(duplicate.signals.duplicateFlood, true);
  assert.equal(duplicate.triggered, true);

  const mentions = new AntiRaidDetector({ now: () => now });
  const mentionResult = mentions.recordMessage({
    serverId: SERVER_ID,
    userId: TARGET_ID,
    messageId: "MENTION1",
    channelId: CHANNEL_ID,
    content: "hello everyone",
    mentionIds: ["USER1", "USER2", "USER3", "USER4", "USER5"],
    accountCreatedAt: now - 10 * AUTOMOD_LIMITS.recentAccountMs,
    joinedAt: now - 10 * AUTOMOD_LIMITS.recentMemberMs,
  });
  assert.equal(mentionResult.signals.mentionFlood, true);
  assert.equal(mentionResult.triggered, true);
});

test("expired messages leave the sliding window", () => {
  let now = 1_800_000_000_000;
  const detector = new AntiRaidDetector({ now: () => now });
  for (let index = 0; index < 3; index += 1) {
    detector.recordMessage({
      serverId: SERVER_ID,
      userId: TARGET_ID,
      messageId: `OLD${index}`,
      channelId: CHANNEL_ID,
      content: "same",
    });
  }
  now += AUTOMOD_LIMITS.duplicateWindowMs + 1;
  const result = detector.recordMessage({
    serverId: SERVER_ID,
    userId: TARGET_ID,
    messageId: "NEW1",
    channelId: CHANNEL_ID,
    content: "same",
  });
  assert.equal(result.signals.duplicateCount, 1);
  assert.equal(result.triggered, false);
});

test("five joins activate raid weighting without punishing on join alone", () => {
  let now = 1_800_000_000_000;
  const detector = new AntiRaidDetector({ now: () => now });
  let join;
  for (let index = 0; index < 5; index += 1) {
    join = detector.recordJoin(SERVER_ID, `JOINER${index}`);
    now += 1_000;
  }
  assert.equal(join.raidActivated, true);
  const oneMessage = detector.recordMessage({
    serverId: SERVER_ID,
    userId: "JOINER4",
    messageId: "JOINMSG1",
    channelId: CHANNEL_ID,
    content: "hello",
  });
  assert.equal(oneMessage.signals.joinedDuringRaid, true);
  assert.equal(oneMessage.triggered, false);
});

test("monitor mode records a protected case without member mutations", async () => {
  const harness = makeHarness({ mode: "monitor" });
  await harness.sendDuplicates();
  assert.equal(harness.protectedLogs.length, 1);
  assert.match(
    harness.protectedLogs[0].payload.embeds[0].description,
    /monitor only/
  );
  assert.equal(
    harness.requests.some((entry) => entry.method === "PATCH"),
    false
  );
  assert.equal(harness.prompts.length, 0);
  assert.equal(harness.store.cases.size, 0);
});

test("enforcement times out first, cleans messages, and opens one vote", async () => {
  const harness = makeHarness({ mode: "enforce" });
  await harness.sendDuplicates();
  assert.equal(harness.requests[0].method, "PATCH");
  assert.equal(harness.requests[1].method, "DELETE");
  assert.equal(harness.requests[2].method, "PUT");
  assert.match(harness.requests[2].path, /reactions/);
  assert.equal(harness.protectedLogs.length, 1);
  assert.equal(harness.prompts.length, 1);
  assert.equal(harness.store.getAutomodCase("AMCASE123").status, "pending");
});

test("cleanup failure does not undo containment or escalate to a ban", async () => {
  const harness = makeHarness({ mode: "enforce", deleteFails: true });
  await harness.sendDuplicates();
  assert.ok(harness.memberTimeouts.get(TARGET_ID));
  assert.match(
    harness.protectedLogs[0].payload.embeds[0].description,
    /1 channel operation\(s\) failed/
  );
  assert.equal(
    harness.requests.some((entry) => entry.path.includes("/bans/")),
    false
  );
});

test("timeout permission failure is logged and does not open a ban vote", async () => {
  const harness = makeHarness({ mode: "enforce", timeoutFails: true });
  await harness.sendDuplicates();
  assert.equal(harness.prompts.length, 0);
  assert.match(
    harness.protectedLogs[0].payload.embeds[0].description,
    /Timeout:\*\* failed or skipped/
  );
  assert.equal(
    harness.requests.some((entry) => entry.path.includes("/bans/")),
    false
  );
});

test("permission refresh failures downgrade enforcement to monitor-only", async () => {
  const harness = makeHarness({
    mode: "enforce",
    failFreshFor: new Set([TARGET_ID]),
  });
  await harness.sendDuplicates();
  assert.equal(
    harness.requests.some((entry) => entry.method === "PATCH"),
    false
  );
  assert.equal(harness.prompts.length, 0);
  assert.match(
    harness.protectedLogs[0].payload.embeds[0].description,
    /enforcement suppressed/
  );
});

test("verified moderation staff are exempt from cases", async () => {
  const harness = makeHarness({ mode: "enforce" });
  harness.memberRoles.set(TARGET_ID, ["ROLEBAN"]);
  await harness.sendDuplicates();
  assert.equal(harness.protectedLogs.length, 0);
  assert.equal(harness.requests.length, 0);
});

test("repeated activity extends containment without creating vote spam", async () => {
  const harness = makeHarness({ mode: "enforce" });
  await harness.sendDuplicates("FIRST");
  const firstTimeout = harness.memberTimeouts.get(TARGET_ID);
  harness.clock += 60_000;
  await harness.sendDuplicates("SECOND");
  const patches = harness.requests.filter((entry) => entry.method === "PATCH");
  assert.equal(patches.length, 2);
  assert.ok(
    new Date(harness.memberTimeouts.get(TARGET_ID)) > new Date(firstTimeout)
  );
  assert.equal(harness.prompts.length, 1);
  assert.equal(harness.store.cases.size, 1);
});

test("two fresh authorized approvals ban exactly once", async () => {
  const harness = makeHarness({ mode: "enforce", quorum: 2 });
  await harness.sendDuplicates();

  const first = await harness.automod.approveCase("AMCASE123", VOTER_ONE);
  assert.equal(first.outcome, "approved");
  assert.equal(
    harness.requests.filter((entry) => entry.path.includes("/bans/")).length,
    0
  );

  const unauthorized = await harness.automod.approveCase(
    "AMCASE123",
    "MEMBER123"
  );
  assert.equal(unauthorized.outcome, "unauthorized");

  const second = await harness.automod.approveCase("AMCASE123", VOTER_TWO);
  assert.equal(second.outcome, "banned");
  const bans = harness.requests.filter((entry) =>
    entry.path.includes("/bans/")
  );
  assert.equal(bans.length, 1);
  assert.match(bans[0].body.reason, /AMCASE123/);

  const duplicate = await harness.automod.approveCase("AMCASE123", VOTER_TWO);
  assert.equal(duplicate.outcome, "banned");
  assert.equal(
    harness.requests.filter((entry) => entry.path.includes("/bans/")).length,
    1
  );
});

test("quorum does not ban when the bot loses Ban Members permission", async () => {
  const harness = makeHarness({ mode: "enforce", quorum: 1 });
  await harness.sendDuplicates();
  harness.memberRoles.delete(BOT_ID);
  const result = await harness.automod.approveCase("AMCASE123", VOTER_ONE);
  assert.equal(result.outcome, "bot_cannot_ban");
  assert.equal(
    harness.requests.filter((entry) => entry.path.includes("/bans/")).length,
    0
  );
  assert.match(
    harness.protectedLogs.at(-1).payload.embeds[0].description,
    /does not currently have verified/
  );
});

test("self-votes and expired approvals cannot ban", async () => {
  const harness = makeHarness({ mode: "enforce", quorum: 1 });
  await harness.sendDuplicates();
  assert.equal(
    (await harness.automod.approveCase("AMCASE123", TARGET_ID)).outcome,
    "self_vote"
  );
  harness.clock += AUTOMOD_LIMITS.approvalWindowMs + 1;
  assert.equal(
    (await harness.automod.approveCase("AMCASE123", VOTER_ONE)).outcome,
    "expired"
  );
  assert.equal(
    harness.requests.filter((entry) => entry.path.includes("/bans/")).length,
    0
  );
});

test("raw hammer reactions use the persisted prompt mapping", async () => {
  const harness = makeHarness({ mode: "enforce", quorum: 1 });
  await harness.sendDuplicates();
  await harness.automod.handleRawEvent({
    type: "MessageReact",
    id: "PROMPT1",
    user_id: VOTER_ONE,
    emoji_id: AUTOMOD_BAN_EMOJI,
  });
  assert.equal(harness.store.getAutomodCase("AMCASE123").status, "banned");
});

test("configuration commands are opt-in and keep case quorum snapshots", async () => {
  const harness = makeHarness({ mode: "off" });
  const commandMessage = {
    server: { id: SERVER_ID },
    channelId: CHANNEL_ID,
    authorId: OWNER_ID,
  };
  const monitor = await harness.automod.handleCommand(commandMessage, [
    "monitor",
    "here",
  ]);
  assert.match(monitor.title, /Monitor Mode Enabled/);
  assert.equal(harness.store.getAutomodConfig(SERVER_ID).mode, "monitor");
  const quorum = await harness.automod.handleCommand(commandMessage, [
    "quorum",
    "1",
  ]);
  assert.match(quorum.title, /Quorum Updated/);
  assert.equal(harness.store.getAutomodConfig(SERVER_ID).quorum, 1);
  const off = await harness.automod.handleCommand(commandMessage, ["off"]);
  assert.match(off.title, /Disabled/);
  assert.equal(harness.store.getAutomodConfig(SERVER_ID).mode, "off");
});

test("join surge posts one protected warning and performs no moderation", async () => {
  const harness = makeHarness({ mode: "monitor" });
  for (let index = 0; index < 5; index += 1) {
    await harness.automod.handleMemberJoin({
      id: { server: SERVER_ID, user: `JOINER${index}` },
      user: {},
    });
    harness.clock += 1_000;
  }
  assert.equal(harness.protectedLogs.length, 1);
  assert.match(
    harness.protectedLogs[0].payload.embeds[0].description,
    /No member was punished/
  );
  assert.equal(harness.requests.length, 0);
});
