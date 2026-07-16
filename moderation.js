// moderation.js — fail-closed manual moderation and bounded user purges
import { randomBytes } from "crypto";
import { buildStatusEmbed } from "./embeds.js";
import {
  findArchivedMessages,
  getArchiveCoverage,
  markMessagesDeleted,
} from "./message-archive.js";
import {
  cancelAutomodCasesForMember,
  clearAutomodStrike,
  createModerationAction,
  findModerationActionByMessage,
  getAuditLogChannel,
  pruneModerationActions,
  updateModerationAction,
} from "./store.js";
import {
  auditAlias,
  authorizeMessageManagerAcrossChannels,
  authorizeServerActor,
  COMMAND_ACCESS,
  isSafeId,
  safeErrorSummary,
} from "./security.js";

export const MODERATION_UNDO_EMOJI = "↩️";
export const MODERATION_CONFIRM_EMOJI = "✅";
export const MODERATION_CANCEL_EMOJI = "❌";

export const MUTE_DURATIONS = Object.freeze({
  "10m": 10 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "3d": 3 * 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
});

export const PURGE_WINDOWS = Object.freeze({
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "3d": 3 * 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
});

const PICKER_EMOJIS = Object.freeze([
  ["1️⃣", "10m"],
  ["2️⃣", "30m"],
  ["3️⃣", "1h"],
  ["4️⃣", "4h"],
  ["5️⃣", "24h"],
  ["6️⃣", "3d"],
  ["7️⃣", "7d"],
]);
const PICKER_BY_EMOJI = new Map(PICKER_EMOJIS);
const INTERACTION_WINDOW_MS = 2 * 60_000;
const UNDO_WINDOW_MS = 10 * 60_000;
const ACTION_RETENTION_MS = 24 * 60 * 60_000;
const MAX_REASON_LENGTH = 300;
const BULK_DELETE_SIZE = 100;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_PENDING_INTERACTIONS = 5_000;

const DEFAULT_STORE = Object.freeze({
  cancelAutomodCasesForMember,
  clearAutomodStrike,
  createModerationAction,
  findModerationActionByMessage,
  getAuditLogChannel,
  pruneModerationActions,
  updateModerationAction,
});

const DEFAULT_ARCHIVE = Object.freeze({
  findArchivedMessages,
  getArchiveCoverage,
  markMessagesDeleted,
});

