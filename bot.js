#!/usr/bin/env node
// ── WebSocket polyfill for Node < 21 ──────────────
import { spawn } from "child_process";
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
import {
  CONFIG,
  GAMES,
  COMMAND_GAME_MAP,
  HOYO_GAME_KEYS,
  NTE_GAME_KEY,
  getEmojiMode,
  setEmojiMode,
} from "./config.js";
import { fetchCodes } from "./api.js";
import {
  EASTER_EGG_COMMANDS,
  uploadEasterEggAttachment,
} from "./easter-eggs.js";
import {
  buildCodesEmbed,
  buildNoCodesEmbed,
  buildHelpEmbed,
  buildStatusEmbed,
  buildAuditLogEnabledEmbed,
} from "./embeds.js";
import {
  enableChannel,
  disableChannel,
  isChannelEnabled,
  getEnabledChannels,
  detectNewCodes,
  seedKnownCodes,
  hasSeenGame,
  enableAuditLog,
  disableAuditLog,
  isAuditLogEnabled,
} from "./store.js";
import {
  auditAlias,
  authorizeCommand,
  COMMAND_ACCESS,
  CommandRateLimiter,
  getCommandAccess,
  isSafeId,
  safeErrorSummary,
  SingleFlight,
} from "./security.js";
import { initAuditLog, startUnbanPolling, runAuditLogTest } from "./auditlog.js";
import { createTamperProtection } from "./tamper-protection.js";

// ── Validate token ─────────────────────────────────
if (!CONFIG.token || CONFIG.token === "your_bot_token_here") {
  console.error(
    "❌  BOT_TOKEN is not set. Copy .env.example → .env and fill in your token."
  );
  process.exit(1);
}

// ── Create client ──────────────────────────────────
const client = new Client();
let restartInProgress = false;
const commandRateLimiter = new CommandRateLimiter();
const codeFetchSingleFlight = new SingleFlight();
const tamperProtection = createTamperProtection(client, {
  send: (channelId, data) => safeSend({ id: channelId }, data),
  request: apiRequest,
});

// ── Audit log ───────────────────────────────────────
initAuditLog(client, {
  sendProtected: tamperProtection.sendProtected,
});

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

  // Transient WebSocket errors are normal during connection — just log a warning
  console.warn("⚠️  Transient client error (usually recovers automatically)");
});

