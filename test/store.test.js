// Tests for JSON-file persistence: channel subscriptions/scopes, new-code
// detection, and atomic writes. Runs hermetically against a temp data dir.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store;
let dataDir;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hoyofetch-test-"));
  process.env.HOYOFETCH_DATA_DIR = dataDir;
  writeFileSync(
    join(dataDir, "post_gate.json"),
    JSON.stringify({
      "legacy-hold": {
        mode: "hold",
        reviewChannelId: "legacy-review",
        updatedAt: "legacy-time",
      },
      "legacy-off": {
        mode: "off",
        reviewChannelId: null,
        updatedAt: "legacy-time",
      },
    })
  );
  // Import AFTER setting the env so the store reads the temp dir.
  store = await import("../store.js");
});

test("channel enable/disable lifecycle with scopes", () => {
  assert.equal(store.isChannelEnabled("chan-1"), false);

  store.enableChannel("chan-1", "hoyo");
  assert.equal(store.isChannelEnabled("chan-1"), true);
  assert.equal(store.getChannelScope("chan-1"), "hoyo");
  assert.deepEqual(store.getEnabledChannels(), [
    { id: "chan-1", scope: "hoyo" },
  ]);

  // Re-enabling with a new scope reports the change.
  const result = store.enableChannel("chan-1", "nte");
  assert.equal(result.wasEnabled, true);
  assert.equal(result.previousScope, "hoyo");
  assert.equal(result.currentScope, "nte");
  assert.equal(result.changed, true);

  store.enableChannel("chan-1", "wuwa");
  assert.equal(store.getChannelScope("chan-1"), "wuwa");

  store.enableChannel("chan-1", "nte_wuwa");
  assert.equal(store.getChannelScope("chan-1"), "nte_wuwa");

  store.disableChannel("chan-1");
  assert.equal(store.isChannelEnabled("chan-1"), false);
  assert.deepEqual(store.getEnabledChannels(), []);
});

test("invalid scope normalises to 'all'", () => {
  store.enableChannel("chan-scope", "bogus");
  assert.equal(store.getChannelScope("chan-scope"), "all");
});

test("all five auto-fetch scopes are accepted", () => {
  assert.deepEqual(
    [...store.AUTO_FETCH_SCOPES],
    ["all", "hoyo", "nte", "wuwa", "nte_wuwa"]
  );
});

test("writes are atomic and produce valid JSON (no leftover .tmp)", () => {
  store.enableChannel("chan-2", "all");
  const path = join(dataDir, "channels.json");
  assert.ok(existsSync(path));
  // Must parse cleanly...
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  assert.equal(parsed["chan-2"].enabled, true);
  // ...and the temp file must have been renamed away.
  assert.equal(existsSync(`${path}.tmp`), false);
});

test("detectNewCodes returns only unseen codes and remembers them", () => {
  assert.deepEqual(store.detectNewCodes("genshin", ["A", "B"]).sort(), [
    "A",
    "B",
  ]);
  assert.deepEqual(store.detectNewCodes("genshin", ["B", "C"]), ["C"]);
  assert.deepEqual(store.detectNewCodes("genshin", ["B", "C"]), []);
});

test("detectNewCodes ignores empty input so it can't wipe known codes", () => {
  store.detectNewCodes("hkrpg", ["X", "Y"]);
  assert.deepEqual(store.detectNewCodes("hkrpg", []), []);
  // X and Y are still known afterwards; only Z is new.
  assert.deepEqual(store.detectNewCodes("hkrpg", ["X", "Y", "Z"]), ["Z"]);
});

test("seedKnownCodes + hasSeenGame", () => {
  assert.equal(store.hasSeenGame("nap"), false);
  store.seedKnownCodes("nap", ["SEED1", "SEED2"]);
  assert.equal(store.hasSeenGame("nap"), true);
  assert.deepEqual(store.detectNewCodes("nap", ["SEED1", "SEED2"]), []);
});

test("source cache round-trips through atomic writes", () => {
  assert.equal(store.getSourceCache("nte"), null);
  store.setSourceCache("nte", { lastAttemptAt: 123, codes: [] });
  assert.deepEqual(store.getSourceCache("nte"), {
    lastAttemptAt: 123,
    codes: [],
  });
});

