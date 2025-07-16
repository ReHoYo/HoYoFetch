import { Client } from "revolt.js";
import axios from "axios";
import 'dotenv/config';

// ─── Load token from env ────────────────────────────────────────────
const TOKEN = process.env.REVOLT_BOT_TOKEN?.trim();
if (!TOKEN) {
  console.error("❌ REVOLT_BOT_TOKEN is missing! Please check your env.");
  process.exit(1);
}

// ─── Who’s allowed to restart ───────────────────────────────────────
// Replace this with your actual Revolt user ID (you can also wire this
// up to an OWNER_ID env-var if you prefer not to hard-code).
const OWNER_ID = "01H2VRZSN1AY7QASPNKXMP52HZ";

// ─── Config ─────────────────────────────────────────────────────────
const API_BASE = "https://hoyo-codes.seria.moe/codes?game=";
const GAMES = {
  "!fetchgi":  { param:"genshin", name:"Genshin Impact",    redeem:"https://genshin.hoyoverse.com/en/gift?code=" },
  "!fetchhsr": { param:"hkrpg",  name:"Honkai Star Rail",   redeem:"https://hsr.hoyoverse.com/gift?code=" },
  "!fetchzzz": { param:"nap",    name:"Zenless Zone Zero", redeem:"https://zenless.hoyoverse.com/redemption?code=" },
};

// ─── Bot Setup ──────────────────────────────────────────────────────
const client = new Client();

// catch-all for any unhandled promise rejections
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

client.on("ready", () => {
  console.log(`✅ Logged in as ${client.user.username}. Waiting for commands…`);
});

// ─── Message Handler ─────────────────────────────────────────────────
client.on("message", async (msg) => {
  if (!msg.content) return;

  const key = msg.content.trim().toLowerCase();

  // ─── Self-restart ───────────────────────────────────────────────────
  if (key === "!restart" && msg.author._id === OWNER_ID) {
    await msg.channel.sendMessage("🔄 Bot restarting now…");
    return process.exit(0);
  }

  // ─── Manual fetch commands ─────────────────────────────────────────
  const gameInfo = GAMES[key];
  if (!gameInfo) return; // only respond to !fetchgi / !fetchhsr / !fetchzzz

  try {
    const { data } = await axios.get(API_BASE + gameInfo.param);
    const list = data.codes || data.active || [];

    if (!list.length) {
      return msg.channel.sendMessage(`No active codes for **${gameInfo.name}** right now.`);
    }

    // Tokyo-time date
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

      // reward logic with funny fallback
      let rawRewards = entry.rewards ?? entry.reward;
      let rewards;
      if (rawRewards) {
        rewards = Array.isArray(rawRewards)
          ? rawRewards.join(", ")
          : rawRewards.replace(/&amp;/g, "&").trim();
      } else {
        const fallbacks = {
          genshin: "Paimon said “probably primogems” 🤷",
          hkrpg:   "Pom-pom shrugged, so maybe stellar jade 🤷",
          nap:     "Bangboo was silent, likely polychromes 🤷",
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

// ─── Login ───────────────────────────────────────────────────────────
client.loginBot(TOKEN).catch((err) => {
  console.error("❌ Login failed:", err);
  process.exit(1);
});
