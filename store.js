// store.js — Lightweight JSON-file persistence for channel config & known codes
// ──────────────────────────────────────────────────────────────────────────────
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
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
const MODERATION_LEVEL_PATH = join(DATA_DIR, "moderation_level.json");
const POST_GATE_PATH = join(DATA_DIR, "post_gate.json");
const POST_GATE_QUEUE_PATH = join(DATA_DIR, "post_gate_queue.json");
const POST_GATE_USER_HOLDS_PATH = join(DATA_DIR, "post_gate_user_holds.json");
// Operator-maintained, never written by the bot. See website docs for the shape.
const PROHIBITED_TERMS_PATH = join(DATA_DIR, "prohibited_terms.json");
const PRIVACY_DIGEST_PATH = join(DATA_DIR, "privacy_digest.json");

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
 * @param {{content?: string, embeds?: object[], attachments?: string[]}} payload
 *   pristine payload, no tamper notice
 * @param {Object|null} restorationPayload payload safe to resend after media deletion
 * @return {Object} the created record
 */
export function addProtectedMessage(
  channelId,
  messageId,
  payload,
  restorationPayload = null
) {
  const record = {
    recordId: messageId,
    channelId,
    messageId,
    payload,
    restorationPayload,
    mediaLost: false,
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

/** Look up a protected record by its stable original id. */
export function getProtectedMessageByRecordId(recordId) {
  return protectedMessages[recordId];
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

// ═══════════════════════════════════════════════════
//  Legacy moderation posture compatibility
// ═══════════════════════════════════════════════════
// { "<serverId>": { level: 1|2|3, tenureDays, updatedAt, updatedBy } }
// Kept readable so deployments that briefly persisted the retired
// threshold/kick policy do not lose data during rollback. Runtime enforcement
// uses the Post Gate configuration below.

export const MODERATION_LEVELS = Object.freeze([1, 2, 3]);
export const DEFAULT_TENURE_DAYS = 7;
export const MIN_TENURE_DAYS = 1;
export const MAX_TENURE_DAYS = 30;

let moderationLevels = readJSON(MODERATION_LEVEL_PATH, {});

function normaliseModerationLevel(value = {}) {
  const level = Number(value.level);
  const tenureDays = Number(value.tenureDays);
  return {
    level: MODERATION_LEVELS.includes(level) ? level : 1,
    tenureDays: Number.isFinite(tenureDays)
      ? Math.max(
          MIN_TENURE_DAYS,
          Math.min(MAX_TENURE_DAYS, Math.trunc(tenureDays))
        )
      : DEFAULT_TENURE_DAYS,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    updatedBy: typeof value.updatedBy === "string" ? value.updatedBy : null,
  };
}

export function getModerationLevel(serverId) {
  return normaliseModerationLevel(moderationLevels[serverId]);
}

export function setModerationLevel(serverId, patch = {}) {
  const previous = getModerationLevel(serverId);
  const next = normaliseModerationLevel({
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  moderationLevels[serverId] = next;
  writeJSON(MODERATION_LEVEL_PATH, moderationLevels);
  return { previous, current: next };
}

// ═══════════════════════════════════════════════════
//  Post gate — held first-post review queue (post-gate.js)
// ═══════════════════════════════════════════════════

export const POST_GATE_MODES = new Set(["off", "hold"]);
export const POST_GATE_LEVELS = new Set([0, 1, 2, 3, 4]);
const MAX_HELD_POSTS = 1_000;

let postGateConfigs = readJSON(POST_GATE_PATH, {});
let postGateQueue = readJSON(POST_GATE_QUEUE_PATH, {});

let migratedLegacyHeldAttachments = false;
for (const record of Object.values(postGateQueue)) {
  if (!Array.isArray(record?.attachments)) continue;
  record.attachments = record.attachments.map((attachment) => {
    if (typeof attachment?.evidencePath !== "string") return attachment;
    migratedLegacyHeldAttachments = true;
    const metadata = { ...attachment };
    delete metadata.evidencePath;
    delete metadata.url;
    return {
      ...metadata,
      archiveAttachmentId: null,
      archiveUrl: null,
      archiveRecordId: null,
      skipReason: "legacy_purged",
    };
  });
}
if (migratedLegacyHeldAttachments) {
  writeJSON(POST_GATE_QUEUE_PATH, postGateQueue);
}

function normalisePostGateConfig(value = {}) {
  const mode = POST_GATE_MODES.has(value.mode) ? value.mode : "off";
  const parsedLevel = Number(value.level);
  const level =
    mode === "off"
      ? 0
      : POST_GATE_LEVELS.has(parsedLevel) && parsedLevel > 0
        ? parsedLevel
        : 1;
  const defaultSendLock =
    value.defaultSendLock &&
    typeof value.defaultSendLock === "object" &&
    typeof value.defaultSendLock.restoreOnUnlock === "boolean"
      ? {
          restoreOnUnlock: value.defaultSendLock.restoreOnUnlock,
          capturedAt:
            typeof value.defaultSendLock.capturedAt === "string"
              ? value.defaultSendLock.capturedAt
              : null,
        }
      : null;
  return {
    mode,
    level,
    defaultSendLock,
    reviewChannelId:
      typeof value.reviewChannelId === "string" ? value.reviewChannelId : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

let migratedPostGateConfigs = false;
for (const [serverId, value] of Object.entries(postGateConfigs)) {
  const normalised = normalisePostGateConfig(value);
  if (JSON.stringify(value) !== JSON.stringify(normalised)) {
    postGateConfigs[serverId] = normalised;
    migratedPostGateConfigs = true;
  }
}
if (migratedPostGateConfigs) writeJSON(POST_GATE_PATH, postGateConfigs);

export function getPostGateConfig(serverId) {
  return normalisePostGateConfig(postGateConfigs[serverId]);
}

export function getAllPostGateConfigs() {
  return Object.entries(postGateConfigs).map(([serverId, value]) => ({
    serverId,
    ...normalisePostGateConfig(value),
  }));
}

export function setPostGateConfig(serverId, patch = {}) {
  const previous = getPostGateConfig(serverId);
  const next = normalisePostGateConfig({
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  postGateConfigs[serverId] = next;
  writeJSON(POST_GATE_PATH, postGateConfigs);
  return { previous, current: next };
}

function persistPostGateQueue() {
  writeJSON(POST_GATE_QUEUE_PATH, postGateQueue);
}

export function createHeldPost(record) {
  postGateQueue[record.queueId] = structuredClone(record);
  const excess = Object.keys(postGateQueue).length - MAX_HELD_POSTS;
  if (excess > 0) {
    const oldest = Object.values(postGateQueue)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      .slice(0, excess);
    for (const entry of oldest) delete postGateQueue[entry.queueId];
  }
  persistPostGateQueue();
  return structuredClone(postGateQueue[record.queueId]);
}

export function getHeldPost(queueId) {
  const record = postGateQueue[queueId];
  return record ? structuredClone(record) : null;
}

export function updateHeldPost(queueId, patch = {}) {
  const record = postGateQueue[queueId];
  if (!record) return null;
  postGateQueue[queueId] = { ...record, ...structuredClone(patch) };
  persistPostGateQueue();
  return structuredClone(postGateQueue[queueId]);
}

export function findHeldPostByReviewMessage(reviewMessageId) {
  const record = Object.values(postGateQueue).find(
    (entry) => entry.reviewMessageId === reviewMessageId
  );
  return record ? structuredClone(record) : null;
}

export function getPendingHeldPosts(serverId) {
  return Object.values(postGateQueue)
    .filter(
      (entry) => entry.serverId === serverId && entry.status === "pending"
    )
    .map((entry) => structuredClone(entry));
}

const RESOLVED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Return the pending entries whose review window has elapsed, without
 * mutating them — the caller (post-gate.js) owns sending the expiry notice
 * and review-card cleanup, then reports the outcome back via updateHeldPost.
 */
export function getExpiredPendingPosts(now = Date.now()) {
  return Object.values(postGateQueue)
    .filter(
      (record) =>
        record.status === "pending" &&
        Number.isFinite(record.expiresAt) &&
        record.expiresAt <= now
    )
    .map((record) => structuredClone(record));
}

/**
 * Drop resolved entries once they've sat resolved past the retention
 * window. Legacy evidence paths are no longer acted on; callers retain the
 * array return for compatibility with stores written by older releases.
 * @param {number} now
 * @return {string[]}
 */
export function prunePostGateQueue(now = Date.now()) {
  const evidencePaths = [];
  let changed = false;
  for (const [queueId, record] of Object.entries(postGateQueue)) {
    const resolvedLongAgo =
      record.status !== "pending" &&
      Number.isFinite(record.reviewedAt) &&
      now - record.reviewedAt > RESOLVED_RETENTION_MS;
    if (resolvedLongAgo) {
      for (const attachment of record.attachments ?? []) {
        if (typeof attachment?.evidencePath === "string") {
          evidencePaths.push(attachment.evidencePath);
        }
      }
      delete postGateQueue[queueId];
      changed = true;
    }
  }
  if (changed) persistPostGateQueue();
  return evidencePaths;
}

// ═══════════════════════════════════════════════════
//  Post gate — full-user holds (post-gate.js)
// ═══════════════════════════════════════════════════
// When a moderator denies a held post with "deny + hold user", every later
// message from that member is held until a moderator releases them. The state
// lives here rather than in memory so it survives a restart, and it is keyed
// "serverId:userId" — the same convention automod_strikes.json uses — so
// leaving and rejoining the server changes nothing.

const MAX_USER_HOLDS = 1_000;
const STORE_SAFE_ID = /^[A-Za-z0-9]+$/;

let postGateUserHolds = readJSON(POST_GATE_USER_HOLDS_PATH, {});

function userHoldKey(serverId, userId) {
  return `${serverId}:${userId}`;
}

function safeStoreId(value) {
  return typeof value === "string" && STORE_SAFE_ID.test(value) ? value : null;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function normalisePostGateUserHold(value = {}) {
  return {
    serverId: safeStoreId(value.serverId),
    userId: safeStoreId(value.userId),
    active: value.active === true,
    heldAt: finiteOrNull(value.heldAt),
    heldBy: safeStoreId(value.heldBy),
    originQueueId: safeStoreId(value.originQueueId),
    originMessageId: safeStoreId(value.originMessageId),
    cardChannelId: safeStoreId(value.cardChannelId),
    cardMessageId: safeStoreId(value.cardMessageId),
    reminderAt: finiteOrNull(value.reminderAt),
    reminderCount:
      Number.isFinite(value.reminderCount) && value.reminderCount > 0
        ? Math.min(Math.floor(value.reminderCount), 1_000)
        : 0,
    lastReminderMessageId: safeStoreId(value.lastReminderMessageId),
    releasedAt: finiteOrNull(value.releasedAt),
    releasedBy: safeStoreId(value.releasedBy),
    releaseReason:
      typeof value.releaseReason === "string" ? value.releaseReason : null,
  };
}

let migratedUserHolds = false;
for (const [key, value] of Object.entries(postGateUserHolds)) {
  const normalised = normalisePostGateUserHold(value);
  if (JSON.stringify(value) !== JSON.stringify(normalised)) {
    postGateUserHolds[key] = normalised;
    migratedUserHolds = true;
  }
}
if (migratedUserHolds) writeJSON(POST_GATE_USER_HOLDS_PATH, postGateUserHolds);

function persistUserHolds() {
  writeJSON(POST_GATE_USER_HOLDS_PATH, postGateUserHolds);
}

/** Synchronous hot path: post-gate.js calls this for every message. */
export function isUserHeld(serverId, userId) {
  return postGateUserHolds[userHoldKey(serverId, userId)]?.active === true;
}

export function getUserHold(serverId, userId) {
  const record = postGateUserHolds[userHoldKey(serverId, userId)];
  return record ? normalisePostGateUserHold(record) : null;
}

/**
 * Idempotent by contract: an already-active hold is returned untouched so a
 * second "deny + hold user" can never duplicate the record or reset who placed
 * the hold and when.
 */
export function createUserHold(record = {}) {
  const normalised = normalisePostGateUserHold(record);
  if (!normalised.serverId || !normalised.userId) {
    return { created: false, record: null };
  }
  const key = userHoldKey(normalised.serverId, normalised.userId);
  const existing = postGateUserHolds[key];
  if (existing?.active) {
    return { created: false, record: normalisePostGateUserHold(existing) };
  }

  normalised.active = true;
  postGateUserHolds[key] = normalised;
  const excess = Object.keys(postGateUserHolds).length - MAX_USER_HOLDS;
  if (excess > 0) {
    const oldest = Object.entries(postGateUserHolds)
      .sort(([, a], [, b]) => (a.heldAt ?? 0) - (b.heldAt ?? 0))
      .slice(0, excess);
    for (const [staleKey] of oldest) delete postGateUserHolds[staleKey];
  }
  persistUserHolds();
  return { created: true, record: structuredClone(normalised) };
}

export function updateUserHold(serverId, userId, patch = {}) {
  const key = userHoldKey(serverId, userId);
  const record = postGateUserHolds[key];
  if (!record) return null;
  postGateUserHolds[key] = normalisePostGateUserHold({
    ...record,
    ...structuredClone(patch),
  });
  persistUserHolds();
  return structuredClone(postGateUserHolds[key]);
}

/**
 * Mark a hold inactive while keeping the record for audit. prunePostGateUserHolds
 * drops it once it has sat released past the shared retention window.
 */
export function releaseUserHold(
  serverId,
  userId,
  { releasedBy = null, releasedAt = Date.now(), reason = null } = {}
) {
  const key = userHoldKey(serverId, userId);
  const record = postGateUserHolds[key];
  if (!record?.active) {
    return { released: false, record: record ? structuredClone(record) : null };
  }
  postGateUserHolds[key] = normalisePostGateUserHold({
    ...record,
    active: false,
    releasedBy,
    releasedAt,
    releaseReason: reason,
    reminderAt: null,
  });
  persistUserHolds();
  return { released: true, record: structuredClone(postGateUserHolds[key]) };
}

/**
 * Reverse lookup for reaction dispatch, mirroring findHeldPostByReviewMessage.
 * A control card and a reminder card are distinguished so ⏳ ("continue
 * holding") can be accepted only where it is actually offered.
 */
export function findUserHoldByCardMessage(messageId) {
  if (!safeStoreId(messageId)) return null;
  for (const record of Object.values(postGateUserHolds)) {
    if (!record.active) continue;
    if (record.cardMessageId === messageId) {
      return { record: structuredClone(record), cardKind: "control" };
    }
    if (record.lastReminderMessageId === messageId) {
      return { record: structuredClone(record), cardKind: "reminder" };
    }
  }
  return null;
}

export function getActiveUserHolds(serverId) {
  return Object.values(postGateUserHolds)
    .filter(
      (record) =>
        record.active &&
        (serverId === undefined || record.serverId === serverId)
    )
    .map((record) => structuredClone(record));
}

export function getDueUserHoldReminders(now = Date.now()) {
  return Object.values(postGateUserHolds)
    .filter(
      (record) =>
        record.active &&
        Number.isFinite(record.reminderAt) &&
        record.reminderAt <= now
    )
    .map((record) => structuredClone(record));
}

export function prunePostGateUserHolds(now = Date.now()) {
  let changed = false;
  for (const [key, record] of Object.entries(postGateUserHolds)) {
    const releasedLongAgo =
      !record.active &&
      Number.isFinite(record.releasedAt) &&
      now - record.releasedAt > RESOLVED_RETENTION_MS;
    if (releasedLongAgo) {
      delete postGateUserHolds[key];
      changed = true;
    }
  }
  if (changed) persistUserHolds();
  return changed;
}

// ═══════════════════════════════════════════════════
//  Post gate — operator prohibited-term list (post-gate.js)
// ═══════════════════════════════════════════════════
// data/prohibited_terms.json is written by the operator, never by the bot, and
// *extends* the built-in seed list in prohibited-terms.js. readJSON is
// deliberately not reused here: it collapses a parse error into the fallback,
// which would make a file the operator broke indistinguishable from one they
// never created.

const MAX_TERM_FILE_ENTRIES = 500;

let prohibitedTermCache = null;
let prohibitedTermStat = null;
let warnedAboutTermFile = false;

function readProhibitedTermsFile() {
  if (!existsSync(PROHIBITED_TERMS_PATH)) {
    return { status: "missing", raw: null, error: null, signature: null };
  }
  try {
    const stats = statSync(PROHIBITED_TERMS_PATH);
    const raw = JSON.parse(readFileSync(PROHIBITED_TERMS_PATH, "utf-8"));
    return {
      status: "ok",
      raw: sanitiseObject(raw),
      error: null,
      signature: `${stats.mtimeMs}:${stats.size}`,
    };
  } catch (error) {
    return {
      status: "malformed",
      raw: null,
      error: error?.message ?? String(error),
      signature: null,
    };
  }
}

function normaliseTermEntries(values, { allowObjects }) {
  const entries = [];
  let skipped = 0;
  for (const value of Array.isArray(values) ? values : []) {
    if (entries.length >= MAX_TERM_FILE_ENTRIES) {
      skipped += 1;
      continue;
    }
    if (typeof value === "string") {
      const term = value.trim();
      if (term) entries.push(term);
      else skipped += 1;
      continue;
    }
    if (
      allowObjects &&
      value &&
      typeof value === "object" &&
      typeof value.term === "string" &&
      value.term.trim()
    ) {
      entries.push({
        term: value.term.trim(),
        ...(typeof value.id === "string" && value.id.trim()
          ? { id: value.id.trim() }
          : {}),
        ...(typeof value.tolerant === "boolean"
          ? { tolerant: value.tolerant }
          : {}),
      });
      continue;
    }
    skipped += 1;
  }
  return { entries, skipped };
}

function normaliseProhibitedTermList(file) {
  if (file.status !== "ok") {
    return {
      terms: [],
      allowlist: [],
      status: file.status,
      error: file.error,
      skipped: 0,
      loadedAt: Date.now(),
    };
  }
  const terms = normaliseTermEntries(file.raw?.terms, { allowObjects: true });
  const allowlist = normaliseTermEntries(file.raw?.allowlist, {
    allowObjects: false,
  });
  return {
    terms: terms.entries,
    allowlist: allowlist.entries,
    status: "ok",
    error: null,
    skipped: terms.skipped + allowlist.skipped,
    loadedAt: Date.now(),
  };
}

function loadProhibitedTermList() {
  const file = readProhibitedTermsFile();
  if (file.status === "malformed" && !warnedAboutTermFile) {
    warnedAboutTermFile = true;
    console.warn(
      `⚠️  Ignoring unreadable ${PROHIBITED_TERMS_PATH}: ${file.error}. The built-in prohibited-term list stays active.`
    );
  }
  if (file.status === "ok") warnedAboutTermFile = false;
  prohibitedTermStat = file.signature;
  prohibitedTermCache = normaliseProhibitedTermList(file);
  return prohibitedTermCache;
}

export function getProhibitedTermList() {
  if (!prohibitedTermCache) loadProhibitedTermList();
  return structuredClone(prohibitedTermCache);
}

/**
 * Re-read only when the file actually changed, so the hourly post-gate sweep
 * costs one stat() rather than a parse. `force` is used by /Post-Gate terms so
 * an operator can apply an edit without restarting the bot.
 */
export function reloadProhibitedTermList({ force = false } = {}) {
  if (!force && prohibitedTermCache) {
    let signature = null;
    try {
      if (existsSync(PROHIBITED_TERMS_PATH)) {
        const stats = statSync(PROHIBITED_TERMS_PATH);
        signature = `${stats.mtimeMs}:${stats.size}`;
      }
    } catch {
      signature = null;
    }
    if (signature === prohibitedTermStat) {
      return { changed: false, ...structuredClone(prohibitedTermCache) };
    }
  }
  return { changed: true, ...structuredClone(loadProhibitedTermList()) };
}

// ═══════════════════════════════════════════════════
//  Privacy exclusion digest state (channel-exclusion.js)
// ═══════════════════════════════════════════════════

let privacyDigestState = readJSON(PRIVACY_DIGEST_PATH, {});

export function getPrivacyDigestState(serverId) {
  const record = privacyDigestState[serverId];
  return {
    lastPostedAt: Number.isFinite(record?.lastPostedAt)
      ? record.lastPostedAt
      : null,
  };
}

export function setPrivacyDigestState(serverId, lastPostedAt) {
  privacyDigestState[serverId] = { lastPostedAt };
  writeJSON(PRIVACY_DIGEST_PATH, privacyDigestState);
}
