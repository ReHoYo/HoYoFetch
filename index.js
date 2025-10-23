import { Client } from "revolt.js";
import axios from "axios";
import fs from "fs";
import path from "path";
import "dotenv/config";

// ───────────────────────────────────────────────────────────────────
// Config & Env
// ───────────────────────────────────────────────────────────────────
const TOKEN = process.env.REVOLT_BOT_TOKEN?.trim();
if (!TOKEN) {
  console.error("❌ REVOLT_BOT_TOKEN is missing! Please check your env.");
  process.exit(1);
}

function clampInt(val, def, min = 0, max = 1e9) {
  const n = Number(val);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

const API_BASE = "https://hoyo-codes.seria.moe/codes?game=";
const GAMES = {
  "!fetchgi":  { param: "genshin", name: "Genshin Impact",  redeem: "https://genshin.hoyoverse.com/en/gift?code=" },
  "!fetchhsr": { param: "hkrpg",   name: "Honkai Star Rail", redeem: "https://hsr.hoyoverse.com/gift?code=" },
  "!fetchzzz": { param: "nap",     name: "Zenless Zone Zero", redeem: "https://zenless.hoyoverse.com/redemption?code=" },
};

// Hold (minutes) waiting for reward text
const DETAIL_HOLD_MINUTES = clampInt(process.env.DETAIL_HOLD_MINUTES, 90);
// Max hourly checks before posting without rewards
const DETAIL_RETRY_LIMIT  = clampInt(process.env.DETAIL_RETRY_LIMIT, 3);
// Cooldown (seconds) for manual !force* commands per-channel
const MANUAL_COOLDOWN_SEC = clampInt(process.env.MANUAL_COOLDOWN_SEC, 30);
// Sweep period (ms)
const SWEEP_PERIOD_MS = clampInt(process.env.SWEEP_PERIOD_MS, 60 * 60 * 1000, 10_000);
// Message chunk limit (safety margin below any hard limit)
const MESSAGE_LIMIT = clampInt(process.env.MESSAGE_LIMIT, 1900, 500, 4000);
// Pending GC tuning
const MAX_ABSENT_SWEEPS = clampInt(process.env.MAX_ABSENT_SWEEPS, 6, 1, 100);            // ~6 hours if hourly
const MAX_PENDING_AGE_MIN = clampInt(process.env.MAX_PENDING_AGE_MIN, 7*24*60, 60, 90*24*60); // 7 days

// ───────────────────────────────────────────────────────────────────
// Persistence Helpers
// ───────────────────────────────────────────────────────────────────
const DATA_FILE    = path.resolve(process.cwd(), "enabledChannels.json");
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
    const tmp = file + "." + Date.now() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error(`❌ Failed to save ${file}:`, err);
  }
}

function flushStateAndExit(code = 0) {
  try {
    saveJSON(DATA_FILE, Object.fromEntries(thresholds));
    saveJSON(PENDING_FILE, pending);
  } finally {
    process.exit(code);
  }
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`⚠️ Caught ${sig}, flushing state...`);
    flushStateAndExit(0);
  });
}

// ───────────────────────────────────────────────────────────────────
// State
// ───────────────────────────────────────────────────────────────────
// thresholds: Map<channelId, { genshin:number, hkrpg:number, nap:number }>
const thresholds = new Map(Object.entries(loadJSON(DATA_FILE)));
// pending: { [cid]: { [param]: { [code]: { count:number, firstSeen:number, _absent?:number } } } }
const pending = loadJSON(PENDING_FILE);

const client = new Client();
process.on("unhandledRejection", console.error);

// Manual command cooldowns: Map<cid, number (epoch ms)>
const lastManualUse = new Map();

// ───────────────────────────────────────────────────────────────────
// Small Utils
// ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getChannelId = (c) => String(c?.id ?? c?._id ?? "");
const getCodeKey = (e) => e?.code || e?.key || e?.name || e?.id || e?._id || String(e ?? "");
const decodeEntities = (s = "") =>
  String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

// Derive a robust monotonic-ish key: prefer timestamps, then numeric IDs.
const getSortKey = (e) => {
  const ts = Date.parse(e?.timestamp || e?.created_at || e?.published_at || "") || 0;
  const n  = Number.isFinite(Number(e?.id)) ? Number(e.id) : 0;
  return ts || n; // fall back to whatever is present
};

