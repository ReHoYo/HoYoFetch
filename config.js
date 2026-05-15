// config.js — Centralised configuration for HoyoFetch
// ────────────────────────────────────────────────────
import { readFileSync, existsSync } from "fs";

// ── Load .env manually (no dotenv dependency) ──────
const ALLOWED_ENV_KEYS = new Set([
  "BOT_TOKEN", "PREFIX", "FETCH_INTERVAL", "EMOJI_MODE", "HOYO_API_BASE",
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
    if ((val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))) {
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
const fetchIntervalMinutes = Number.isFinite(rawInterval) && rawInterval >= 1
  ? Math.min(rawInterval, 1440)
  : 60;

if (fetchIntervalMinutes !== rawInterval) {
  console.warn(
    `⚠️  FETCH_INTERVAL clamped to ${fetchIntervalMinutes} (was ${process.env.FETCH_INTERVAL})`
  );
}

export const CONFIG = {
  token: process.env.BOT_TOKEN || "",
  prefix: process.env.PREFIX || "/",
  fetchIntervalMinutes,
  hoyoApiBase:
    process.env.HOYO_API_BASE || "https://hoyo-codes.seria.moe/codes",
};

// ═══════════════════════════════════════════════════
//  Emoji system
// ═══════════════════════════════════════════════════
// "unicode" → built-in fallback emoji (works everywhere, default)
// "custom"  → Revolt server custom emoji (requires uploading icons)
//
// HOW TO SET UP CUSTOM EMOJI:
//   1. Download item icons (see ASSET GUIDE at bottom of file)
//   2. Upload each as server emoji on your Revolt server
//   3. Get each emoji's ID from the emoji picker or server settings
//   4. Replace the placeholder IDs in CUSTOM_EMOJI below
//   5. Set EMOJI_MODE=custom in your .env file

export const EMOJI_MODE = process.env.EMOJI_MODE || "unicode";

const UNICODE_EMOJI = {
  // ── Genshin Impact ──────────────────────────────
  primogem: "💎", mora: "🪙", "hero's wit": "📕",
  "adventurer's experience": "📗", "mystic enhancement ore": "🔮",
  "fine enhancement ore": "🔷", resin: "🌙",
  // ── Honkai: Star Rail ───────────────────────────
  "stellar jade": "💎", credit: "🪙", "traveler's guide": "📕",
  "adventure log": "📗", "refined aether": "🔮",
  "condensed aether": "🔷", "trailblaze power": "⚡",
  // ── Zenless Zone Zero ───────────────────────────
  polychrome: "💎", dennies: "🪙", "senior investigator log": "📕",
  "w-engine energy module": "🔮", "battery charge": "⚡",
  // ── Honkai Impact 3rd ───────────────────────────
  crystal: "💎", asterite: "🪙", "stamina potion": "⚡",
  coin: "🪙", stamina: "⚡", mithril: "🔷",
};

// Fill in your server emoji IDs after uploading icons.
// Format: ":REVOLT_EMOJI_ID:" — e.g. ":01JF7K9ABCDEF:"
const CUSTOM_EMOJI = {
  // ── Genshin Impact ──────────────────────────────
  primogem: ":01KJ9DT9PFV146B7RT8E7GF5RK:",
  mora: ":01KJ9DTH3SJ3QWNYG63HCBQE2K:",
  "hero's wit": ":01KJ9H1PJ7Z7KCYS1DGDWD9MRS:",
  "adventurer's experience": ":01KJ9H0T8V0HFZHWPYS49K10S0:",
  // ── Honkai: Star Rail ───────────────────────────
  "stellar jade": ":01KJ9E3A1G9QZ31YXH2SWGNMYH:",
  credit: ":01KJ9E3ZDQ58WJE7T88N2DCAK4:",
  // ── Zenless Zone Zero ───────────────────────────
  polychrome: ":01KJ9DWBQAH7RRY47Z7WXTSE3B:",
  dennies: ":01KJ9DVYCN9Q1Y3DKP8ATGPRJC:",
  // ── Honkai Impact 3rd ───────────────────────────
  crystal: ":01KJ9EYTYBY44P9QN9PTAHCWHR:",
  asterite: ":01KJ9GZCP7CMNT9506X9GGQDFJ:",
  coin: ":01KJ9EYMKX900EDHY97FRE3JTZ:",
};

export function getEmojiMap() {
  return EMOJI_MODE === "custom" ? CUSTOM_EMOJI : UNICODE_EMOJI;
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
    deprecated: false,
  },
  hkrpg: {
    key: "hkrpg",
    apiParam: "hkrpg",
    name: "Honkai: Star Rail",
    colour: "#FFD700",
    icon: "https://img-os-static.hoyolab.com/communityWeb/upload/473aee1166b3c22d093ee74c6a4f8e1e.png",
    redeemUrl: "https://hsr.hoyoverse.com/gift?code=",
    source: "seria",
    deprecated: false,
  },
  nap: {
    key: "nap",
    apiParam: "nap",
    name: "Zenless Zone Zero",
    colour: "#FF6347",
    icon: "https://img-os-static.hoyolab.com/communityWeb/upload/1db8126f4554985a3610985bf5a69249.png",
    redeemUrl: "https://zenless.hoyoverse.com/redemption?code=",
    source: "seria",
    deprecated: false,
  },
  honkai3rd: {
    key: "honkai3rd",
    apiParam: "honkai3rd",
    name: "Honkai Impact 3rd",
    colour: "#9B59B6",
    icon: "https://img-os-static.hoyolab.com/communityWeb/upload/bbb364aaa7d51897a2c74f16c2a71521.png",
    redeemUrl: null, // HI3 codes must be redeemed in-game
    source: "hi3_multi",
    deprecated: false,
  },
};

export const COMMAND_GAME_MAP = {
  fetchgi: "genshin",
  fetchhsr: "hkrpg",
  fetchzzz: "nap",
  fetchhi3: "honkai3rd",
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
//  ASSET DOWNLOAD GUIDE
// ═══════════════════════════════════════════════════
//
//  Where to get item icons for custom Revolt emoji:
//
//  GENSHIN IMPACT
//    Ambr.top (best quality):  https://ambr.top/en/archive/material
//    Wiki:  https://genshin-impact.fandom.com/wiki/Primogem
//           → right-click icon → Open image in new tab → Save
//    Key items to download:
//      Item_Primogem.png, Item_Mora.png, Item_Heros_Wit.png,
//      Item_Adventurers_Experience.png, Item_Mystic_Enhancement_Ore.png,
//      Item_Original_Resin.png
//
//  HONKAI: STAR RAIL
//    Yatta.moe:  https://hsr.yatta.moe/
//    Wiki:  https://honkai-star-rail.fandom.com/wiki/Stellar_Jade
//    Key items: Stellar_Jade.png, Credit.png, Trailblaze_Power.png,
//      Traveler's_Guide.png, Refined_Aether.png
//
//  ZENLESS ZONE ZERO
//    Hakush.in:  https://zzz.hakush.in/
//    Wiki:  https://zenless-zone-zero.fandom.com/wiki/Polychrome
//    Key items: Polychrome.png, Dennies.png, Battery_Charge.png
//
//  HONKAI IMPACT 3RD
//    Wiki:  https://honkaiimpact3.fandom.com/wiki/Crystal_(Currency)
//    Key items: Crystal.png, Asterite.png, Stamina.png, Mithril.png
//
//  RECOMMENDED SPEC
//    • 128×128 or 256×256 px, square
//    • PNG with transparent background
//    • Under 500 KB
//    • Name them clearly: "primogem", "stellarjade", etc.
//
//  UPLOAD ON REVOLT
//    Server Settings → Emojis → Upload Emoji
//    After uploading, grab the emoji ID and put it in CUSTOM_EMOJI above.
