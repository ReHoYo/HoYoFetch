import test from "node:test";
import assert from "node:assert/strict";
import {
  auditAlias,
  authorizeCommand,
  COMMAND_ACCESS,
  CommandRateLimiter,
  evaluatePermissionSnapshot,
  getCommandAccess,
  isSafeId,
  refreshCommandAuthorization,
  safeErrorSummary,
  SingleFlight,
} from "../security.js";

const GAME_COMMANDS = {
  fetchgi: "genshin",
  fetchhsr: "hkrpg",
  fetchzzz: "nap",
  fetchhi3: "honkai3rd",
  fetchnte: "nte",
};

const PERMISSIONS = {
  ManageServer: 2 ** 1,
  KickMembers: 2 ** 6,
  BanMembers: 2 ** 7,
  TimeoutMembers: 2 ** 8,
  ManageMessages: 2 ** 23,
};

function makePermissionSnapshots({
  owner = "OWNER123",
  defaultPermissions = 0,
  memberRoles = [],
  roles = {},
  channelDefault = { a: 0, d: 0 },
  channelRoles = {},
  timeout = null,
} = {}) {
  return {
    server: {
      _id: "SERVER123",
      owner,
      default_permissions: defaultPermissions,
      roles,
    },
    member: {
      _id: { server: "SERVER123", user: "USER123" },
      joined_at: new Date(0).toISOString(),
      roles: memberRoles,
      timeout,
    },
    channel: {
      channel_type: "TextChannel",
      _id: "CHANNEL123",
      server: "SERVER123",
      name: "general",
      default_permissions: channelDefault,
      role_permissions: channelRoles,
    },
  };
}

function makeRefreshClient(snapshots, { fail = false, calls = [] } = {}) {
  return {
    api: {
      async get(path) {
        calls.push(path);
        if (fail) throw new Error("permission service unavailable");
        if (path === "/servers/SERVER123") return snapshots.server;
        if (path === "/servers/SERVER123/members/USER123")
          return snapshots.member;
        if (path === "/channels/CHANNEL123") return snapshots.channel;
        throw new Error("unexpected permission route");
      },
    },
  };
}

function makeMessage({
  owner = false,
  serverPermissions = [],
  channelPermissions = [],
  bot = false,
  webhook = false,
  throwPermissions = false,
} = {}) {
  const authorId = "USER123";
  const server = {
    id: "SERVER123",
    ownerId: owner ? authorId : "OWNER123",
  };
  const channel = {
    id: "CHANNEL123",
    server,
  };
  const member = {
    id: {
      user: authorId,
      server: server.id,
    },
    hasPermission(target, permission) {
      if (throwPermissions) throw new Error("permission cache unavailable");
      if (target === channel) return channelPermissions.includes(permission);
      if (target === server) return serverPermissions.includes(permission);
      return false;
    },
  };

  return {
    author: { bot: bot ? { owner: "BOTOWNER" } : undefined },
    authorId,
    channel,
    channelId: channel.id,
    member,
    server,
    webhook: webhook ? { name: "incoming" } : undefined,
  };
}

