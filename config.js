// config.js — Centralised configuration for HoyoFetch
// ────────────────────────────────────────────────────
import { readFileSync, existsSync } from "fs";

// ── Load .env manually (no dotenv dependency) ──────
const ALLOWED_ENV_KEYS = new Set([
  "BOT_TOKEN",
  "PREFIX",
  "FETCH_INTERVAL",
  "FETCH_COOLDOWN",
  "EMOJI_MODE",
  "EMOJI_HUB_SERVER_ID",
  "HOYO_API_BASE",
  "EMERGENCY_SERVER_ID",
  "STOAT_API_BASE",
  "HOYOFETCH_DATA_DIR",
  "AUDITLOG_DEBUG",
  "AUDITLOG_EVIDENCE_MAX_MB",
  "POST_GATE_HOLD_REMINDER_HOURS",
]);

function loadEnv() {
  const envPath = new URL(".env", import.meta.url).pathname;
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes (single or double), matching dotenv behaviour
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    // Only set recognised keys to prevent overwriting sensitive Node.js env vars
    if (!ALLOWED_ENV_KEYS.has(key)) {
      console.warn(`⚠️  Ignoring unrecognised .env key: ${key}`);
      continue;
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

// ── Exported config ────────────────────────────────
const rawInterval = parseInt(process.env.FETCH_INTERVAL || "60", 10);
const fetchIntervalMinutes =
  Number.isFinite(rawInterval) && rawInterval >= 1
    ? Math.min(rawInterval, 1440)
    : 60;

if (fetchIntervalMinutes !== rawInterval) {
  console.warn(
    `⚠️  FETCH_INTERVAL clamped to ${fetchIntervalMinutes} (was ${process.env.FETCH_INTERVAL})`
  );
}

const rawCooldown = parseInt(process.env.FETCH_COOLDOWN || "10", 10);
const fetchCooldownSeconds =
  Number.isFinite(rawCooldown) && rawCooldown >= 0
    ? Math.min(rawCooldown, 3600)
    : 10;

const rawEvidenceMaxMb = Number(process.env.AUDITLOG_EVIDENCE_MAX_MB ?? "20");
const auditLogEvidenceMaxBytes =
  Number.isFinite(rawEvidenceMaxMb) && rawEvidenceMaxMb >= 0
    ? rawEvidenceMaxMb * 1024 * 1024
    : 20 * 1024 * 1024;

// How long a member may sit in full Post Gate before Irminsul reminds
// moderators that the hold is still standing. It never auto-releases.
const rawHoldReminder = parseInt(
  process.env.POST_GATE_HOLD_REMINDER_HOURS || "24",
  10
);
const postGateHoldReminderHours =
  Number.isFinite(rawHoldReminder) && rawHoldReminder >= 1
    ? Math.min(rawHoldReminder, 168)
    : 24;

if (
  process.env.POST_GATE_HOLD_REMINDER_HOURS &&
  postGateHoldReminderHours !== rawHoldReminder
) {
  console.warn(
    `⚠️  POST_GATE_HOLD_REMINDER_HOURS clamped to ${postGateHoldReminderHours} (was ${process.env.POST_GATE_HOLD_REMINDER_HOURS})`
  );
}

export const CONFIG = {
  token: process.env.BOT_TOKEN || "",
  prefix: process.env.PREFIX || "/",
  fetchIntervalMinutes,
  fetchCooldownSeconds,
  auditLogEvidenceMaxBytes,
  hoyoApiBase:
    process.env.HOYO_API_BASE || "https://hoyo-codes.seria.moe/codes",
  emergencyServerId: process.env.EMERGENCY_SERVER_ID || "",
  // This is Irminsul's own in-house emoji hub — not a secret, just a server
  // id — so it's pinned here rather than requiring every deployment to set
  // it. EMOJI_HUB_SERVER_ID still overrides it for a different install.
  emojiHubServerId:
    process.env.EMOJI_HUB_SERVER_ID || "01KJ9DNB94BTZ9594Z9YR93H9M",
  stoatApiBase: process.env.STOAT_API_BASE || "https://api.stoat.chat",
  postGateHoldReminderMs: postGateHoldReminderHours * 60 * 60 * 1_000,
};

// ═══════════════════════════════════════════════════
//  Emoji system
// ═══════════════════════════════════════════════════
// "unicode" → built-in fallback emoji (works everywhere, default)
// "custom"  → Revolt server custom emoji, auto-provisioned from icon URLs
//
// HOW TO SET UP CUSTOM EMOJI:
//   1. Create (or reuse) a Revolt server and invite this bot with
//      Manage Customisation, then set EMOJI_HUB_SERVER_ID to its id
//   2. Run `/EmojiSetup` in that server (or `npm run emoji:provision`)
//      to download icons from emoji-icons.js and upload them as emoji
//   3. Set EMOJI_MODE=custom in your .env file
//
// Provisioning persists provisioned ids to data/emoji_registry.json and
// calls setCustomEmojiRegistry() below so it applies without a restart.

// Runtime-mutable emoji mode (seeded from .env, toggleable via /EmojiMode).
let emojiMode = process.env.EMOJI_MODE === "custom" ? "custom" : "unicode";

export function getEmojiMode() {
  return emojiMode;
}

/**
 * Switch emoji rendering mode at runtime.
 * @param  {string}  mode — "unicode" or "custom"
 * @return {boolean} true if the mode was valid and applied
 */
export function setEmojiMode(mode) {
  if (mode !== "unicode" && mode !== "custom") return false;
  emojiMode = mode;
  return true;
}

const UNICODE_EMOJI = {
  // ── Genshin Impact ──────────────────────────────
  primogem: "💎",
  mora: "🪙",
  "hero's wit": "📕",
  "adventurer's experience": "📗",
  "mystic enhancement ore": "🔮",
  "fine enhancement ore": "🔷",
  resin: "🌙",
  // ── Honkai: Star Rail ───────────────────────────
  "stellar jade": "💎",
  credit: "🪙",
  "traveler's guide": "📕",
  "adventure log": "📗",
  "refined aether": "🔮",
  "condensed aether": "🔷",
  "trailblaze power": "⚡",
  // ── Zenless Zone Zero ───────────────────────────
  polychrome: "💎",
  dennies: "🪙",
  "senior investigator log": "📕",
  "w-engine energy module": "🔮",
  "battery charge": "⚡",
  // ── Honkai Impact 3rd ───────────────────────────
  crystal: "💎",
  asterite: "🪙",
  "stamina potion": "⚡",
  coin: "🪙",
  stamina: "⚡",
  mithril: "🔷",
  // ── Neverness to Everness ───────────────────────
  annulith: "💎",
  fons: "🪙",
  "beetle coin": "🪙",
  "rising hunter guide": "📕",
  "senior hunter guide": "📕",
  "elite hunter guide": "📕",
  "light dye": "🔷",
  "colorless dye": "🔷",
  "colourless dye": "🔷",
  "chaotic dye": "🔮",
  dynamik: "⚡",
  "clicky fries": "🍟",
  // ── Wuthering Waves ─────────────────────────────
  astrite: "💎",
  "shell credit": "🪙",
  "resonance potion": "🧪",
  "revival inhaler": "❤️",
  "energy bag": "⚡",
  "energy core": "🔮",
  "sealed tube": "🔮",
  tuner: "🔧",
  "nutrient block": "🍱",
};

// Pre-provisioning fallback: emoji already uploaded to the historical hub
// before /EmojiSetup existed. setCustomEmojiRegistry() merges the live
// provisioned registry over this seed, so these ids keep working even with
// an empty data/ directory, and provisioning only ever adds or replaces.
// Format: bare ULID — getCustomEmojiRegistry() wraps it as ":ULID:".
const SEED_CUSTOM_EMOJI = {
  // ── Genshin Impact ──────────────────────────────
  primogem: "01KJ9DT9PFV146B7RT8E7GF5RK",
  mora: "01KJ9DTH3SJ3QWNYG63HCBQE2K",
  "hero's wit": "01KJ9H1PJ7Z7KCYS1DGDWD9MRS",
  "adventurer's experience": "01KJ9H0T8V0HFZHWPYS49K10S0",
  // ── Honkai: Star Rail ───────────────────────────
  "stellar jade": "01KJ9E3A1G9QZ31YXH2SWGNMYH",
  credit: "01KJ9E3ZDQ58WJE7T88N2DCAK4",
  // ── Zenless Zone Zero ───────────────────────────
  polychrome: "01KJ9DWBQAH7RRY47Z7WXTSE3B",
  dennies: "01KJ9DVYCN9Q1Y3DKP8ATGPRJC",
  // ── Honkai Impact 3rd ───────────────────────────
  crystal: "01KJ9EYTYBY44P9QN9PTAHCWHR",
  asterite: "01KJ9GZCP7CMNT9506X9GGQDFJ",
  coin: "01KJ9EYMKX900EDHY97FRE3JTZ",
};

const EMOJI_ID_PATTERN = /^:[A-Za-z0-9]{1,64}:$/;

function seedRegistry() {
  return Object.fromEntries(
    Object.entries(SEED_CUSTOM_EMOJI).map(([keyword, id]) => [
      keyword,
      `:${id}:`,
    ])
  );
}

// Runtime-mutable custom emoji registry. Seeded from the hardcoded fallback
// above; /EmojiSetup (via provisionEmoji) merges its results on top with
// setCustomEmojiRegistry(), and bot.js re-applies the persisted registry on
// every start.
let customEmojiRegistry = seedRegistry();

/**
 * Replace the live custom emoji registry, merged over the hardcoded seed so
 * un-provisioned keywords keep their pre-existing id. Malformed entries
 * (wrong shape, not ":ID:") are dropped rather than applied.
 *
 * @param  {Object<string,string>} map — { keyword: ":ULID:" }
 * @return {number} count of entries actually applied
 */
export function setCustomEmojiRegistry(map) {
  const next = seedRegistry();
  let applied = 0;
  for (const [keyword, value] of Object.entries(map ?? {})) {
    if (typeof keyword !== "string" || !keyword) continue;
    if (typeof value !== "string" || !EMOJI_ID_PATTERN.test(value)) continue;
    next[keyword] = value;
    applied += 1;
  }
  customEmojiRegistry = next;
  return applied;
}

export function getCustomEmojiRegistry() {
  return { ...customEmojiRegistry };
}

export function getEmojiMap() {
  if (emojiMode !== "custom") return UNICODE_EMOJI;

  const customOverrides = Object.fromEntries(
    Object.entries(customEmojiRegistry).filter(([, value]) => value)
  );
  return { ...UNICODE_EMOJI, ...customOverrides };
}

// ═══════════════════════════════════════════════════
//  Game definitions
// ═══════════════════════════════════════════════════

export const GAMES = {
  genshin: {
    key: "genshin",
    apiParam: "genshin",
    name: "Genshin Impact",
    colour: "#00BFFF",
    icon: "https://img-os-static.hoyolab.com/communityWeb/upload/1d7dd8f33c5ccdfdeac86e1e86ddd652.png",
    redeemUrl: "https://genshin.hoyoverse.com/en/gift?code=",
    source: "seria",
    // Human-readable article to point to when no source has reward text for
    // a code — distinct from sourceUrl, which is what a scraper hits.
    codesArticleUrl: "https://game8.co/games/Genshin-Impact/archives/304759",
    deprecated: false,
  },
  hkrpg: {
    key: "hkrpg",
    apiParam: "hkrpg",
    name: "Honkai: Star Rail",
    colour: "#FFD700",
    // The original img-os-static.hoyolab.com community-upload icon rotted
    // (404) — swapped for Game8's HSR hub icon, verified reachable.
    icon: "https://img.game8.co/3642210/daaaa1c27a3ad015412368150d5f712a.png/thumb",
    redeemUrl: "https://hsr.hoyoverse.com/gift?code=",
    source: "seria",
    codesArticleUrl: "https://game8.co/games/Honkai-Star-Rail/archives/410296",
    deprecated: false,
  },
  nap: {
    key: "nap",
    apiParam: "nap",
    name: "Zenless Zone Zero",
    colour: "#FF6347",
    // Same rot as hkrpg above — swapped for Game8's ZZZ hub icon.
    icon: "https://img.game8.co/3804018/ed32cdf4c8269ac713071bb4fb3b2358.png/thumb",
    redeemUrl: "https://zenless.hoyoverse.com/redemption?code=",
    source: "seria",
    codesArticleUrl: "https://game8.co/games/Zenless-Zone-Zero/archives/435683",
    deprecated: false,
  },
  honkai3rd: {
    key: "honkai3rd",
    apiParam: "honkai3rd",
    name: "Honkai Impact 3rd",
    colour: "#9B59B6",
    // Same rot as above, but Game8 has no HI3 hub to fall back to (its
    // page 404s) — the official site's favicon is the only verified
    // fallback found; lower quality than the others but at least live.
    icon: "https://honkaiimpact3.hoyoverse.com/favicon.ico",
    redeemUrl: null, // HI3 codes must be redeemed in-game
    redeemInstructions: "Account → Exchange Rewards",
    source: "hi3_multi",
    // Game8 has no HI3 codes article — this is the page Irminsul already scrapes.
    codesArticleUrl: "https://honkaiimpact3.fandom.com/wiki/Exchange_Rewards",
    deprecated: false,
  },
  nte: {
    key: "nte",
    apiParam: "nte",
    name: "Neverness to Everness",
    colour: "#00A884",
    icon: "https://img.game8.co/4490666/fa0365bacaedb0ccc466e4beb8de3c5e.png/show",
    redeemUrl: null,
    redeemInstructions: "Redeem Code menu",
    source: "game8",
    sourceUrl: "https://game8.co/games/Neverness-to-Everness/archives/593718",
    // Deliberately its own literal rather than aliasing sourceUrl, so the two
    // can diverge later without a silent behaviour change.
    codesArticleUrl:
      "https://game8.co/games/Neverness-to-Everness/archives/593718",
    deprecated: false,
  },
  wuwa: {
    key: "wuwa",
    apiParam: "wuwa",
    name: "Wuthering Waves",
    colour: "#5C9BB0",
    icon: "https://img.game8.co/4557859/22a71791e3bdd41f51c7b03a132cd368.png/show",
    redeemUrl: null,
    redeemInstructions: "Settings → Other Settings → Redemption Code",
    source: "game8",
    sourceUrl: "https://game8.co/games/Wuthering-Waves/archives/453149",
    codesArticleUrl: "https://game8.co/games/Wuthering-Waves/archives/453149",
    deprecated: false,
  },
};

export const HOYO_GAME_KEYS = ["genshin", "hkrpg", "nap", "honkai3rd"];
export const NTE_GAME_KEY = "nte";
export const WUWA_GAME_KEY = "wuwa";
export const GAME8_GAME_KEYS = [NTE_GAME_KEY, WUWA_GAME_KEY];

export const COMMAND_GAME_MAP = {
  fetchgi: "genshin",
  fetchhsr: "hkrpg",
  fetchzzz: "nap",
  fetchhi3: "honkai3rd",
  fetchnte: "nte",
  fetchwuwa: "wuwa",
};

// ═══════════════════════════════════════════════════
//  HI3 fallback sources (tried in order)
// ═══════════════════════════════════════════════════

export const HI3_SOURCES = [
  {
    // 1. torikushiii/hoyoverse-api — community REST API, actively maintained
    name: "ennead API",
    url: "https://api.ennead.cc/mihoyo/honkai/codes",
    type: "json",
  },
  {
    // 2. Fandom Wiki — scrape HTML table as fallback
    name: "Fandom Wiki",
    url: "https://honkaiimpact3.fandom.com/wiki/Exchange_Rewards",
    type: "wiki",
  },
];

// ═══════════════════════════════════════════════════
//  Reward backfill sources
// ═══════════════════════════════════════════════════
// The primary source for a game sometimes omits reward text for a code (e.g.
// seria periodically returns rewards: "" for an otherwise-valid code). When
// that happens, fetchCodes consults a secondary source here and fills in by
// code identity. Games with no entry (nte/wuwa) fall back to the code
// article link instead — Game8 already *is* the human-readable source there.
export const REWARD_BACKFILL_SOURCES = {
  genshin: {
    name: "ennead API",
    url: "https://api.ennead.cc/mihoyo/genshin/codes",
    type: "json",
    cacheKey: "ennead:genshin",
    cacheTtlMs: 30 * 60 * 1000,
  },
  hkrpg: {
    name: "ennead API",
    url: "https://api.ennead.cc/mihoyo/starrail/codes",
    type: "json",
    cacheKey: "ennead:starrail",
    cacheTtlMs: 30 * 60 * 1000,
  },
  nap: {
    name: "ennead API",
    url: "https://api.ennead.cc/mihoyo/zenless/codes",
    type: "json",
    cacheKey: "ennead:zenless",
    cacheTtlMs: 30 * 60 * 1000,
  },
  // ennead is already the primary HI3 source, so its secondary is the wiki.
  honkai3rd: {
    name: "Fandom Wiki",
    url: HI3_SOURCES[1].url,
    type: "wiki",
    cacheKey: "hi3wiki:rewards",
    cacheTtlMs: 60 * 60 * 1000,
  },
};

// ═══════════════════════════════════════════════════
//  Game8 sources
// ═══════════════════════════════════════════════════

export const NTE_SOURCE = {
  name: "Game8",
  gameKey: NTE_GAME_KEY,
  logLabel: "NTE",
  url: "https://game8.co/games/Neverness-to-Everness/archives/593718",
  cacheKey: "nte",
  cacheTtlMs: 60 * 60 * 1000,
  parser: "nte",
};

export const WUWA_SOURCE = {
  name: "Game8",
  gameKey: WUWA_GAME_KEY,
  logLabel: "WuWa",
  url: "https://game8.co/games/Wuthering-Waves/archives/453149",
  cacheKey: "wuwa",
  cacheTtlMs: 60 * 60 * 1000,
  parser: "wuwa",
};

export const GAME8_SOURCES = {
  [NTE_GAME_KEY]: NTE_SOURCE,
  [WUWA_GAME_KEY]: WUWA_SOURCE,
};

// Item icon sourcing, sizing spec, and upload/provisioning now live in
// emoji-icons.js (the manifest) and emoji-provision.js (the uploader) —
// see /EmojiSetup or `npm run emoji:provision`.
