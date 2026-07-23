// store.js — Lightweight JSON-file persistence for channel config & known codes
// ──────────────────────────────────────────────────────────────────────────────
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Overridable so tests run hermetically and deployments can mount a volume.
export const DATA_DIR =
  process.env.HOYOFETCH_DATA_DIR || join(__dirname, "data");

// Ensure the data directory exists
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ── Paths ──────────────────────────────────────────
const CHANNELS_PATH = join(DATA_DIR, "channels.json");
const KNOWN_CODES_PATH = join(DATA_DIR, "known_codes.json");
const SOURCE_CACHE_PATH = join(DATA_DIR, "source_cache.json");
const PROTECTED_PATH = join(DATA_DIR, "protected_messages.json");
const AUDITLOG_PATH = join(DATA_DIR, "auditlog.json");
const SETTINGS_SNAPSHOTS_PATH = join(
  DATA_DIR,
  "server_settings_snapshots.json"
);
const AUTOMOD_PATH = join(DATA_DIR, "automod.json");
const AUTOMOD_CASES_PATH = join(DATA_DIR, "automod_cases.json");
const AUTOMOD_STRIKES_PATH = join(DATA_DIR, "automod_strikes.json");
const MODERATION_ACTIONS_PATH = join(DATA_DIR, "moderation_actions.json");
const SPAM_REPORTS_PATH = join(DATA_DIR, "spam_reports.json");
const CHANNEL_EXCLUSIONS_PATH = join(DATA_DIR, "channel_exclusions.json");

// ── Helpers ────────────────────────────────────────
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Recursively strip dangerous keys from parsed JSON to prevent prototype pollution.
 */
function sanitiseObject(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitiseObject);

  const clean = {};
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    clean[key] = sanitiseObject(obj[key]);
  }
  return clean;
}

function readJSON(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return sanitiseObject(raw);
  } catch {
    return fallback;
  }
}

// Atomic write: serialise to a temp file, then rename over the target.
// rename() is atomic on the same filesystem, so a crash mid-write can never
// leave a half-written (corrupt) JSON file behind.
function writeJSON(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, path);
}

// ═══════════════════════════════════════════════════
//  Channel subscriptions
// ═══════════════════════════════════════════════════
// Shape: {
//   "<channelId>": {
//     enabled: true,
//     scope: "all" | "hoyo" | "nte" | "wuwa" | "nte_wuwa"
//   }
// }

export const AUTO_FETCH_SCOPES = new Set([
  "all",
  "hoyo",
  "nte",
  "wuwa",
  "nte_wuwa",
]);

let channels = readJSON(CHANNELS_PATH, {});

// ═══════════════════════════════════════════════════
//  Audit-log channel exclusions
// ═══════════════════════════════════════════════════
// Shape: {
//   "<channelId>": {
//     serverId, excludedAt, requestedBy, approvedBy, requestId
//   }
// }

let channelExclusions = readJSON(CHANNEL_EXCLUSIONS_PATH, {});

export function isChannelExcluded(channelId) {
  return Boolean(channelExclusions[channelId]);
}

export function getExcludedChannels(serverId) {
  return Object.entries(channelExclusions)
    .filter(([, record]) => record.serverId === serverId)
    .map(([channelId, record]) => ({
      channelId,
      ...structuredClone(record),
    }));
}

export function getAllChannelExclusions() {
  return Object.entries(channelExclusions).map(([channelId, record]) => ({
    channelId,
    ...structuredClone(record),
  }));
}

export function addChannelExclusion(record) {
  if (!record?.channelId) return null;
  const { channelId, ...stored } = structuredClone(record);
  channelExclusions[channelId] = stored;
  writeJSON(CHANNEL_EXCLUSIONS_PATH, channelExclusions);
  return { channelId, ...structuredClone(stored) };
}

export function removeChannelExclusion(channelId) {
  const existing = channelExclusions[channelId];
  if (!existing) return null;
  delete channelExclusions[channelId];
  writeJSON(CHANNEL_EXCLUSIONS_PATH, channelExclusions);
  return { channelId, ...structuredClone(existing) };
}

function normaliseScope(scope) {
  return AUTO_FETCH_SCOPES.has(scope) ? scope : "all";
}

