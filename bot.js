#!/usr/bin/env node
// ── WebSocket polyfill for Node < 21 ──────────────
import { WebSocket as _WS } from "ws";
if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = _WS;
}

// bot.js — HoyoFetch: Revolt/Stoat bot for HoYoverse redemption codes
// ════════════════════════════════════════════════════════════════════
//
// IMPORTANT DESIGN NOTE
// ─────────────────────
// Revolt (Stoat.chat) does NOT support Discord-style slash commands or
// interactions. All "slash commands" here are actually message-based
// prefix commands. We use "/" as the prefix so the UX feels familiar,
// but they are parsed from message content, not from an interaction API.
//
// ════════════════════════════════════════════════════════════════════

import { Client } from "revolt.js";
import { CONFIG, GAMES, COMMAND_GAME_MAP } from "./config.js";
import { fetchCodes } from "./api.js";
import {
  buildCodesEmbed,
  buildNoCodesEmbed,
  buildHelpEmbed,
  buildStatusEmbed,
} from "./embeds.js";
import {
  enableChannel,
  disableChannel,
  isChannelEnabled,
  getEnabledChannels,
  detectNewCodes,
  seedKnownCodes,
  hasSeenGame,
} from "./store.js";

// ── Validate token ─────────────────────────────────
if (!CONFIG.token || CONFIG.token === "your_bot_token_here") {
  console.error(
    "❌  BOT_TOKEN is not set. Copy .env.example → .env and fill in your token."
  );
  process.exit(1);
}

// ── Create client ──────────────────────────────────
const client = new Client(
  { baseURL: CONFIG.revoltApiBase },
  {
    app: "https://stoat.chat",
    ws: CONFIG.revoltWsUrl,
  }
);

// ── Error handler ──────────────────────────────────
client.on("error", (err) => {
  const errData = err?.data ?? err;

  // InvalidSession means the token was rejected — no point retrying
  if (errData?.type === "InvalidSession") {
    console.error(
      "❌  Your BOT_TOKEN is invalid or expired.\n" +
      "   1. Go to your Revolt bot settings and copy a fresh token\n" +
      "   2. Paste it into .env as BOT_TOKEN=<token>\n" +
      "   3. Restart the bot"
    );
    process.exit(1);
  }

  const detail =
    errData?.message ||
    errData?.error?.message ||
    errData?.type ||
    "unknown client error";
  console.warn(`⚠️  Client error: ${detail}`);
});

// ── Ready handler ──────────────────────────────────
client.on("ready", async () => {
  console.log(`✅  Logged in as ${client.user.username}`);
  console.log(`   Prefix : ${CONFIG.prefix}`);
  console.log(`   API    : ${CONFIG.revoltApiBase}`);
  console.log(`   Events : ${CONFIG.revoltWsUrl}`);
  console.log(`   Interval: every ${CONFIG.fetchIntervalMinutes} min`);
  console.log(`   Enabled channels: ${getEnabledChannels().length}`);

  // Seed known codes on first boot so we don't spam existing codes
  await seedAllGames();

  // Start the auto-fetch loop
  scheduleAutoFetch();
});

// ── Message handler (command router) ───────────────
client.on("messageCreate", async (message) => {
  // Ignore own messages and messages without content
  if (!message.content) return;
  if (message.authorId === client.user.id) return;

  const raw = message.content.trim();

  // Reject excessively long messages early to avoid unnecessary processing
  if (raw.length > 200) return;

  // Must start with the prefix
  if (!raw.toLowerCase().startsWith(CONFIG.prefix.toLowerCase())) return;

  // Strip prefix and lowercase for matching
  const body = raw.slice(CONFIG.prefix.length).toLowerCase();

  try {
    // ── Game fetch commands ──────────────────────
    if (COMMAND_GAME_MAP[body]) {
      await handleFetchCommand(message, COMMAND_GAME_MAP[body]);
      return;
    }

    // ── EnableFetch ──────────────────────────────
    if (body === "enablefetch") {
      if (!requirePermission(message)) {
        await sendNoPermission(message);
        return;
      }
      await handleEnableFetch(message);
      return;
    }

    // ── DisableFetch ─────────────────────────────
    if (body === "disablefetch") {
      if (!requirePermission(message)) {
        await sendNoPermission(message);
        return;
      }
      await handleDisableFetch(message);
      return;
    }

    // ── HelpHoyoFetch ────────────────────────────
    if (body === "helphoyofetch") {
      await handleHelp(message);
      return;
    }

    // ── HarHar ──────────────────────────────────────
    if (body === "harhar") {
      await safeSend(message.channelId, { content: ":01KPK39288XJE44RWR495WSZGR:" });
      return;
    }
  } catch (err) {
    console.error(`Command error [${body}]:`, err);
    await safeSend(message.channelId, {
      embeds: [
        buildStatusEmbed(
          "⚠️ Error",
          "Something went wrong while processing your command. Please try again later.",
          "#E74C3C"
        ),
      ],
    });
  }
});

