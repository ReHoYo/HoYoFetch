import test from "node:test";
import assert from "node:assert/strict";
import {
  createSpamReporter,
  createSpamReportId,
  isSpamReportInvocation,
  parseSpamReportCommand,
  sanitizeSpamReportReason,
  SPAM_REPORT_ATTEMPT_COOLDOWN_MS,
} from "../spam-report.js";

const SERVER_ID = "SERVER123";
const CHANNEL_ID = "CHANNEL123";
const AUDIT_CHANNEL_ID = "AUDIT123";
const BOT_ID = "BOT123";
const OWNER_ID = "OWNER123";
const REPORTER_ONE = "REPORTER123";
const REPORTER_TWO = "REPORTER456";
const REPORTER_THREE = "REPORTER789";
const TARGET_ONE = "TARGET123";
const TARGET_TWO = "TARGET456";
const TARGET_THREE = "TARGET789";
const TARGET_FOUR = "TARGET999";
const MANAGE_MESSAGES_BIT = 2 ** 23;

function makeMemoryStore({ audit = true } = {}) {
  const reports = [];
  return {
    reports,
    getAuditLogChannel() {
      return audit ? AUDIT_CHANNEL_ID : null;
    },
    pruneSpamReports() {},
    getRecentSpamReports(serverId, since) {
      return reports
        .filter(
          (record) => record.serverId === serverId && record.createdAt >= since
        )
        .map((record) => structuredClone(record));
    },
    findRecentSpamReport(serverId, reporterId, targetId, since) {
      const record = reports.find(
        (entry) =>
          entry.serverId === serverId &&
          entry.reporterId === reporterId &&
          entry.targetId === targetId &&
          entry.createdAt >= since
      );
      return record ? structuredClone(record) : null;
    },
    createSpamReport(record) {
      reports.push(structuredClone(record));
      return structuredClone(record);
    },
  };
}

