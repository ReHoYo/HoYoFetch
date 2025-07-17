import { Client } from "revolt.js";
import axios from "axios";
import fs from "fs";
import path from "path";
import 'dotenv/config';

// ─── Load token from env ───────────────────────────────────────────
const TOKEN = process.env.REVOLT_BOT_TOKEN?.trim();
if (!TOKEN) {
  console.error("❌ REVOLT_BOT_TOKEN is missing! Please check your env.");
  process.exit(1);
}

// ─── Config ────────────────────────────────────────────────────────
const API_BASE = "https://hoyo-codes.seria.moe/codes?game=";
const GAMES = {
  "!fetchgi":  { param:"genshin", name:"Genshin Impact",    redeem:"https://genshin.hoyoverse.com/en/gift?code=" },
  "!fetchhsr": { param:"hkrpg",  name:"Honkai Star Rail",   redeem:"https://hsr.hoyoverse.com/gift?code=" },
  "!fetchzzz": { param:"nap",    name:"Zenless Zone Zero", redeem:"https://zenless.hoyoverse.com/redemption?code=" },
};

// ─── Persistence Helpers ────────────────────────────────────────────
const DATA_FILE = path.resolve(process.cwd(), "enabledChannels.json");

function loadEnabled() {
  if (!fs.existsSync(DATA_FILE)) return new Map();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const obj = JSON.parse(raw);
    const m = new Map();
    for (const [cid, sets] of Object.entries(obj)) {
      m.set(cid, {
        genshin: new Set(sets.genshin || []),
        hkrpg:   new Set(sets.hkrpg   || []),
        nap:     new Set(sets.nap     || []),
      });
    }
    return m;
  } catch (err) {
    console.error("❌ Failed to load enabledChannels.json:", err);
    return new Map();
  }
}

function saveEnabled(map) {
  const obj = {};
  for (const [cid, seen] of map.entries()) {
    obj[cid] = {
      genshin: Array.from(seen.genshin),
      hkrpg:   Array.from(seen.hkrpg),
      nap:     Array.from(seen.nap),
    };
  }
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (err) {
    console.error("❌ Failed to save enabledChannels.json:", err);
  }
}

// ─── State for auto-fetch ───────────────────────────────────────────
const enabledChannels = loadEnabled();
const client = new Client();
process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});

client.on("ready", () => {
  console.log(`✅ Logged in as ${client.user.username}.`);
  setInterval(async () => {
    for (const [channelId, seen] of enabledChannels.entries()) {
      const channel = client.channels.get(channelId);
      if (!channel) continue;
      const sections = [];
      for (const gameInfo of Object.values(GAMES)) {
        try {
          const { data } = await axios.get(API_BASE + gameInfo.param);
          const list = data.codes || data.active || [];
          const codes = list.map(e => e.code || e.key || e.name);
          const newCodes = codes.filter(c => !seen[gameInfo.param].has(c));
          if (!newCodes.length) continue;
          newCodes.forEach(c => seen[gameInfo.param].add(c));
          let header;
          switch (gameInfo.param) {
            case "genshin": header = "**there are new primogems to be redeemed! Come get em!**"; break;
            case "hkrpg":  header = "**there are new stellar jades to be redeemed! Come get em!**"; break;
            case "nap":    header = "**fresh polychrome from the bangboo on sixth street! Come get them!**"; break;
          }
          const lines = [header];
          for (const entry of list.filter(e => newCodes.includes(e.code || e.key || e.name))) {
            const code = entry.code || entry.key || entry.name;
            const raw = entry.rewards ?? entry.reward;
            const rewards = Array.isArray(raw)
              ? raw.join(", ")
              : raw?.replace(/&amp;/g, "&").trim() || "Unknown reward";
            lines.push(`• **${code}** — ${rewards}\n<${gameInfo.redeem}${code}>`);
          }
          sections.push(lines.join("\n"));
        } catch (err) {
          console.error("Auto-fetch error for", gameInfo.name, err);
        }
      }
      if (sections.length) await channel.sendMessage(sections.join("\n\n"));
    }
  }, 60 * 60 * 1000);
});

client.on("message", async (msg) => {
  if (!msg.content) return;
  const key = msg.content.trim().toLowerCase();
  const cid = msg.channel.id ?? msg.channel._id;

  // ─── Enable auto-fetch ────────────────────────────────────────────
  if (key === "!enablefetch") {
    if (!enabledChannels.has(cid)) {
      // initialize sets and prime with current codes to avoid reposting
      const seen = { genshin:new Set(), hkrpg:new Set(), nap:new Set() };
      for (const g of Object.values(GAMES)) {
        try {
          const res = await axios.get(API_BASE + g.param);
          const list = res.data.codes || res.data.active || [];
          for (const e of list) {
            const code = e.code || e.key || e.name;
            seen[g.param].add(code);
          }
        } catch {}
      }
      enabledChannels.set(cid, seen);
      saveEnabled(enabledChannels);
      return msg.channel.sendMessage("✅ Auto-fetch enabled! I’ll check every hour and announce new codes here.");
    } else {
      return msg.channel.sendMessage("ℹ️ Auto-fetch is already enabled in this channel.");
    }
  }

  // ─── Disable auto-fetch ───────────────────────────────────────────
  if (key === "!disablefetch") {
    if (enabledChannels.has(cid)) {
      enabledChannels.delete(cid);
      saveEnabled(enabledChannels);
      return msg.channel.sendMessage("❎ Auto-fetch disabled. I won’t post new codes here anymore.");
    } else {
      return msg.channel.sendMessage("ℹ️ Auto-fetch wasn’t enabled in this channel.");
    }
  }

  // ─── Manual fetch commands ────────────────────────────────────────
  const gameInfo = GAMES[key];
  if (!gameInfo) return;
  try {
    const { data } = await axios.get(API_BASE + gameInfo.param);
    const list = data.codes || data.active || [];
    if (!list.length) return msg.channel.sendMessage(`No active codes for **${gameInfo.name}** right now.`);
    const today = new Date().toLocaleDateString("en-JP", { timeZone:"Asia/Tokyo", year:"numeric", month:"short", day:"numeric" });
    const lines = [`**As of ${today}, here are the codes for ${gameInfo.name}:**`];
    for (const entry of list) {
      const code = entry.code || entry.key || entry.name;
      const raw = entry.rewards ?? entry.reward;
      const rewards = Array.isArray(raw)
        ? raw.join(", ")
        : raw?.replace(/&amp;/g, "&").trim() || "Unknown reward";
      lines.push(`• **${code}** — ${rewards}\n<${gameInfo.redeem}${code}>`);
    }
    await msg.channel.sendMessage(lines.join("\n"));
  } catch (err) {
    console.error("❌ Manual fetch failed:", err);
    await msg.channel.sendMessage("Failed to fetch codes — try again later.");
  }
});

client.loginBot(TOKEN).catch((err) => {
  console.error("❌ Login failed:", err);
  process.exit(1);
});