test("audit log channel configuration round-trips and disables", () => {
  const result = store.setAuditLogChannel("server-audit", "channel-audit");
  assert.equal(result.changed, true);
  assert.equal(store.getAuditLogChannel("server-audit"), "channel-audit");
  store.disableAuditLog("server-audit");
  assert.equal(store.getAuditLogChannel("server-audit"), null);
});

test("channel exclusions persist and filter by server", () => {
  store.addChannelExclusion({
    channelId: "privacy-channel",
    serverId: "privacy-server",
    excludedAt: 123,
    requestedBy: "moderator",
    approvedBy: "owner",
    requestId: "request",
  });
  assert.equal(store.isChannelExcluded("privacy-channel"), true);
  assert.deepEqual(store.getExcludedChannels("privacy-server"), [
    {
      channelId: "privacy-channel",
      serverId: "privacy-server",
      excludedAt: 123,
      requestedBy: "moderator",
      approvedBy: "owner",
      requestId: "request",
    },
  ]);
  assert.equal(store.getAllChannelExclusions().length, 1);
  assert.equal(
    store.removeChannelExclusion("privacy-channel").requestId,
    "request"
  );
  assert.equal(store.isChannelExcluded("privacy-channel"), false);
});

test("server-settings snapshots round-trip atomically and can be removed", () => {
  store.setServerSettingsSnapshot("server-settings", {
    version: 1,
    server: { name: "Test Server" },
    channels: {},
  });
  assert.deepEqual(store.getServerSettingsSnapshot("server-settings"), {
    version: 1,
    server: { name: "Test Server" },
    channels: {},
  });
  assert.doesNotThrow(() =>
    JSON.parse(
      readFileSync(join(dataDir, "server_settings_snapshots.json"), "utf-8")
    )
  );
  store.removeServerSettingsSnapshot("server-settings");
  assert.equal(store.getServerSettingsSnapshot("server-settings"), null);
});

test("automod configuration defaults off and persists mode, channel, and quorum", () => {
  assert.deepEqual(store.getAutomodConfig("server-automod"), {
    mode: "off",
    logChannelId: null,
    quorum: 2,
    updatedAt: null,
  });
  store.setAutomodConfig("server-automod", {
    mode: "monitor",
    logChannelId: "channel-automod",
    quorum: 1,
  });
  const config = store.getAutomodConfig("server-automod");
  assert.equal(config.mode, "monitor");
  assert.equal(config.logChannelId, "channel-automod");
  assert.equal(config.quorum, 1);
  assert.ok(config.updatedAt);
  assert.doesNotThrow(() =>
    JSON.parse(readFileSync(join(dataDir, "automod.json"), "utf-8"))
  );
});

test("automod pending cases support lookup, approval updates, and expiry", () => {
  const now = Date.now();
  store.createAutomodCase({
    caseId: "AMCASE1",
    serverId: "SERVER1",
    userId: "USER1",
    promptMessageId: "PROMPT1",
    approvals: [],
    status: "pending",
    createdAt: now,
    expiresAt: now + 10_000,
    dedupeUntil: now + 20_000,
  });
  assert.equal(
    store.findAutomodCaseByPromptMessage("PROMPT1").caseId,
    "AMCASE1"
  );
  assert.equal(
    store.findActiveAutomodCase("SERVER1", "USER1", now).caseId,
    "AMCASE1"
  );
  store.updateAutomodCase("AMCASE1", { approvals: ["MOD1"] });
  assert.deepEqual(store.getAutomodCase("AMCASE1").approvals, ["MOD1"]);

  store.pruneAutomodCases(now + 15_000);
  assert.equal(store.getAutomodCase("AMCASE1").status, "expired");
  assert.equal(
    store.findActiveAutomodCase("SERVER1", "USER1", now + 15_000).caseId,
    "AMCASE1"
  );
  store.pruneAutomodCases(now + 25_000);
  assert.equal(store.getAutomodCase("AMCASE1"), null);
});

test("automod strike state persists and can be reset", () => {
  const now = Date.now();
  store.setAutomodStrike("SERVER1", "USER1", {
    level: 3,
    lastContainedAt: now,
    timeoutUntil: now + 60_000,
  });
  assert.deepEqual(store.getAutomodStrike("SERVER1", "USER1"), {
    serverId: "SERVER1",
    userId: "USER1",
    level: 3,
    lastContainedAt: now,
    timeoutUntil: now + 60_000,
  });
  assert.equal(store.clearAutomodStrike("SERVER1", "USER1"), true);
  assert.equal(store.getAutomodStrike("SERVER1", "USER1"), null);
});