function makeHarness({
  audit = true,
  deleteFails = false,
  protectedFails = false,
  permissionBits = MANAGE_MESSAGES_BIT,
  missingMembers = new Set(),
} = {}) {
  let clock = 2_000_000_000_000;
  let reportCounter = 0;
  const store = makeMemoryStore({ audit });
  const requests = [];
  const sent = [];
  const protectedLogs = [];
  const knownUsers = new Set([
    BOT_ID,
    OWNER_ID,
    REPORTER_ONE,
    REPORTER_TWO,
    REPORTER_THREE,
    TARGET_ONE,
    TARGET_TWO,
    TARGET_THREE,
    TARGET_FOUR,
  ]);
  const client = {
    user: { id: BOT_ID },
    api: {
      async get(path) {
        if (path === `/servers/${SERVER_ID}`) {
          return {
            _id: SERVER_ID,
            owner: OWNER_ID,
            default_permissions: permissionBits,
            roles: {},
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
        const memberMatch = path.match(
          /^\/servers\/SERVER123\/members\/([A-Za-z0-9]+)$/
        );
        if (memberMatch) {
          const userId = memberMatch[1];
          if (!knownUsers.has(userId) || missingMembers.has(userId)) {
            throw new Error("member missing");
          }
          return {
            _id: { server: SERVER_ID, user: userId },
            roles: [],
          };
        }
        const userMatch = path.match(/^\/users\/([A-Za-z0-9]+)$/);
        if (userMatch) {
          const userId = userMatch[1];
          if (!knownUsers.has(userId)) throw new Error("user missing");
          return {
            _id: userId,
            ...(userId === BOT_ID ? { bot: { owner: OWNER_ID } } : {}),
          };
        }
        throw new Error(`unexpected GET ${path}`);
      },
    },
  };
  const request = async (method, path, body) => {
    requests.push({ method, path, body: structuredClone(body) });
    if (method === "DELETE" && path.includes("/messages/")) {
      return { ok: !deleteFails, status: deleteFails ? 403 : 204 };
    }
    return { ok: true, status: 200 };
  };
  const reporter = createSpamReporter(client, {
    send: async (channelId, payload) => {
      sent.push({ channelId, payload });
      return { _id: `PUBLIC${sent.length}` };
    },
    sendProtected: async (channelId, payload) => {
      protectedLogs.push({ channelId, payload });
      if (protectedFails) return undefined;
      return { _id: `PROTECTED${protectedLogs.length}` };
    },
    request,
    store,
    now: () => clock,
    reportIdFactory: () => {
      reportCounter += 1;
      return `SRREPORT${reportCounter}`;
    },
    logger: { log() {}, warn() {} },
  });

  function message({
    reporterId = REPORTER_ONE,
    messageId = `COMMAND${requests.length + 1}`,
  } = {}) {
    return {
      id: messageId,
      authorId: reporterId,
      channelId: CHANNEL_ID,
      channel: { id: CHANNEL_ID, serverId: SERVER_ID },
      server: { id: SERVER_ID, ownerId: OWNER_ID },
    };
  }

  return {
    reporter,
    requests,
    sent,
    protectedLogs,
    store,
    message,
    advance(ms) {
      clock += ms;
    },
  };
}

test("parser reads plain sentences and keeps the legacy delimiter", () => {
  assert.deepEqual(
    parseSpamReportCommand("<@TARGET123> sent me a scam DM out of nowhere"),
    {
      ok: true,
      targetId: TARGET_ONE,
      reason: "sent me a scam DM out of nowhere",
    }
  );
  assert.deepEqual(
    parseSpamReportCommand("<@TARGET123> for repeated commission spam"),
    { ok: true, targetId: TARGET_ONE, reason: "repeated commission spam" },
    "a leading preposition is filler, not part of the reason"
  );
  assert.deepEqual(
    parseSpamReportCommand(
      "<@TARGET123> reason: unsolicited commission scam message"
    ),
    {
      ok: true,
      targetId: TARGET_ONE,
      reason: "unsolicited commission scam message",
    }
  );
  assert.equal(
    parseSpamReportCommand(
      `they friend requested me then ${TARGET_ONE} pitched a commission`
    ).ok,
    false,
    "a bare ID is only read as the target in the leading position"
  );
});

test("parser enforces the target and reason length bounds", () => {
  assert.equal(
    parseSpamReportCommand("not-an-id sent me enough text here").ok,
    false
  );
  assert.equal(parseSpamReportCommand(`${TARGET_ONE}`).ok, false);
  assert.equal(parseSpamReportCommand(`${TARGET_ONE} for`).ok, false);
  assert.equal(parseSpamReportCommand(`${TARGET_ONE} reason: short`).ok, false);
  assert.equal(parseSpamReportCommand(`${TARGET_ONE} spam`).ok, false);
  assert.equal(
    parseSpamReportCommand(`${TARGET_ONE} ${"x".repeat(301)}`).ok,
    false
  );
});

test("reason sanitization neutralizes mentions, formatting, and clickable URLs", () => {
  const sanitised = sanitizeSpamReportReason(
    "<@TARGET123> @everyone **click** https://scam.example/path [label](www.bad.test)"
  );
  assert.doesNotMatch(sanitised, /https?:\/\/|www\./i);
  assert.doesNotMatch(sanitised, /<@TARGET123>|@everyone|\*\*|\[label\]/);
  assert.match(sanitised, /\[link removed\]/);
});

test("generated report IDs are opaque, safe, and non-repeating", () => {
  const first = createSpamReportId();
  const second = createSpamReportId();
  assert.match(first, /^SR[A-F0-9]{16}$/);
  assert.notEqual(first, second);
});

test("report invocations can be excluded from the audit message archive", () => {
  assert.equal(
    isSpamReportInvocation(
      " /Report-Spam TARGET123 reason: private evidence",
      "/"
    ),
    true
  );
  assert.equal(
    isSpamReportInvocation(
      "!REPORT-SPAM TARGET123 reason: private evidence",
      "!"
    ),
    true
  );
  assert.equal(isSpamReportInvocation("/Report-Spammer TARGET123", "/"), false);
  assert.equal(isSpamReportInvocation("/FetchGI", "/"), false);
});

test("archive exclusion requires a successful coordinated deletion", async () => {
  const accepted = makeHarness();
  const acceptedMessage = {
    ...accepted.message(),
    content: `/Report-Spam ${TARGET_ONE} reason: unsolicited commission scam`,
  };
  const acceptedOperation = accepted.reporter.handleCommand(
    acceptedMessage,
    `${TARGET_ONE} reason: unsolicited commission scam`
  );
  const acceptedExclusion =
    accepted.reporter.shouldExcludeMessage(acceptedMessage);
  const acceptedDeleteExclusion = accepted.reporter.shouldExcludeMessageDelete(
    acceptedMessage.id
  );
  const [, excluded, deleteExcluded] = await Promise.all([
    acceptedOperation,
    acceptedExclusion,
    acceptedDeleteExclusion,
  ]);
  assert.equal(excluded, true);
  assert.equal(deleteExcluded, true);

  const failed = makeHarness({ deleteFails: true });
  const failedMessage = {
    ...failed.message(),
    content: `/Report-Spam ${TARGET_ONE} reason: unsolicited commission scam`,
  };
  const failedOperation = failed.reporter.handleCommand(
    failedMessage,
    `${TARGET_ONE} reason: unsolicited commission scam`
  );
  const failedExclusion = failed.reporter.shouldExcludeMessage(failedMessage);
  const failedDeleteExclusion = failed.reporter.shouldExcludeMessageDelete(
    failedMessage.id
  );
  const [, failedExcluded, failedDeleteExcluded] = await Promise.all([
    failedOperation,
    failedExclusion,
    failedDeleteExclusion,
  ]);
  assert.equal(failedExcluded, false);
  assert.equal(failedDeleteExcluded, false);

  assert.equal(
    await accepted.reporter.shouldExcludeMessage({
      id: "UNROUTED1",
      content: `/Report-Spam ${TARGET_ONE} reason: audit bypass attempt`,
    }),
    false
  );
});

test("invocation is deleted before syntax validation", async () => {
  const harness = makeHarness();
  await harness.reporter.handleCommand(harness.message(), "invalid");

  assert.equal(harness.requests[0].method, "DELETE");
  assert.match(harness.requests[0].path, /\/messages\/COMMAND1$/);
  assert.equal(harness.protectedLogs.length, 0);
  assert.match(harness.sent.at(-1).payload.embeds[0].title, /Invalid Report/);
});

test("missing Manage Messages or a failed delete rejects without recording", async () => {
  const noPermission = makeHarness({ permissionBits: 0 });
  await noPermission.reporter.handleCommand(
    noPermission.message(),
    `${TARGET_ONE} reason: unsolicited commission scam`
  );
  assert.equal(noPermission.requests.length, 0);
  assert.equal(noPermission.store.reports.length, 0);

  const deleteFailure = makeHarness({ deleteFails: true });
  await deleteFailure.reporter.handleCommand(
    deleteFailure.message(),
    `${TARGET_ONE} reason: unsolicited commission scam`
  );
  assert.equal(deleteFailure.requests.length, 1);
  assert.equal(deleteFailure.store.reports.length, 0);
  assert.equal(deleteFailure.protectedLogs.length, 0);
});

test("missing audit configuration and protected delivery failures fail closed", async () => {
  const noAudit = makeHarness({ audit: false });
  await noAudit.reporter.handleCommand(
    noAudit.message(),
    `${TARGET_ONE} reason: unsolicited commission scam`
  );
  assert.equal(noAudit.store.reports.length, 0);
  assert.equal(noAudit.protectedLogs.length, 0);

  const failedDelivery = makeHarness({ protectedFails: true });
  await failedDelivery.reporter.handleCommand(
    failedDelivery.message(),
    `${TARGET_ONE} reason: unsolicited commission scam`
  );
  assert.equal(failedDelivery.store.reports.length, 0);
  assert.equal(failedDelivery.protectedLogs.length, 1);
});

test("fresh membership and protected target exclusions fail closed", async () => {
  const missingTarget = makeHarness({
    missingMembers: new Set([TARGET_ONE]),
  });
  await missingTarget.reporter.handleCommand(
    missingTarget.message(),
    `${TARGET_ONE} reason: unsolicited commission scam`
  );
  assert.equal(missingTarget.store.reports.length, 0);

  for (const targetId of [REPORTER_ONE, BOT_ID, OWNER_ID]) {
    const harness = makeHarness();
    await harness.reporter.handleCommand(
      harness.message(),
      `${targetId} reason: unsolicited commission scam`
    );
    assert.equal(harness.store.reports.length, 0);
  }
});

test("attempt cooldown, duplicate reports, and daily accepted limits block misuse", async () => {
  const harness = makeHarness();
  await harness.reporter.handleCommand(
    harness.message({ messageId: "COMMAND1" }),
    `${TARGET_ONE} reason: unsolicited commission scam`
  );
  await harness.reporter.handleCommand(
    harness.message({ messageId: "COMMAND2" }),
    `${TARGET_TWO} reason: another unsolicited scam message`
  );
  assert.equal(harness.store.reports.length, 1);
  assert.equal(
    harness.requests.filter(({ method }) => method === "DELETE").length,
    2
  );

  harness.advance(SPAM_REPORT_ATTEMPT_COOLDOWN_MS);
  await harness.reporter.handleCommand(
    harness.message({ messageId: "COMMAND3" }),
    `${TARGET_ONE} reason: repeated unsolicited scam message`
  );
  assert.equal(harness.store.reports.length, 1);

  for (const [index, targetId] of [TARGET_TWO, TARGET_THREE].entries()) {
    harness.advance(SPAM_REPORT_ATTEMPT_COOLDOWN_MS);
    await harness.reporter.handleCommand(
      harness.message({ messageId: `COMMAND${index + 4}` }),
      `${targetId} reason: unsolicited commission scam message`
    );
  }
  assert.equal(harness.store.reports.length, 3);

  harness.advance(SPAM_REPORT_ATTEMPT_COOLDOWN_MS);
  await harness.reporter.handleCommand(
    harness.message({ messageId: "COMMAND6" }),
    `${TARGET_FOUR} reason: unsolicited commission scam message`
  );
  assert.equal(harness.store.reports.length, 3);
  assert.match(harness.sent.at(-1).payload.embeds[0].title, /Limit Reached/);
});

test("three unique reporters raise priority without calling moderation endpoints", async () => {
  const harness = makeHarness();
  for (const [index, reporterId] of [
    REPORTER_ONE,
    REPORTER_TWO,
    REPORTER_THREE,
  ].entries()) {
    if (index) harness.advance(SPAM_REPORT_ATTEMPT_COOLDOWN_MS);
    const result = await harness.reporter.handleCommand(
      harness.message({
        reporterId,
        messageId: `COMMAND${index + 1}`,
      }),
      `${TARGET_ONE} reason: unsolicited commission scam message`
    );
    assert.equal(result.correlationCount, index + 1);
    assert.equal(result.priority, index === 2);
  }

  assert.equal(harness.store.reports.length, 3);
  assert.match(
    harness.protectedLogs.at(-1).payload.embeds[0].title,
    /Priority/
  );
  assert.match(
    harness.protectedLogs.at(-1).payload.embeds[0].description,
    /No automatic timeout, deletion, kick, ban, or automod strike/
  );
  assert.ok(
    harness.requests.every(
      ({ method, path }) =>
        method === "DELETE" && /\/channels\/.+\/messages\/.+/.test(path)
    )
  );
  assert.doesNotMatch(
    harness.sent.at(-1).payload.embeds[0].description,
    new RegExp(`${TARGET_ONE}|${REPORTER_THREE}`)
  );
  assert.doesNotMatch(
    `${harness.sent.at(-1).payload.embeds[0].title} ${harness.sent.at(-1).payload.embeds[0].description}`,
    /staff|audit|log/i
  );
});