test("every privileged command and alias uses manager access", () => {
  for (const command of [
    "enablefetch",
    "enablefetchhoyo",
    "enablefetchnte",
    "disablefetch",
  ]) {
    assert.equal(
      getCommandAccess(command, GAME_COMMANDS),
      COMMAND_ACCESS.FETCH_MANAGER
    );
  }

  for (const command of [
    ...Object.keys(GAME_COMMANDS),
    "helphoyofetch",
    "harhar",
    "chison",
    "potential",
    "me",
  ]) {
    assert.equal(
      getCommandAccess(command, GAME_COMMANDS),
      COMMAND_ACCESS.MEMBER
    );
  }

  for (const command of [
    "restart",
    "emojimode",
    "emojimode custom",
    "auditlog",
    "enable-auditlog",
    "enableauditlog",
    "disable-auditlog",
    "disableauditlog",
    "test-auditlog",
    "testauditlog",
  ]) {
    assert.equal(
      getCommandAccess(command, GAME_COMMANDS),
      COMMAND_ACCESS.FETCH_MANAGER
    );
  }
  for (const command of [
    "automod",
    "automod status",
    "automod monitor",
    "automod monitor here",
    "automod enforce <#CHANNEL123>",
    "automod off",
    "automod quorum 2",
  ]) {
    assert.equal(
      getCommandAccess(command, GAME_COMMANDS),
      COMMAND_ACCESS.FETCH_MANAGER
    );
  }
  assert.equal(
    getCommandAccess("automod approve AM123", GAME_COMMANDS),
    COMMAND_ACCESS.BAN_APPROVER
  );
  assert.equal(
    getCommandAccess("automod release <@USER123> reason: x", GAME_COMMANDS),
    COMMAND_ACCESS.TIMEOUT
  );
  assert.equal(
    getCommandAccess("ban <@USER123> reason: x", GAME_COMMANDS),
    COMMAND_ACCESS.BAN
  );
  assert.equal(
    getCommandAccess("kick <@USER123> reason: x", GAME_COMMANDS),
    COMMAND_ACCESS.KICK
  );
  assert.equal(
    getCommandAccess("mute <@USER123> 1h reason: x", GAME_COMMANDS),
    COMMAND_ACCESS.TIMEOUT
  );
  assert.equal(
    getCommandAccess("purge-user USER123 window:1h reason: x", GAME_COMMANDS),
    COMMAND_ACCESS.MANAGE_MESSAGES
  );
  assert.equal(getCommandAccess("unknown", GAME_COMMANDS), null);
  assert.equal(getCommandAccess("chison now", GAME_COMMANDS), null);
});

test("ordinary members keep public commands but cannot use manager or admin access", () => {
  const message = makeMessage();

  assert.equal(authorizeCommand(message, COMMAND_ACCESS.MEMBER).allowed, true);
  const fetchManagement = authorizeCommand(
    message,
    COMMAND_ACCESS.FETCH_MANAGER
  );
  assert.equal(fetchManagement.allowed, false);
  assert.equal(fetchManagement.reason, "insufficient_permission");
  assert.equal(authorizeCommand(message, COMMAND_ACCESS.ADMIN).allowed, false);
});

test("owners and Manage Server administrators pass manager and admin access", () => {
  for (const message of [
    makeMessage({ owner: true }),
    makeMessage({ serverPermissions: ["ManageServer"] }),
  ]) {
    assert.equal(
      authorizeCommand(message, COMMAND_ACCESS.FETCH_MANAGER).allowed,
      true
    );
    assert.equal(authorizeCommand(message, COMMAND_ACCESS.ADMIN).allowed, true);
  }
});

test("each server moderation permission passes manager but not admin access", () => {
  for (const permission of ["KickMembers", "BanMembers", "TimeoutMembers"]) {
    const message = makeMessage({ serverPermissions: [permission] });
    assert.equal(
      authorizeCommand(message, COMMAND_ACCESS.FETCH_MANAGER).reason,
      "moderator"
    );
    assert.equal(
      authorizeCommand(message, COMMAND_ACCESS.ADMIN).allowed,
      false
    );
  }
});

test("Manage Messages is evaluated against the current channel", () => {
  const channelModerator = makeMessage({
    channelPermissions: ["ManageMessages"],
  });
  const serverOnlyValue = makeMessage({
    serverPermissions: ["ManageMessages"],
  });

  assert.equal(
    authorizeCommand(channelModerator, COMMAND_ACCESS.FETCH_MANAGER).allowed,
    true
  );
  assert.equal(
    authorizeCommand(serverOnlyValue, COMMAND_ACCESS.FETCH_MANAGER).allowed,
    false
  );
});

test("every audit-log command remains executable by capability-based moderators", () => {
  const auditCommands = [
    "auditlog",
    "enable-auditlog",
    "enableauditlog",
    "disable-auditlog",
    "disableauditlog",
    "test-auditlog",
    "testauditlog",
  ];
  const moderators = [
    makeMessage({ serverPermissions: ["KickMembers"] }),
    makeMessage({ serverPermissions: ["BanMembers"] }),
    makeMessage({ serverPermissions: ["TimeoutMembers"] }),
    makeMessage({ channelPermissions: ["ManageMessages"] }),
  ];

  for (const command of auditCommands) {
    const access = getCommandAccess(command, GAME_COMMANDS);
    assert.equal(access, COMMAND_ACCESS.FETCH_MANAGER);
    for (const moderator of moderators) {
      assert.equal(authorizeCommand(moderator, access).allowed, true);
    }
  }
});

