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
  buildUserInfoEmbed,
  buildUserInfoLines,
  collectUserInfo,
  deriveAccountCreatedAt,
  evaluateBotSignals,
  isEmptyLookup,
  parseUserInfoCommand,
} = await import("../user-info.js");
const { LOOKUP_SCOPE } = await import("../account-lookup.js");

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

function fakeLookup(overrides = {}) {
  return {
    scope: LOOKUP_SCOPE.UNKNOWN,
    identitySource: "none",
    identity: null,
    accountExists: null,
    platformFlags: null,
    banned: false,
    banReason: null,
    banListChecked: true,
    mutualElsewhere: false,
    mutualServers: [],
    idWellFormed: true,
    probeStatuses: {},
    ...overrides,
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
  // No cached user and no lookup means the avatar is unknown, not absent —
  // otherwise every join the gateway delivers uncached is flagged for review.
  assert.equal(record.hasCustomAvatar, null);
  assert.deepEqual(evaluateBotSignals(record, NOW), []);
  assert.ok(
    buildUserInfoLines(record, [], { now: NOW }).includes("**Avatar:** unknown")
  );
});

test("derives creation time from a ULID but not a malformed id", () => {
  const createdAt = deriveAccountCreatedAt(OLD_USER_ID);
  assert.ok(createdAt instanceof Date);
  assert.equal(Number.isNaN(createdAt.getTime()), false);
  assert.equal(deriveAccountCreatedAt("UNKNOWN_ID"), null);

  const record = collectUserInfo(new Client(), {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    user: null,
    store: emptyStore(),
  });
  assert.equal(record.accountCreatedAtSource, "id");
  assert.equal(record.accountCreatedAt.getTime(), createdAt.getTime());
});

test("an explicitly supplied user wins over a different cached user", () => {
  const client = makeClientWithUser(OLD_USER_ID);
  const supplied = {
    username: "Supplied",
    discriminator: "9999",
    displayName: "Supplied Name",
    createdAt: new Date(NOW - 1_000),
    avatar: null,
  };
  const record = collectUserInfo(client, {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    user: supplied,
    store: emptyStore(),
  });
  assert.equal(record.username, "Supplied");
  assert.equal(record.displayName, "Supplied Name");
});

