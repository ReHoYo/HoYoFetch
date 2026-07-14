// store.js — Lightweight JSON-file persistence for channel config & known codes
// ──────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Overridable so tests run hermetically and deployments can mount a volume.
const DATA_DIR = process.env.HOYOFETCH_DATA_DIR || join(__dirname, "data");

// Ensure the data directory exists
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ── Paths ──────────────────────────────────────────
const CHANNELS_PATH = join(DATA_DIR, "channels.json");
const KNOWN_CODES_PATH = join(DATA_DIR, "known_codes.json");
const SOURCE_CACHE_PATH = join(DATA_DIR, "source_cache.json");
const AUDITLOG_PATH = join(DATA_DIR, "auditlog.json");

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
// Shape: { "<channelId>": { enabled: true, scope: "all" | "hoyo" | "nte" } }

export const AUTO_FETCH_SCOPES = new Set(["all", "hoyo", "nte"]);

let channels = readJSON(CHANNELS_PATH, {});

function normaliseScope(scope) {
  return AUTO_FETCH_SCOPES.has(scope) ? scope : "all";
}

/**
 * Enable auto-fetch in a channel for the selected game scope.
 * @param {string} channelId
 * @param {"all"|"hoyo"|"nte"} scope
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
 * @return {"all"|"hoyo"|"nte"}
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

  const fresh = detectFreshCodes(gameKey, knownCodes[gameKey] || [], currentCodes);

  // Persist the full current set (replaces expired codes too)
  knownCodes[gameKey] = currentCodes;
  writeJSON(KNOWN_CODES_PATH, knownCodes);

  return fresh;
}

/**
 * Pure helper for comparing current source codes against a previous known set.
 * NTE is scraped from Game8, so casing drift there should not re-announce codes.
 *
 * @param  {string}   gameKey
 * @param  {string[]} previousCodes
 * @param  {string[]} currentCodes
 * @return {string[]} — only codes not represented in previousCodes
 */
export function detectFreshCodes(gameKey, previousCodes, currentCodes) {
  const previous = new Set(previousCodes.map((code) => getCodeIdentity(gameKey, code)));
  return currentCodes.filter((code) => !previous.has(getCodeIdentity(gameKey, code)));
}

function getCodeIdentity(gameKey, code) {
  const value = String(code ?? "").trim();
  return gameKey === "nte" ? value.toUpperCase() : value;
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