test("ban approval requires owner, Manage Server, or Ban Members", () => {
  for (const message of [
    makeMessage({ owner: true }),
    makeMessage({ serverPermissions: ["ManageServer"] }),
    makeMessage({ serverPermissions: ["BanMembers"] }),
  ]) {
    assert.equal(
      authorizeCommand(message, COMMAND_ACCESS.BAN_APPROVER).allowed,
      true
    );
  }
  for (const message of [
    makeMessage(),
    makeMessage({ serverPermissions: ["TimeoutMembers"] }),
    makeMessage({ channelPermissions: ["ManageMessages"] }),
  ]) {
    assert.equal(
      authorizeCommand(message, COMMAND_ACCESS.BAN_APPROVER).allowed,
      false
    );
  }
});

test("manual moderation access requires the matching effective capability", () => {
  const policies = [
    [COMMAND_ACCESS.BAN, "BanMembers", "serverPermissions"],
    [COMMAND_ACCESS.KICK, "KickMembers", "serverPermissions"],
    [COMMAND_ACCESS.TIMEOUT, "TimeoutMembers", "serverPermissions"],
    [COMMAND_ACCESS.MANAGE_MESSAGES, "ManageMessages", "channelPermissions"],
  ];
  for (const [access, permission, scope] of policies) {
    const allowed = makeMessage({ [scope]: [permission] });
    assert.equal(authorizeCommand(allowed, access).allowed, true);
    assert.equal(authorizeCommand(makeMessage(), access).allowed, false);
  }
  assert.equal(
    authorizeCommand(
      makeMessage({ serverPermissions: ["ManageMessages"] }),
      COMMAND_ACCESS.MANAGE_MESSAGES
    ).allowed,
    false
  );
});

test("permission snapshots preserve high bits and ordered allow/deny precedence", () => {
  const highBit = 2 ** 35;
  const snapshots = makePermissionSnapshots({
    defaultPermissions: highBit,
    memberRoles: ["LOWROLE", "HIGHROLE"],
    roles: {
      LOWROLE: {
        name: "Low",
        rank: 10,
        permissions: { a: PERMISSIONS.ManageServer, d: 0 },
      },
      HIGHROLE: {
        name: "High",
        rank: 1,
        permissions: { a: 0, d: PERMISSIONS.ManageServer },
      },
    },
  });
  const evaluated = evaluatePermissionSnapshot({
    authorId: "USER123",
    ...snapshots,
  });

  assert.equal(evaluated.valid, true);
  assert.equal(evaluated.serverPermissions & BigInt(highBit), BigInt(highBit));
  assert.equal(
    evaluated.serverPermissions & BigInt(PERMISSIONS.ManageServer),
    0n
  );
});

test("permission snapshots apply channel role overrides after server roles", () => {
  const snapshots = makePermissionSnapshots({
    memberRoles: ["MODROLE"],
    roles: {
      MODROLE: {
        name: "Moderator",
        rank: 1,
        permissions: { a: 0, d: 0 },
      },
    },
    channelRoles: {
      MODROLE: { a: PERMISSIONS.ManageMessages, d: 0 },
    },
  });
  const evaluated = evaluatePermissionSnapshot({
    authorId: "USER123",
    ...snapshots,
  });

  assert.equal(evaluated.valid, true);
  assert.equal(
    evaluated.channelPermissions & BigInt(PERMISSIONS.ManageMessages),
    BigInt(PERMISSIONS.ManageMessages)
  );
});

test("fresh snapshots recover cached Manage Server false denials", async () => {
  const snapshots = makePermissionSnapshots({
    memberRoles: ["ADMINROLE"],
    roles: {
      ADMINROLE: {
        name: "Administrator",
        rank: 1,
        permissions: { a: PERMISSIONS.ManageServer, d: 0 },
      },
    },
  });
  const calls = [];
  const cached = authorizeCommand(makeMessage(), COMMAND_ACCESS.ADMIN);
  const refreshed = await refreshCommandAuthorization(
    makeRefreshClient(snapshots, { calls }),
    cached,
    COMMAND_ACCESS.ADMIN
  );

  assert.equal(cached.allowed, false);
  assert.equal(refreshed.allowed, true);
  assert.equal(refreshed.reason, "admin");
  assert.equal(refreshed.permissionSource, "refreshed");
  assert.equal(calls.length, 3);
});

