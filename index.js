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
  "!fetchgi":  { param: "genshin", name: "Genshin Impact",  redeem: "https://genshin.hoyoverse.com/en/gift?code=" },
  "!fetchhsr": { param: "hkrpg",  name: "Honkai Star Rail", redeem: "https://hsr.hoyoverse.com/gift?code=" },
  "!fetchzzz": { param: "nap",    name: "Zenless Zone Zero", redeem: "https://zenless.hoyoverse.com/redemption?code=" },
};

// How long to wait (minutes) before posting a code that still has no reward text
// You can override via env: DETAIL_HOLD_MINUTES=90
const DETAIL_HOLD_MINUTES = Number(process.env.DETAIL_HOLD_MINUTES || 90);
// How many hourly checks to wait at most before posting without rewards
const DETAIL_RETRY_LIMIT = Number(process.env.DETAIL_RETRY_LIMIT || 3);

// ─── Persistence Helpers ────────────────────────────────────────────
const DATA_FILE = path.resolve(process.cwd(), "enabledChannels.json");
const PENDING_FILE = path.resolve(process.cwd(), "pendingDetails.json");

function backupFile(file) {
  try {
    const badName = file + ".corrupt." + Date.now();
    fs.renameSync(file, badName);
    console.warn(`⚠️ Backed up corrupt file to ${badName}`);
  } catch {}
}

function loadJSON(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`❌ Failed to parse ${file}, backing up and starting fresh:`, err);
    backupFile(file);
    return {};
  }
}

function saveJSON(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
  } catch (err) {
    console.error(`❌ Failed to save ${file}:`, err);
  }
}

// ─── State: thresholds & pending counts ─────────────────────────────
// thresholds: Map<channelId, { genshin:number, hkrpg:number, nap:number }>
const thresholds = new Map(Object.entries(loadJSON(DATA_FILE)));
// pending: { [cid]: { [param]: { [code]: { count:number, firstSeen:number } } } }
const pending = loadJSON(PENDING_FILE);

const client = new Client();
process.on("unhandledRejection", console.error);

// ID coercion helper
const getIdNum = e => Number(e.id) || 0;
const getCodeKey = e => e.code || e.key || e.name;

// Safe send helper
async function safeSend(channel, content) {
  try {
    await channel.sendMessage(content);
  } catch (err) {
    console.error(`❌ Failed to send message to ${channel._id}:`, err);
    if (err?.message?.includes('permissions')) {
      thresholds.delete(channel._id);
      saveJSON(DATA_FILE, Object.fromEntries(thresholds));
      console.warn(`🚫 Auto-fetch removed for ${channel._id} due to permissions.`);
    }
  }
}

// Comical reward fallbacks
const FALLBACKS = {
  genshin: "I asked Paimon and she guesses primogems. (The API did not pass any reward information for this code.)",
  hkrpg:   "I asked Pom-Pom and it's probably stellar jade. (The API did not pass any reward information for this code.)",
  nap:     "I asked the Bangboo in the back alley of Sixth Street and they told me it's probably polychromes. (The API did not pass any reward information for this code.)",
};

// ─── Auto-fetch loop ─────────────────────────────────────────────────
client.on("ready", () => {
  console.log(`✅ Logged in as ${client.user.username}.`);
  setInterval(async () => {
    let changed = false; // track if we need to save files at the end

    for (const [cid, thr] of thresholds.entries()) {
      const channel = client.channels.get(cid);
      if (!channel) {
        thresholds.delete(cid);
        changed = true;
        continue;
      }

      const sections = [];

      for (const gameInfo of Object.values(GAMES)) {
        let list;
        try {
          const res = await axios.get(API_BASE + gameInfo.param);
          list = res.data.codes || res.data.active || [];
        } catch {
          continue;
        }

        const lastId = Number(thr[gameInfo.param] || 0);
        const newEntries = list
          .map(e => ({ ...e, _idNum: getIdNum(e) }))
          .filter(e => e._idNum > lastId)
          .sort((a,b) => a._idNum - b._idNum);

        const publish = [];
        for (const e of newEntries) {
          const hasDetails = Boolean(e.rewards ?? e.reward);
          const codeKey = getCodeKey(e);

          // init pending structure & normalize shape (back-compat if old numeric value exists)
          pending[cid] = pending[cid] || {};
          pending[cid][gameInfo.param] = pending[cid][gameInfo.param] || {};
          const prev = pending[cid][gameInfo.param][codeKey];
          let count = 0;
          let firstSeen = Date.now();
          if (prev) {
            if (typeof prev === 'number') {
              count = prev;
              firstSeen = Date.now();
            } else {
              count = Number(prev.count || 0);
              firstSeen = Number(prev.firstSeen || Date.now());
            }
          }

          if (hasDetails) {
            publish.push(e);
            delete pending[cid][gameInfo.param][codeKey];
          } else {
            // increment attempts and set/keep firstSeen
            count += 1;
            if (!prev) firstSeen = Date.now();
            pending[cid][gameInfo.param][codeKey] = { count, firstSeen };

            const ageMin = (Date.now() - firstSeen) / 60000;
            if (count >= DETAIL_RETRY_LIMIT || ageMin >= DETAIL_HOLD_MINUTES) {
              // time/attempt threshold reached: publish with fallback
              publish.push(e);
              delete pending[cid][gameInfo.param][codeKey];
            }
          }
        }

        if (!publish.length) continue;

        // update threshold to highest published id (do not skip held-back codes)
        thr[gameInfo.param] = Math.max(...publish.map(e=>e._idNum), lastId);
        changed = true;

        // build message
        let header;
        switch (gameInfo.param) {
          case "genshin": header = "**there are new primogems to be redeemed! Come get em!**"; break;
          case "hkrpg":  header = "**there are new stellar jades to be redeemed! Come get em!**"; break;
          case "nap":    header = "**fresh polychrome from the bangboo on sixth street! Come get them!**"; break;
        }
        const lines = [header];
        publish.forEach(e => {
          let raw = e.rewards ?? e.reward;
          if (!raw) raw = FALLBACKS[gameInfo.param];
          const rewards = Array.isArray(raw) ? raw.join(", ") : String(raw).replace(/&amp;/g, "&").trim();
          const code = getCodeKey(e);
          lines.push(`• **${code}** — ${rewards}\n<${gameInfo.redeem}${code}>`);
        });
        sections.push(lines.join("\n"));
      }

      if (sections.length) {
        await safeSend(channel, sections.join("\n\n"));
      }
    }

    if (changed) {
      saveJSON(DATA_FILE, Object.fromEntries(thresholds));
      saveJSON(PENDING_FILE, pending);
    }
  }, 60 * 60 * 1000);
});

