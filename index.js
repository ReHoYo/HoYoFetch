import { Client } from "revolt.js";
import axios from "axios";
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
  "!fetchgi": {
    param:  "genshin",
    name:   "Genshin Impact",
    redeem: "https://genshin.hoyoverse.com/en/gift?code=",
  },
  "!fetchhsr": {
    param:  "hkrpg",
    name:   "Honkai Star Rail",
    redeem: "https://hsr.hoyoverse.com/gift?code=",
  },
  "!fetchzzz": {
    param:  "nap",
    name:   "Zenless Zone Zero",
    redeem: "https://zenless.hoyoverse.com/redemption?code=",
  },
};

// ─── State for auto-fetch ───────────────────────────────────────────
/** Map<channelId, { genshin: Set, hkrpg: Set, nap: Set }> */
const enabledChannels = new Map();

const client = new Client();

// catch-all for any unhandled promise rejections
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

client.on("ready", () => {
  console.log(`✅ Logged in as ${client.user.username}. Waiting for commands…`);
});

client.on("message", async (msg) => {
  if (!msg.content) return;

  const key = msg.content.trim().toLowerCase();
  // ← always use .id first (fallback to _id for older versions)
  const cid = msg.channel.id ?? msg.channel._id;

  // ─── Enable / Disable auto-fetch ────────────────────────────────
  if (key === "!enablefetch") {
    if (!enabledChannels.has(cid)) {
      enabledChannels.set(cid, {
        genshin: new Set(),
        hkrpg:   new Set(),
        nap:     new Set(),
      });
      return msg.channel.sendMessage("✅ Auto-fetch enabled! I’ll check every 2 hours and announce new codes here.");
    } else {
      return msg.channel.sendMessage("ℹ️ Auto-fetch is already enabled in this channel.");
    }
  }

  if (key === "!disablefetch") {
    if (enabledChannels.has(cid)) {
      enabledChannels.delete(cid);
      return msg.channel.sendMessage("❎ Auto-fetch disabled. I won’t post new codes here anymore.");
    } else {
      return msg.channel.sendMessage("ℹ️ Auto-fetch wasn’t enabled in this channel.");
    }
  }

  // ─── Manual fetch commands ───────────────────────────────────────
  const gameInfo = GAMES[key];
  if (!gameInfo) return; // ignore all other messages

  try {
    const { data } = await axios.get(API_BASE + gameInfo.param);
    const list = data.codes || data.active || [];

    if (!list.length) {
      return msg.channel.sendMessage(`No active codes for **${gameInfo.name}** right now.`);
    }

    // format date in Tokyo timezone
    const today = new Date().toLocaleDateString("en-JP", {
      timeZone: "Asia/Tokyo",
      year:   "numeric",
      month:  "short",
      day:    "numeric",
    });

    const lines = [
      `**As of ${today}, here are the codes for ${gameInfo.name}:**`,
    ];

    for (const entry of list) {
      const code = entry.code || entry.key || entry.name;

      // reward logic with humorous fallbacks
      let rawRewards = entry.rewards ?? entry.reward;
      let rewards;
      if (rawRewards) {
        if (Array.isArray(rawRewards)) {
          rewards = rawRewards.join(", ");
        } else {
          rewards = rawRewards.replace(/&amp;/g, "&").trim();
        }
      } else {
        const fallbacks = {
          genshin: "i asked paimon and she said probably primogems 🤷",
          hkrpg:   "pom-pom had no clue so maybe stellar jade 🤷",
          nap:     "bangboo was silent so likely polychromes 🤷",
        };
        rewards = fallbacks[gameInfo.param] || "Unknown reward";
      }

      lines.push(`• **${code}** — ${rewards}\n<${gameInfo.redeem}${code}>`);
    }

    await msg.channel.sendMessage(lines.join("\n"));
  } catch (err) {
    console.error("❌ Failed to fetch codes:", err);
    await msg.channel.sendMessage("Failed to fetch codes — try again later.");
  }
});

client.loginBot(TOKEN).catch((err) => {
  console.error("❌ Login failed:", err);
  process.exit(1);
});