/**
 * Enable auto-fetch in a channel for the selected game scope.
 * @param {string} channelId
 * @param {"all"|"hoyo"|"nte"|"wuwa"|"nte_wuwa"} scope
 * @return {{wasEnabled: boolean, previousScope: string, currentScope: string, changed: boolean}}
 */
export function enableChannel(channelId, scope = "all") {
  channels[channelId] = channels[channelId] || {};
  const previousScope = getChannelScope(channelId);
  const wasEnabled = channels[channelId].enabled === true;
  const currentScope = normaliseScope(scope);

  channels[channelId].enabled = true;
  channels[channelId].scope = currentScope;
  writeJSON(CHANNELS_PATH, channels);

  return {
    wasEnabled,
    previousScope,
    currentScope,
    changed: !wasEnabled || previousScope !== currentScope,
  };
}

/**
 * Disable auto-fetch in a channel.
 * @param {string} channelId
 */
export function disableChannel(channelId) {
  if (channels[channelId]) {
    channels[channelId].enabled = false;
  }
  writeJSON(CHANNELS_PATH, channels);
}

/**
 * Check whether a channel has auto-fetch enabled.
 * @param  {string} channelId
 * @return {boolean}
 */
export function isChannelEnabled(channelId) {
  return channels[channelId]?.enabled === true;
}

/**
 * Get the enabled channel's auto-fetch scope. Legacy enabled channels default to all.
 * @param  {string} channelId
 * @return {"all"|"hoyo"|"nte"|"wuwa"|"nte_wuwa"}
 */
export function getChannelScope(channelId) {
  return normaliseScope(channels[channelId]?.scope);
}

/**
 * Get all enabled channels with their auto-fetch scopes.
 * @return {{id: string, scope: string}[]}
 */
export function getEnabledChannels() {
  return Object.entries(channels)
    .filter(([, v]) => v.enabled)
    .map(([id]) => ({ id, scope: normaliseScope(channels[id]?.scope) }));
}

// ═══════════════════════════════════════════════════
//  Known codes (to detect "new" codes)
// ═══════════════════════════════════════════════════
// Shape: { "<gameKey>": ["CODE1", "CODE2", ...] }

let knownCodes = readJSON(KNOWN_CODES_PATH, {});

/**
 * Return codes that are NOT yet in our known set for a game.
 * Also persists the new full set so future checks are aware.
 *
 * @param  {string}   gameKey
 * @param  {string[]} currentCodes — full list of active codes from the API
 * @return {string[]} — only the NEW codes
 */
export function detectNewCodes(gameKey, currentCodes) {
  // An empty list almost always means the source returned nothing this cycle.
  // Don't let that overwrite our known set — otherwise the next non-empty fetch
  // would treat every still-active code as "new" and re-announce it.
  if (!Array.isArray(currentCodes) || currentCodes.length === 0) {
    return [];
  }

  const fresh = detectFreshCodes(
    gameKey,
    knownCodes[gameKey] || [],
    currentCodes
  );

  // Persist the full current set (replaces expired codes too)
  knownCodes[gameKey] = currentCodes;
  writeJSON(KNOWN_CODES_PATH, knownCodes);

  return fresh;
}

/**
 * Pure helper for comparing current source codes against a previous known set.
 * Game8 pages can change code capitalization without changing code identity.
 *
 * @param  {string}   gameKey
 * @param  {string[]} previousCodes
 * @param  {string[]} currentCodes
 * @return {string[]} — only codes not represented in previousCodes
 */
export function detectFreshCodes(gameKey, previousCodes, currentCodes) {
  const previous = new Set(
    previousCodes.map((code) => getCodeIdentity(gameKey, code))
  );
  return currentCodes.filter(
    (code) => !previous.has(getCodeIdentity(gameKey, code))
  );
}

function getCodeIdentity(gameKey, code) {
  const value = String(code ?? "").trim();
  return gameKey === "nte" || gameKey === "wuwa" ? value.toUpperCase() : value;
}

/**
 * Mark a set of codes as known without detecting new ones.
 * Useful for the first run to seed without spamming channels.
 *
 * @param {string}   gameKey
 * @param {string[]} codes
 */
export function seedKnownCodes(gameKey, codes) {
  knownCodes[gameKey] = codes;
  writeJSON(KNOWN_CODES_PATH, knownCodes);
}