test("manual release can close pending automod ban reviews", () => {
  const now = Date.now();
  store.createAutomodCase({
    caseId: "AMRELEASE1",
    serverId: "SERVERREL",
    userId: "USERREL",
    promptMessageId: "PROMPTREL",
    approvals: [],
    status: "pending",
    createdAt: now,
    expiresAt: now + 10_000,
    dedupeUntil: now + 20_000,
  });
  assert.equal(
    store.cancelAutomodCasesForMember("SERVERREL", "USERREL", now + 1),
    1
  );
  assert.equal(store.getAutomodCase("AMRELEASE1").status, "released");
});

test("spam-report metadata persists without reasons and reloads safely", async () => {
  const now = Date.now();
  store.createSpamReport({
    reportId: "SRSTORE1",
    serverId: "SERVERSPAM",
    reporterId: "REPORTER1",
    targetId: "TARGET1",
    sourceChannelId: "CHANNEL1",
    protectedChannelId: "AUDIT1",
    protectedMessageId: "LOG1",
    createdAt: now,
  });
  assert.equal(
    store.findRecentSpamReport("SERVERSPAM", "REPORTER1", "TARGET1", now - 1)
      .reportId,
    "SRSTORE1"
  );
  const persisted = readFileSync(join(dataDir, "spam_reports.json"), "utf-8");
  assert.doesNotMatch(persisted, /reason/i);

  const reloaded = await import(`../store.js?spam-reload=${now}`);
  assert.equal(
    reloaded.getRecentSpamReports("SERVERSPAM", now - 1)[0].reportId,
    "SRSTORE1"
  );
});

test("spam-report retention drops expired and over-cap metadata", () => {
  const now = 2_100_000_000_000;
  const records = Object.fromEntries(
    [
      ["EXPIRED", now - store.SPAM_REPORT_RETENTION_MS - 1],
      ["SRKEEP1", now - 3],
      ["SRKEEP2", now - 2],
      ["SRKEEP3", now - 1],
    ].map(([reportId, createdAt]) => [
      reportId,
      { reportId, serverId: "SERVER1", createdAt },
    ])
  );
  assert.deepEqual(
    Object.keys(store.selectRetainedSpamReports(records, now, 2)),
    ["SRKEEP2", "SRKEEP3"]
  );
});

test("reversible moderation actions support message lookup and expiry", () => {
  const now = Date.now();
  store.createModerationAction({
    actionId: "MDACTION1",
    type: "mute",
    logMessageId: "LOG1",
    status: "active",
    createdAt: now,
    expiresAt: now + 10_000,
    retentionUntil: now + 20_000,
  });
  assert.equal(
    store.findModerationActionByMessage("LOG1").actionId,
    "MDACTION1"
  );
  store.addProtectedMessage("CHANNEL1", "LOG1", { content: "protected" });
  store.updateProtectedMessage("LOG1", { messageId: "RESTOREDLOG1" });
  assert.equal(
    store.findModerationActionByMessage("RESTOREDLOG1").actionId,
    "MDACTION1"
  );
  store.pruneModerationActions(now + 15_000);
  assert.equal(store.getModerationAction("MDACTION1").status, "expired");
  store.pruneModerationActions(now + 25_000);
  assert.equal(store.getModerationAction("MDACTION1"), null);
});

test("moderation level defaults to standard and clamps out-of-range values", () => {
  assert.deepEqual(store.getModerationLevel("server-level"), {
    level: 1,
    tenureDays: 7,
    updatedAt: null,
    updatedBy: null,
  });

  store.setModerationLevel("server-level", { level: 3, updatedBy: "admin-1" });
  const raised = store.getModerationLevel("server-level");
  assert.equal(raised.level, 3);
  assert.equal(raised.updatedBy, "admin-1");
  assert.ok(raised.updatedAt);

  // An unrecognised level must fall back to 1, never up into lockdown.
  store.setModerationLevel("server-level", { level: 9 });
  assert.equal(store.getModerationLevel("server-level").level, 1);

  store.setModerationLevel("server-level", { tenureDays: 500 });
  assert.equal(store.getModerationLevel("server-level").tenureDays, 30);
  store.setModerationLevel("server-level", { tenureDays: 0 });
  assert.equal(store.getModerationLevel("server-level").tenureDays, 1);

  assert.doesNotThrow(() =>
    JSON.parse(readFileSync(join(dataDir, "moderation_level.json"), "utf-8"))
  );
});

