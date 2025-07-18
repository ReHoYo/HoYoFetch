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
function backupCorruptFile() {
  try {
    const badName = DATA_FILE + ".corrupt." + Date.now();
    fs.renameSync(DATA_FILE, badName);
    console.warn(`⚠️ Backed up corrupt JSON to ${badName}`);
  } catch {
    console.error("❌ Could not backup corrupt JSON");
  }
}

function loadThresholds() {
  if (!fs.existsSync(DATA_FILE)) return new Map();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const obj = JSON.parse(raw);
    return new Map(Object.entries(obj));
  } catch (err) {
    console.error("❌ Failed to parse thresholds, backing up and starting fresh:", err);
    backupCorruptFile();
    return new Map();
  }
}

function saveThresholds(map) {
  const obj = Object.fromEntries(map.entries());
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

// Numeric coercion helper
const getIdNum = e => Number(e.id) || 0;

// Safe send
async function safeSend(channel, content) {
  try {
    await channel.sendMessage(content);
  } catch (err) {
    console.error(`❌ Failed to send message to ${channel._id}:`, err);
    if (err.message.includes('permissions')) {
      console.warn(`🚫 Removing auto-fetch for ${channel._id} due to permission error.`);
      thresholds.delete(channel._id);
      saveThresholds(thresholds);
    }
  }
}

// ─── Auto-fetch loop ─────────────────────────────────────────────────
client.on("ready", () => {
  console.log(`✅ Logged in as ${client.user.username}.`);
  setInterval(async () => {
    for (const [cid, thr] of thresholds.entries()) {
      const channel = client.channels.get(cid);
      if (!channel) { thresholds.delete(cid); saveThresholds(thresholds); continue; }
      const sections = [];
      for (const gameInfo of Object.values(GAMES)) {
        let list;
        try {
          const res = await axios.get(API_BASE + gameInfo.param);
          list = res.data.codes || res.data.active || [];
        } catch (err) {
          console.error(`Error fetching ${gameInfo.name}:`, err);
          continue;
        }
        const newEntries = list
          .map(e => ({ ...e, _idNum: getIdNum(e) }))
          .filter(e => e._idNum > (thr[gameInfo.param] || 0))
          .sort((a,b) => a._idNum - b._idNum);
        if (!newEntries.length) continue;
        thr[gameInfo.param] = newEntries[newEntries.length -1]._idNum;

        let header;
        switch (gameInfo.param) {
          case "genshin": header = "**there are new primogems to be redeemed! Come get em!**"; break;
          case "hkrpg":  header = "**there are new stellar jades to be redeemed! Come get em!**"; break;
          case "nap":    header = "**fresh polychrome from the bangboo on sixth street! Come get them!**"; break;
        }
        const lines = [header];
        newEntries.forEach(e => {
          let raw = e.rewards ?? e.reward;
          if (raw === undefined) {
            const altKey = Object.keys(e).find(k => /reward/i.test(k));
            raw = altKey ? e[altKey] : undefined;
          }
          const rewards = Array.isArray(raw)
            ? raw.join(", ")
            : (typeof raw === 'string' ? raw.replace(/&amp;/g, "&").trim() : "") || "Unknown reward";
          const code = e.code || e.key || e.name;
          lines.push(`• **${code}** — ${rewards}\n<${gameInfo.redeem}${code}>`);
        });
        sections.push(lines.join("\n"));
      }
      if (sections.length) {
        await safeSend(channel, sections.join("\n\n"));
        saveThresholds(thresholds);
      }
    }
  }, 60 * 60 * 1000);
});

// ─── Commands: enable/disable/manual ─────────────────────────────────
client.on("message", async msg => {
  if (!msg.content) return;
  const key = msg.content.trim().toLowerCase();
  const cid = msg.channel.id ?? msg.channel._id;

  if (key === "!enablefetch") {
    if (!thresholds.has(cid)) {
      const thr = {};
      for (const gInfo of Object.values(GAMES)) {
        try {
          const res = await axios.get(API_BASE + gInfo.param);
          const list = res.data.codes || res.data.active || [];
          thr[gInfo.param] = list.reduce((max,e)=>Math.max(max, getIdNum(e)), 0);
        } catch (err) {
          console.warn(`Could not prime ${gInfo.name}:`, err);
          thr[gInfo.param] = 0;
        }
      }
      thresholds.set(cid, thr);
      saveThresholds(thresholds);
      return safeSend(msg.channel, "✅ Auto-fetch enabled! I’ll check every hour and announce new codes here.");
    }
    return safeSend(msg.channel, "ℹ️ Auto-fetch is already enabled in this channel.");
  }

  if (key === "!disablefetch") {
    if (thresholds.has(cid)) {
      thresholds.delete(cid);
      saveThresholds(thresholds);
      return safeSend(msg.channel, "❎ Auto-fetch disabled. I won’t post new codes here anymore.");
    }
    return safeSend(msg.channel, "ℹ️ Auto-fetch wasn’t enabled in this channel.");
  }

  const gameInfo = GAMES[key];
  if (!gameInfo) return;
  let list;
  try {
    const res = await axios.get(API_BASE + gameInfo.param);
    list = res.data.codes || res.data.active || [];
  } catch (err) {
    console.error(`Manual fetch error for ${gameInfo.name}:`, err);
    return safeSend(msg.channel, "Failed to fetch codes — try again later.");
  }
  const thr = thresholds.get(cid) || {};
  const newEntries = list
    .map(e => ({ ...e, _idNum: getIdNum(e) }))
    .filter(e => e._idNum > (thr[gameInfo.param] || 0))
    .sort((a,b) => a._idNum - b._idNum);
  if (!newEntries.length) {
    return safeSend(msg.channel, `No new codes for **${gameInfo.name}** since last check.`);
  }
  thr[gameInfo.param] = newEntries[newEntries.length -1]._idNum;
  thresholds.set(cid, thr);
  saveThresholds(thresholds);

  const today = new Date().toLocaleDateString("en-JP", { timeZone:"Asia/Tokyo", year:"numeric", month:"short", day:"numeric" });
  const header = `**As of ${today}, new codes for ${gameInfo.name}:**`;
  const lines = [header];
  newEntries.forEach(e => {
    let raw = e.rewards ?? e.reward;
    if (raw === undefined) {
      const altKey = Object.keys(e).find(k => /reward/i.test(k));
      raw = altKey ? e[altKey] : undefined;
    }
    const rewards = Array.isArray(raw)
      ? raw.join(", ")
      : (typeof raw === 'string' ? raw.replace(/&amp;/g, "&").trim() : "") || "Unknown reward";
    const code = e.code || e.key || e.name;
    lines.push(`• **${code}** — ${rewards}\n<${gameInfo.redeem}${code}>`);
  });
  await safeSend(msg.channel, lines.join("\n"));
});

// ─── Start Bot ──────────────────────────────────────────────────────
client.loginBot(TOKEN).catch(err => {
  console.error("❌ Login failed:", err);
  process.exit(1);
});