/**
 * Whether we have ever fetched codes for a game before.
 * @param  {string}  gameKey
 * @return {boolean}
 */
export function hasSeenGame(gameKey) {
  return Array.isArray(knownCodes[gameKey]) && knownCodes[gameKey].length > 0;
}

// ═══════════════════════════════════════════════════
//  Source cache (scrapers with external rate limits)
// ═══════════════════════════════════════════════════
// Shape: { "<sourceKey>": { lastAttemptAt, lastSuccessAt, codes } }

let sourceCache = readJSON(SOURCE_CACHE_PATH, {});

/**
 * Read a cached source payload.
 * @param  {string} sourceKey
 * @return {Object|null}
 */
export function getSourceCache(sourceKey) {
  const entry = sourceCache[sourceKey];
  return entry && typeof entry === "object" ? entry : null;
}

/**
 * Persist a cached source payload.
 * @param {string} sourceKey
 * @param {Object} entry
 */
export function setSourceCache(sourceKey, entry) {
  sourceCache[sourceKey] = entry;
  writeJSON(SOURCE_CACHE_PATH, sourceCache);
}

// ═══════════════════════════════════════════════════
//  Tamper protection (audit-log messages)
// ═══════════════════════════════════════════════════
// Shape: { "<recordId>": {
//   recordId, channelId, messageId, payload,
//   restorations, createdAt, lastVerifiedAt,
//   failures, nextAttemptAt, channelMissing
// } }
//
// recordId is the ORIGINAL message id and never changes. messageId is the
// CURRENT live id and is rewritten on every restoration — this is what lets
// a deleted restoration itself be detected and restored again.

let protectedMessages = readJSON(PROTECTED_PATH, {});

// In-memory index: live messageId -> recordId, rebuilt on load for O(1)
// lookup from delete events.
let messageIdIndex = new Map(
  Object.values(protectedMessages).map((r) => [r.messageId, r.recordId])
);

function persistProtectedMessages() {
  writeJSON(PROTECTED_PATH, protectedMessages);
}

/**
 * Begin tracking a newly-sent audit-log message so a future delete triggers
 * a restoration.
 *
 * @param {string} channelId
 * @param {string} messageId
 * @param {{content?: string, embeds?: object[]}} payload — pristine payload, no tamper notice
 * @return {Object} the created record
 */
export function addProtectedMessage(channelId, messageId, payload) {
  const record = {
    recordId: messageId,
    channelId,
    messageId,
    payload,
    restorations: 0,
    createdAt: Date.now(),
    lastVerifiedAt: Date.now(),
    failures: 0,
    nextAttemptAt: 0,
    channelMissing: false,
  };
  protectedMessages[record.recordId] = record;
  messageIdIndex.set(messageId, record.recordId);
  persistProtectedMessages();
  return record;
}

/**
 * Look up a protected-message record by its CURRENT live message id.
 * @param  {string} messageId
 * @return {Object|undefined}
 */
export function getProtectedMessageByMessageId(messageId) {
  const recordId = messageIdIndex.get(messageId);
  return recordId ? protectedMessages[recordId] : undefined;
}

/**
 * Shallow-merge a patch into a protected-message record and persist.
 * Keeps the messageId index in sync when messageId changes (i.e. on a
 * successful restoration).
 *
 * @param  {string} recordId
 * @param  {Object} patch
 * @return {Object|undefined} the updated record
 */
export function updateProtectedMessage(recordId, patch) {
  const record = protectedMessages[recordId];
  if (!record) return undefined;

  if (patch.messageId && patch.messageId !== record.messageId) {
    messageIdIndex.delete(record.messageId);
    messageIdIndex.set(patch.messageId, recordId);
  }

  Object.assign(record, patch);
  persistProtectedMessages();
  return record;
}

/**
 * Stop tracking a record entirely (only for bot-initiated deletes of
 * protected content — never used for user tamper attempts).
 * @param {string} recordId
 */
export function removeProtectedMessage(recordId) {
  const record = protectedMessages[recordId];
  if (!record) return;
  messageIdIndex.delete(record.messageId);
  delete protectedMessages[recordId];
  persistProtectedMessages();
}