test("fresh snapshots authorize every moderator capability for manager commands", async () => {
  assert.equal(
    getCommandAccess("restart", GAME_COMMANDS),
    COMMAND_ACCESS.FETCH_MANAGER
  );
  assert.equal(
    getCommandAccess("emojimode custom", GAME_COMMANDS),
    COMMAND_ACCESS.FETCH_MANAGER
  );

  for (const permission of ["KickMembers", "BanMembers", "TimeoutMembers"]) {
    const snapshots = makePermissionSnapshots({
      memberRoles: ["MODROLE"],
      roles: {
        MODROLE: {
          name: "Moderator",
          rank: 1,
          permissions: { a: PERMISSIONS[permission], d: 0 },
        },
      },
    });
    const cached = authorizeCommand(
      makeMessage(),
      COMMAND_ACCESS.FETCH_MANAGER
    );
    const refreshed = await refreshCommandAuthorization(
      makeRefreshClient(snapshots),
      cached,
      COMMAND_ACCESS.FETCH_MANAGER
    );
    assert.equal(refreshed.reason, "moderator", permission);
  }

  const channelSnapshots = makePermissionSnapshots({
    memberRoles: ["CHANNELMOD"],
    roles: {
      CHANNELMOD: {
        name: "Channel Moderator",
        rank: 1,
        permissions: { a: 0, d: 0 },
      },
    },
    channelRoles: {
      CHANNELMOD: { a: PERMISSIONS.ManageMessages, d: 0 },
    },
  });
  const cached = authorizeCommand(makeMessage(), COMMAND_ACCESS.FETCH_MANAGER);
  const refreshed = await refreshCommandAuthorization(
    makeRefreshClient(channelSnapshots),
    cached,
    COMMAND_ACCESS.FETCH_MANAGER
  );
  assert.equal(refreshed.reason, "moderator");
});

test("the explicit admin tier still rejects moderator-only snapshots", async () => {
  const snapshots = makePermissionSnapshots({
    memberRoles: ["MODROLE"],
    roles: {
      MODROLE: {
        name: "Moderator",
        rank: 1,
        permissions: { a: PERMISSIONS.BanMembers, d: 0 },
      },
    },
  });
  const cached = authorizeCommand(makeMessage(), COMMAND_ACCESS.ADMIN);
  const refreshed = await refreshCommandAuthorization(
    makeRefreshClient(snapshots),
    cached,
    COMMAND_ACCESS.ADMIN
  );
  assert.equal(refreshed.allowed, false);
  assert.equal(refreshed.permissionSource, "refreshed");
});

