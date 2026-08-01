import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "revolt.js";

process.env.HOYOFETCH_DATA_DIR = mkdtempSync(
  join(tmpdir(), "hoyofetch-user-info-test-")
);

const {
  buildUserInfoLines,
  collectUserInfo,
  evaluateBotSignals,
  parseUserInfoCommand,
} = await import("../user-info.js");

const SERVER_ID = "SERVER123";
// revolt.js derives createdAt from a ULID, so ids below are shaped like real
// Stoat ULIDs (26 chars, Crockford base32) to exercise that decoding path.
const OLD_USER_ID = "01HZY3M6Q8V7N2K4J5T9W0XAAA"; // minted long before "now"
const FRESH_USER_ID = "01J9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9"; // minted just before "now"
const NOW = new Date("2026-08-01T00:00:00.000Z").getTime();

function emptyStore() {
  return {
    findActiveAutomodCase: () => null,
    getAutomodStrike: () => null,
    getRecentSpamReports: () => [],
  };
}

function makeClientWithUser(
  userId,
  { badges = 0, flags = 0, avatar, bot } = {}
) {
  const client = new Client();
  client.users.getOrCreate(userId, {
    _id: userId,
    username: "TestUser",
    discriminator: "0001",
    badges,
    flags,
    ...(avatar ? { avatar } : {}),
    ...(bot ? { bot } : {}),
  });
  return client;
}

test("collectUserInfo tolerates an unknown user without throwing", () => {
  const client = new Client();
  const record = collectUserInfo(client, {
    serverId: SERVER_ID,
    userId: "UNKNOWN_ID",
    store: emptyStore(),
  });
  assert.equal(record.username, null);
  assert.equal(record.accountCreatedAt, null);
  assert.equal(record.hasCustomAvatar, false);
  assert.deepEqual(evaluateBotSignals(record, NOW), [
    "Using the default avatar",
  ]);
});

test("collectUserInfo reads badges, flags, and bot info from the cached user", () => {
  const DEVELOPER_BIT = 1;
  const SUSPENDED_BIT = 1;
  const client = makeClientWithUser(OLD_USER_ID, {
    badges: DEVELOPER_BIT,
    flags: SUSPENDED_BIT,
    avatar: { _id: "FILE1", tag: "avatars" },
    bot: { owner: "OWNER1" },
  });
  const record = collectUserInfo(client, {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    store: emptyStore(),
  });
  assert.deepEqual(record.badges, ["Developer"]);
  assert.deepEqual(record.flags, ["Suspended"]);
  assert.equal(record.hasCustomAvatar, true);
  assert.equal(record.isBot, true);
  assert.equal(record.botOwnerId, "OWNER1");
});

test("evaluateBotSignals flags a recently created account", () => {
  const client = makeClientWithUser(FRESH_USER_ID);
  const accountCreatedAt = client.users.get(FRESH_USER_ID).createdAt;
  const record = collectUserInfo(client, {
    serverId: SERVER_ID,
    userId: FRESH_USER_ID,
    store: emptyStore(),
  });
  // "now" is one hour after account creation — well inside the 7-day window.
  const signals = evaluateBotSignals(
    record,
    accountCreatedAt.getTime() + 60 * 60_000
  );
  assert.ok(signals.some((s) => s.startsWith("Account created")));
});

test("evaluateBotSignals flags an account created just before joining", () => {
  const client = makeClientWithUser(OLD_USER_ID);
  const server = client.servers.getOrCreate(SERVER_ID, {
    _id: SERVER_ID,
    owner: "OWNER1",
    name: "Test",
    channels: [],
    roles: {},
    default_permissions: 0,
  });
  const accountCreatedAt = client.users.get(OLD_USER_ID).createdAt;
  const member = client.serverMembers.getOrCreate(
    { server: SERVER_ID, user: OLD_USER_ID },
    {
      _id: { server: SERVER_ID, user: OLD_USER_ID },
      joined_at: new Date(
        accountCreatedAt.getTime() + 5 * 60_000
      ).toISOString(),
      roles: [],
    }
  );
  const record = collectUserInfo(client, {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    member,
    store: emptyStore(),
  });
  const now = accountCreatedAt.getTime() + 10 * 60_000;
  const signals = evaluateBotSignals(record, now);
  assert.ok(
    signals.includes("Account was created less than an hour before joining")
  );
  void server;
});