/**
 * @return {Object[]} every tracked record
 */
export function getAllProtectedMessages() {
  return Object.values(protectedMessages);
}

/**
 * Mark every record in a channel as un-repostable because the channel
 * itself is gone. Records are kept — they remain the audit content — but
 * the sweep stops burning API budget trying to repost into a dead channel.
 * @param {string} channelId
 */
export function markChannelMissing(channelId) {
  let changed = false;
  for (const record of Object.values(protectedMessages)) {
    if (record.channelId === channelId && !record.channelMissing) {
      record.channelMissing = true;
      changed = true;
    }
  }
  if (changed) persistProtectedMessages();
}

// ── Pure helpers (unit-testable, no I/O) ────────────

const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

/**
 * Exponential backoff with jitter, capped, for retrying a failed repost.
 * @param  {number} failures — consecutive failure count (>= 1)
 * @return {number} delay in ms before the next attempt
 */
export function computeBackoffMs(failures) {
  const exp = Math.min(
    BASE_BACKOFF_MS * 2 ** Math.max(0, failures - 1),
    MAX_BACKOFF_MS
  );
  const jitter = 0.8 + Math.random() * 0.4; // 0.8x .. 1.2x
  return Math.round(Math.min(exp * jitter, MAX_BACKOFF_MS));
}

/**
 * Age-tiered re-verification cadence: freshly-created records are checked
 * every sweep, older ones progressively less often. Keeps sweep cost O(1)
 * regardless of how many records have accumulated.
 *
 * @param  {Object} record
 * @param  {number} now
 * @return {boolean}
 */
export function shouldVerify(record, now) {
  if (record.channelMissing) return false;
  if (record.nextAttemptAt && now < record.nextAttemptAt) return false;

  const age = now - record.createdAt;
  const sinceVerified = now - record.lastVerifiedAt;

  let cadenceMs;
  if (age < 24 * 60 * 60 * 1000)
    cadenceMs = 0; // < 1 day old: every sweep
  else if (age < 7 * 24 * 60 * 60 * 1000)
    cadenceMs = 60 * 60 * 1000; // < 1 week: hourly
  else if (age < 30 * 24 * 60 * 60 * 1000)
    cadenceMs = 6 * 60 * 60 * 1000; // < 1 month: every 6h
  else cadenceMs = 24 * 60 * 60 * 1000; // older: daily

  return sinceVerified >= cadenceMs;
}

/**
 * Pick which due records to verify this sweep, bounded by a budget so sweep
 * cost stays O(1) regardless of total record count. Least-recently-verified
 * first.
 *
 * @param  {Object[]} records
 * @param  {number}   now
 * @param  {number}   budget — max records to return
 * @return {Object[]}
 */
export function selectDueRecords(records, now, budget) {
  return records
    .filter((r) => shouldVerify(r, now))
    .sort((a, b) => a.lastVerifiedAt - b.lastVerifiedAt)
    .slice(0, budget);
}

// ═══════════════════════════════════════════════════
//  Audit log (server → channel mapping)
// ═══════════════════════════════════════════════════
// Shape: { "<serverId>": { enabled, channelId, enabledAt, knownBans: string[] } }
// Stoat/Revolt has no native audit log — this workaround relays moderation
// events to a channel chosen by an admin/mod via /enable-auditlog.

let auditLogs = readJSON(AUDITLOG_PATH, {});

/**
 * Enable audit logging for a server, directing it to a channel.
 * @param  {string} serverId
 * @param  {string} channelId
 * @return {{wasEnabled: boolean, previousChannelId: string|null, changed: boolean}}
 */
export function enableAuditLog(serverId, channelId) {
  const existing = auditLogs[serverId];
  const wasEnabled = existing?.enabled === true;
  const previousChannelId = wasEnabled ? existing.channelId : null;

  auditLogs[serverId] = {
    enabled: true,
    channelId,
    enabledAt: new Date().toISOString(),
    knownBans: existing?.knownBans ?? [],
  };
  writeJSON(AUDITLOG_PATH, auditLogs);

  return {
    wasEnabled,
    previousChannelId,
    changed: !wasEnabled || previousChannelId !== channelId,
  };
}

// Unified /AuditLog command name for the same persisted server → channel seam.
export const setAuditLogChannel = enableAuditLog;