// ─── Message Handler ─────────────────────────────────────────────────
client.on("message", async msg => {
  if (!msg.content) return;
  const key = msg.content.trim().toLowerCase();
  const cid = msg.channel.id ?? msg.channel._id;

  // enable auto-fetch
  if (key === "!enablefetch") {
    if (!thresholds.has(cid)) {
      const thr = {};
      for (const gInfo of Object.values(GAMES)) {
        try {
          const res = await axios.get(API_BASE + gInfo.param);
          const list = res.data.codes || res.data.active || [];
          thr[gInfo.param] = list.reduce((max,e)=>Math.max(max, getIdNum(e)), 0);
        } catch {
          thr[gInfo.param] = 0;
        }
      }
      thresholds.set(cid, thr);
      saveJSON(DATA_FILE, Object.fromEntries(thresholds));
      return safeSend(msg.channel, `✅ Auto-fetch enabled! I’ll check every hour and announce new codes here. (Delaying ${DETAIL_HOLD_MINUTES}m for missing reward details, up to ${DETAIL_RETRY_LIMIT} attempts)`) ;
    }
    return safeSend(msg.channel, "ℹ️ Auto-fetch is already enabled in this channel.");
  }

  // disable auto-fetch
  if (key === "!disablefetch") {
    if (thresholds.has(cid)) {
      thresholds.delete(cid);
      saveJSON(DATA_FILE, Object.fromEntries(thresholds));
      delete pending[cid];
      saveJSON(PENDING_FILE, pending);
      return safeSend(msg.channel, "❎ Auto-fetch disabled. I won’t post new codes here anymore.");
    }
    return safeSend(msg.channel, "ℹ️ Auto-fetch wasn’t enabled in this channel.");
  }

  // manual force-fetch
  const manualMap = {
    '!forcegi':  GAMES['!fetchgi'],
    '!forcehsr': GAMES['!fetchhsr'],
    '!forcezzz': GAMES['!fetchzzz'],
  };
  const gameInfo = manualMap[key];
  if (gameInfo) {
    try {
      const { data } = await axios.get(API_BASE + gameInfo.param);
      const list = data.codes || data.active || [];
      const header = `After manually checking the codes for ${gameInfo.name}, here are the codes. This includes new codes, and some codes which aren't new but may still be active.`;
      const lines = [header];
      list.forEach(entry => {
        let raw = entry.rewards ?? entry.reward;
        if (!raw) raw = FALLBACKS[gameInfo.param];
        const rewards = Array.isArray(raw) ? raw.join(", ") : String(raw).replace(/&amp;/g, "&").trim();
        const code = getCodeKey(entry);
        lines.push(`• **${code}** — ${rewards}\n<${gameInfo.redeem}${code}>`);
      });
      return safeSend(msg.channel, lines.join("\n"));
    } catch (err) {
      console.error(`Manual force fetch error for ${gameInfo.name}:`, err);
      return safeSend(msg.channel, "Failed to manually fetch codes — try again later.");
    }
  }
});

// ─── Start Bot ──────────────────────────────────────────────────────
client.loginBot(TOKEN).catch(err => {
  console.error("❌ Login failed:", err);
  process.exit(1);
});
