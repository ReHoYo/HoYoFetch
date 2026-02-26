// store.js — Lightweight JSON-file persistence for channel config & known codes
// ──────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");

// Ensure the data directory exists
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ── Paths ──────────────────────────────────────────
const CHANNELS_PATH = join(DATA_DIR, "channels.json");
const KNOWN_CODES_PATH = join(DATA_DIR, "known_codes.json");

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

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

// ═══════════════════════════════════════════════════
//  Channel subscriptions
// ═══════════════════════════════════════════════════
// Shape: { "<channelId>": { "genshin": true, "hkrpg": true, ... } }

let channels = readJSON(CHANNELS_PATH, {});

/**
 * Enable auto-fetch in a channel for ALL games.
 * @param {string} channelId
 */
export function enableChannel(channelId) {
  channels[channelId] = channels[channelId] || {};
  channels[channelId].enabled = true;
  writeJSON(CHANNELS_PATH, channels);
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
 * Get an array of all enabled channel IDs.
 * @return {string[]}
 */
export function getEnabledChannels() {
  return Object.entries(channels)
    .filter(([, v]) => v.enabled)
    .map(([id]) => id);
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
  const previous = new Set(knownCodes[gameKey] || []);
  const fresh = currentCodes.filter((c) => !previous.has(c));

  // Persist the full current set (replaces expired codes too)
  knownCodes[gameKey] = currentCodes;
  writeJSON(KNOWN_CODES_PATH, knownCodes);

  return fresh;
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
