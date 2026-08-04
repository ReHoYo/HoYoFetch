// server-info.js — Local-only server and host diagnostics for /Server-Info
// Host details are deliberately limited to aggregate operational metrics.
import * as fs from "fs";
import os from "os";
import { createRequire } from "module";
import { DATA_DIR } from "./store.js";
import {
  getArchiveCoverage,
  MAX_MESSAGES,
  RETENTION_MONTHS,
} from "./message-archive.js";
import {
  getAutomodConfig,
  getEnabledChannels,
  getExcludedChannels,
  getPostGateConfig,
} from "./store.js";
import { getAuditDiagnostics } from "./auditlog.js";

const require = createRequire(import.meta.url);
const APP_VERSION = require("./package.json").version;
const MAX_DESCRIPTION_LENGTH = 2000;

const DEFAULT_DEPS = Object.freeze({
  now: () => Date.now(),
  archiveCoverage: getArchiveCoverage,
  archivePolicy: () => ({
    retentionMonths: RETENTION_MONTHS,
    maxMessages: MAX_MESSAGES,
  }),
  enabledChannels: getEnabledChannels,
  excludedChannels: getExcludedChannels,
  automodConfig: getAutomodConfig,
  postGateConfig: getPostGateConfig,
  auditDiagnostics: getAuditDiagnostics,
  systemMetrics: collectSystemMetrics,
  appVersion: APP_VERSION,
});

export function collectSystemMetrics() {
  const metrics = {
    nodeVersion: process.version,
    platform: safeProbe(() => `${os.platform()} ${os.arch()}`),
    processUptimeSeconds: safeProbe(() => process.uptime()),
    hostUptimeSeconds: safeProbe(() => os.uptime()),
    processMemory: safeProbe(() => {
      const memory = process.memoryUsage();
      return { rss: memory.rss, heapUsed: memory.heapUsed };
    }),
    hostMemory: safeProbe(() => {
      const total = os.totalmem();
      return { total, used: Math.max(0, total - os.freemem()) };
    }),
    normalizedLoad: safeProbe(() => {
      const cpuCount = Math.max(1, os.cpus()?.length ?? 1);
      return os.loadavg()[0] / cpuCount;
    }),
    disk: null,
  };

  metrics.disk = safeProbe(() => {
    if (typeof fs.statfsSync !== "function") return null;
    const stat = fs.statfsSync(DATA_DIR);
    const blockSize = Number(stat.bsize);
    const total = Number(stat.blocks) * blockSize;
    const available = Number(stat.bavail) * blockSize;
    return { total, used: Math.max(0, total - available) };
  });
  return metrics;
}

/** Build one bounded, local-only diagnostic embed for a server. */
export function buildServerInfoEmbed(client, serverId, overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const now = deps.now();
  const server = client?.servers?.get?.(serverId);
  const botId = client?.user?.id;
  const botMember =
    botId &&
    client?.serverMembers?.getByKey?.({ server: serverId, user: botId });
  const cachedMembers = countCachedMembers(client, serverId);
  const archive = safeProbe(() => deps.archiveCoverage(serverId)) ?? {};
  const policy = safeProbe(() => deps.archivePolicy()) ?? {};
  const audit = safeProbe(() => deps.auditDiagnostics(serverId)) ?? {};
  const automod = safeProbe(() => deps.automodConfig(serverId)) ?? {};
  const postGate = safeProbe(() => deps.postGateConfig(serverId)) ?? {};
  const excluded = safeProbe(() => deps.excludedChannels(serverId)) ?? [];
  const enabled = safeProbe(() => deps.enabledChannels()) ?? [];
  const fetchChannels = enabled.filter(
    ({ id }) => client?.channels?.get?.(id)?.serverId === serverId
  );
  const system = safeProbe(() => deps.systemMetrics()) ?? {};

  const lines = [
    "**Server**",
    `**Name:** ${bounded(server?.name ?? "Unavailable", 80)}`,
    `**ID:** \`${bounded(serverId, 40)}\` · **Owner:** ${mention(server?.ownerId)}`,
    `**Created:** ${dateAndAge(server?.createdAt, now)}`,
    `**Bot joined:** ${dateAndAge(botMember?.joinedAt, now)}`,
    `**Cached inventory:** ${countOf(server?.channels)} channels · ${sizeOf(server?.roles)} roles · ${countOf(server?.categories)} categories · ${cachedMembers} members`,
    "",
    "**Message archive · this server**",
    `**Messages:** ${formatInteger(archive.count)} · **Coverage:** ${coverage(archive, now)}`,
    `**Policy:** ${integer(policy.retentionMonths)} months · ${formatInteger(policy.maxMessages)} message installation cap`,
    "",
    "**Features · this server**",
    `**Auto-fetch:** ${fetchSummary(fetchChannels)}`,
    `**Audit log:** ${featureChannel(audit.enabled, audit.channelId)} · ${auditHealth(audit)}`,
    `**Member events:** ${memberEventHealth(audit.memberEvents)}`,
    `**Settings monitor:** ${settingsHealth(audit.settings)}`,
    `**Automod:** ${modeChannel(automod.mode, automod.logChannelId)} · quorum ${integer(automod.quorum)}`,
    `**Post-gate:** ${modeChannel(postGate.mode, postGate.reviewChannelId)}`,
    `**Privacy exclusions:** ${Array.isArray(excluded) ? excluded.length : 0} channel(s)`,
    "",
    "**Runtime · installation-wide**",
    `**Software:** HoYoFetch ${bounded(deps.appVersion, 24)} · Node ${bounded(system.nodeVersion ?? "Unavailable", 24)} · ${bounded(system.platform ?? "Unavailable", 40)}`,
    `**Uptime:** bot ${duration(system.processUptimeSeconds)} · VPS ${duration(system.hostUptimeSeconds)}`,
    `**Bot memory:** ${memoryPair(system.processMemory, "rss", "heapUsed", "RSS", "heap")}`,
    `**VPS memory:** ${usage(system.hostMemory)} · **Disk:** ${usage(system.disk)}`,
    `**Normalized 1m load:** ${percent(system.normalizedLoad)}`,
  ];

  let description = lines.join("\n");
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    description = `${description.slice(0, MAX_DESCRIPTION_LENGTH - 28)}\n… *(output truncated)*`;
  }
  return {
    title: "🩺 Server & Bot Diagnostics",
    description,
    colour: "#3498DB",
  };
}