function chunkByLines(text, limit = MESSAGE_LIMIT) {
  const out = [];
  let buf = "";
  for (const line of String(text ?? "").split("\n")) {
    const cand = buf ? buf + "\n" + line : line;
    if (cand.length > limit) {
      if (buf) out.push(buf);
      if (line.length > limit) {
        for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
        buf = "";
      } else {
        buf = line;
      }
    } else {
      buf = cand;
    }
  }
  if (buf) out.push(buf);
  return out;
}

async function safeSend(channel, content) {
  try {
    const text = String(content ?? "").trim();
    if (!text) return;
    const parts = chunkByLines(text);
    for (const p of parts) {
      await channel.sendMessage(p);
      await sleep(250); // rate limit friendly
    }
  } catch (err) {
    const chId = getChannelId(channel);
    console.error(`❌ Failed to send message to ${chId}:`, err);
    const m = String(err?.message || "").toLowerCase();
    if (m.includes("permission") || m.includes("missing access")) {
      thresholds.delete(chId);
      delete pending[chId];
      saveJSON(DATA_FILE, Object.fromEntries(thresholds));
      saveJSON(PENDING_FILE, pending);
      console.warn(`🚫 Auto-fetch removed for ${chId} due to permissions. Pending cleared.`);
    }
  }
}

// HTTP with retries & timeout
async function getWithRetry(url, tries = 3, timeout = 15000) {
  for (let i = 1; i <= tries; i++) {
    try {
      return await axios.get(url, { timeout });
    } catch (e) {
      if (i === tries) throw e;
      await sleep(i * 500);
    }
  }
}

// Fetch each game's list once per sweep
async function fetchAllGamesOnce() {
  const results = {};
  await Promise.all(
    Object.values(GAMES).map(async (g) => {
      try {
        const { data } = await getWithRetry(API_BASE + g.param);
        results[g.param] = data?.codes || data?.active || [];
      } catch (e) {
        console.error(`⚠️ Fetch failed for ${g.param}:`, e?.message || e);
        results[g.param] = [];
      }
    })
  );
  return results;
}

// Permission helper: allow DMs, enforce server "Manage Channel" where applicable
function canManageChannel(msg) {
  try {
    const ch = msg.channel;
    const isServerBound = Boolean(ch?.server || ch?.server_id || msg?.server);
    if (!isServerBound) return true; // DMs / group DMs: allow
    if (typeof ch?.permissionsFor === "function") {
      const perms = ch.permissionsFor(msg.member);
      if (perms?.has?.("ManageChannel")) return true;
    }
    if (typeof ch?.havePermission === "function") {
      return !!ch.havePermission(msg.member, "ManageChannel");
    }
  } catch (e) {
    console.error("Permission check failed:", e);
  }
  return false;
}

// ───────────────────────────────────────────────────────────────────
// Fallback banter
// ───────────────────────────────────────────────────────────────────
const FALLBACKS = {
  genshin: "I asked Paimon and she guesses primogems.",
  hkrpg:   "I asked Pom-Pom and it's probably stellar jade.",
  nap:     "I asked the Bangboo in the back alley of Sixth Street and they told me it's probably polychromes.",
};

// ───────────────────────────────────────────────────────────────────
// Sweep Logic (non-overlapping)
// ───────────────────────────────────────────────────────────────────
let sweepRunning = false;