/**
 * Disable audit logging for a server.
 * @param {string} serverId
 */
export function disableAuditLog(serverId) {
  if (auditLogs[serverId]) {
    auditLogs[serverId].enabled = false;
  }
  writeJSON(AUDITLOG_PATH, auditLogs);
}

/**
 * Whether audit logging is enabled for a server.
 * @param  {string} serverId
 * @return {boolean}
 */
export function isAuditLogEnabled(serverId) {
  return auditLogs[serverId]?.enabled === true;
}

/**
 * Get the channel audit events should be posted to for a server.
 * @param  {string} serverId
 * @return {string|null}
 */
export function getAuditLogChannel(serverId) {
  const entry = auditLogs[serverId];
  return entry?.enabled ? entry.channelId : null;
}

/**
 * List all servers with audit logging currently enabled.
 * @return {{serverId: string, channelId: string}[]}
 */
export function getAuditLogServers() {
  return Object.entries(auditLogs)
    .filter(([, v]) => v.enabled)
    .map(([serverId, v]) => ({ serverId, channelId: v.channelId }));
}

/**
 * Get the last-known set of banned user IDs for a server (for unban diffing).
 * @param  {string} serverId
 * @return {string[]}
 */
export function getKnownBans(serverId) {
  return Array.isArray(auditLogs[serverId]?.knownBans)
    ? auditLogs[serverId].knownBans
    : [];
}

/**
 * Persist a fresh snapshot of banned user IDs for a server.
 * @param {string}   serverId
 * @param {string[]} userIds
 */
export function setKnownBans(serverId, userIds) {
  if (!auditLogs[serverId]) return;
  auditLogs[serverId].knownBans = userIds;
  writeJSON(AUDITLOG_PATH, auditLogs);
}

// ═══════════════════════════════════════════════════
//  Server-settings audit snapshots
// ═══════════════════════════════════════════════════
// These snapshots contain only non-secret server configuration. They let the
// audit monitor compare fresh REST state after a restart or gateway outage.

let serverSettingsSnapshots = readJSON(SETTINGS_SNAPSHOTS_PATH, {});

export function getServerSettingsSnapshot(serverId) {
  const snapshot = serverSettingsSnapshots[serverId];
  return snapshot && typeof snapshot === "object"
    ? structuredClone(snapshot)
    : null;
}

export function setServerSettingsSnapshot(serverId, snapshot) {
  serverSettingsSnapshots[serverId] = structuredClone(snapshot);
  writeJSON(SETTINGS_SNAPSHOTS_PATH, serverSettingsSnapshots);
}

export function removeServerSettingsSnapshot(serverId) {
  if (!serverSettingsSnapshots[serverId]) return;
  delete serverSettingsSnapshots[serverId];
  writeJSON(SETTINGS_SNAPSHOTS_PATH, serverSettingsSnapshots);
}

// ═══════════════════════════════════════════════════
//  Anti-raid automod
// ═══════════════════════════════════════════════════
// Configuration shape:
// { "<serverId>": { mode: "off"|"monitor"|"enforce",
//                    logChannelId: string|null, quorum: 1|2, updatedAt } }
// Cases intentionally omit message content. The protected logger entry is the
// durable evidence record; this file only keeps short-lived approval state.

export const AUTOMOD_MODES = new Set(["off", "monitor", "enforce"]);

let automodConfigs = readJSON(AUTOMOD_PATH, {});
let automodCases = readJSON(AUTOMOD_CASES_PATH, {});
let automodStrikes = readJSON(AUTOMOD_STRIKES_PATH, {});
let moderationActions = readJSON(MODERATION_ACTIONS_PATH, {});
let spamReports = readJSON(SPAM_REPORTS_PATH, {});
const MAX_AUTOMOD_CASES = 5_000;
const MAX_MODERATION_ACTIONS = 5_000;
export const SPAM_REPORT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const MAX_SPAM_REPORTS = 10_000;

