import { Client } from "revolt.js";
import axios from "axios";
import 'dotenv/config';

// ─── Load token from env ───────────────────────────────────────────────────────
const TOKEN = process.env.REVOLT_BOT_TOKEN?.trim();
if (!TOKEN) {
  console.error("❌ REVOLT_BOT_TOKEN is missing! Please check your env.");
  process.exit(1);
}

// ─── Config ───────────────────────────────────────────────────────────────────
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

// ─── State for auto-fetch ─────────────────────────────────────────────────────
/** Map<channelId, { genshin: Set, hkrpg: Set, nap: Set }> */
const enabledChannels = new Map();

const client = new Client();

// catch-all for unhandled promise rejections
process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});

client.on("ready", () => {
  console.log(`✅ Logged in as ${client.user.username}.`);

  // every 2 hours, check enabled channels
  setInterval(async () => {
    for (const [channelId, seen] of enabledChannels.entries()) {
      const channel = client.channels.get(channelId);
      if (!channel) continue;

      for (const gameInfo of Object.values(GAMES)) {
        try {
          const { data } = await axios.get(API_BASE + gameInfo.param);
          const list = data.codes || data.active || [];
          const codes = list.map(e => e.code || e.key || e.name);
          const newCodes = codes.filter(c => !seen[gameInfo.param].has(c));

          if (newCodes.length) {
            // mark all as seen
            newCodes.forEach(c => seen[gameInfo.param].add(c));

            // choose bold header
            let header;
            switch (gameInfo.param) {
              case "genshin":
                header = "**Genshin Impact: there are new primogems to be redeemed!**";
                break;
              case "hkrpg":
                header = "**Honkai Star Rail: there are new stellar jades to be redeemed!**";
                break;
              case "nap":
                header = "**Zenless Zone Zero: there are new polychromes to be redeemed!**";
                break;
            }

            const lines = [header];
            for (const entry of list.filter(e => newCodes.includes(e.code || e.key || e.name))) {
              const code = entry.code || entry.key || entry.name;
              const raw  = entry.rewards ?? entry.reward;
              const rewards = Array.isArray(raw)
                ? raw.join(", ")
                : raw?.replace(/&amp;/g, "&").trim() || "Unknown reward";

              lines.push(`• **${code}** — ${rewards}\n<${gameInfo.redeem}${code}>`);
            }

            await channel.sendMessage(lines.join("\n"));
          }
        } catch (err) {
          console.error("Auto-fetch error for", gameInfo.name, err);
        }
      }
    }
  }, 2 * 60 * 60 * 1000); // 2 hours
});

client.on("message", async (msg) => {
  if (!msg.content) return;

  const key = msg.content.trim().toLowerCase();
  // ↓ the fix: use `.id` instead of `._id`
  const cid = msg.channel.id;

  // ─── Enable auto-fetch ──────────────────────────────────────────────────────
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

  // ─── Disable auto-fetch ─────────────────────────────────────────────────────
  if (key === "!disablefetch") {
    if (enabledChannels.has(cid)) {
      enabledChannels.delete(cid);
      return msg.channel.sendMessage("❎ Auto-fetch disabled. I won’t post new codes here anymore.");
    } else {
      return msg.channel.sendMessage("ℹ️ Auto-fetch wasn’t enabled in this channel.");
    }
  }

  // ─── Manual fetch commands ──────────────────────────────────────────────────
  const gameInfo = GAMES[key];
  if (!gameInfo) return;

  try {
    const { data } = await axios.get(API_BASE + gameInfo.param);
    const list = data.codes || data.active || [];
    if (!list.length) {
      return msg.channel.sendMessage(`No active codes for **${gameInfo.name}** right now.`);
    }

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
      const raw  = entry.rewards ?? entry.reward;
      const rewards = Array.isArray(raw)
        ? raw.join(", ")
        : raw?.replace(/&amp;/g, "&").trim() || "Unknown reward";

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
