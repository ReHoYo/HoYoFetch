import test from "node:test";
import assert from "node:assert/strict";
import {
  auditAlias,
  authorizeCommand,
  COMMAND_ACCESS,
  CommandRateLimiter,
  getCommandAccess,
  isSafeId,
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

test("command classification protects every fetch-management variant", () => {
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

  assert.equal(getCommandAccess("restart", GAME_COMMANDS), COMMAND_ACCESS.ADMIN);
  assert.equal(getCommandAccess("emojimode", GAME_COMMANDS), COMMAND_ACCESS.ADMIN);
  assert.equal(
    getCommandAccess("emojimode custom", GAME_COMMANDS),
    COMMAND_ACCESS.ADMIN
  );
  assert.equal(getCommandAccess("unknown", GAME_COMMANDS), null);
  assert.equal(getCommandAccess("chison now", GAME_COMMANDS), null);
});

test("ordinary members keep public commands but cannot manage fetch or restart", () => {
  const message = makeMessage();

  assert.equal(
    authorizeCommand(message, COMMAND_ACCESS.MEMBER).allowed,
    true
  );
  const fetchManagement = authorizeCommand(
    message,
    COMMAND_ACCESS.FETCH_MANAGER
  );
  assert.equal(fetchManagement.allowed, false);
  assert.equal(fetchManagement.reason, "insufficient_permission");
  assert.equal(
    authorizeCommand(message, COMMAND_ACCESS.ADMIN).allowed,
    false
  );
});

test("owners and Manage Server administrators can manage fetch and restart", () => {
  for (const message of [
    makeMessage({ owner: true }),
    makeMessage({ serverPermissions: ["ManageServer"] }),
  ]) {
    assert.equal(
      authorizeCommand(message, COMMAND_ACCESS.FETCH_MANAGER).allowed,
      true
    );
    assert.equal(
      authorizeCommand(message, COMMAND_ACCESS.ADMIN).allowed,
      true
    );
  }
});

test("each server moderation permission can manage fetch but cannot restart", () => {
  for (const permission of [
    "KickMembers",
    "BanMembers",
    "TimeoutMembers",
  ]) {
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
