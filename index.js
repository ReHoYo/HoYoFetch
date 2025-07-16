import { Client } from "revolt.js";
import axios from "axios";
import 'dotenv/config';

const TOKEN = process.env.REVOLT_BOT_TOKEN?.trim();
if (!TOKEN) {
  console.error("❌ REVOLT_BOT_TOKEN is missing!");
  process.exit(1);
}

// Used for version checking
const START_TIME = new Date().toISOString();

const API_BASE = "https://hoyo-codes.seria.moe/codes?game=";
const GAMES = {
  "!fetchgi":  { param:"genshin", name:"Genshin Impact",   redeem:"https://genshin.hoyoverse.com/en/gift?code=" },
  "!fetchhsr": { param:"hkrpg",  name:"Honkai Star Rail", redeem:"https://hsr.hoyoverse.com/gift?code=" },
  "!fetchzzz": { param:"nap",    name:"Zenless Zone Zero",redeem:"https://zenless.hoyoverse.com/redemption?code=" },
};

// channelId → { genshin: Set, hkrpg: Set, nap: Set }
const enabledChannels = new Map();

const client = new Client();

// catch any unhandled promise rejections
process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});

// Auto-fetch loop
client.on("ready", () => {
  console.log(`✅ Logged in as ${client.user.username}`);
  setInterval(async () => {
    for (const [cid, seen] of enabledChannels.entries()) {
      const ch = client.channels.get(cid);
      if (!ch) continue;

      for (const gameInfo of Object.values(GAMES)) {
        try {
          const { data } = await axios.get(API_BASE + gameInfo.param);
          const list = data.codes || data.active || [];
          const codes = list.map(e => e.code||e.key||e.name);
          const newOnes = codes.filter(c => !seen[gameInfo.param].has(c));
          if (!newOnes.length) continue;

          newOnes.forEach(c => seen[gameInfo.param].add(c));
          const hdr = {
            genshin: "**Genshin Impact: new primogems!**",
            hkrpg:   "**Honkai Star Rail: new stellar jades!**",
            nap:     "**Zenless Zone Zero: new polychromes!**",
          }[gameInfo.param];

          const lines = [hdr];
          for (const e of list.filter(x => newOnes.includes(x.code||x.key||x.name))) {
            const code = e.code||e.key||e.name;
            const raw  = e.rewards ?? e.reward;
            const rewards = Array.isArray(raw)
              ? raw.join(", ")
              : raw?.replace(/&amp;/g,"&").trim() || "Unknown reward";
            lines.push(`• **${code}** — ${rewards}\n<${gameInfo.redeem}${code}>`);
          }
          await ch.sendMessage(lines.join("\n"));
        } catch(err) {
          console.error("Auto-fetch error for", gameInfo.name, err);
        }
      }
    }
  }, 2 * 60 * 60 * 1000); // 2h
});

// Unified message handler
async function handleMessage(msg) {
  if (!msg.content) return;
  const key = msg.content.trim().toLowerCase();
  const cid = msg.channel.id;

  // ---- CORE DEBUG ----
  if (key === "!ping") {
    return msg.channel.sendMessage("pong");
  }
  if (key === "!debugenable") {
    return msg.channel.sendMessage(`🔍 debug: key='${key}', channel='${cid}'`);
  }
  if (key === "!version") {
    return msg.channel.sendMessage(`🚀 Bot start time: ${START_TIME}`);
  }
  if (key === "!restart") {
    await msg.channel.sendMessage("🔄 Restarting…");
    process.exit(0);
  }

  // ---- ENABLE / DISABLE FETCH ----
  if (key === "!enablefetch") {
    if (!enabledChannels.has(cid)) {
      enabledChannels.set(cid, { genshin:new Set(), hkrpg:new Set(), nap:new Set() });
      return msg.channel.sendMessage("✅ Auto-fetch enabled here!");
    } else {
      return msg.channel.sendMessage("ℹ️ Auto-fetch is already enabled in this channel.");
    }
  }
  if (key === "!disablefetch") {
    if (enabledChannels.has(cid)) {
      enabledChannels.delete(cid);
      return msg.channel.sendMessage("❎ Auto-fetch disabled here.");
    } else {
      return msg.channel.sendMessage("ℹ️ Auto-fetch wasn’t enabled in this channel.");
    }
  }

  // ---- MANUAL FETCH COMMANDS ----
  const gameInfo = GAMES[key];
  if (!gameInfo) return;

  try {
    const { data } = await axios.get(API_BASE + gameInfo.param);
    const list = data.codes || data.active || [];
    if (!list.length) {
      return msg.channel.sendMessage(`No active codes for **${gameInfo.name}** right now.`);
    }
    const today = new Date().toLocaleDateString("en-JP", {
      timeZone:"Asia/Tokyo", year:"numeric", month:"short", day:"numeric"
    });
    const lines = [`**As of ${today}, codes for ${gameInfo.name}:**`];
    for (const e of list) {
      const code = e.code||e.key||e.name;
      const raw  = e.rewards ?? e.reward;
      const rewards = Array.isArray(raw)
        ? raw.join(", ")
        : raw?.replace(/&amp;/g,"&").trim() || "Unknown reward";
      lines.push(`• **${code}** — ${rewards}\n<${gameInfo.redeem}${code}>`);
    }
    await msg.channel.sendMessage(lines.join("\n"));
  } catch(err) {
    console.error("❌ Failed manual fetch:", err);
    await msg.channel.sendMessage("Failed to fetch codes—try again later.");
  }
}

// Listen on both possible events
client.on("message", handleMessage);
client.on("messageCreate", handleMessage);

client.loginBot(TOKEN).catch(err => {
  console.error("❌ Login failed:", err);
  process.exit(1);
});
