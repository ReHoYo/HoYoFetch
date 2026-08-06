import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dataDir = mkdtempSync(join(tmpdir(), "hoyofetch-server-info-test-"));
process.env.HOYOFETCH_DATA_DIR = dataDir;
const { buildServerInfoEmbed } = await import("../server-info.js");

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const NOW = Date.UTC(2026, 7, 3, 12);
const DAY = 24 * 60 * 60 * 1000;

function fakeClient({ longName = false, botMember = true } = {}) {
  const members = [
    {
      id: { server: "serverA", user: "bot" },
      joinedAt: new Date(NOW - 20 * DAY),
    },
    { id: { server: "serverA", user: "memberA" } },
    { id: { server: "serverB", user: "memberB" } },
  ];
  if (!botMember) members.shift();

  return {
    user: { id: "bot" },
    servers: new Map([
      [
        "serverA",
        {
          id: "serverA",
          name: longName ? `Server ${"x".repeat(3000)}` : "Example Server",
          ownerId: "ownerA",
          createdAt: new Date(NOW - 400 * DAY),
          channels: [{}, {}, {}],
          roles: new Map([
            ["one", {}],
            ["two", {}],
          ]),
          categories: [{}],
        },
      ],
    ]),
    channels: new Map([
      ["fetchA1", { serverId: "serverA" }],
      ["fetchA2", { serverId: "serverA" }],
      ["fetchB", { serverId: "serverB" }],
    ]),
    serverMembers: {
      getByKey({ server, user }) {
        return members.find(
          (member) => member.id.server === server && member.id.user === user
        );
      },
      values() {
        return members.values();
      },
    },
  };
}

function diagnostics(overrides = {}) {
  return {
    now: () => NOW,
    appVersion: "9.8.7",
    archiveCoverage: (serverId) => {
      assert.equal(serverId, "serverA");
      return {
        count: 12_345,
        earliestAt: NOW - 100 * DAY,
        latestAt: NOW - DAY,
      };
    },
    archivePolicy: () => ({ retentionMonths: 12, maxMessages: 1_000_000 }),
    enabledChannels: () => [
      { id: "fetchA1", scope: "all" },
      { id: "fetchA2", scope: "hoyo" },
      { id: "fetchB", scope: "wuwa" },
    ],
    excludedChannels: (serverId) => {
      assert.equal(serverId, "serverA");
      return [{ channelId: "privateA" }];
    },
    automodConfig: () => ({
      mode: "enforce",
      logChannelId: "automodA",
      quorum: 2,
    }),
    postGateConfig: () => ({
      mode: "hold",
      level: 3,
      reviewChannelId: "reviewA",
    }),
    auditDiagnostics: () => ({
      enabled: true,
      channelId: "auditA",
      consecutiveFailures: 0,
      queuePending: 1,
      queueLimit: 50,
      memberEvents: {
        lastJoinSeenAt: NOW - DAY,
        lastJoinPostedAt: null,
        lastLeaveSeenAt: NOW - DAY,
        lastLeavePostedAt: NOW - DAY,
        joinsDropped: 2,
        leavesDropped: 0,
        lastDropReason: "join:audit_disabled",
      },
      settings: {
        baselineReady: true,
        webhookFailures: 0,
        lastSuccessAt: NOW - DAY,
      },
    }),
    systemMetrics: () => ({
      nodeVersion: "v22.0.0",
      platform: "linux x64",
      processUptimeSeconds: 90_000,
      hostUptimeSeconds: 900_000,
      processMemory: { rss: 128 * 1024 ** 2, heapUsed: 64 * 1024 ** 2 },
      hostMemory: { used: 2 * 1024 ** 3, total: 4 * 1024 ** 3 },
      disk: { used: 25 * 1024 ** 3, total: 100 * 1024 ** 3 },
      normalizedLoad: 0.25,
    }),
    ...overrides,
  };
}

test("renders scoped archive, feature, runtime, and safe host diagnostics", () => {
  const embed = buildServerInfoEmbed(fakeClient(), "serverA", diagnostics());

  assert.equal(embed.title, "🩺 Server & Bot Diagnostics");
  assert.match(embed.description, /12,345/);
  assert.match(embed.description, /2 channel\(s\) \(all: 1, hoyo: 1\)/);
  assert.doesNotMatch(embed.description, /wuwa/);
  assert.match(embed.description, /Audit log:\*\* on in <#auditA>/);
  assert.match(embed.description, /installation queue 1\/50/);
  // Joins arriving but never posting is the exact shape of a silent member
  // audit failure, so it has to be legible at a glance.
  assert.match(
    embed.description,
    /Member events:\*\* joins seen\/never posted · leaves seen\/posted · 2 dropped \(join:audit_disabled\)/
  );
  assert.match(
    embed.description,
    /Automod:\*\* enforce in <#automodA> · quorum 2/
  );
  // The tenure threshold only means anything at level 3, so it is shown there.
  assert.match(embed.description, /Moderation level:\*\* 3 — lockdown/);
  assert.match(embed.description, /Privacy exclusions:\*\* 1 channel/);
  assert.match(embed.description, /HoYoFetch 9\.8\.7/);
  assert.match(embed.description, /bot 1d 1h · VPS 10d 10h/);
  assert.match(embed.description, /128\.0 MB RSS · 64\.0 MB heap/);
  assert.match(embed.description, /2\.0 GB \/ 4\.0 GB \(50%\)/);
  assert.match(embed.description, /25% per CPU/);
  assert.ok(embed.description.length <= 2000);
});

test("uses explicit unavailable fallbacks when cached data or probes fail", () => {
  const fail = () => {
    throw new Error("probe failed at /secret/path on 203.0.113.1");
  };
  const embed = buildServerInfoEmbed(
    fakeClient({ botMember: false }),
    "serverA",
    diagnostics({
      archiveCoverage: fail,
      archivePolicy: fail,
      enabledChannels: fail,
      excludedChannels: fail,
      automodConfig: fail,
      postGateConfig: fail,
      auditDiagnostics: fail,
      systemMetrics: fail,
    })
  );

  assert.match(embed.description, /Bot joined:\*\* Unavailable/);
  assert.match(embed.description, /No retained messages/);
  assert.match(embed.description, /Runtime · installation-wide/);
  assert.match(embed.description, /VPS memory:\*\* Unavailable/);
  assert.doesNotMatch(
    embed.description,
    /secret|203\.0\.113\.1|\/secret\/path/
  );
  assert.ok(embed.description.length <= 2000);
});

test("bounds untrusted labels to the Stoat embed limit", () => {
  const embed = buildServerInfoEmbed(
    fakeClient({ longName: true }),
    "serverA",
    diagnostics()
  );
  assert.ok(embed.description.length <= 2000);
  assert.doesNotMatch(embed.description, /x{100}/);
});