test("post-gate configuration defaults off and persists mode + review channel", () => {
  assert.deepEqual(store.getPostGateConfig("server-postgate"), {
    mode: "off",
    level: 0,
    defaultSendLock: null,
    reviewChannelId: null,
    updatedAt: null,
  });
  store.setPostGateConfig("server-postgate", {
    mode: "hold",
    defaultSendLock: {
      restoreOnUnlock: true,
      capturedAt: "2026-08-06T00:00:00.000Z",
    },
    reviewChannelId: "channel-postgate",
  });
  const config = store.getPostGateConfig("server-postgate");
  assert.equal(config.mode, "hold");
  assert.equal(config.level, 1);
  assert.deepEqual(config.defaultSendLock, {
    restoreOnUnlock: true,
    capturedAt: "2026-08-06T00:00:00.000Z",
  });
  assert.equal(config.reviewChannelId, "channel-postgate");
  assert.ok(config.updatedAt);
  assert.deepEqual(
    store
      .getAllPostGateConfigs()
      .find(({ serverId }) => serverId === "server-postgate"),
    { serverId: "server-postgate", ...config }
  );
  assert.doesNotThrow(() =>
    JSON.parse(readFileSync(join(dataDir, "post_gate.json"), "utf-8"))
  );
});

test("legacy post-gate configurations migrate to server levels", () => {
  assert.equal(store.getPostGateConfig("legacy-hold").level, 1);
  assert.equal(store.getPostGateConfig("legacy-off").level, 0);
  const persisted = JSON.parse(
    readFileSync(join(dataDir, "post_gate.json"), "utf-8")
  );
  assert.equal(persisted["legacy-hold"].level, 1);
  assert.equal(persisted["legacy-off"].level, 0);
});

test("post-gate queue supports lookup by id and by review message, pending listing, and eviction cleanup", () => {
  const now = Date.now();
  store.createHeldPost({
    queueId: "PG1",
    serverId: "PGSERVER",
    channelId: "PGCHANNEL",
    userId: "PGUSER",
    messageId: "PGMSG1",
    content: "check this link",
    attachments: [],
    reviewMessageId: "PGREVIEW1",
    status: "pending",
    createdAt: now,
    expiresAt: now + 7 * 24 * 60 * 60 * 1000,
  });
  assert.equal(store.getHeldPost("PG1").queueId, "PG1");
  assert.equal(store.findHeldPostByReviewMessage("PGREVIEW1").queueId, "PG1");
  assert.equal(store.getPendingHeldPosts("PGSERVER").length, 1);

  store.updateHeldPost("PG1", {
    status: "approved",
    reviewedBy: "MOD1",
    reviewedAt: now,
  });
  assert.equal(store.getPendingHeldPosts("PGSERVER").length, 0);
  assert.equal(store.getHeldPost("PG1").status, "approved");

  // Resolved entries stick around for a 7-day accountability window, then
  // their evidence is released.
  const evidencePaths = store.prunePostGateQueue(now + 6 * 24 * 60 * 60 * 1000);
  assert.deepEqual(evidencePaths, []);
  assert.ok(store.getHeldPost("PG1"));

  store.updateHeldPost("PG1", {
    attachments: [{ filename: "x.png", evidencePath: "/tmp/pg-evidence.png" }],
  });
  const releasedPaths = store.prunePostGateQueue(now + 8 * 24 * 60 * 60 * 1000);
  assert.deepEqual(releasedPaths, ["/tmp/pg-evidence.png"]);
  assert.equal(store.getHeldPost("PG1"), null);
});