// ═══════════════════════════════════════════════════
//  Command handlers
// ═══════════════════════════════════════════════════

async function handleFetchCommand(message, gameKey) {
  const game = GAMES[gameKey];

  // Show which API source we're hitting
  const apiLabel =
    game.source === "hi3_multi"
      ? "community sources"
      : game.source === "nte_scrape"
        ? "neverness.gg codes page"
        : "hoyo-codes API";

  const loadingEmbed = buildStatusEmbed(
    `⏳ Fetching ${game.name} codes…`,
    `Contacting the ${apiLabel}…`,
    game.colour
  );
  const loadingMsg = await safeSend(message.channelId, { embeds: [loadingEmbed] });

  const codes = await fetchCodes(gameKey);

  if (!codes.length) {
    if (loadingMsg?._id) await safeDelete(message.channelId, loadingMsg._id);
    await safeSend(message.channelId, {
      embeds: [buildNoCodesEmbed(gameKey)],
    });
    return;
  }

  // Revolt has a ~2000 char embed limit — batch codes into groups
  const BATCH_SIZE = 10;
  const totalBatches = Math.ceil(codes.length / BATCH_SIZE);

  for (let i = 0; i < codes.length; i += BATCH_SIZE) {
    const batch = codes.slice(i, i + BATCH_SIZE);
    const page = Math.floor(i / BATCH_SIZE) + 1;
    const embed = buildCodesEmbed(gameKey, batch, {
      isAuto: false,
      page: totalBatches > 1 ? `${page}/${totalBatches}` : null,
    });
    await safeSend(message.channelId, { embeds: [embed] });
  }

  // Delete the loading message now that all code embeds are posted
  if (loadingMsg?._id) await safeDelete(message.channelId, loadingMsg._id);
}

async function handleEnableFetch(message) {
  const channelId = message.channelId;

  if (isChannelEnabled(channelId)) {
    await safeSend(channelId, {
      embeds: [
        buildStatusEmbed(
          "ℹ️ Already Enabled",
          "Auto-fetch is already active in this channel.",
          "#3498DB"
        ),
      ],
    });
    return;
  }

  enableChannel(channelId);
  await safeSend(channelId, {
    embeds: [
      buildStatusEmbed(
        "✅ Auto-Fetch Enabled",
        "This channel will now receive new HoYoverse codes automatically every hour.\n" +
        `Use \`${CONFIG.prefix}DisableFetch\` to stop.`,
        "#2ECC71"
      ),
    ],
  });
}

async function handleDisableFetch(message) {
  const channelId = message.channelId;

  if (!isChannelEnabled(channelId)) {
    await safeSend(channelId, {
      embeds: [
        buildStatusEmbed(
          "ℹ️ Already Disabled",
          "Auto-fetch is not active in this channel.",
          "#3498DB"
        ),
      ],
    });
    return;
  }

  disableChannel(channelId);
  await safeSend(channelId, {
    embeds: [
      buildStatusEmbed(
        "🔕 Auto-Fetch Disabled",
        "This channel will no longer receive automatic code updates.",
        "#E67E22"
      ),
    ],
  });
}

async function handleHelp(message) {
  await safeSend(message.channelId, {
    embeds: [buildHelpEmbed(CONFIG.prefix)],
  });
}

// ═══════════════════════════════════════════════════
//  Auto-fetch scheduler
// ═══════════════════════════════════════════════════

function scheduleAutoFetch() {
  const ms = CONFIG.fetchIntervalMinutes * 60 * 1000;
  setInterval(() => runAutoFetch(), ms);
  console.log(
    `⏰  Auto-fetch scheduled: every ${CONFIG.fetchIntervalMinutes} minutes`
  );
}

async function runAutoFetch() {
  const enabledChannels = getEnabledChannels();
  if (enabledChannels.length === 0) return;

  console.log(
    `🔄  Auto-fetch triggered — ${enabledChannels.length} channel(s)`
  );

  // Check ALL non-deprecated games (HI3 is now included!)
  const activeGames = Object.values(GAMES).filter((g) => !g.deprecated);

  for (const game of activeGames) {
    try {
      const codes = await fetchCodes(game.key);
      const codeStrings = codes.map((c) => c.code);

      const newCodes = detectNewCodes(game.key, codeStrings);

      if (newCodes.length === 0) {
        console.log(`   ${game.name}: no new codes`);
        continue;
      }

      console.log(`   ${game.name}: ${newCodes.length} new code(s)!`);

      const newCodeObjects = codes.filter((c) => newCodes.includes(c.code));

      // Batch codes to stay under Revolt's embed size limit
      const BATCH_SIZE = 10;
      const totalBatches = Math.ceil(newCodeObjects.length / BATCH_SIZE);

      for (const chId of enabledChannels) {
        try {
          if (!isSafeId(chId)) continue;

          for (let i = 0; i < newCodeObjects.length; i += BATCH_SIZE) {
            const batch = newCodeObjects.slice(i, i + BATCH_SIZE);
            const page = Math.floor(i / BATCH_SIZE) + 1;
            const embed = buildCodesEmbed(game.key, batch, {
              isAuto: true,
              page: totalBatches > 1 ? `${page}/${totalBatches}` : null,
            });
            await safeSend(chId, { embeds: [embed] });
          }
        } catch (err) {
          console.error(`   Failed to send to channel ${chId}:`, err.message);
        }
      }
    } catch (err) {
      console.error(`   Auto-fetch error for ${game.name}:`, err.message);
    }
  }
}

