import { Client } from "revolt.js";
import axios from "axios";
import 'dotenv/config';

// ─── Load token from Replit Secrets ───────────────────────────────────────────
const TOKEN = process.env.REVOLT_BOT_TOKEN?.trim();
if (!TOKEN) {
  console.error(
    "❌ REVOLT_BOT_TOKEN is missing! Please check your Replit Secrets.",
  );
  process.exit(1);
}

// ─── Config ───────────────────────────────────────────────────────────────────
const API_BASE = "https://hoyo-codes.seria.moe/codes?game=";
const GAMES = {
  "!fetchgi": {
    param: "genshin",
    name: "Genshin Impact",
    redeem: "https://genshin.hoyoverse.com/en/gift?code=",
  },
  "!fetchhsr": {
    param: "hkrpg",
    name: "Honkai Star Rail",
    redeem: "https://hsr.hoyoverse.com/gift?code=",
  },
  "!fetchzzz": {
    param: "nap",
    name: "Zenless Zone Zero",
    redeem: "https://zenless.hoyoverse.com/redemption?code=",
  },
};

// ─── Bot Setup ────────────────────────────────────────────────────────────────
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
  const gameInfo = GAMES[key];
  if (!gameInfo) return; // ignore other messages

  try {
    const { data } = await axios.get(API_BASE + gameInfo.param);
    const list = data.codes || data.active || [];

    if (!list.length) {
      return msg.channel.sendMessage(
        `No active codes for **${gameInfo.name}** right now.`,
      );
    }

    // Change timezone to Tokyo (Asia/Tokyo)
    const today = new Date().toLocaleDateString("en-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "short",
      day: "numeric",
    });

    const lines = [
      `**As of ${today}, here are the codes for ${gameInfo.name}:**`,
    ];

    for (const entry of list) {
      const code = entry.code || entry.key || entry.name;
      // ── Reward logic with humorous fallbacks ─────────────────────────────────
      let rawRewards = entry.rewards ?? entry.reward;
      let rewards;
      if (rawRewards) {
        if (Array.isArray(rawRewards)) {
          rewards = rawRewards.join(", ");
        } else {
          rewards = rawRewards.replace(/&amp;/g, "&").trim();
        }
      } else {
        // humorous default per game
        const fallbacks = {
          genshin:
            "i asked paimon and she replied that it's probably primogems but can you really trust her",
          hkrpg:
            "i asked pom-pom and couldn't find what this code has so probably stellar jade",
          nap: "idk the bangboo I asked didn't give me the reward so it's probably polychromes",
        };
        rewards = fallbacks[gameInfo.param] || "Unknown reward";
      }
      // ────────────────────────────────────────────────────────────────────────

      lines.push(`• **${code}** — ${rewards}\n<${gameInfo.redeem}${code}>`);
    }

    await msg.channel.sendMessage(lines.join("\n"));
  } catch (err) {
    console.error("❌ Failed to fetch codes:", err);
    await msg.channel.sendMessage("Failed to fetch codes — try again later.");
  }
});

// ─── Login ───────────────────────────────────────────────────────────────────
client.loginBot(TOKEN).catch((err) => {
  console.error("❌ Login failed:", err);
  process.exit(1);
});