test("lookup identity and platform flags fill otherwise invisible records", () => {
  const record = collectUserInfo(new Client(), {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    user: null,
    store: emptyStore(),
    lookup: fakeLookup({
      scope: LOOKUP_SCOPE.BANNED,
      identitySource: "ban-list",
      identity: {
        username: "BanIdentity",
        discriminator: "4444",
        displayName: null,
        hasCustomAvatar: true,
      },
      platformFlags: 2,
      banned: true,
    }),
  });
  assert.equal(record.username, "BanIdentity");
  assert.equal(record.hasCustomAvatar, true);
  assert.deepEqual(record.flags, ["Deleted"]);
  assert.ok(
    evaluateBotSignals(record, NOW).includes("Banned from this server")
  );
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
  assert.ok(signals.includes("Existing automod strike (stage 2/4)"));
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

test("collectUserInfo leaves the message count null when no archive is supplied (join-log path)", () => {
  const client = makeClientWithUser(OLD_USER_ID);
  let archiveCalls = 0;
  const archive = {
    countArchivedMessages: () => {
      archiveCalls++;
      return 999;
    },
    getArchiveCoverage: () => {
      archiveCalls++;
      return { count: 999, earliestAt: NOW, latestAt: NOW };
    },
  };
  const record = collectUserInfo(client, {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    store: emptyStore(),
    // archive intentionally omitted — matches auditlog.js's join-log call.
  });
  assert.equal(record.messageCount, null);
  assert.equal(record.messageCountSince, null);
  assert.equal(
    archiveCalls,
    0,
    "the archive must not be touched on every join"
  );
  void archive;
});

test("collectUserInfo reads the message count from the archive when supplied", () => {
  const client = makeClientWithUser(OLD_USER_ID);
  const archive = {
    countArchivedMessages: ({ serverId, authorId }) => {
      assert.equal(serverId, SERVER_ID);
      assert.equal(authorId, OLD_USER_ID);
      return 42;
    },
    getArchiveCoverage: (serverId) => {
      assert.equal(serverId, SERVER_ID);
      return { count: 100, earliestAt: NOW - 86_400_000, latestAt: NOW };
    },
  };
  const record = collectUserInfo(client, {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    store: emptyStore(),
    archive,
  });
  assert.equal(record.messageCount, 42);
  assert.equal(record.messageCountSince, NOW - 86_400_000);
});

test("buildUserInfoLines(verbose: true) lists every field, using explicit fallbacks for empty ones", () => {
  const client = makeClientWithUser(OLD_USER_ID);
  const record = collectUserInfo(client, {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    store: emptyStore(),
    archive: {
      countArchivedMessages: () => 0,
      getArchiveCoverage: () => ({
        count: 0,
        earliestAt: null,
        latestAt: null,
      }),
    },
  });
  const lines = buildUserInfoLines(record, [], { now: NOW, verbose: true });
  const joined = lines.join("\n");

  // revolt.js's User.displayName falls back to the username when no
  // explicit display name is set, so this is "TestUser", not "none".
  assert.match(joined, /\*\*Display name:\*\* TestUser/);
  assert.match(joined, /\*\*Nickname:\*\* none/);
  assert.match(joined, /\*\*User ID:\*\* `01HZY3M6Q8V7N2K4J5T9W0XAAA`/);
  assert.match(joined, /\*\*Joined this server:\*\* not currently a member/);
  assert.match(joined, /\*\*Badges:\*\* none/);
  assert.match(joined, /\*\*Platform flags:\*\* none/);
  assert.match(joined, /\*\*Online:\*\* unknown/);
  assert.match(joined, /\*\*Bot owner:\*\* n\/a/);
  assert.match(joined, /\*\*Timed out until:\*\* none/);
  assert.match(joined, /\*\*Roles:\*\* none/);
  assert.match(joined, /\*\*Automod strike stage:\*\* 0\/4/);
  assert.match(joined, /\*\*Open automod case:\*\* no/);
  assert.match(joined, /\*\*Prior spam reports:\*\* 0/);
  assert.match(joined, /\*\*Messages sent:\*\* 0 recorded/);
});

test("buildUserInfoLines(verbose: true) reports a nonzero message count with its coverage start", () => {
  const client = makeClientWithUser(OLD_USER_ID);
  const since = NOW - 30 * 24 * 60 * 60_000;
  const record = collectUserInfo(client, {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    store: emptyStore(),
    archive: {
      countArchivedMessages: () => 1234,
      getArchiveCoverage: () => ({
        count: 5000,
        earliestAt: since,
        latestAt: NOW,
      }),
    },
  });
  const joined = buildUserInfoLines(record, [], {
    now: NOW,
    verbose: true,
  }).join("\n");
  assert.match(joined, /\*\*Messages sent:\*\* 1,234 recorded since/);
  assert.match(
    joined,
    /only messages observed while audit logging was active; deleted and purged messages are excluded/
  );
});

test("buildUserInfoLines(verbose: false) — the join log's default — omits empty fields as before", () => {
  const client = makeClientWithUser(OLD_USER_ID);
  const record = collectUserInfo(client, {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    store: emptyStore(),
  });
  const lines = buildUserInfoLines(record, [], { now: NOW });
  const joined = lines.join("\n");

  assert.ok(!joined.includes("Display name"));
  assert.ok(!joined.includes("User ID"));
  assert.ok(!joined.includes("Online"));
  assert.ok(!joined.includes("Bot owner"));
  assert.ok(!joined.includes("Timed out until"));
  assert.ok(!joined.includes("Messages sent"));
  assert.ok(!joined.includes("Automod strike stage"));
});

test("buildUserInfoLines(verbose: true) caps a long roles list and notes the remainder", () => {
  const client = makeClientWithUser(OLD_USER_ID);
  const server = client.servers.getOrCreate(SERVER_ID, {
    _id: SERVER_ID,
    owner: "OWNER1",
    name: "Test",
    channels: [],
    roles: {},
    default_permissions: 0,
  });
  const roleIds = Array.from({ length: 25 }, (_, i) => `ROLE${i}`);
  const member = client.serverMembers.getOrCreate(
    { server: SERVER_ID, user: OLD_USER_ID },
    {
      _id: { server: SERVER_ID, user: OLD_USER_ID },
      joined_at: new Date(NOW).toISOString(),
      roles: roleIds,
    }
  );
  const record = collectUserInfo(client, {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    member,
    store: emptyStore(),
  });
  const joined = buildUserInfoLines(record, [], {
    now: NOW,
    verbose: true,
  }).join("\n");
  const rolesLine = joined
    .split("\n")
    .find((line) => line.startsWith("**Roles:**"));
  assert.ok(rolesLine, "expected a Roles line");
  assert.match(rolesLine, /…and 10 more/);
  assert.equal((rolesLine.match(/<@&ROLE/g) ?? []).length, 15);
  void server;
});

test("lookup-only signals do not affect the join-log path", () => {
  const base = collectUserInfo(new Client(), {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    user: null,
    store: emptyStore(),
  });
  assert.ok(!evaluateBotSignals(base, NOW).includes("Banned from this server"));
  for (const verbose of [false, true]) {
    const joined = buildUserInfoLines(base, [], { now: NOW, verbose }).join(
      "\n"
    );
    assert.ok(!joined.includes("Lookup scope"));
    assert.ok(!joined.includes("Ban reason"));
  }
});

test("unknown identity does not claim the default avatar or an empty bio", () => {
  const record = collectUserInfo(new Client(), {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    user: null,
    profile: null,
    store: emptyStore(),
    lookup: fakeLookup(),
  });
  const signals = evaluateBotSignals(record, NOW);
  assert.ok(!signals.includes("Using the default avatar"));
  assert.ok(!signals.includes("No bio set"));
  assert.match(
    buildUserInfoLines(record, signals, { now: NOW, verbose: true }).join("\n"),
    /\*\*Avatar:\*\* unknown/
  );
});

test("a deleted account with local evidence is promoted to former and signaled", () => {
  const record = collectUserInfo(new Client(), {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    user: null,
    store: {
      ...emptyStore(),
      getAutomodStrike: () => ({ level: 2 }),
    },
    lookup: fakeLookup({
      scope: LOOKUP_SCOPE.MISSING,
      accountExists: false,
    }),
  });
  assert.equal(record.lookup.scope, LOOKUP_SCOPE.FORMER);
  assert.ok(
    evaluateBotSignals(record, NOW).some((signal) =>
      signal.startsWith("Stoat no longer has an account")
    )
  );
});

test("local evidence does not downgrade a confirmed ban to former", () => {
  const record = collectUserInfo(new Client(), {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    user: null,
    store: {
      ...emptyStore(),
      getAutomodStrike: () => ({ level: 1 }),
    },
    lookup: fakeLookup({
      scope: LOOKUP_SCOPE.BANNED,
      accountExists: true,
      banned: true,
    }),
  });
  assert.equal(record.lookup.scope, LOOKUP_SCOPE.BANNED);
});

test("renders every lookup scope and the ban-permission caveat", () => {
  const expected = new Map([
    [LOOKUP_SCOPE.MEMBER, "Current member of this server."],
    [LOOKUP_SCOPE.BANNED, "Not a member — banned from this server."],
    [LOOKUP_SCOPE.FORMER, "No longer a member of this server."],
    [LOOKUP_SCOPE.OUTSIDE, "visible to me through another community"],
    [LOOKUP_SCOPE.PLATFORM, "the account exists on Stoat"],
    [LOOKUP_SCOPE.UNKNOWN, "did not confirm whether this account exists"],
    [LOOKUP_SCOPE.MISSING, "no account has this ID"],
  ]);
  for (const [scope, sentence] of expected) {
    const record = collectUserInfo(new Client(), {
      serverId: SERVER_ID,
      userId: OLD_USER_ID,
      user: null,
      store: emptyStore(),
      lookup: fakeLookup({ scope, banListChecked: false }),
    });
    const line = buildUserInfoLines(record, [], {
      now: NOW,
      verbose: true,
    }).find((value) => value.startsWith("**Lookup scope:**"));
    assert.ok(line.includes(sentence), scope);
    if (scope === LOOKUP_SCOPE.MEMBER) {
      assert.ok(!line.includes("needs Ban Members"));
    } else {
      assert.ok(line.includes("needs Ban Members"));
    }
  }
});

test("renders at most three mutual server names and summarizes the rest", () => {
  const record = collectUserInfo(new Client(), {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    user: null,
    store: emptyStore(),
    lookup: fakeLookup({
      scope: LOOKUP_SCOPE.OUTSIDE,
      mutualServers: [
        { id: "1", name: "One" },
        { id: "2", name: "Two" },
        { id: "3", name: "Three" },
        { id: "4", name: "Four" },
      ],
    }),
  });
  const joined = buildUserInfoLines(record, [], {
    now: NOW,
    verbose: true,
  }).join("\n");
  assert.match(joined, /\*\*Also seen in:\*\* One, Two, Three, …and 1 more/);
  assert.ok(!joined.includes("Four"));
});

test("isEmptyLookup only accepts a confirmed missing account with no local evidence", () => {
  const base = collectUserInfo(new Client(), {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    user: null,
    store: emptyStore(),
    archive: {
      countArchivedMessages: () => 0,
      getArchiveCoverage: () => ({ earliestAt: null }),
    },
    lookup: fakeLookup({
      scope: LOOKUP_SCOPE.MISSING,
      accountExists: false,
    }),
  });
  assert.equal(isEmptyLookup(base), true);
  assert.equal(isEmptyLookup({ ...base, spamReportCount: 1 }), false);
  assert.equal(
    isEmptyLookup({
      ...base,
      lookup: { ...base.lookup, accountExists: null },
    }),
    false
  );
  assert.equal(
    isEmptyLookup({
      ...base,
      lookup: { ...base.lookup, banListChecked: false },
    }),
    false
  );
});

test("a maximal lookup embed stays within Stoat's description budget", () => {
  const client = makeClientWithUser(OLD_USER_ID, {
    badges: 1,
    flags: 1,
    avatar: { _id: "AVATAR", tag: "avatars" },
  });
  const member = {
    nickname: "N".repeat(100),
    joinedAt: new Date(NOW - 1_000),
    roles: Array.from({ length: 30 }, (_, i) => `ROLE${i}${"X".repeat(20)}`),
    timeout: new Date(NOW + 60_000),
  };
  const record = collectUserInfo(client, {
    serverId: SERVER_ID,
    userId: OLD_USER_ID,
    member,
    profile: { content: "B".repeat(300) },
    store: {
      findActiveAutomodCase: () => ({ caseId: "CASE" }),
      getAutomodStrike: () => ({ level: 4 }),
      getRecentSpamReports: () => [{ targetId: OLD_USER_ID }],
    },
    archive: {
      countArchivedMessages: () => 999_999,
      getArchiveCoverage: () => ({ earliestAt: NOW - 1_000 }),
    },
    lookup: fakeLookup({
      scope: LOOKUP_SCOPE.BANNED,
      identitySource: "fetch",
      banned: true,
      banReason: "R".repeat(500),
      mutualServers: Array.from({ length: 5 }, (_, i) => ({
        id: String(i),
        name: `Server ${i} ${"S".repeat(80)}`,
      })),
    }),
  });
  const signals = evaluateBotSignals(record, NOW);
  assert.ok(
    buildUserInfoEmbed(record, signals, { now: NOW }).description.length <= 2000
  );
});