test("timeouts, malformed snapshots, cross-server data, and API failures fail closed", async () => {
  const timedOut = makePermissionSnapshots({
    defaultPermissions: PERMISSIONS.ManageServer,
    timeout: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(
    evaluatePermissionSnapshot({ authorId: "USER123", ...timedOut })
      .serverPermissions,
    0n
  );

  const malformed = makePermissionSnapshots();
  malformed.server.default_permissions = Number.NaN;
  assert.equal(
    evaluatePermissionSnapshot({ authorId: "USER123", ...malformed }).valid,
    false
  );

  const crossServer = makePermissionSnapshots();
  crossServer.channel.server = "OTHERSERVER";
  assert.equal(
    evaluatePermissionSnapshot({ authorId: "USER123", ...crossServer }).valid,
    false
  );

  const output = [];
  const cached = authorizeCommand(makeMessage(), COMMAND_ACCESS.ADMIN);
  const failed = await refreshCommandAuthorization(
    makeRefreshClient(makePermissionSnapshots(), { fail: true }),
    cached,
    COMMAND_ACCESS.ADMIN,
    { logger: { warn: (message) => output.push(message) } }
  );
  assert.equal(failed.allowed, false);
  assert.equal(failed.permissionSource, "refresh_failed");
  assert.doesNotMatch(output.join("\n"), /USER123|SERVER123|CHANNEL123/);
});

test("cached approvals and member commands never trigger permission refresh", async () => {
  const calls = [];
  const client = makeRefreshClient(makePermissionSnapshots(), { calls });
  const cachedAdmin = authorizeCommand(
    makeMessage({ serverPermissions: ["ManageServer"] }),
    COMMAND_ACCESS.ADMIN
  );
  const cachedMember = authorizeCommand(makeMessage(), COMMAND_ACCESS.MEMBER);

  assert.equal(
    await refreshCommandAuthorization(
      client,
      cachedAdmin,
      COMMAND_ACCESS.ADMIN
    ),
    cachedAdmin
  );
  assert.equal(
    await refreshCommandAuthorization(
      client,
      cachedMember,
      COMMAND_ACCESS.MEMBER
    ),
    cachedMember
  );
  assert.equal(calls.length, 0);
});

test("role names alone do not grant access and permission errors fail closed", () => {
  const namedRole = makeMessage();
  namedRole.member.roles = [{ name: "Administrator" }, { name: "Moderator" }];

  assert.equal(
    authorizeCommand(namedRole, COMMAND_ACCESS.FETCH_MANAGER).allowed,
    false
  );
  assert.equal(
    authorizeCommand(
      makeMessage({ throwPermissions: true }),
      COMMAND_ACCESS.FETCH_MANAGER
    ).allowed,
    false
  );
});

test("DMs, missing members, bots, webhooks, and invalid IDs are rejected", () => {
  const dm = makeMessage();
  dm.server = undefined;
  dm.channel.server = undefined;

  const missingMember = makeMessage();
  missingMember.member = undefined;

  const invalidId = makeMessage();
  invalidId.channelId = "../CHANNEL";

  for (const message of [
    dm,
    missingMember,
    makeMessage({ bot: true }),
    makeMessage({ webhook: true }),
    invalidId,
  ]) {
    assert.equal(
      authorizeCommand(message, COMMAND_ACCESS.MEMBER).allowed,
      false
    );
  }
});

test("command rate limiter allows five commands and emits one notice per window", () => {
  let now = 1_000;
  const limiter = new CommandRateLimiter({ now: () => now });

  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.check("USER123").allowed, true);
  }

  assert.deepEqual(limiter.check("USER123"), {
    allowed: false,
    notify: true,
    retryAfterMs: 30_000,
  });
  assert.equal(limiter.check("USER123").notify, false);

  now += 30_000;
  assert.equal(limiter.check("USER123").allowed, true);
});

test("command rate limiter expires entries and enforces its actor cap", () => {
  let now = 1_000;
  const limiter = new CommandRateLimiter({
    maxActors: 2,
    now: () => now,
  });

  limiter.check("USER1");
  limiter.check("USER2");
  limiter.check("USER3");
  assert.equal(limiter.actors.size, 2);
  assert.equal(limiter.actors.has("USER1"), false);

  now += 30_000;
  limiter.prune();
  assert.equal(limiter.actors.size, 0);
});

test("single-flight shares concurrent work and clears successful operations", async () => {
  const singleFlight = new SingleFlight();
  let callCount = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const first = singleFlight.run("genshin", async () => {
    callCount += 1;
    await gate;
    return ["CODE"];
  });
  const second = singleFlight.run("genshin", () => {
    callCount += 1;
    return ["OTHER"];
  });

  assert.equal(first, second);
  release();
  assert.deepEqual(await first, ["CODE"]);
  assert.equal(callCount, 1);

  await singleFlight.run("genshin", async () => {
    callCount += 1;
    return [];
  });
  assert.equal(callCount, 2);
});

test("single-flight clears rejected operations so retries can run", async () => {
  const singleFlight = new SingleFlight();
  let callCount = 0;

  await assert.rejects(
    singleFlight.run("nte", async () => {
      callCount += 1;
      throw new Error("temporary");
    }),
    /temporary/
  );

  assert.equal(
    await singleFlight.run("nte", async () => {
      callCount += 1;
      return "recovered";
    }),
    "recovered"
  );
  assert.equal(callCount, 2);
});

test("audit helpers do not expose raw identifiers or URLs", () => {
  const rawId = "01KPK39288XJE44RWR495WSZGR";
  const alias = auditAlias(rawId);

  assert.match(alias, /^[a-f0-9]{12}$/);
  assert.equal(alias.includes(rawId), false);
  assert.equal(alias, auditAlias(rawId));
  assert.notEqual(alias, auditAlias("ANOTHER123"));
  assert.equal(isSafeId("../bad"), false);

  const summary = safeErrorSummary(
    new Error(`Request https://example.com/${rawId} failed`)
  );
  assert.equal(summary.includes("https://"), false);
  assert.equal(summary.includes(rawId), false);
});
