import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "revolt.js";
import { LOOKUP_SCOPE, resolveAccountLookup } from "../account-lookup.js";

const SERVER_ID = "SERVER123";
const USER_ID = "01HZY3M6Q8V7N2K4J5T9W0XAAA";

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, data };
}

function countingProbes(overrides = {}) {
  const calls = { member: 0, user: 0, bans: 0, flags: 0, profile: 0 };
  const defaults = {
    member: () => response(404, { type: "NotFound" }),
    user: () => response(403, { type: "Forbidden" }),
    bans: () => response(200, { bans: [], users: [] }),
    flags: () => response(403, { type: "Forbidden" }),
    profile: () => response(403, { type: "Forbidden" }),
  };
  const probes = Object.fromEntries(
    Object.keys(calls).map((name) => [
      name,
      (...args) => {
        calls[name]++;
        return (overrides[name] ?? defaults[name])(...args);
      },
    ])
  );
  return { calls, probes };
}

function hydrateServer(client, id = SERVER_ID, name = "Test Server") {
  return client.servers.getOrCreate(id, {
    _id: id,
    owner: "OWNER1",
    name,
    channels: [],
    roles: {},
    default_permissions: 0,
  });
}

function hydrateUser(client, userId = USER_ID) {
  return client.users.getOrCreate(userId, {
    _id: userId,
    username: "CachedUser",
    discriminator: "0001",
  });
}

test("cached current member skips resolution probes and only fetches the profile", async () => {
  const client = new Client();
  hydrateServer(client);
  hydrateUser(client);
  client.serverMembers.getOrCreate(
    { server: SERVER_ID, user: USER_ID },
    {
      _id: { server: SERVER_ID, user: USER_ID },
      joined_at: new Date().toISOString(),
      roles: [],
    }
  );
  const { calls, probes } = countingProbes();
  const result = await resolveAccountLookup(client, {
    serverId: SERVER_ID,
    userId: USER_ID,
    probes,
  });
  assert.equal(result.summary.scope, LOOKUP_SCOPE.MEMBER);
  assert.deepEqual(calls, {
    member: 0,
    user: 0,
    bans: 0,
    flags: 0,
    profile: 1,
  });
});

test("a cached member without cached identity uses the validated user probe", async () => {
  const client = new Client();
  hydrateServer(client);
  client.serverMembers.getOrCreate(
    { server: SERVER_ID, user: USER_ID },
    {
      _id: { server: SERVER_ID, user: USER_ID },
      joined_at: new Date().toISOString(),
      roles: [],
    }
  );
  const { calls, probes } = countingProbes({
    user: () =>
      response(200, {
        _id: USER_ID,
        username: "FetchedMember",
        discriminator: "0005",
      }),
  });
  const result = await resolveAccountLookup(client, {
    serverId: SERVER_ID,
    userId: USER_ID,
    probes,
  });
  assert.equal(result.summary.scope, LOOKUP_SCOPE.MEMBER);
  assert.equal(result.summary.identitySource, "fetch");
  assert.equal(calls.user, 1);
  assert.equal(calls.bans, 0);
});

test("uses ban-list identity when the user endpoint is denied", async () => {
  const client = new Client();
  const { probes } = countingProbes({
    bans: () =>
      response(200, {
        bans: [
          {
            _id: { server: SERVER_ID, user: USER_ID },
            reason: "raid account",
          },
        ],
        users: [
          {
            _id: USER_ID,
            username: "BannedUser",
            discriminator: "1234",
          },
        ],
      }),
  });
  const result = await resolveAccountLookup(client, {
    serverId: SERVER_ID,
    userId: USER_ID,
    probes,
  });
  assert.equal(result.user, null);
  assert.equal(result.summary.scope, LOOKUP_SCOPE.BANNED);
  assert.equal(result.summary.identitySource, "ban-list");
  assert.equal(result.summary.identity.username, "BannedUser");
  assert.equal(result.summary.banReason, "raid account");
});