test("post-gate queue reports pending entries whose review window has elapsed", () => {
  const now = Date.now();
  store.createHeldPost({
    queueId: "PG2",
    serverId: "PGSERVER2",
    channelId: "PGCHANNEL2",
    userId: "PGUSER2",
    messageId: "PGMSG2",
    content: "",
    attachments: [],
    reviewMessageId: "PGREVIEW2",
    status: "pending",
    createdAt: now,
    expiresAt: now + 1_000,
  });
  assert.equal(store.getExpiredPendingPosts(now).length, 0);
  const expired = store.getExpiredPendingPosts(now + 2_000);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].queueId, "PG2");
});

test("privacy digest state round-trips per server and defaults to null", () => {
  assert.deepEqual(store.getPrivacyDigestState("digest-server"), {
    lastPostedAt: null,
  });
  store.setPrivacyDigestState("digest-server", 123_456);
  assert.deepEqual(store.getPrivacyDigestState("digest-server"), {
    lastPostedAt: 123_456,
  });
  assert.doesNotThrow(() =>
    JSON.parse(readFileSync(join(dataDir, "privacy_digest.json"), "utf-8"))
  );
});

test("user holds normalise ids, timestamps, and the active flag on load", () => {
  const created = store.createUserHold({
    serverId: "HOLDSERVER1",
    userId: "HOLDUSER1",
    heldAt: 1_000,
    heldBy: "HOLDMOD1",
    originQueueId: "PGHOLD1",
    originMessageId: "HOLDMSG1",
    cardChannelId: "HOLDCHANNEL1",
    reminderAt: 2_000,
    // Hostile/garbage values must be dropped rather than persisted.
    releasedAt: "not-a-number",
    reminderCount: -5,
    lastReminderMessageId: "bad id with spaces",
  });
  assert.equal(created.created, true);
  assert.equal(created.record.active, true);
  assert.equal(created.record.releasedAt, null);
  assert.equal(created.record.reminderCount, 0);
  assert.equal(created.record.lastReminderMessageId, null);
  assert.equal(created.record.heldBy, "HOLDMOD1");

  assert.equal(store.isUserHeld("HOLDSERVER1", "HOLDUSER1"), true);
  assert.equal(store.isUserHeld("HOLDSERVER1", "SOMEONEELSE"), false);

  // A record with no usable server/user id is refused outright.
  assert.deepEqual(store.createUserHold({ serverId: "", userId: "" }), {
    created: false,
    record: null,
  });
});

test("creating a user hold twice returns the existing record without duplicating it", () => {
  store.createUserHold({
    serverId: "HOLDSERVER2",
    userId: "HOLDUSER2",
    heldAt: 5_000,
    heldBy: "FIRSTMOD",
  });
  const again = store.createUserHold({
    serverId: "HOLDSERVER2",
    userId: "HOLDUSER2",
    heldAt: 9_999,
    heldBy: "SECONDMOD",
  });
  assert.equal(again.created, false);
  // Who placed the hold and when must survive a repeat attempt.
  assert.equal(again.record.heldBy, "FIRSTMOD");
  assert.equal(again.record.heldAt, 5_000);
  assert.equal(store.getActiveUserHolds("HOLDSERVER2").length, 1);
});

test("finding a user hold by card message resolves both the control card and the latest reminder", () => {
  store.createUserHold({
    serverId: "HOLDSERVER3",
    userId: "HOLDUSER3",
    heldAt: 1,
    heldBy: "HOLDMOD3",
  });
  store.updateUserHold("HOLDSERVER3", "HOLDUSER3", {
    cardMessageId: "CONTROLCARD3",
    lastReminderMessageId: "REMINDERCARD3",
  });

  assert.equal(
    store.findUserHoldByCardMessage("CONTROLCARD3").cardKind,
    "control"
  );
  assert.equal(
    store.findUserHoldByCardMessage("REMINDERCARD3").cardKind,
    "reminder"
  );
  assert.equal(store.findUserHoldByCardMessage("UNKNOWNCARD"), null);
  assert.equal(store.findUserHoldByCardMessage(undefined), null);
});

test("reminders come due on the stored absolute timestamp", () => {
  store.createUserHold({
    serverId: "HOLDSERVER4",
    userId: "HOLDUSER4",
    heldAt: 0,
    heldBy: "HOLDMOD4",
    reminderAt: 10_000,
  });
  const due = (now) =>
    store
      .getDueUserHoldReminders(now)
      .filter((record) => record.serverId === "HOLDSERVER4");
  assert.equal(due(9_999).length, 0);
  assert.equal(due(10_000).length, 1);

  store.updateUserHold("HOLDSERVER4", "HOLDUSER4", { reminderAt: 30_000 });
  assert.equal(due(10_000).length, 0);
});