// ── Ready handler ──────────────────────────────────
client.on("ready", async () => {
  console.log(`✅  Logged in as ${client.user.username}`);
  console.log(`   Prefix : ${CONFIG.prefix}`);
  console.log(`   Interval: every ${CONFIG.fetchIntervalMinutes} min`);
  console.log(`   Enabled channels: ${getEnabledChannels().length}`);

  // Seed known codes on first boot so we don't spam existing codes
  await seedAllGames();

  // Start the auto-fetch loop
  scheduleAutoFetch();

  // Tamper protection: reconcile immediately, then on a fixed interval.
  await tamperProtection.start();

  // Start polling for unbans (no gateway event exists for these)
  startUnbanPolling(client, {
    sendProtected: tamperProtection.sendProtected,
  });
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
  const access = getCommandAccess(body, COMMAND_GAME_MAP);
  if (!access) return;

  const authorization = authorizeCommand(message, access);
  if (!authorization.authorId) return;

  const rateLimit = commandRateLimiter.check(authorization.authorId);
  if (!rateLimit.allowed) {
    if (rateLimit.notify && authorization.channel) {
      await sendRateLimited(authorization.channel, rateLimit.retryAfterMs);
    }
    logCommandAudit(body, authorization, "rate_limited");
    return;
  }

  if (!authorization.allowed) {
    if (authorization.reason === "insufficient_permission") {
      await sendNoPermission(message, access);
      logCommandAudit(body, authorization, "denied");
    }
    return;
  }

  if (access !== COMMAND_ACCESS.MEMBER) {
    logCommandAudit(body, authorization, "allowed");
  }

  try {
    // ── Hidden image easter eggs ─────────────────
    if (EASTER_EGG_COMMANDS[body]) {
      await handleEasterEggCommand(message, EASTER_EGG_COMMANDS[body]);
      return;
    }

    // ── Game fetch commands ──────────────────────
    if (COMMAND_GAME_MAP[body]) {
      await handleFetchCommand(message, COMMAND_GAME_MAP[body]);
      return;
    }

    // ── EnableFetch ──────────────────────────────
    if (body === "enablefetch") {
      await handleEnableFetch(message, "all");
      return;
    }

    // ── EnableFetchHoyo ──────────────────────────
    if (body === "enablefetchhoyo") {
      await handleEnableFetch(message, "hoyo");
      return;
    }

    // ── EnableFetchNTE ───────────────────────────
    if (body === "enablefetchnte") {
      await handleEnableFetch(message, "nte");
      return;
    }

    // ── DisableFetch ─────────────────────────────
    if (body === "disablefetch") {
      await handleDisableFetch(message);
      return;
    }

    // ── Restart ──────────────────────────────────
    if (body === "restart") {
      await handleRestart(message);
      return;
    }

    // ── Enable-AuditLog ──────────────────────────
    if (body === "enable-auditlog" || body === "enableauditlog") {
      await handleEnableAuditLog(message);
      return;
    }

    // ── Disable-AuditLog ─────────────────────────
    if (body === "disable-auditlog" || body === "disableauditlog") {
      await handleDisableAuditLog(message);
      return;
    }

    // ── Test-AuditLog ────────────────────────────
    if (body === "test-auditlog" || body === "testauditlog") {
      await handleTestAuditLog(message);
      return;
    }

    // ── HelpHoyoFetch ────────────────────────────
    if (body === "helphoyofetch") {
      await handleHelp(message);
      return;
    }

    // ── EmojiMode [unicode|custom] ───────────────
    if (body === "emojimode" || body.startsWith("emojimode ")) {
      await handleEmojiMode(message, body.slice("emojimode".length).trim());
      return;
    }

    // ── HarHar ──────────────────────────────────────
    if (body === "harhar") {
      await safeSend(message.channel, { content: ":01KPK39288XJE44RWR495WSZGR:" });
      return;
    }
  } catch (err) {
    console.error(
      `Command error [${body}] actor=${auditAlias(message.authorId)} ` +
      `channel=${auditAlias(message.channelId)} ${safeErrorSummary(err)}`
    );
    await safeSend(message.channel, {
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

// Per-channel cooldown for /Fetch* commands to avoid hammering upstream
// sources when a channel spams the command. Map<channelId, lastFetchMs>.
const fetchCooldowns = new Map();

async function handleEasterEggCommand(message, asset) {
  const attachmentId = await uploadEasterEggAttachment({
    asset,
    autumnUrl: client.configuration?.features?.autumn?.url,
    authenticationHeader: client.authenticationHeader,
  });
  const sent = await safeSend(message.channel, {
    attachments: [attachmentId],
  });
  if (!sent) {
    throw new Error("Easter egg image could not be posted.");
  }
}

async function handleFetchCommand(message, gameKey) {
  const game = GAMES[gameKey];

  // Rate-limit per channel
  const cooldownMs = CONFIG.fetchCooldownSeconds * 1000;
  if (cooldownMs > 0) {
    const channelId = message.channelId;
    const last = fetchCooldowns.get(channelId) ?? 0;
    const elapsed = Date.now() - last;
    if (elapsed < cooldownMs) {
      const wait = Math.ceil((cooldownMs - elapsed) / 1000);
      await safeSend(message.channel, {
        embeds: [
          buildStatusEmbed(
            "⏳ Slow down",
            `Please wait ${wait}s before fetching again.`,
            "#F39C12"
          ),
        ],
      });
      return;
    }
    fetchCooldowns.set(channelId, Date.now());
  }

  // Show which API source we're hitting
  const apiLabel =
    game.source === "hi3_multi"
      ? "community sources"
      : game.source === "game8"
        ? "Game8"
        : "hoyo-codes API";

  const loadingEmbed = buildStatusEmbed(
    `⏳ Fetching ${game.name} codes…`,
    `Contacting the ${apiLabel}…`,
    game.colour
  );
  const loadingMsg = await safeSend(message.channel, { embeds: [loadingEmbed] });

  const codes = await fetchCodesOnce(gameKey);

  if (!codes.length) {
    if (loadingMsg?._id) await safeDelete(message.channel.id, loadingMsg._id);
    await safeSend(message.channel, {
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
    await tamperProtection.sendProtected(message.channel, { embeds: [embed] });
  }

  // Delete the loading message now that all code embeds are posted
  if (loadingMsg?._id) await safeDelete(message.channel.id, loadingMsg._id);
}

async function handleEnableFetch(message, scope = "all") {
  const channelId = message.channelId;
  const result = enableChannel(channelId, scope);
  const scopeLabel = getScopeLabel(result.currentScope);

  if (result.wasEnabled && !result.changed) {
    await tamperProtection.sendProtected(message.channel, {
      embeds: [
        buildStatusEmbed(
          "ℹ️ Already Enabled",
          `Auto-fetch is already active in this channel for ${scopeLabel}.`,
          "#3498DB"
        ),
      ],
    });
    return;
  }

  const title = result.wasEnabled ? "✅ Auto-Fetch Updated" : "✅ Auto-Fetch Enabled";
  await tamperProtection.sendProtected(message.channel, {
    embeds: [
      buildStatusEmbed(
        title,
        `This channel will now receive new ${scopeLabel} automatically every hour.\n` +
        `Use \`${CONFIG.prefix}DisableFetch\` to stop.`,
        "#2ECC71"
      ),
    ],
  });
}

async function handleDisableFetch(message) {
  const channelId = message.channelId;

  if (!isChannelEnabled(channelId)) {
    await tamperProtection.sendProtected(message.channel, {
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
  await tamperProtection.sendProtected(message.channel, {
    embeds: [
      buildStatusEmbed(
        "🔕 Auto-Fetch Disabled",
        "This channel will no longer receive automatic code updates.",
        "#E67E22"
      ),
    ],
  });
}

async function handleEnableAuditLog(message) {
  const result = enableAuditLog(message.server.id, message.channelId);

  if (result.wasEnabled && !result.changed) {
    await safeSend(message.channel, {
      embeds: [
        buildStatusEmbed(
          "ℹ️ Already Enabled",
          "Audit logging is already active in this channel.",
          "#3498DB"
        ),
      ],
    });
    return;
  }

  await safeSend(message.channel, {
    embeds: [
      buildAuditLogEnabledEmbed(CONFIG.prefix, {
        moved: result.wasEnabled,
        previousChannelId: result.previousChannelId,
      }),
    ],
  });
}

async function handleDisableAuditLog(message) {
  const serverId = message.server.id;

  if (!isAuditLogEnabled(serverId)) {
    await safeSend(message.channel, {
      embeds: [
        buildStatusEmbed(
          "ℹ️ Already Disabled",
          "Audit logging is not active in this server.",
          "#3498DB"
        ),
      ],
    });
    return;
  }

  disableAuditLog(serverId);
  await safeSend(message.channel, {
    embeds: [
      buildStatusEmbed(
        "🔕 Audit Log Disabled",
        "This server will no longer receive audit log messages.",
        "#E67E22"
      ),
    ],
  });
}

async function handleTestAuditLog(message) {
  const status = runAuditLogTest(message.server.id);

  if (!status.enabled) {
    await safeSend(message.channel, {
      embeds: [
        buildStatusEmbed(
          "ℹ️ Audit Log Not Enabled",
          `Audit logging is not active in this server. Run \`${CONFIG.prefix}Enable-AuditLog\` in the channel that should receive the log.`,
          "#3498DB"
        ),
      ],
    });
    return;
  }

  const evidenceMB = (status.evidenceBytes / (1024 * 1024)).toFixed(1);
  const evidenceBudgetMB = Math.round(status.evidenceBudgetBytes / (1024 * 1024));
  const lines = [
    `Test event queued — a 🧪 embed should appear in <#${status.channelId}> within a few seconds.`,
    `**Messages currently archived:** ${status.archivedCount}`,
    `**Attachment evidence stored:** ${status.evidenceFiles} file(s), ${evidenceMB} MB / ${evidenceBudgetMB} MB` +
      (status.evidenceBudgetBytes === 0 ? " (evidence capture disabled)" : ""),
  ];
  if (status.consecutiveFailures > 0) {
    lines.push(
      `⚠️ **${status.consecutiveFailures} recent send failure(s)** — if the test embed does not appear, ` +
      "check that I can send messages and embeds in the log channel."
    );
  }
  lines.push("If no 🧪 embed appears, the send pipeline is broken — check my channel permissions and console logs.");

  await safeSend(message.channel, {
    embeds: [buildStatusEmbed("🧪 Audit Log Test Queued", lines.join("\n"), "#3498DB")],
  });
}

async function handleHelp(message) {
  await safeSend(message.channel, {
    embeds: [buildHelpEmbed(CONFIG.prefix)],
  });
}

async function handleEmojiMode(message, arg) {
  // No argument → report the current mode.
  if (!arg) {
    await safeSend(message.channel, {
      embeds: [
        buildStatusEmbed(
          "🎨 Emoji Mode",
          `Current mode: **${getEmojiMode()}**.\n` +
          `Use \`${CONFIG.prefix}EmojiMode unicode\` or \`${CONFIG.prefix}EmojiMode custom\` to change it.`,
          "#3498DB"
        ),
      ],
    });
    return;
  }

  if (!setEmojiMode(arg)) {
    await safeSend(message.channel, {
      embeds: [
        buildStatusEmbed(
          "⚠️ Invalid mode",
          `\`${arg}\` is not valid. Choose **unicode** or **custom**.`,
          "#E74C3C"
        ),
      ],
    });
    return;
  }

  await safeSend(message.channel, {
    embeds: [
      buildStatusEmbed(
        "✅ Emoji Mode Updated",
        `Emoji rendering is now set to **${getEmojiMode()}**.`,
        "#2ECC71"
      ),
    ],
  });
}

async function handleRestart(message) {
  if (restartInProgress) {
    await safeSend(message.channel, {
      embeds: [
        buildStatusEmbed(
          "ℹ️ Restart Already Queued",
          "A restart is already in progress.",
          "#3498DB"
        ),
      ],
    });
    return;
  }

  restartInProgress = true;
  const supervisorMode = shouldUseSupervisorRestart();
  const restartMode = supervisorMode ? "the host process manager" : "a new local bot process";

  await safeSend(message.channel, {
    embeds: [
      buildStatusEmbed(
        "🔄 Restarting HoyoFetch",
        `Restart requested. I will disconnect now and come back through ${restartMode}.`,
        "#F1C40F"
      ),
    ],
  });

  console.log(
    `🔄  Restart requested actor=${auditAlias(message.authorId)}; ` +
    `mode=${supervisorMode ? "supervisor" : "self-spawn"}`
  );

  setTimeout(() => restartProcess(supervisorMode), 1_000).unref();
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

  // Check only games that at least one enabled channel has subscribed to.
  const activeGames = Object.values(GAMES).filter(
    (g) => !g.deprecated && enabledChannels.some((ch) => scopeIncludesGame(ch.scope, g.key))
  );

  for (const game of activeGames) {
    try {
      const subscribedChannels = enabledChannels.filter((ch) =>
        scopeIncludesGame(ch.scope, game.key)
      );
      const codes = await fetchCodesOnce(game.key);
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

      for (const { id: chId } of subscribedChannels) {
        try {
          const channel = client.channels.get(chId);
          if (!channel) continue;

          for (let i = 0; i < newCodeObjects.length; i += BATCH_SIZE) {
            const batch = newCodeObjects.slice(i, i + BATCH_SIZE);
            const page = Math.floor(i / BATCH_SIZE) + 1;
            const embed = buildCodesEmbed(game.key, batch, {
              isAuto: true,
              page: totalBatches > 1 ? `${page}/${totalBatches}` : null,
            });
            if (!isSafeId(chId)) continue;
            await tamperProtection.sendProtected(channel, { embeds: [embed] });
          }
        } catch (err) {
          console.error(
            `   Failed to send channel=${auditAlias(chId)}: ${safeErrorSummary(err)}`
          );
        }
      }
    } catch (err) {
      console.error(
        `   Auto-fetch error for ${game.name}: ${safeErrorSummary(err)}`
      );
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
      const codes = await fetchCodesOnce(game.key);
      const codeStrings = codes.map((c) => c.code);
      seedKnownCodes(game.key, codeStrings);
      console.log(
        `   Seeded ${game.name} (${game.source}): ${codeStrings.length} codes`
      );
    } catch (err) {
      console.error(`   Seed error for ${game.name}: ${safeErrorSummary(err)}`);
    }
  }
}

// ═══════════════════════════════════════════════════
//  Command security
// ═══════════════════════════════════════════════════

async function sendNoPermission(message, access) {
  const description =
    access === COMMAND_ACCESS.ADMIN
      ? "Only the server owner or members with **Manage Server** permission can use this command."
      : "Only server administrators or members with moderation permissions can use this command.";
  await safeSend(message.channel, {
    embeds: [
      buildStatusEmbed(
        "🔒 Permission Denied",
        description,
        "#E74C3C"
      ),
    ],
  });
}

async function sendRateLimited(channel, retryAfterMs) {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
  await safeSend(channel, {
    embeds: [
      buildStatusEmbed(
        "⏳ Slow Down",
        `Too many commands were sent. Try again in ${retryAfterSeconds} seconds.`,
        "#E67E22"
      ),
    ],
  });
}

function logCommandAudit(command, authorization, outcome) {
  console.log(
    `🔐  command=${command} outcome=${outcome} reason=${authorization.reason} ` +
    `actor=${auditAlias(authorization.authorId)} ` +
    `channel=${auditAlias(authorization.channelId)}`
  );
}

function fetchCodesOnce(gameKey) {
  return codeFetchSingleFlight.run(gameKey, () => fetchCodes(gameKey));
}

function scopeIncludesGame(scope, gameKey) {
  if (scope === "hoyo") return HOYO_GAME_KEYS.includes(gameKey);
  if (scope === "nte") return gameKey === NTE_GAME_KEY;
  return true;
}

function getScopeLabel(scope) {
  if (scope === "hoyo") return "HoYoverse codes";
  if (scope === "nte") return "NTE codes";
  return "HoYoverse and NTE codes";
}

function shouldUseSupervisorRestart() {
  return Boolean(
    process.env.pm_id ||
    process.env.PM2_HOME ||
    process.env.INVOCATION_ID ||
    process.env.KUBERNETES_SERVICE_HOST
  );
}

function restartProcess(supervisorMode) {
  if (!supervisorMode) {
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...process.env,
        HOYOFETCH_RESTART_CHILD: "1",
      },
      stdio: "ignore",
    });
    child.unref();
  }

  process.exit(supervisorMode ? 1 : 0);
}

// ═══════════════════════════════════════════════════
//  Utility
// ═══════════════════════════════════════════════════

async function safeSend(channel, data) {
  try {
    if (!channel?.id) {
      console.warn("safeSend: channel is missing or has no id");
      return;
    }
    if (!isSafeId(channel.id)) {
      console.warn("safeSend: channel id contains invalid characters");
      return;
    }
    // Revolt requires content field; add a blank one if only embeds are sent
    if (data.embeds && !data.content) {
      data.content = " ";
    }
    // Use REST API directly to avoid revolt.js hydration bug with solid-js
    return await client.api.post(`/channels/${channel.id}/messages`, data);
  } catch (err) {
    console.error(
      `safeSend error channel=${auditAlias(channel?.id)}: ${safeErrorSummary(err)}`
    );
    // Fallback: try sending as plain text if embed failed
    try {
      const embed = data?.embeds?.[0];
      if (embed && channel?.id) {
        const fallback = `**${embed.title || ""}**\n${embed.description || ""}`;
        return await client.api.post(`/channels/${channel.id}/messages`, {
          content: fallback,
        });
      }
    } catch (fallbackErr) {
      console.error(
        `safeSend fallback error channel=${auditAlias(channel?.id)}: ` +
        safeErrorSummary(fallbackErr)
      );
    }
  }
}

async function safeDelete(channelId, messageId) {
  try {
    if (!isSafeId(channelId) || !isSafeId(messageId)) {
      console.warn("safeDelete: ID contains invalid characters");
      return;
    }
    await tamperProtection.runIntentionalDelete(messageId, async () => {
      const url = `${client.api.baseURL}/channels/${channelId}/messages/${messageId}`;
      const res = await fetch(url, {
        method: "DELETE",
        headers: client.api.config.headers,
      });
      if (!res.ok) {
        console.warn(`safeDelete: HTTP ${res.status} ${res.statusText}`);
      }
      return res.ok;
    });
  } catch (err) {
    console.warn(
      `safeDelete error channel=${auditAlias(channelId)}: ${safeErrorSummary(err)}`
    );
  }
}

/**
 * Raw REST call that surfaces the HTTP status code — client.api never
 * checks response.ok, so a 429/403/404 would otherwise resolve as if it
 * were a success. Needed for the repost path's failure classification.
 */
async function apiRequest(method, path, body) {
  try {
    const res = await fetch(`${client.api.baseURL}${path}`, {
      method,
      headers: {
        ...client.api.config.headers,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    let data;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: undefined, err };
  }
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