test("a banned account without a full user still receives platform flags", async () => {
  const client = new Client();
  const { calls, probes } = countingProbes({
    bans: () =>
      response(200, {
        bans: [
          {
            _id: { server: SERVER_ID, user: USER_ID },
            reason: null,
          },
        ],
        users: [
          {
            _id: USER_ID,
            username: "BannedUser",
            discriminator: "1234",
          },
        ],
      }),
    flags: () => response(200, { flags: 2 }),
  });
  const result = await resolveAccountLookup(client, {
    serverId: SERVER_ID,
    userId: USER_ID,
    probes,
  });
  assert.equal(result.summary.platformFlags, 2);
  assert.equal(calls.flags, 1);
});

test("a denied ban list is inconclusive rather than fatal", async () => {
  const client = new Client();
  const { probes } = countingProbes({
    bans: () => response(403, { type: "Forbidden" }),
  });
  const result = await resolveAccountLookup(client, {
    serverId: SERVER_ID,
    userId: USER_ID,
    probes,
  });
  assert.equal(result.summary.banListChecked, false);
  assert.equal(result.summary.scope, LOOKUP_SCOPE.UNKNOWN);
});

test("only a flags 404 proves a well-formed account is missing", async () => {
  for (const [status, expected] of [
    [404, false],
    [403, null],
    [429, null],
    [0, null],
  ]) {
    const client = new Client();
    const { probes } = countingProbes({
      flags: () => response(status, { type: "Error" }),
    });
    const result = await resolveAccountLookup(client, {
      serverId: `${SERVER_ID}${status}`,
      userId: USER_ID,
      probes,
    });
    assert.equal(result.summary.accountExists, expected, `status ${status}`);
  }
});

test("skips flags once a validated user resolves", async () => {
  const client = new Client();
  const { calls, probes } = countingProbes({
    user: () =>
      response(200, {
        _id: USER_ID,
        username: "FetchedUser",
        discriminator: "0002",
      }),
  });
  const result = await resolveAccountLookup(client, {
    serverId: SERVER_ID,
    userId: USER_ID,
    probes,
  });
  assert.equal(result.summary.identitySource, "fetch");
  assert.equal(calls.flags, 0);
});

test("rejects a mismatched user payload without poisoning the user cache", async () => {
  const client = new Client();
  const { probes } = countingProbes({
    user: () =>
      response(200, {
        _id: "01HZY3M6Q8V7N2K4J5T9W0XBBB",
        username: "WrongUser",
        discriminator: "0003",
      }),
  });
  const result = await resolveAccountLookup(client, {
    serverId: SERVER_ID,
    userId: USER_ID,
    probes,
  });
  assert.equal(result.user, null);
  assert.equal(client.users.has(undefined), false);
  assert.equal(client.users.has(USER_ID), false);
});

test("reuses one server ban list within its TTL", async () => {
  const client = new Client();
  const { calls, probes } = countingProbes();
  await resolveAccountLookup(client, {
    serverId: SERVER_ID,
    userId: USER_ID,
    probes,
    now: 1_000,
  });
  await resolveAccountLookup(client, {
    serverId: SERVER_ID,
    userId: "01HZY3M6Q8V7N2K4J5T9W0XBBB",
    probes,
    now: 2_000,
  });
  assert.equal(calls.bans, 1);
});

test("collects named cached mutual servers and excludes the current server", async () => {
  const client = new Client();
  hydrateServer(client);
  hydrateServer(client, "OTHER1", "Other Community");
  hydrateUser(client);
  client.serverMembers.getOrCreate(
    { server: "OTHER1", user: USER_ID },
    {
      _id: { server: "OTHER1", user: USER_ID },
      joined_at: new Date().toISOString(),
      roles: [],
    }
  );
  client.serverMembers.getOrCreate(
    { server: "OTHER_WITHOUT_NAME", user: USER_ID },
    {
      _id: { server: "OTHER_WITHOUT_NAME", user: USER_ID },
      joined_at: new Date().toISOString(),
      roles: [],
    }
  );
  const { probes } = countingProbes();
  const result = await resolveAccountLookup(client, {
    serverId: SERVER_ID,
    userId: USER_ID,
    probes,
  });
  assert.deepEqual(result.summary.mutualServers, [
    { id: "OTHER1", name: "Other Community" },
    { id: "OTHER_WITHOUT_NAME", name: "OTHER_WITHOUT_NAME" },
  ]);
});