test("releasing a user hold preserves the record for audit and prunes after the retention window", () => {
  store.createUserHold({
    serverId: "HOLDSERVER5",
    userId: "HOLDUSER5",
    heldAt: 100,
    heldBy: "HOLDMOD5",
    reminderAt: 200,
  });
  const released = store.releaseUserHold("HOLDSERVER5", "HOLDUSER5", {
    releasedBy: "RELEASEMOD5",
    releasedAt: 500,
    reason: "reaction",
  });
  assert.equal(released.released, true);
  assert.equal(released.record.active, false);
  assert.equal(released.record.releasedBy, "RELEASEMOD5");
  assert.equal(released.record.releaseReason, "reaction");
  // A released hold must stop holding, stop reminding, and stop answering
  // reaction lookups.
  assert.equal(store.isUserHeld("HOLDSERVER5", "HOLDUSER5"), false);
  assert.equal(
    store.getDueUserHoldReminders(1_000).some((r) => r.userId === "HOLDUSER5"),
    false
  );
  // Releasing twice is a no-op rather than an error.
  assert.equal(
    store.releaseUserHold("HOLDSERVER5", "HOLDUSER5").released,
    false
  );
  assert.equal(store.releaseUserHold("NOSUCH", "NOBODY").released, false);

  // The record stays readable for audit until the retention window elapses.
  assert.equal(store.getUserHold("HOLDSERVER5", "HOLDUSER5").releasedAt, 500);
  store.prunePostGateUserHolds(500 + 24 * 60 * 60 * 1_000);
  assert.ok(store.getUserHold("HOLDSERVER5", "HOLDUSER5"));
  store.prunePostGateUserHolds(500 + 8 * 24 * 60 * 60 * 1_000);
  assert.equal(store.getUserHold("HOLDSERVER5", "HOLDUSER5"), null);
});

test("a missing prohibited-term file reports missing without throwing, and a malformed one reports malformed", () => {
  const termsPath = join(dataDir, "prohibited_terms.json");
  assert.equal(existsSync(termsPath), false);
  const absent = store.reloadProhibitedTermList({ force: true });
  assert.equal(absent.status, "missing");
  assert.deepEqual(absent.terms, []);
  assert.deepEqual(absent.allowlist, []);

  writeFileSync(termsPath, "{ this is not json");
  const broken = store.reloadProhibitedTermList({ force: true });
  assert.equal(broken.status, "malformed");
  assert.ok(broken.error);
  // Falling back to an empty operator list keeps the built-in list active
  // rather than taking the filter offline.
  assert.deepEqual(broken.terms, []);

  writeFileSync(
    termsPath,
    JSON.stringify({
      version: 1,
      terms: [
        "plainterm",
        { id: "local:one", term: "phrase term", tolerant: false },
        { term: "   " },
        42,
        null,
      ],
      allowlist: ["scunthorpe", "", { term: "objects not allowed here" }],
      unknownKey: "ignored",
    })
  );
  const loaded = store.reloadProhibitedTermList({ force: true });
  assert.equal(loaded.status, "ok");
  assert.deepEqual(loaded.terms, [
    "plainterm",
    { term: "phrase term", id: "local:one", tolerant: false },
  ]);
  assert.deepEqual(loaded.allowlist, ["scunthorpe"]);
  assert.equal(loaded.skipped, 5);
});

test("reloading the prohibited-term list only re-reads when the file changed", () => {
  const termsPath = join(dataDir, "prohibited_terms.json");
  writeFileSync(termsPath, JSON.stringify({ terms: ["stableterm"] }));
  const first = store.reloadProhibitedTermList({ force: true });
  assert.equal(first.changed, true);

  const second = store.reloadProhibitedTermList();
  assert.equal(second.changed, false);
  assert.deepEqual(second.terms, ["stableterm"]);

  writeFileSync(
    termsPath,
    JSON.stringify({ terms: ["stableterm", "anotherterm"] })
  );
  const third = store.reloadProhibitedTermList();
  assert.equal(third.changed, true);
  assert.deepEqual(third.terms, ["stableterm", "anotherterm"]);
});