function safeProbe(probe) {
  try {
    return probe();
  } catch {
    return null;
  }
}

function countCachedMembers(client, serverId) {
  try {
    return [...(client?.serverMembers?.values?.() ?? [])].filter(
      (member) => member?.id?.server === serverId
    ).length;
  } catch {
    return 0;
  }
}

function bounded(value, max) {
  const text = String(value ?? "Unavailable").replace(/[\r\n]+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function mention(id) {
  return id ? `<@${bounded(id, 40)}>` : "Unavailable";
}

function countOf(value) {
  return Array.isArray(value) ? value.length : (value?.size ?? 0);
}

function sizeOf(value) {
  return (
    value?.size ??
    (value && typeof value === "object" ? Object.keys(value).length : 0)
  );
}

function integer(value) {
  return Number.isFinite(Number(value))
    ? Math.max(0, Math.floor(Number(value)))
    : 0;
}

function formatInteger(value) {
  return Number.isFinite(Number(value))
    ? Math.floor(Number(value)).toLocaleString("en-US")
    : "Unavailable";
}

function toTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const time = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(time) ? time : null;
}

function dateAndAge(value, now) {
  const time = toTimestamp(value);
  if (time === null) return "Unavailable";
  return `${new Date(time).toISOString().slice(0, 10)} (${duration((now - time) / 1000)} ago)`;
}

function coverage(archive, now) {
  const earliest = toTimestamp(archive.earliestAt);
  const latest = toTimestamp(archive.latestAt);
  if (!integer(archive.count) || earliest === null || latest === null)
    return "No retained messages";
  return `${new Date(earliest).toISOString().slice(0, 10)} → ${new Date(latest).toISOString().slice(0, 10)} (${duration((now - earliest) / 1000)})`;
}

function duration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "Unavailable";
  const totalMinutes = Math.floor(value / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function fetchSummary(channels) {
  if (!channels.length) return "off";
  const scopes = new Map();
  for (const { scope = "all" } of channels)
    scopes.set(scope, (scopes.get(scope) ?? 0) + 1);
  return `${channels.length} channel(s) (${[...scopes].map(([scope, count]) => `${scope}: ${count}`).join(", ")})`;
}

function featureChannel(enabled, channelId) {
  return enabled
    ? `on in ${channelId ? `<#${bounded(channelId, 40)}>` : "an unavailable channel"}`
    : "off";
}

function modeChannel(mode = "off", channelId) {
  const label = bounded(mode, 16);
  return mode !== "off" && channelId
    ? `${label} in <#${bounded(channelId, 40)}>`
    : label;
}

function auditHealth(audit) {
  const failures = integer(audit.consecutiveFailures);
  const queue = `${integer(audit.queuePending)}/${integer(audit.queueLimit)}`;
  return `${failures ? `${failures} recent failure(s)` : "delivery healthy"}; installation queue ${queue}`;
}

// Joins and leaves are the one audit path that can fail with nothing posted
// and nothing logged, so report arrivals separately from deliveries: "seen"
// with no "posted" means the gateway is delivering and something here is
// discarding them; neither means the events are not reaching us at all.
function memberEventHealth(stats) {
  if (!stats) return "unavailable";
  const seen = (value) => (value ? "seen" : "never seen");
  const dropped = integer(stats.joinsDropped) + integer(stats.leavesDropped);
  return (
    `joins ${seen(stats.lastJoinSeenAt)}/${stats.lastJoinPostedAt ? "posted" : "never posted"} · ` +
    `leaves ${seen(stats.lastLeaveSeenAt)}/${stats.lastLeavePostedAt ? "posted" : "never posted"}` +
    `${dropped ? ` · ${dropped} dropped (${bounded(stats.lastDropReason ?? "unknown", 32)})` : ""}`
  );
}

function settingsHealth(settings) {
  if (!settings) return "unavailable";
  const baseline = settings.baselineReady
    ? "baseline ready"
    : "baseline not ready";
  const failures = integer(settings.webhookFailures);
  const last = toTimestamp(settings.lastSuccessAt);
  return `${baseline}${failures ? `; ${failures} webhook failure(s)` : ""}${last === null ? "" : `; last success ${new Date(last).toISOString().slice(0, 10)}`}`;
}

function bytes(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return "Unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let scaled = amount;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index++;
  }
  return `${scaled.toFixed(index < 2 ? 0 : 1)} ${units[index]}`;
}

function memoryPair(value, first, second, firstLabel, secondLabel) {
  if (!value) return "Unavailable";
  return `${bytes(value[first])} ${firstLabel} · ${bytes(value[second])} ${secondLabel}`;
}

function usage(value) {
  if (
    !value ||
    !Number.isFinite(value.used) ||
    !Number.isFinite(value.total) ||
    value.total <= 0
  )
    return "Unavailable";
  return `${bytes(value.used)} / ${bytes(value.total)} (${Math.round((value.used / value.total) * 100)}%)`;
}

function percent(value) {
  return Number.isFinite(value)
    ? `${Math.round(value * 100)}% per CPU`
    : "Unavailable";
}