async function runSweep() {
  if (sweepRunning) return;
  sweepRunning = true;

  let thresholdsChanged = false;
  let pendingChanged = false;

  const t0 = Date.now();
  try {
    const gameLists = await fetchAllGamesOnce();

    // Softer GC for pending to avoid false positives on API flicker
    for (const [cid, games] of Object.entries(pending)) {
      for (const [param, codes] of Object.entries(games)) {
        const masterList = gameLists[param] || [];
        const masterCodeKeys = new Set(masterList.map(getCodeKey));
        for (const [codeKey, info] of Object.entries(codes)) {
          const present = masterCodeKeys.has(codeKey);
          const now = Date.now();
          const firstSeen = Number(info?.firstSeen || now);
          const ageMin = (now - firstSeen) / 60000;

          if (!present) {
            const abs = Number(info?._absent || 0) + 1;
            pending[cid][param][codeKey] = { ...(info || {}), _absent: abs, firstSeen };
            pendingChanged = true;

            if (abs >= MAX_ABSENT_SWEEPS || ageMin >= MAX_PENDING_AGE_MIN) {
              delete pending[cid][param][codeKey];
              pendingChanged = true;
              console.warn(`🗑️ GC: Pruned stale code ${codeKey} (absent=${abs}, ageMin=${Math.round(ageMin)}) in channel ${cid}`);
            }
          } else if (info?._absent) {
            pending[cid][param][codeKey] = { ...(info || {}), _absent: 0, firstSeen };
            pendingChanged = true;
          }
        }
        if (Object.keys(pending[cid][param]).length === 0) delete pending[cid][param];
      }
      if (Object.keys(pending[cid] || {}).length === 0) delete pending[cid];
    }

    // Per-channel publish
    for (const [cid, thr] of thresholds.entries()) {
      const channel = client.channels.get(cid);
      if (!channel) {
        thresholds.delete(cid);
        delete pending[cid];
        thresholdsChanged = true;
        pendingChanged = true;
        continue;
      }

      for (const gameInfo of Object.values(GAMES)) {
        const listRaw = gameLists[gameInfo.param] || [];
        if (!Array.isArray(listRaw) || listRaw.length === 0) continue;

        const lastKey = Number(thr?.[gameInfo.param] || 0);
        const sorted = listRaw
          .map((e) => ({ ...e, _sortKey: Number(getSortKey(e)) || 0, _codeKey: getCodeKey(e) }))
          .filter((e) => e._sortKey > lastKey && e._sortKey > 0) // ignore ancient/unsorted (0)
          .sort((a, b) => a._sortKey - b._sortKey);

        if (!sorted.length) continue;

        const publish = [];

        for (const e of sorted) {
          const hasDetails = Boolean(e.rewards ?? e.reward);
          const codeKey = e._codeKey;

          pending[cid] = pending[cid] || {};
          pending[cid][gameInfo.param] = pending[cid][gameInfo.param] || {};
          const prev = pending[cid][gameInfo.param][codeKey];
          let count = 0;
          let firstSeen = Date.now();

          if (prev) {
            if (typeof prev === "number") {
              count = prev;
            } else {
              count = Number(prev.count || 0);
              firstSeen = Number(prev.firstSeen || Date.now());
            }
          }

          if (hasDetails) {
            publish.push(e);
            if (prev) {
              delete pending[cid][gameInfo.param][codeKey];
              pendingChanged = true;
            }
          } else {
            count += 1;
            if (!prev) firstSeen = Date.now();
            pending[cid][gameInfo.param][codeKey] = { count, firstSeen, _absent: 0 };
            pendingChanged = true;

            const ageMin = (Date.now() - firstSeen) / 60000;
            if (count >= DETAIL_RETRY_LIMIT || ageMin >= DETAIL_HOLD_MINUTES) {
              publish.push(e);
              delete pending[cid][gameInfo.param][codeKey];
              pendingChanged = true;
            }
          }
        }

        if (!publish.length) continue;

        const maxKey = Math.max(...publish.map((e) => e._sortKey), lastKey);
        if (maxKey !== lastKey) {
          thr[gameInfo.param] = maxKey;
          thresholdsChanged = true;
        }

        // build message block
        let header = "";
        switch (gameInfo.param) {
          case "genshin": header = "**there are new primogems to be redeemed! Come get em!**"; break;
          case "hkrpg":   header = "**there are new stellar jades to be redeemed! Come get em!**"; break;
          case "nap":     header = "**fresh polychrome from the bangboo on sixth street! Come get them!**"; break;
        }

        const lines = [header];
        for (const e of publish) {
          let raw = e.rewards ?? e.reward;
          if (!raw) raw = FALLBACKS[gameInfo.param];
          const rewards = Array.isArray(raw)
            ? raw.map((x) => decodeEntities(String(x))).join(", ")
            : decodeEntities(String(raw).trim());
          const code = getCodeKey(e);
          const url = `${gameInfo.redeem}${encodeURIComponent(code)}`;
          lines.push(`• **${code}** — ${rewards}\n<${url}>`);
        }

        await safeSend(channel, lines.join("\n"));
        await sleep(500); // avoid bursting 3 game posts at once
      }

      await sleep(200); // tiny delay between channels
    }
  } catch (err) {
    console.error("❌ Sweep error:", err);
  } finally {
    if (thresholdsChanged) saveJSON(DATA_FILE, Object.fromEntries(thresholds));
    if (pendingChanged)    saveJSON(PENDING_FILE, pending);
    sweepRunning = false;
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`Sweep finished in ${dt}s.`);
  }
}

// ───────────────────────────────────────────────────────────────────
// Bot Lifecycle
// ───────────────────────────────────────────────────────────────────
client.on("ready", async () => {
  console.log(`✅ Logged in as ${client.user.username}.`);
  await runSweep();                // immediate first sweep
  setInterval(runSweep, SWEEP_PERIOD_MS);
});