function actionId() {
  return `MD${randomBytes(6).toString("hex").toUpperCase()}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTarget(value) {
  const token = String(value ?? "").trim();
  const mention = token.match(/^<@!?([A-Za-z0-9]+)>$/);
  const id = mention?.[1] ?? token;
  return isSafeId(id) ? id : null;
}

function parseReason(args) {
  const reasonIndex = args.findIndex((token) =>
    String(token).toLowerCase().startsWith("reason:")
  );
  if (reasonIndex < 0) {
    return { ok: false, error: "A `reason:` is required." };
  }
  const first = String(args[reasonIndex]);
  const reason = [
    first.slice(first.indexOf(":") + 1),
    ...args.slice(reasonIndex + 1),
  ]
    .join(" ")
    .trim();
  if (!reason) return { ok: false, error: "The moderation reason is empty." };
  if (reason.length > MAX_REASON_LENGTH) {
    return {
      ok: false,
      error: `The reason must be ${MAX_REASON_LENGTH} characters or fewer.`,
    };
  }
  return { ok: true, reason, optionTokens: args.slice(1, reasonIndex) };
}

function baseParse(args) {
  const targetId = parseTarget(args[0]);
  if (!targetId) {
    return {
      ok: false,
      error: "Mention one member or provide one valid user ID.",
    };
  }
  const parsed = parseReason(args);
  return parsed.ok ? { ...parsed, targetId } : parsed;
}

export function parseModerationCommand(command, args = []) {
  const cmd = String(command).toLowerCase();
  const parsed = baseParse(args);
  if (!parsed.ok) return parsed;
  const options = parsed.optionTokens.map((value) =>
    String(value).toLowerCase()
  );

  if (cmd === "ban") {
    if (options.length > 1)
      return { ok: false, error: "Too many ban options." };
    const deleteWindow = options[0]?.startsWith("delete:")
      ? options[0].slice("delete:".length)
      : null;
    if (options.length && (!deleteWindow || !PURGE_WINDOWS[deleteWindow])) {
      return {
        ok: false,
        error:
          "Use `delete:1h`, `delete:6h`, `delete:1d`, `delete:3d`, or `delete:7d`.",
      };
    }
    return { ...parsed, command: cmd, deleteWindow };
  }

  if (cmd === "kick" || cmd === "automod-release") {
    if (options.length)
      return { ok: false, error: "This command has no options." };
    return { ...parsed, command: cmd };
  }

  if (cmd === "mute") {
    if (options.length > 1)
      return { ok: false, error: "Choose one mute duration." };
    const duration = options[0] ?? null;
    if (duration && !MUTE_DURATIONS[duration]) {
      return {
        ok: false,
        error: "Use `10m`, `30m`, `1h`, `4h`, `24h`, `3d`, or `7d`.",
      };
    }
    return { ...parsed, command: cmd, duration };
  }

  if (cmd === "purge-user") {
    if (options.length !== 1 || !options[0].startsWith("window:")) {
      return { ok: false, error: "A single `window:` option is required." };
    }
    const window = options[0].slice("window:".length);
    if (!PURGE_WINDOWS[window]) {
      return {
        ok: false,
        error:
          "Use `window:1h`, `window:6h`, `window:1d`, `window:3d`, or `window:7d`.",
      };
    }
    return { ...parsed, command: cmd, window };
  }

  return { ok: false, error: "Unknown moderation command." };
}

function safeReason(value) {
  return String(value)
    .replace(/<@/g, "<@\u200B")
    .replace(/`/g, "ˋ")
    .replace(/\s+/g, " ")
    .trim();
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export function createModeration(
  client,
  {
    send,
    sendProtected,
    request,
    store = DEFAULT_STORE,
    archive = DEFAULT_ARCHIVE,
    logger = console,
    now = Date.now,
    actionIdFactory = actionId,
    attach = true,
  } = {}
) {
  if (typeof send !== "function")
    throw new TypeError("Moderation requires a sender.");
  if (typeof sendProtected !== "function") {
    throw new TypeError("Moderation requires a protected sender.");
  }
  if (typeof request !== "function") {
    throw new TypeError("Moderation requires an HTTP requester.");
  }

  const pending = new Map();
  const actionLocks = new Set();
  const purgeLocks = new Set();

  function prunePending() {
    const current = now();
    for (const [messageId, interaction] of pending) {
      if (interaction.expiresAt <= current) pending.delete(messageId);
    }
    while (pending.size > MAX_PENDING_INTERACTIONS) {
      pending.delete(pending.keys().next().value);
    }
  }

  function logFailure(label, error) {
    logger.warn?.(`moderation: ${label} ${safeErrorSummary(error)}`);
  }

  async function respond(channelId, title, description, colour = "#3498DB") {
    return send(channelId, {
      embeds: [buildStatusEmbed(title, description, colour)],
    });
  }

  async function seedReaction(channelId, messageId, emoji) {
    const result = await request(
      "PUT",
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`
    );
    if (!result.ok) {
      logger.warn?.(
        `moderation: reaction seed failed channel=${auditAlias(channelId)} status=${result.status}`
      );
    }
  }

  async function requireAudit(serverId, channelId) {
    const auditChannelId = store.getAuditLogChannel(serverId);
    if (!isSafeId(auditChannelId)) {
      await respond(
        channelId,
        "📝 Audit Log Required",
        "Configure an audit channel with `/AuditLog here` before using moderation commands.",
        "#E67E22"
      );
      return null;
    }
    return auditChannelId;
  }

  async function freshAccess(
    serverId,
    channelId,
    actorId,
    access,
    allowBot = false
  ) {
    return authorizeServerActor(
      client,
      { serverId, channelId, authorId: actorId },
      access,
      { allowBot, logger }
    );
  }

  async function requireAccess(
    message,
    access,
    channelIds = [message.channelId]
  ) {
    const serverId = message.server?.id ?? message.channel?.serverId;
    const uniqueChannelIds = [...new Set(channelIds)];
    if (
      access === COMMAND_ACCESS.MANAGE_MESSAGES &&
      uniqueChannelIds.length > 0
    ) {
      const actor = await authorizeMessageManagerAcrossChannels(
        client,
        {
          serverId,
          channelIds: uniqueChannelIds,
          authorId: message.authorId,
        },
        { logger }
      );
      const bot = await authorizeMessageManagerAcrossChannels(
        client,
        {
          serverId,
          channelIds: uniqueChannelIds,
          authorId: client.user?.id,
        },
        { allowBot: true, logger }
      );
      if (!actor.allowed || actor.permissionSource !== "refreshed") {
        await respond(
          message.channelId,
          "🔒 Permission Denied",
          "A fresh permission check did not authorize you in every affected channel.",
          "#E74C3C"
        );
        return false;
      }
      if (!bot.allowed || bot.permissionSource !== "refreshed") {
        await respond(
          message.channelId,
          "⚠️ Bot Permission Missing",
          "A fresh permission check did not confirm that I can clean every affected channel.",
          "#E74C3C"
        );
        return false;
      }
      return true;
    }
    for (const channelId of uniqueChannelIds) {
      const actor = await freshAccess(
        serverId,
        channelId,
        message.authorId,
        access
      );
      const bot = await freshAccess(
        serverId,
        channelId,
        client.user?.id,
        access,
        true
      );
      if (!actor.allowed || actor.permissionSource !== "refreshed") {
        await respond(
          message.channelId,
          "🔒 Permission Denied",
          "A fresh permission check did not authorize you for this action.",
          "#E74C3C"
        );
        return false;
      }
      if (!bot.allowed || bot.permissionSource !== "refreshed") {
        await respond(
          message.channelId,
          "⚠️ Bot Permission Missing",
          "A fresh permission check did not confirm that I can complete this action.",
          "#E74C3C"
        );
        return false;
      }
    }
    return true;
  }

  async function validateTarget(
    message,
    targetId,
    { requireMember = true } = {}
  ) {
    const serverId = message.server?.id ?? message.channel?.serverId;
    if (
      targetId === message.authorId ||
      targetId === client.user?.id ||
      targetId === message.server?.ownerId
    ) {
      await respond(
        message.channelId,
        "⚠️ Invalid Moderation Target",
        "You cannot target yourself, the server owner, or this bot.",
        "#E74C3C"
      );
      return false;
    }
    try {
      const server = await client.api.get(`/servers/${serverId}`);
      if (server?._id !== serverId) throw new Error("target server mismatch");
      if (server.owner === targetId) {
        await respond(
          message.channelId,
          "⚠️ Invalid Moderation Target",
          "The server owner cannot be targeted.",
          "#E74C3C"
        );
        return false;
      }
      // Purges may intentionally target someone who already left. A safe ID,
      // same-server archive selection, and owner/self/bot exclusions are the
      // only identity requirements in that case.
      if (!requireMember) return true;
      const user = await client.api.get(`/users/${targetId}`);
      if (user?._id !== targetId) throw new Error("target identity mismatch");
      if (requireMember) {
        const response = await client.api.get(
          `/servers/${serverId}/members/${targetId}`,
          { roles: false }
        );
        const member = response?.member ?? response;
        const memberUserId = member?._id?.user ?? member?.id?.user;
        const memberServerId = member?._id?.server ?? member?.id?.server;
        if (memberUserId !== targetId || memberServerId !== serverId) {
          throw new Error("target member mismatch");
        }
      }
      return true;
    } catch (error) {
      logFailure("target verification failed", error);
      await respond(
        message.channelId,
        "⚠️ Target Verification Failed",
        requireMember
          ? "The target could not be freshly verified as a member of this server."
          : "The target identity could not be freshly verified.",
        "#E74C3C"
      );
      return false;
    }
  }

  function actionEmbed({
    title,
    action,
    actionId: id,
    actorId,
    targetId,
    reason,
    details = [],
    reversible = false,
  }) {
    return {
      title,
      description: [
        `**Action ID:** \`${id}\``,
        `**Action:** ${action}`,
        `**Moderator:** <@${actorId}>`,
        `**Target:** <@${targetId}>`,
        `**Reason:** ${safeReason(reason)}`,
        ...details,
        reversible
          ? "React with ↩️ within 10 minutes to undo. Any freshly authorized moderator may do so."
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
      colour: "#E67E22",
    };
  }

  async function recordAction({
    type,
    serverId,
    auditChannelId,
    actorId,
    targetId,
    reason,
    details,
    reversible,
    metadata = {},
  }) {
    const id = actionIdFactory();
    const createdAt = now();
    let logged;
    try {
      logged = await sendProtected(auditChannelId, {
        embeds: [
          actionEmbed({
            title: `🛡️ Manual ${type[0].toUpperCase()}${type.slice(1)}`,
            action: type,
            actionId: id,
            actorId,
            targetId,
            reason,
            details,
            reversible,
          }),
        ],
      });
    } catch (error) {
      logFailure("protected action log failed", error);
      return null;
    }
    if (!isSafeId(logged?._id)) return null;
    if (reversible) {
      store.createModerationAction({
        actionId: id,
        type,
        serverId,
        targetId,
        actorId,
        reason,
        logChannelId: auditChannelId,
        logMessageId: logged._id,
        createdAt,
        expiresAt: createdAt + UNDO_WINDOW_MS,
        retentionUntil: createdAt + ACTION_RETENTION_MS,
        status: "active",
        ...metadata,
      });
      await seedReaction(auditChannelId, logged._id, MODERATION_UNDO_EMOJI);
    }
    return { actionId: id, message: logged };
  }

  function selectMessages(serverId, targetId, windowMs) {
    const cutoff = now() - windowMs;
    const auditChannelId = store.getAuditLogChannel(serverId);
    return archive
      .findArchivedMessages({
        serverId,
        authorId: targetId,
        since: cutoff,
        until: now(),
      })
      .filter(
        (entry) =>
          entry.channelId !== auditChannelId &&
          isSafeId(entry.channelId) &&
          isSafeId(entry.id)
      );
  }

  async function deleteBatch(channelId, ids) {
    let attempt = 0;
    while (attempt <= MAX_RATE_LIMIT_RETRIES) {
      const response = await request(
        "DELETE",
        `/channels/${channelId}/messages/bulk`,
        { ids }
      );
      if (response.ok) return response;
      if (response.status !== 429 || attempt === MAX_RATE_LIMIT_RETRIES) {
        return response;
      }
      const retryAfter = Math.max(
        250,
        Math.min(10_000, Number(response.data?.retry_after) || 1_000)
      );
      await delay(retryAfter);
      attempt += 1;
    }
    return { ok: false, status: 0 };
  }

  async function purgeSelected(entries) {
    const byChannel = new Map();
    for (const entry of entries) {
      if (!isSafeId(entry.channelId) || !isSafeId(entry.id)) continue;
      const ids = byChannel.get(entry.channelId) ?? [];
      ids.push(entry.id);
      byChannel.set(entry.channelId, ids);
    }
    let deleted = 0;
    let failed = 0;
    for (const [channelId, ids] of byChannel) {
      for (const batch of chunks(ids, BULK_DELETE_SIZE)) {
        const response = await deleteBatch(channelId, batch);
        if (response.ok) {
          deleted += batch.length;
          archive.markMessagesDeleted?.(batch, now());
        } else failed += batch.length;
      }
    }
    return {
      selected: entries.length,
      deleted,
      failed,
      channels: byChannel.size,
    };
  }

  async function applyMute(message, parsed, duration, auditChannelId) {
    const serverId = message.server?.id ?? message.channel?.serverId;
    if (!(await requireAccess(message, COMMAND_ACCESS.TIMEOUT))) return;
    if (!(await validateTarget(message, parsed.targetId))) return;
    const timeoutUntil = now() + MUTE_DURATIONS[duration];
    const response = await request(
      "PATCH",
      `/servers/${serverId}/members/${parsed.targetId}`,
      { timeout: new Date(timeoutUntil).toISOString() }
    );
    if (!response.ok) {
      await respond(
        message.channelId,
        "⚠️ Mute Failed",
        `Stoat rejected the timeout request (HTTP ${response.status || "unknown"}).`,
        "#E74C3C"
      );
      return;
    }
    const recorded = await recordAction({
      type: "mute",
      serverId,
      auditChannelId,
      actorId: message.authorId,
      targetId: parsed.targetId,
      reason: parsed.reason,
      details: [
        `**Duration:** ${duration}`,
        `**Until:** ${new Date(timeoutUntil).toISOString()}`,
      ],
      reversible: true,
      metadata: { timeoutUntil },
    });
    await respond(
      message.channelId,
      "🔇 Member Muted",
      `<@${parsed.targetId}> was timed out for **${duration}**.${recorded ? ` Action \`${recorded.actionId}\` was logged.` : " The action succeeded, but protected logging failed."}`,
      "#2ECC71"
    );
  }

  async function handleMute(message, parsed, auditChannelId) {
    if (parsed.duration) {
      await applyMute(message, parsed, parsed.duration, auditChannelId);
      return;
    }
    const picker = await send(message.channelId, {
      embeds: [
        buildStatusEmbed(
          "⏱️ Choose Mute Duration",
          [
            `**Target:** <@${parsed.targetId}>`,
            "1️⃣ 10m · 2️⃣ 30m · 3️⃣ 1h · 4️⃣ 4h · 5️⃣ 24h · 6️⃣ 3d · 7️⃣ 7d",
            "React within two minutes. Only the invoking moderator can choose.",
          ].join("\n"),
          "#3498DB"
        ),
      ],
    });
    if (!isSafeId(picker?._id)) return;
    pending.set(picker._id, {
      type: "mute-picker",
      message,
      parsed,
      auditChannelId,
      expiresAt: now() + INTERACTION_WINDOW_MS,
    });
    prunePending();
    for (const [emoji] of PICKER_EMOJIS) {
      await seedReaction(message.channelId, picker._id, emoji);
    }
    await seedReaction(message.channelId, picker._id, MODERATION_CANCEL_EMOJI);
  }

  async function handleKick(message, parsed, auditChannelId) {
    const serverId = message.server?.id ?? message.channel?.serverId;
    if (!(await requireAccess(message, COMMAND_ACCESS.KICK))) return;
    if (!(await validateTarget(message, parsed.targetId))) return;
    const response = await request(
      "DELETE",
      `/servers/${serverId}/members/${parsed.targetId}`
    );
    if (!response.ok) {
      await respond(
        message.channelId,
        "⚠️ Kick Failed",
        `Stoat rejected the kick request (HTTP ${response.status || "unknown"}).`,
        "#E74C3C"
      );
      return;
    }
    const recorded = await recordAction({
      type: "kick",
      serverId,
      auditChannelId,
      actorId: message.authorId,
      targetId: parsed.targetId,
      reason: parsed.reason,
      details: [
        "**Undo:** unavailable; the member must rejoin through an invite.",
      ],
      reversible: false,
    });
    await respond(
      message.channelId,
      "👢 Member Kicked",
      `<@${parsed.targetId}> was removed. This cannot be undone; they must rejoin.${recorded ? ` Action \`${recorded.actionId}\` was logged.` : " Protected logging failed after the kick."}`,
      "#2ECC71"
    );
  }

  async function preflightPurge(message, entries) {
    const channelIds = [...new Set(entries.map((entry) => entry.channelId))];
    if (!channelIds.length) return true;
    return requireAccess(message, COMMAND_ACCESS.MANAGE_MESSAGES, channelIds);
  }

  async function handleBan(message, parsed, auditChannelId) {
    const serverId = message.server?.id ?? message.channel?.serverId;
    if (!(await requireAccess(message, COMMAND_ACCESS.BAN))) return;
    if (!(await validateTarget(message, parsed.targetId))) return;
    const entries = parsed.deleteWindow
      ? selectMessages(
          serverId,
          parsed.targetId,
          PURGE_WINDOWS[parsed.deleteWindow]
        )
      : [];
    if (parsed.deleteWindow && !(await preflightPurge(message, entries)))
      return;
    const response = await request(
      "PUT",
      `/servers/${serverId}/bans/${parsed.targetId}`,
      { reason: parsed.reason }
    );
    if (!response.ok) {
      await respond(
        message.channelId,
        "⚠️ Ban Failed",
        `Stoat rejected the ban request (HTTP ${response.status || "unknown"}).`,
        "#E74C3C"
      );
      return;
    }
    let cleanup = null;
    if (parsed.deleteWindow) cleanup = await purgeSelected(entries);
    const cleanupLine = cleanup
      ? `**History cleanup (${parsed.deleteWindow}):** ${cleanup.deleted}/${cleanup.selected} deleted; ${cleanup.failed} failed across ${cleanup.channels} channel(s). Coverage is limited to messages observed by Irminsul.`
      : "**History cleanup:** not requested.";
    const recorded = await recordAction({
      type: "ban",
      serverId,
      auditChannelId,
      actorId: message.authorId,
      targetId: parsed.targetId,
      reason: parsed.reason,
      details: [
        cleanupLine,
        "Undo removes the ban only; it cannot restore membership or deleted messages.",
      ],
      reversible: true,
      metadata: { cleanup },
    });
    await respond(
      message.channelId,
      "🔨 Member Banned",
      `<@${parsed.targetId}> was banned. ${cleanupLine}${recorded ? ` Action \`${recorded.actionId}\` was logged.` : " Protected logging failed after the ban."}`,
      cleanup?.failed ? "#E67E22" : "#2ECC71"
    );
  }

  async function executePurge(message, parsed, auditChannelId) {
    const serverId = message.server?.id ?? message.channel?.serverId;
    if (purgeLocks.has(serverId)) {
      await respond(
        message.channelId,
        "⏳ Purge Already Running",
        "Wait for the current server purge to finish before starting another.",
        "#E67E22"
      );
      return;
    }
    purgeLocks.add(serverId);
    try {
      const entries = selectMessages(
        serverId,
        parsed.targetId,
        PURGE_WINDOWS[parsed.window]
      );
      if (!(await preflightPurge(message, entries))) return;
      const result = await purgeSelected(entries);
      const coverage = archive.getArchiveCoverage(serverId);
      await recordAction({
        type: "purge",
        serverId,
        auditChannelId,
        actorId: message.authorId,
        targetId: parsed.targetId,
        reason: parsed.reason,
        details: [
          `**Window:** ${parsed.window}`,
          `**Result:** ${result.deleted}/${result.selected} deleted; ${result.failed} failed across ${result.channels} channel(s).`,
          `**Archive coverage:** ${coverage.count} current record(s); earliest observed ${coverage.earliestAt ? new Date(coverage.earliestAt).toISOString() : "unavailable"}.`,
          "Protected audit records and evidence were preserved.",
        ],
        reversible: false,
      });
      await respond(
        message.channelId,
        "🧹 User Purge Completed",
        `${result.deleted}/${result.selected} known message(s) were deleted; ${result.failed} failed. Coverage is limited to messages observed while audit logging was active.`,
        result.failed ? "#E67E22" : "#2ECC71"
      );
    } finally {
      purgeLocks.delete(serverId);
    }
  }

  async function handlePurge(message, parsed, auditChannelId) {
    if (
      !(await validateTarget(message, parsed.targetId, {
        requireMember: false,
      }))
    )
      return;
    const serverId = message.server?.id ?? message.channel?.serverId;
    const entries = selectMessages(
      serverId,
      parsed.targetId,
      PURGE_WINDOWS[parsed.window]
    );
    if (!(await preflightPurge(message, entries))) return;
    const confirmation = await send(message.channelId, {
      embeds: [
        buildStatusEmbed(
          "⚠️ Confirm User Purge",
          [
            `Delete **${entries.length} known message(s)** from <@${parsed.targetId}> within **${parsed.window}**?`,
            "This cannot be undone. Protected audit records and evidence are retained.",
            "React ✅ to continue or ❌ to cancel within two minutes.",
          ].join("\n"),
          "#E67E22"
        ),
      ],
    });
    if (!isSafeId(confirmation?._id)) return;
    pending.set(confirmation._id, {
      type: "purge-confirm",
      message,
      parsed,
      auditChannelId,
      expiresAt: now() + INTERACTION_WINDOW_MS,
    });
    prunePending();
    await seedReaction(
      message.channelId,
      confirmation._id,
      MODERATION_CONFIRM_EMOJI
    );
    await seedReaction(
      message.channelId,
      confirmation._id,
      MODERATION_CANCEL_EMOJI
    );
  }

  async function handleRelease(message, parsed, auditChannelId) {
    const serverId = message.server?.id ?? message.channel?.serverId;
    if (!(await requireAccess(message, COMMAND_ACCESS.TIMEOUT))) return;
    if (!(await validateTarget(message, parsed.targetId))) return;
    const response = await request(
      "PATCH",
      `/servers/${serverId}/members/${parsed.targetId}`,
      { remove: ["Timeout"] }
    );
    if (!response.ok) {
      await respond(
        message.channelId,
        "⚠️ Release Failed",
        `Stoat rejected the timeout removal (HTTP ${response.status || "unknown"}).`,
        "#E74C3C"
      );
      return;
    }
    const reset = store.clearAutomodStrike(serverId, parsed.targetId);
    const cancelledCases =
      store.cancelAutomodCasesForMember?.(serverId, parsed.targetId, now()) ??
      0;
    await recordAction({
      type: "release",
      serverId,
      auditChannelId,
      actorId: message.authorId,
      targetId: parsed.targetId,
      reason: parsed.reason,
      details: [
        `**Automod escalation reset:** ${reset ? "yes" : "no strike record existed"}`,
        `**Pending ban reviews closed:** ${cancelledCases}`,
      ],
      reversible: false,
    });
    await respond(
      message.channelId,
      "🔊 Member Released",
      `<@${parsed.targetId}> can message again. ${reset ? "Their automod escalation history was reset." : "No automod strike record existed."} ${cancelledCases} pending ban review(s) were closed.`,
      "#2ECC71"
    );
  }

  async function undoAction(record, voterId) {
    if (record.status !== "active" || record.expiresAt <= now()) return;
    if (actionLocks.has(record.actionId)) return;
    actionLocks.add(record.actionId);
    try {
      const access =
        record.type === "ban" ? COMMAND_ACCESS.BAN : COMMAND_ACCESS.TIMEOUT;
      const actor = await freshAccess(
        record.serverId,
        record.logChannelId,
        voterId,
        access
      );
      const bot = await freshAccess(
        record.serverId,
        record.logChannelId,
        client.user?.id,
        access,
        true
      );
      if (
        !actor.allowed ||
        actor.permissionSource !== "refreshed" ||
        !bot.allowed ||
        bot.permissionSource !== "refreshed"
      ) {
        return;
      }
      const response =
        record.type === "ban"
          ? await request(
              "DELETE",
              `/servers/${record.serverId}/bans/${record.targetId}`
            )
          : await request(
              "PATCH",
              `/servers/${record.serverId}/members/${record.targetId}`,
              { remove: ["Timeout"] }
            );
      if (!response.ok) {
        await sendProtected(record.logChannelId, {
          embeds: [
            buildStatusEmbed(
              "⚠️ Moderation Undo Failed",
              `Action \`${record.actionId}\` could not be undone (HTTP ${response.status || "unknown"}).`,
              "#E74C3C"
            ),
          ],
        });
        return;
      }
      store.updateModerationAction(record.actionId, {
        status: "undone",
        undoneAt: now(),
        undoneBy: voterId,
      });
      await sendProtected(record.logChannelId, {
        embeds: [
          buildStatusEmbed(
            "↩️ Moderation Action Undone",
            [
              `**Action ID:** \`${record.actionId}\``,
              `**Original action:** ${record.type}`,
              `**Target:** <@${record.targetId}>`,
              `**Undone by:** <@${voterId}>`,
              record.type === "ban"
                ? "The member was unbanned, but membership and deleted messages were not restored."
                : "The member timeout was removed.",
            ].join("\n"),
            "#2ECC71"
          ),
        ],
      });
    } finally {
      actionLocks.delete(record.actionId);
    }
  }

  async function handleRawEvent(event) {
    if (
      event?.type !== "MessageReact" ||
      !isSafeId(event.id) ||
      !isSafeId(event.user_id) ||
      event.user_id === client.user?.id
    ) {
      return;
    }
    prunePending();
    const interaction = pending.get(event.id);
    if (interaction) {
      if (interaction.expiresAt <= now()) {
        pending.delete(event.id);
        return;
      }
      if (event.user_id !== interaction.message.authorId) return;
      if (event.emoji_id === MODERATION_CANCEL_EMOJI) {
        pending.delete(event.id);
        await respond(
          interaction.message.channelId,
          "❌ Moderation Action Cancelled",
          "No member or message state was changed.",
          "#808080"
        );
        return;
      }
      if (interaction.type === "mute-picker") {
        const duration = PICKER_BY_EMOJI.get(event.emoji_id);
        if (!duration) return;
        pending.delete(event.id);
        await applyMute(
          interaction.message,
          interaction.parsed,
          duration,
          interaction.auditChannelId
        );
        return;
      }
      if (
        interaction.type === "purge-confirm" &&
        event.emoji_id === MODERATION_CONFIRM_EMOJI
      ) {
        pending.delete(event.id);
        await executePurge(
          interaction.message,
          interaction.parsed,
          interaction.auditChannelId
        );
        return;
      }
    }

    if (event.emoji_id !== MODERATION_UNDO_EMOJI) return;
    store.pruneModerationActions(now());
    const record = store.findModerationActionByMessage(event.id);
    if (record) await undoAction(record, event.user_id);
  }

  async function handleCommand(message, command, args = []) {
    prunePending();
    const serverId = message.server?.id ?? message.channel?.serverId;
    if (!isSafeId(serverId)) return;
    const parsed = parseModerationCommand(command, args);
    if (!parsed.ok) {
      await respond(
        message.channelId,
        "⚠️ Invalid Moderation Command",
        parsed.error,
        "#E74C3C"
      );
      return;
    }
    const auditChannelId = await requireAudit(serverId, message.channelId);
    if (!auditChannelId) return;
    if (command === "ban") await handleBan(message, parsed, auditChannelId);
    else if (command === "kick")
      await handleKick(message, parsed, auditChannelId);
    else if (command === "mute")
      await handleMute(message, parsed, auditChannelId);
    else if (command === "purge-user")
      await handlePurge(message, parsed, auditChannelId);
    else if (command === "automod-release") {
      await handleRelease(message, parsed, auditChannelId);
    }
  }

  store.pruneModerationActions(now());
  if (attach) {
    client.events.on("event", (event) => {
      handleRawEvent(event).catch((error) =>
        logFailure("reaction handler failed", error)
      );
    });
  }

  return { handleCommand, handleRawEvent };
}