test("evaluateBotSignals surfaces moderation history and platform flags", () => {
  const SUSPENDED_BIT = 1;
  const client = makeClientWithUser(OLD_USER_ID, {
    flags: SUSPENDED_BIT,
    avatar: { _id: "FILE1", tag: "avatars" },
  });
  const store = {
    findActiveAutomodCase: () => ({ caseId: "AM1" }),
    getAutomodStrike: () => ({ level: 2 }),
    getRecentSpamReports: () => [
      { targetId: OLD_USER_ID },
      { targetId: "someone-else" },
    ],
  };
  const record = collectUserInfo(client, {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    store,
  });
  const signals = evaluateBotSignals(record, NOW);
  assert.ok(signals.includes("Stoat has flagged this account as Suspended"));
  assert.ok(signals.includes("Existing automod strike (level 2/4)"));
  assert.ok(signals.includes("Has an open automod case"));
  assert.ok(signals.includes("1 spam report filed against this account"));
});

test("a clean, established account produces no signals", () => {
  const client = makeClientWithUser(OLD_USER_ID, {
    avatar: { _id: "FILE1", tag: "avatars" },
  });
  const record = collectUserInfo(client, {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    store: emptyStore(),
  });
  assert.deepEqual(evaluateBotSignals(record, NOW), []);
});

test("buildUserInfoLines includes a signals block only when signals exist", () => {
  const client = makeClientWithUser(OLD_USER_ID, {
    avatar: { _id: "FILE1", tag: "avatars" },
  });
  const record = collectUserInfo(client, {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    store: emptyStore(),
  });
  const cleanLines = buildUserInfoLines(record, [], { now: NOW });
  assert.ok(!cleanLines.some((line) => line.includes("Signals")));

  const flaggedLines = buildUserInfoLines(
    record,
    ["Using the default avatar"],
    {
      now: NOW,
    }
  );
  assert.ok(flaggedLines.some((line) => line.includes("⚠️ Signals (1)")));
});

test("buildUserInfoLines omits the bio line unless a profile was fetched", () => {
  const client = makeClientWithUser(OLD_USER_ID);
  const withoutProfile = collectUserInfo(client, {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    store: emptyStore(),
  });
  assert.ok(
    !buildUserInfoLines(withoutProfile, [], { now: NOW }).some((line) =>
      line.startsWith("**Bio:**")
    )
  );

  const withProfile = collectUserInfo(client, {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    profile: { content: "hello there" },
    store: emptyStore(),
  });
  assert.ok(
    buildUserInfoLines(withProfile, [], { now: NOW }).some(
      (line) => line === "**Bio:** hello there"
    )
  );
});

test("parseUserInfoCommand accepts a mention, a bare ULID, and rejects neither", () => {
  assert.deepEqual(parseUserInfoCommand(["<@01HZY3M6Q8V7N2K4J5T9W0XAAA>"]), {
    ok: true,
    targetId: "01HZY3M6Q8V7N2K4J5T9W0XAAA",
  });
  assert.deepEqual(parseUserInfoCommand(["01HZY3M6Q8V7N2K4J5T9W0XAAA"]), {
    ok: true,
    targetId: "01HZY3M6Q8V7N2K4J5T9W0XAAA",
  });
  assert.equal(parseUserInfoCommand([]).ok, false);
  assert.equal(parseUserInfoCommand(["not-a-target"]).ok, false);
});

test("parseUserInfoCommand prefers a mention over a bare ULID in the same message", () => {
  const result = parseUserInfoCommand([
    "01HZY3M6Q8V7N2K4J5T9W0XBBB",
    "<@01HZY3M6Q8V7N2K4J5T9W0XAAA>",
  ]);
  assert.deepEqual(result, {
    ok: true,
    targetId: "01HZY3M6Q8V7N2K4J5T9W0XAAA",
  });
});