// ───────────────────────────────────────────────────────────────────
// Message Handler
// ───────────────────────────────────────────────────────────────────
client.on("message", async (msg) => {
  if (!msg?.content || !msg.channel) return;
  if (msg.author?.bot) return; // ignore other bots

  const key = msg.content.trim().toLowerCase();
  const cid = getChannelId(msg.channel);

  // enable auto-fetch
  if (key === "!enablefetch") {
    if (!canManageChannel(msg)) {
      return safeSend(msg.channel, "Sorry, cuh. You need the 'Manage Channel' permission for that.");
    }
    if (!thresholds.has(cid)) {
      const thr = {};
      await Promise.all(
        Object.values(GAMES).map(async (gInfo) => {
          try {
            const { data } = await getWithRetry(API_BASE + gInfo.param);
            const list = data?.codes || data?.active || [];
            const maxKey = list.reduce((m, e) => Math.max(m, Number(getSortKey(e)) || 0), 0);
            thr[gInfo.param] = maxKey;
          } catch {
            thr[gInfo.param] = 0;
          }
        })
      );
      thresholds.set(cid, thr);
      saveJSON(DATA_FILE, Object.fromEntries(thresholds));
      return safeSend(
        msg.channel,
        `✅ Auto-fetch enabled! I’ll check every hour and announce new codes here. (Delaying ${DETAIL_HOLD_MINUTES}m for missing reward details, up to ${DETAIL_RETRY_LIMIT} attempts)`
      );
    }
    return safeSend(msg.channel, "ℹ️ Auto-fetch is already enabled in this channel.");
  }

  // disable auto-fetch
  if (key === "!disablefetch") {
    if (!canManageChannel(msg)) {
      return safeSend(msg.channel, "Sorry, cuh. You need the 'Manage Channel' permission for that.");
    }
    if (thresholds.has(cid)) {
      thresholds.delete(cid);
      saveJSON(DATA_FILE, Object.fromEntries(thresholds));
      if (pending[cid]) {
        delete pending[cid];
        saveJSON(PENDING_FILE, pending);
      }
      return safeSend(msg.channel, "❎ Auto-fetch disabled. I won’t post new codes here anymore.");
    }
    return safeSend(msg.channel, "ℹ️ Auto-fetch wasn’t enabled in this channel.");
  }

  // manual force-fetch
  const manualMap = {
    "!forcegi":  GAMES["!fetchgi"],
    "!forcehsr": GAMES["!fetchhsr"],
    "!forcezzz": GAMES["!fetchzzz"],
  };
  const gameInfo = manualMap[key];

  if (gameInfo) {
    // cooldown per channel
    const now = Date.now();
    const last = lastManualUse.get(cid) || 0;
    const waitMs = MANUAL_COOLDOWN_SEC * 1000;
    if (now - last < waitMs) {
      const left = Math.ceil((waitMs - (now - last)) / 1000);
      return safeSend(msg.channel, `⏳ Cooldown: try again in ${left}s.`);
    }
    lastManualUse.set(cid, now);
    setTimeout(() => lastManualUse.delete(cid), 60 * 60 * 1000); // forget after an hour

    try {
      const { data } = await getWithRetry(API_BASE + gameInfo.param);
      const list = data?.codes || data?.active || [];
      const header = `After manually checking the codes for ${gameInfo.name}, here are the codes. This includes new codes, and some codes which aren't new but may still be active.`;

      const lines = [header];
      list.forEach((entry) => {
        let raw = entry.rewards ?? entry.reward;
        if (!raw) raw = FALLBACKS[gameInfo.param];
        const rewards = Array.isArray(raw)
          ? raw.map((x) => decodeEntities(String(x))).join(", ")
          : decodeEntities(String(raw).trim());
        const code = getCodeKey(entry);
        const url = `${gameInfo.redeem}${encodeURIComponent(code)}`;
        lines.push(`• **${code}** — ${rewards}\n<${url}>`);
      });

      return safeSend(msg.channel, lines.join("\n"));
    } catch (err) {
      console.error(`Manual force fetch error for ${gameInfo.name}:`, err);
      return safeSend(msg.channel, "Failed to manually fetch codes — try again later.");
    }
  }
});

// ───────────────────────────────────────────────────────────────────
// Start
// ───────────────────────────────────────────────────────────────────
client.loginBot(TOKEN).catch((err) => {
  console.error("❌ Login failed:", err);
  process.exit(1);
});
