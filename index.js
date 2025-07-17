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
  "!fetchzzz": { param:"nap",    name:"Zenless Zone Zero",   redeem:"https://zenless.hoyoverse.com/redemption?code=" },
};

// ─── Persistence Helpers ────────────────────────────────────────────
const DATA_FILE = path.resolve(process.cwd(), "enabledChannels.json");

function loadThresholds() {
  if (!fs.existsSync(DATA_FILE)) return new Map();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const obj = JSON.parse(raw);
    const m = new Map();
    for (const [cid, vals] of Object.entries(obj)) {
      m.set(cid, {
        genshin: vals.genshin || 0,
        hkrpg:   vals.hkrpg   || 0,
        nap:     vals.nap     || 0,
      });
    }
    return m;
  } catch (err) {
    console.error("❌ Failed to load thresholds:", err);
    return new Map();
  }
}

function saveThresholds(map) {
  const obj = {};
  for (const [cid, thr] of map.entries()) {
    obj[cid] = {
      genshin: thr.genshin,
      hkrpg:   thr.hkrpg,
      nap:     thr.nap,
    };
  }
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (err) {
    console.error("❌ Failed to save thresholds:", err);
  }
}

// ─── State: last-seen-ID thresholds ─────────────────────────────────
const thresholds = loadThresholds();
const client = new Client();

process.on("unhandledRejection", console.error);

// ─── Auto-fetch loop ─────────────────────────────────────────────────
client.on("ready", () => {
  console.log(`✅ Logged in as ${client.user.username}.`);
  setInterval(async () => {
    for (const [cid, thr] of thresholds.entries()) {
      const channel = client.channels.get(cid);
      if (!channel) continue;
      const sections = [];
      // check each game
      for (const gameInfo of Object.values(GAMES)) {
        try {
          const res = await axios.get(API_BASE + gameInfo.param);
          const list = res.data.codes || res.data.active || [];
          // filter entries with id > last threshold
          const newEntries = list.filter(e => (e.id || 0) > (thr[gameInfo.param] || 0));
          if (newEntries.length === 0) {
            // update threshold even if no entries? keep old
          } else {
            // update threshold to highest id seen
            thr[gameInfo.param] = Math.max(...newEntries.map(e => e.id));
            // build header
            let header;
            switch (gameInfo.param) {
              case "genshin": header = "**there are new primogems to be redeemed! Come get em!**"; break;
              case "hkrpg":  header = "**there are new stellar jades to be redeemed! Come get em!**"; break;
              case "nap":    header = "**fresh polychrome from the bangboo on sixth street! Come get them!**"; break;
            }
            // build lines
            const lines = [header];
            for (const entry of newEntries) {
              const code = entry.code || entry.key || entry.name;
              const raw  = entry.rewards ?? entry.reward;
              const rewards = Array.isArray(raw) ? raw.join(", ") : raw?.replace(/&amp;/g, "&").trim() || "Unknown reward";
              lines.push(`• **${code}** — ${rewards}\n<${gameInfo.redeem}${code}>`);
            }
            sections.push(lines.join("\n"));
          }
        } catch (err) {
          console.error(`Error fetching ${gameInfo.name}:`, err);
        }
      }
      // if any new entries across games, send one message
      if (sections.length) {
        await channel.sendMessage(sections.join("\n\n"));
        saveThresholds(thresholds);
      }
    }
  }, 60 * 60 * 1000); // every hour
});

// ─── Commands: enable/disable/manual ─────────────────────────────────
client.on("message", async (msg) => {
  if (!msg.content) return;
  const key = msg.content.trim().toLowerCase();
  const cid = msg.channel.id ?? msg.channel._id;

  if (key === "!enablefetch") {
    if (!thresholds.has(cid)) {
      // prime thresholds to current highest IDs
      const thr = { genshin:0, hkrpg:0, nap:0 };
      for (const gameInfo of Object.values(GAMES)) {
        try {
          const res = await axios.get(API_BASE + gameInfo.param);
          const list = res.data.codes || res.data.active || [];
          thr[gameInfo.param] = list.reduce((max,e)=>(e.id>max?e.id:max), 0);
        } catch {}
      }
      thresholds.set(cid, thr);
      saveThresholds(thresholds);
      return msg.channel.sendMessage("✅ Auto-fetch enabled! I’ll check every hour and announce new codes here.");
    } else {
      return msg.channel.sendMessage("ℹ️ Auto-fetch is already enabled in this channel.");
    }
  }

  if (key === "!disablefetch") {
    if (thresholds.has(cid)) {
      thresholds.delete(cid);
      saveThresholds(thresholds);
      return msg.channel.sendMessage("❎ Auto-fetch disabled. I won’t post new codes here anymore.");
    } else {
      return msg.channel.sendMessage("ℹ️ Auto-fetch wasn’t enabled in this channel.");
    }
  }

  // manual fetch commands
  const gameInfo = GAMES[key];
  if (!gameInfo) return;
  try {
    const res = await axios.get(API_BASE + gameInfo.param);
    const list = res.data.codes || res.data.active || [];
    if (list.length === 0) {
      return msg.channel.sendMessage(`No active codes for **${gameInfo.name}** right now.`);
    }
    const today = new Date().toLocaleDateString("en-JP", { timeZone:"Asia/Tokyo", year:"numeric", month:"short", day:"numeric" });
    const header = `**As of ${today}, here are the codes for ${gameInfo.name}:**`;
    const lines = [header];
    for (const entry of list) {
      const code = entry.code || entry.key || entry.name;
      const raw  = entry.rewards ?? entry.reward;
      const rewards = Array.isArray(raw)? raw.join(", "): raw?.replace(/&amp;/g, "&").trim() || "Unknown reward";
      lines.push(`• **${code}** — ${rewards}\n<${gameInfo.redeem}${code}>`);
    }
    await msg.channel.sendMessage(lines.join("\n"));
  } catch (err) {
    console.error(`Manual fetch error for ${gameInfo.name}:`, err);
    await msg.channel.sendMessage("Failed to fetch codes — try again later.");
  }
});

// ─── Start Bot ──────────────────────────────────────────────────────
client.loginBot(TOKEN).catch((err) => {
  console.error("❌ Login failed:", err);
  process.exit(1);
});