function normaliseAutomodConfig(value = {}) {
  return {
    mode: AUTOMOD_MODES.has(value.mode) ? value.mode : "off",
    logChannelId:
      typeof value.logChannelId === "string" ? value.logChannelId : null,
    quorum: value.quorum === 1 ? 1 : 2,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

export function getAutomodConfig(serverId) {
  return normaliseAutomodConfig(automodConfigs[serverId]);
}

export function setAutomodConfig(serverId, patch = {}) {
  const previous = getAutomodConfig(serverId);
  const next = normaliseAutomodConfig({
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  automodConfigs[serverId] = next;
  writeJSON(AUTOMOD_PATH, automodConfigs);
  return { previous, current: next };
}

function persistAutomodCases() {
  writeJSON(AUTOMOD_CASES_PATH, automodCases);
}

export function createAutomodCase(record) {
  pruneAutomodCases();
  automodCases[record.caseId] = structuredClone(record);
  const excess = Object.keys(automodCases).length - MAX_AUTOMOD_CASES;
  if (excess > 0) {
    const oldest = Object.values(automodCases)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      .slice(0, excess);
    for (const entry of oldest) delete automodCases[entry.caseId];
  }
  persistAutomodCases();
  return structuredClone(automodCases[record.caseId]);
}

export function getAutomodCase(caseId) {
  const record = automodCases[caseId];
  return record ? structuredClone(record) : null;
}

export function updateAutomodCase(caseId, patch = {}) {
  const record = automodCases[caseId];
  if (!record) return null;
  automodCases[caseId] = { ...record, ...structuredClone(patch) };
  persistAutomodCases();
  return structuredClone(automodCases[caseId]);
}

export function findAutomodCaseByPromptMessage(messageId) {
  const record = Object.values(automodCases).find(
    (entry) => entry.promptMessageId === messageId
  );
  return record ? structuredClone(record) : null;
}

export function findActiveAutomodCase(serverId, userId, now = Date.now()) {
  const record = Object.values(automodCases)
    .filter(
      (entry) =>
        entry.serverId === serverId &&
        entry.userId === userId &&
        Number.isFinite(entry.dedupeUntil) &&
        entry.dedupeUntil > now
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return record ? structuredClone(record) : null;
}

export function pruneAutomodCases(now = Date.now()) {
  let changed = false;
  for (const [caseId, record] of Object.entries(automodCases)) {
    if (!Number.isFinite(record.dedupeUntil) || record.dedupeUntil <= now) {
      delete automodCases[caseId];
      changed = true;
    } else if (
      record.status === "pending" &&
      Number.isFinite(record.expiresAt) &&
      record.expiresAt <= now
    ) {
      record.status = "expired";
      changed = true;
    }
  }
  if (changed) persistAutomodCases();
}

function automodStrikeKey(serverId, userId) {
  return `${serverId}:${userId}`;
}

export function getAutomodStrike(serverId, userId) {
  const record = automodStrikes[automodStrikeKey(serverId, userId)];
  if (!record) return null;
  return {
    serverId,
    userId,
    level: Math.max(1, Math.min(4, Number(record.level) || 1)),
    lastContainedAt: Number(record.lastContainedAt) || null,
    timeoutUntil: Number(record.timeoutUntil) || null,
  };
}

export function setAutomodStrike(serverId, userId, record) {
  const key = automodStrikeKey(serverId, userId);
  automodStrikes[key] = {
    serverId,
    userId,
    level: Math.max(1, Math.min(4, Number(record?.level) || 1)),
    lastContainedAt: Number(record?.lastContainedAt) || Date.now(),
    timeoutUntil: Number(record?.timeoutUntil) || null,
  };
  writeJSON(AUTOMOD_STRIKES_PATH, automodStrikes);
  return structuredClone(automodStrikes[key]);
}

export function clearAutomodStrike(serverId, userId) {
  const key = automodStrikeKey(serverId, userId);
  if (!automodStrikes[key]) return false;
  delete automodStrikes[key];
  writeJSON(AUTOMOD_STRIKES_PATH, automodStrikes);
  return true;
}

export function cancelAutomodCasesForMember(
  serverId,
  userId,
  now = Date.now()
) {
  let cancelled = 0;
  for (const record of Object.values(automodCases)) {
    if (
      record.serverId === serverId &&
      record.userId === userId &&
      record.status === "pending"
    ) {
      record.status = "released";
      record.releasedAt = now;
      cancelled += 1;
    }
  }
  if (cancelled) persistAutomodCases();
  return cancelled;
}

// ═══════════════════════════════════════════════════
//  Member spam reports
// ═══════════════════════════════════════════════════
// Reports intentionally persist correlation metadata only. The member-supplied
// reason lives solely inside the protected audit record referenced here.

function persistSpamReports() {
  writeJSON(SPAM_REPORTS_PATH, spamReports);
}

export function selectRetainedSpamReports(
  records,
  now = Date.now(),
  maxRecords = MAX_SPAM_REPORTS
) {
  const cutoff = now - SPAM_REPORT_RETENTION_MS;
  const limit = Math.max(0, maxRecords);
  const retained = Object.values(records ?? {})
    .filter(
      (record) =>
        Number.isFinite(record.createdAt) && record.createdAt >= cutoff
    )
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .slice(limit === 0 ? 0 : -limit);
  if (limit === 0) return {};
  return Object.fromEntries(
    retained.map((record) => [record.reportId, structuredClone(record)])
  );
}

export function pruneSpamReports(now = Date.now()) {
  const retained = selectRetainedSpamReports(spamReports, now);
  if (Object.keys(retained).length === Object.keys(spamReports).length) return;
  spamReports = retained;
  persistSpamReports();
}

export function createSpamReport(record) {
  pruneSpamReports(record?.createdAt ?? Date.now());
  spamReports[record.reportId] = structuredClone(record);
  spamReports = selectRetainedSpamReports(
    spamReports,
    record?.createdAt ?? Date.now()
  );
  persistSpamReports();
  return structuredClone(spamReports[record.reportId]);
}

export function getRecentSpamReports(serverId, since = 0) {
  return Object.values(spamReports)
    .filter(
      (record) =>
        record.serverId === serverId &&
        Number.isFinite(record.createdAt) &&
        record.createdAt >= since
    )
    .map((record) => structuredClone(record));
}

export function findRecentSpamReport(
  serverId,
  reporterId,
  targetId,
  since = 0
) {
  const record = Object.values(spamReports).find(
    (entry) =>
      entry.serverId === serverId &&
      entry.reporterId === reporterId &&
      entry.targetId === targetId &&
      Number.isFinite(entry.createdAt) &&
      entry.createdAt >= since
  );
  return record ? structuredClone(record) : null;
}

export function getAllSpamReports() {
  return Object.values(spamReports).map((record) => structuredClone(record));
}

function persistModerationActions() {
  writeJSON(MODERATION_ACTIONS_PATH, moderationActions);
}

export function createModerationAction(record) {
  pruneModerationActions();
  moderationActions[record.actionId] = structuredClone(record);
  const excess = Object.keys(moderationActions).length - MAX_MODERATION_ACTIONS;
  if (excess > 0) {
    const oldest = Object.values(moderationActions)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      .slice(0, excess);
    for (const entry of oldest) delete moderationActions[entry.actionId];
  }
  persistModerationActions();
  return structuredClone(moderationActions[record.actionId]);
}

export function getModerationAction(actionId) {
  const record = moderationActions[actionId];
  return record ? structuredClone(record) : null;
}

export function findModerationActionByMessage(messageId) {
  const record = Object.values(moderationActions).find(
    (entry) =>
      entry.logMessageId === messageId ||
      protectedMessages[entry.logMessageId]?.messageId === messageId
  );
  return record ? structuredClone(record) : null;
}

export function updateModerationAction(actionId, patch = {}) {
  const record = moderationActions[actionId];
  if (!record) return null;
  moderationActions[actionId] = { ...record, ...structuredClone(patch) };
  persistModerationActions();
  return structuredClone(moderationActions[actionId]);
}

export function pruneModerationActions(now = Date.now()) {
  let changed = false;
  for (const [actionId, record] of Object.entries(moderationActions)) {
    const retentionUntil = Number(record.retentionUntil ?? record.expiresAt);
    if (!Number.isFinite(retentionUntil) || retentionUntil <= now) {
      delete moderationActions[actionId];
      changed = true;
    } else if (
      record.status === "active" &&
      Number.isFinite(record.expiresAt) &&
      record.expiresAt <= now
    ) {
      record.status = "expired";
      changed = true;
    }
  }
  if (changed) persistModerationActions();
}