/**
 * Seed known codes on startup so the bot doesn't announce all
 * existing codes as "new" when first deployed.
 */
async function seedAllGames() {
  const activeGames = Object.values(GAMES).filter((g) => !g.deprecated);

  for (const game of activeGames) {
    if (hasSeenGame(game.key)) continue;

    try {
      const codes = await fetchCodes(game.key);
      const codeStrings = codes.map((c) => c.code);
      seedKnownCodes(game.key, codeStrings);
      console.log(
        `   Seeded ${game.name} (${game.source}): ${codeStrings.length} codes`
      );
    } catch (err) {
      console.error(`   Seed error for ${game.name}:`, err.message);
    }
  }
}

// ═══════════════════════════════════════════════════
//  Permissions
// ═══════════════════════════════════════════════════

/**
 * Check whether the message author has a server-level permission.
 * Returns false if there is no server context (e.g. DMs).
 */
function requirePermission(message, permission = "ManageServer") {
  const member = message.member;
  const server = message.server;
  if (!member || !server) return false;
  return member.hasPermission(server, permission);
}

async function sendNoPermission(message) {
  await safeSend(message.channelId, {
    embeds: [
      buildStatusEmbed(
        "🔒 Permission Denied",
        "You need the **Manage Server** permission to use this command.",
        "#E74C3C"
      ),
    ],
  });
}

// ═══════════════════════════════════════════════════
//  Utility
// ═══════════════════════════════════════════════════

async function safeSend(channel, data) {
  const channelId = getChannelId(channel);
  try {
    if (!channelId) {
      console.warn("safeSend: channel is missing or has no id");
      return;
    }
    if (!isSafeId(channelId)) {
      console.warn("safeSend: channel id contains invalid characters");
      return;
    }
    // Revolt requires content field; add a blank one if only embeds are sent
    if (data.embeds && !data.content) {
      data.content = " ";
    }
    // Use REST API directly to avoid revolt.js hydration bug with solid-js
    return await revoltRequest("POST", `/channels/${channelId}/messages`, data);
  } catch (err) {
    console.error("safeSend error:", err?.message || err);
    // Fallback: try sending as plain text if embed failed
    try {
      const embed = data?.embeds?.[0];
      if (embed && channelId) {
        const fallback = `**${embed.title || ""}**\n${embed.description || ""}`;
        await revoltRequest("POST", `/channels/${channelId}/messages`, {
          content: fallback,
        });
      }
    } catch (fallbackErr) {
      console.error("safeSend fallback error:", fallbackErr?.message || fallbackErr);
    }
  }
}

function getChannelId(channel) {
  if (typeof channel === "string") return channel;
  return channel?.id ?? channel?.channelId ?? null;
}

async function safeDelete(channelId, messageId) {
  try {
    if (!isSafeId(channelId) || !isSafeId(messageId)) {
      console.warn("safeDelete: ID contains invalid characters");
      return;
    }
    await revoltRequest("DELETE", `/channels/${channelId}/messages/${messageId}`);
  } catch (err) {
    console.warn("safeDelete error:", err?.message || err);
  }
}

async function revoltRequest(method, path, data = undefined) {
  const res = await fetch(`${client.api.baseURL}${path}`, {
    method,
    headers: {
      ...client.api.config.headers,
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });

  const text = await res.text();
  const body = text ? parseJSON(text) : null;

  if (!res.ok) {
    const detail =
      body?.reason ||
      body?.error ||
      body?.type ||
      text ||
      `${res.status} ${res.statusText}`;
    throw new Error(`Revolt API ${method} ${path} failed: ${detail}`);
  }

  return body;
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Validate that an ID string contains only alphanumeric characters.
 * Prevents path traversal / URL injection when interpolating into API paths.
 */
function isSafeId(id) {
  return typeof id === "string" && /^[A-Za-z0-9]+$/.test(id);
}

// ── Graceful shutdown ──────────────────────────────
process.on("SIGINT", () => {
  console.log("\n👋  Shutting down…");
  process.exit(0);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

// ── Connect ────────────────────────────────────────
console.log("🚀  Starting HoyoFetch…");
client.loginBot(CONFIG.token);
