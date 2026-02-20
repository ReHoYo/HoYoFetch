import { Client } from "revolt.js";
import axios from "axios";
import { load as loadHtml } from "cheerio";
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
  "!fetchgi":  { param: "genshin", name: "Genshin Impact", source: "api", redeem: "https://genshin.hoyoverse.com/en/gift?code=" },
  "!fetchhsr": { param: "hkrpg",  name: "Honkai Star Rail", source: "api", redeem: "https://hsr.hoyoverse.com/gift?code=" },
  "!fetchzzz": { param: "nap",    name: "Zenless Zone Zero", source: "api", redeem: "https://zenless.hoyoverse.com/redemption?code=" },
  "!fetchhi3": { param: "honkai3rd", name: "Honkai Impact 3rd", source: "hi3", platform: "in-game only" },
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
// thresholds: Map<channelId, { [gameParam]: number | string[] }>
const thresholds = new Map(Object.entries(loadJSON(DATA_FILE)));
// pending: { [cid]: { [param]: { [code]: { count:number, firstSeen:number } } } }
const pending = loadJSON(PENDING_FILE);

const client = new Client();
process.on("unhandledRejection", console.error);

// ID coercion helper
const getIdNum = e => Number(e.id) || 0;
const getCodeKey = e => e.code || e.key || e.name;

async function fetchHi3Codes() {
  const url = "https://honkaiimpact3.fandom.com/wiki/Exchange_Rewards";
  const { data } = await axios.get(url, { headers: { "User-Agent": "hoyofetch-bot" } });
  const $ = loadHtml(data);

  let table = null;
  $("table.wikitable").each((_, el) => {
    if (table) return;
    const headingText = $(el).prevAll("h2, h3").first().text().trim().toLowerCase();
    const captionText = $(el).find("caption").text().trim().toLowerCase();
    if (headingText.includes("active") || captionText.includes("active")) {
      table = el;
    }
  });

  if (!table) table = $("table.wikitable").first().get(0);
  if (!table) return [];

  const codes = [];
  $(table).find("tr").slice(1).each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length >= 4) {
      const code = $(cells[1]).text().trim();
      const date = $(cells[2]).text().trim();
      const rewards = cells.length > 4 ? $(cells[4]).text().trim() : "";
      if (code) {
        codes.push({
          code,
          rewards,
          date,
          game: "honkai3rd",
          platform: "in-game only",
        });
      }
    }
  });

  return codes;
}

async function fetchGameCodes(gameInfo) {
  if (gameInfo.source === "hi3") {
    return fetchHi3Codes();
  }

  const { data } = await axios.get(API_BASE + gameInfo.param);
  return data.codes || data.active || [];
}

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
          list = await fetchGameCodes(gameInfo);
        } catch {
          continue;
        }

        if (gameInfo.source === "hi3") {
          const seenCodes = new Set(Array.isArray(thr[gameInfo.param]) ? thr[gameInfo.param] : []);
          const publish = list.filter(e => !seenCodes.has(getCodeKey(e)));
          if (!publish.length) continue;

          thr[gameInfo.param] = [...new Set([...seenCodes, ...publish.map(getCodeKey)])];
          changed = true;

          const lines = ["**captain! new HI3 exchange rewards were found!**"];
          publish.forEach(e => {
            const code = getCodeKey(e);
            const rewards = (e.rewards || "Reward details unavailable").replace(/\s+/g, " ").trim();
            const date = e.date ? ` (added ${e.date})` : "";
            lines.push(`• **${code}** — ${rewards}${date}\nPlatform: ${e.platform || gameInfo.platform || "in-game only"}`);
          });
          sections.push(lines.join("\n"));
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
          if (!raw && FALLBACKS[gameInfo.param]) raw = FALLBACKS[gameInfo.param];
          if (!raw) raw = "Reward details unavailable";
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
          const list = await fetchGameCodes(gInfo);
          if (gInfo.source === "hi3") {
            thr[gInfo.param] = list.map(getCodeKey);
          } else {
            thr[gInfo.param] = list.reduce((max,e)=>Math.max(max, getIdNum(e)), 0);
          }
        } catch {
          thr[gInfo.param] = gInfo.source === "hi3" ? [] : 0;
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
    '!forcehi3': GAMES['!fetchhi3'],
  };
  const gameInfo = manualMap[key];
  if (gameInfo) {
    try {
      const list = await fetchGameCodes(gameInfo);
      const header = `After manually checking the codes for ${gameInfo.name}, here are the codes. This includes new codes, and some codes which aren't new but may still be active.`;
      const lines = [header];
      list.forEach(entry => {
        let raw = entry.rewards ?? entry.reward;
        if (!raw && FALLBACKS[gameInfo.param]) raw = FALLBACKS[gameInfo.param];
        if (!raw) raw = "Reward details unavailable";
        const rewards = Array.isArray(raw) ? raw.join(", ") : String(raw).replace(/&amp;/g, "&").trim();
        const code = getCodeKey(entry);
        if (gameInfo.redeem) {
          lines.push(`• **${code}** — ${rewards}\n<${gameInfo.redeem}${code}>`);
        } else {
          const date = entry.date ? ` (added ${entry.date})` : "";
          lines.push(`• **${code}** — ${rewards}${date}\nPlatform: ${entry.platform || gameInfo.platform || "in-game only"}`);
        }
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
