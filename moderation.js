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

// Cleanup windows. The longest window stays below message-archive's 30-day
// retention (RETENTION_MS) so a selection can never outrun the archive that
// feeds it.
export const PURGE_WINDOWS = Object.freeze({
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "3d": 3 * 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "14d": 14 * 24 * 60 * 60_000,
  "29d": 29 * 24 * 60 * 60_000,
});

// 1️⃣–7️⃣ mean different things on different picker messages, so each pending
// interaction carries its own emoji → value map instead of a shared global.
const DIGIT_EMOJIS = Object.freeze(["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣"]);

function buildPicker(values) {
  return Object.freeze(
    values.slice(0, DIGIT_EMOJIS.length).map((value, index) => ({
      emoji: DIGIT_EMOJIS[index],
      value,
    }))
  );
}

const MUTE_PICKER = buildPicker(Object.keys(MUTE_DURATIONS));
const CLEANUP_PICKER = buildPicker(Object.keys(PURGE_WINDOWS));

function pickerLegend(picker) {
  return picker.map(({ emoji, value }) => `${emoji} ${value}`).join(" · ");
}

function pickerChoice(picker, emoji) {
  return picker.find((entry) => entry.emoji === emoji)?.value ?? null;
}

const INTERACTION_WINDOW_MS = 2 * 60_000;
const UNDO_WINDOW_MS = 10 * 60_000;
const ACTION_RETENTION_MS = 24 * 60 * 60_000;
const MAX_REASON_LENGTH = 300;
const BULK_DELETE_SIZE = 100;
// Stoat's bulk-delete route only accepts recent messages; anything older is
// removed one message at a time.
const BULK_DELETE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_CLEANUP_MESSAGES = 2_000;
const SLOW_CLEANUP_THRESHOLD = 100;
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

const MENTION_PATTERN = /^<@!?([A-Za-z0-9]+)>$/;
// Stoat IDs are ULIDs. isSafeId() alone accepts any alphanumeric word, so a
// bare ID is only recognized mid-sentence when it has the full ULID shape.
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// A bare leading token is only read as a user ID when it is long and carries a
// digit or capital, so `/Kick for raiding` asks for a member instead of trying
// to moderate someone called "for".
const BARE_ID_PATTERN = /^(?=.{8,})(?=.*[0-9A-Z])[A-Za-z0-9]+$/;
const WINDOW_PREFIXES = Object.freeze(["delete:", "window:", "purge:"]);
const DURATION_PREFIXES = Object.freeze(["duration:", "mute:", "timeout:"]);
// Leading filler between the member and the reason, so `/Ban @member for
// spamming` records "spamming" rather than "for spamming".
const REASON_PREFIX_PATTERN =
  /^(?:reason\s*:\s*|(?:because of|because|due to|for|about|over|-|–|—|:)(?:\s+|$))/i;

const OPTION_SPECS = Object.freeze({
  ban: { window: "deleteWindow", duration: false },
  kick: { window: "deleteWindow", duration: false },
  mute: { window: "deleteWindow", duration: true },
  "purge-user": { window: "window", duration: false },
  "automod-release": { window: null, duration: false },
});

const WINDOW_HELP = `Use ${Object.keys(PURGE_WINDOWS)
  .map((key) => `\`${key}\``)
  .join(", ")}.`;
const DURATION_HELP = `Use ${Object.keys(MUTE_DURATIONS)
  .map((key) => `\`${key}\``)
  .join(", ")}.`;

function prefixedOption(token, spec) {
  const lower = token.toLowerCase();
  if (spec.window) {
    const prefix = WINDOW_PREFIXES.find((entry) => lower.startsWith(entry));
    if (prefix) return { kind: "window", value: lower.slice(prefix.length) };
  }
  if (spec.duration) {
    const prefix = DURATION_PREFIXES.find((entry) => lower.startsWith(entry));
    if (prefix) return { kind: "duration", value: lower.slice(prefix.length) };
  }
  return null;
}

function bareOption(token, spec) {
  const lower = token.toLowerCase();
  if (spec.duration && Object.hasOwn(MUTE_DURATIONS, lower)) {
    return { kind: "duration", value: lower };
  }
  if (spec.window && Object.hasOwn(PURGE_WINDOWS, lower)) {
    return { kind: "window", value: lower };
  }
  return null;
}

/**
 * Parse a manual moderation command written in any order.
 *
 * The member, the options, and the reason may appear in any arrangement:
 * `/Ban @member for spamming`, `/Mute 1h @member being rude`, and the legacy
 * `/Ban @member delete:1d reason: spam` all parse. Bare option words such as
 * `1h` are only read as options while they precede the reason; once free text
 * starts, everything that follows belongs to the reason.
 */
export function parseModerationCommand(command, args = []) {
  const cmd = String(command).toLowerCase();
  const spec = OPTION_SPECS[cmd];
  if (!spec) return { ok: false, error: "Unknown moderation command." };

  const tokens = args
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length > 0);
  const consumed = new Set();
  let targetId = null;

  for (const [index, token] of tokens.entries()) {
    const mention = token.match(MENTION_PATTERN);
    if (mention && isSafeId(mention[1])) {
      targetId = mention[1];
      consumed.add(index);
      break;
    }
  }
  if (!targetId) {
    for (const [index, token] of tokens.entries()) {
      if (!ULID_PATTERN.test(token)) continue;
      targetId = token;
      consumed.add(index);
      break;
    }
  }

  const selected = { window: null, duration: null };
  let leading = true;
  for (const [index, token] of tokens.entries()) {
    if (consumed.has(index)) continue;
    const option =
      prefixedOption(token, spec) ?? (leading ? bareOption(token, spec) : null);
    if (option) {
      const table = option.kind === "window" ? PURGE_WINDOWS : MUTE_DURATIONS;
      if (!Object.hasOwn(table, option.value)) {
        return {
          ok: false,
          error:
            option.kind === "window"
              ? `\`${token}\` is not a cleanup window. ${WINDOW_HELP}`
              : `\`${token}\` is not a mute duration. ${DURATION_HELP}`,
        };
      }
      if (selected[option.kind] && selected[option.kind] !== option.value) {
        return {
          ok: false,
          error:
            option.kind === "window"
              ? "Choose one cleanup window."
              : "Choose one mute duration.",
        };
      }
      selected[option.kind] = option.value;
      consumed.add(index);
      continue;
    }
    if (!leading) continue;
    if (!targetId && BARE_ID_PATTERN.test(token) && isSafeId(token)) {
      targetId = token;
      consumed.add(index);
      continue;
    }
    leading = false;
  }

  if (!targetId) {
    return {
      ok: false,
      error: "Mention one member or provide one valid user ID.",
    };
  }

  const reason = tokens
    .filter((_, index) => !consumed.has(index))
    .join(" ")
    .replace(REASON_PREFIX_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!reason) {
    return {
      ok: false,
      error:
        "Add a short reason in your own words, for example `@member for repeated spam`.",
    };
  }
  if (reason.length > MAX_REASON_LENGTH) {
    return {
      ok: false,
      error: `The reason must be ${MAX_REASON_LENGTH} characters or fewer.`,
    };
  }

  const parsed = { ok: true, command: cmd, targetId, reason };
  if (spec.window) parsed[spec.window] = selected.window;
  if (spec.duration) parsed.duration = selected.duration;
  return parsed;
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

  async function requestWithRetry(method, path, body) {
    let attempt = 0;
    while (attempt <= MAX_RATE_LIMIT_RETRIES) {
      const response = await request(method, path, body);
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

  async function deleteBatch(channelId, ids) {
    return requestWithRetry("DELETE", `/channels/${channelId}/messages/bulk`, {
      ids,
    });
  }

  async function deleteSingle(channelId, id) {
    return requestWithRetry("DELETE", `/channels/${channelId}/messages/${id}`);
  }

  // Delete one message at a time. Used for anything Stoat's bulk route will
  // not take (older than BULK_DELETE_MAX_AGE_MS) and as the fallback when a
  // bulk batch is rejected for a reason other than rate limiting.
  async function deleteIndividually(channelId, ids) {
    const removed = [];
    let failed = 0;
    for (const id of ids) {
      const response = await deleteSingle(channelId, id);
      if (response.ok) removed.push(id);
      else failed += 1;
    }
    return { removed, failed };
  }

  async function purgeSelected(entries) {
    const cutoff = now() - BULK_DELETE_MAX_AGE_MS;
    const usable = entries.filter(
      (entry) => isSafeId(entry.channelId) && isSafeId(entry.id)
    );
    // Oldest first, so a capped run clears the earliest history and the
    // remainder stays reachable through a second, narrower cleanup.
    const ordered = [...usable].sort(
      (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)
    );
    const targeted = ordered.slice(0, MAX_CLEANUP_MESSAGES);
    const skipped = ordered.length - targeted.length;

    const byChannel = new Map();
    for (const entry of targeted) {
      const buckets = byChannel.get(entry.channelId) ?? {
        bulk: [],
        single: [],
      };
      if ((entry.createdAt ?? 0) >= cutoff) buckets.bulk.push(entry.id);
      else buckets.single.push(entry.id);
      byChannel.set(entry.channelId, buckets);
    }

    let deleted = 0;
    let failed = 0;
    for (const [channelId, buckets] of byChannel) {
      const removed = [];
      for (const batch of chunks(buckets.bulk, BULK_DELETE_SIZE)) {
        const response = await deleteBatch(channelId, batch);
        if (response.ok) {
          removed.push(...batch);
          continue;
        }
        // The bulk route may refuse a batch for reasons the age split cannot
        // predict; retry those IDs individually before calling them failures.
        const retried = await deleteIndividually(channelId, batch);
        removed.push(...retried.removed);
        failed += retried.failed;
      }
      const singles = await deleteIndividually(channelId, buckets.single);
      removed.push(...singles.removed);
      failed += singles.failed;
      deleted += removed.length;
      if (removed.length) archive.markMessagesDeleted?.(removed, now());
    }
    return {
      selected: targeted.length,
      deleted,
      failed,
      skipped,
      channels: byChannel.size,
    };
  }

  function cleanupSummary(result) {
    const capped = result.skipped
      ? ` ${result.skipped} more were left untouched by the ${MAX_CLEANUP_MESSAGES}-message safety cap; run the cleanup again to continue.`
      : "";
    return (
      `${result.deleted}/${result.selected} known message(s) deleted across ` +
      `${result.channels} channel(s); ${result.failed} failed.${capped}`
    );
  }

  async function openPicker(message, { title, description, colour, entry }) {
    const picker = await send(message.channelId, {
      embeds: [buildStatusEmbed(title, description, colour)],
    });
    if (!isSafeId(picker?._id)) return null;
    pending.set(picker._id, {
      ...entry,
      message,
      expiresAt: now() + INTERACTION_WINDOW_MS,
    });
    prunePending();
    for (const { emoji } of entry.choices) {
      await seedReaction(message.channelId, picker._id, emoji);
    }
    await seedReaction(message.channelId, picker._id, MODERATION_CANCEL_EMOJI);
    return picker._id;
  }

  // Offered after a ban, kick, or mute so moderators pick a cleanup window by
  // reaction instead of remembering `delete:` syntax.
  async function offerCleanup(
    message,
    { targetId, actionId, actionLabel, auditChannelId }
  ) {
    await openPicker(message, {
      title: "🧹 Delete Recent Messages?",
      description: [
        `**Target:** <@${targetId}>`,
        `The ${actionLabel} has already been applied. Choose how much of their observed history to delete:`,
        pickerLegend(CLEANUP_PICKER),
        "React within two minutes, or ❌ to keep their messages. Only the invoking moderator can choose.",
      ].join("\n"),
      colour: "#E67E22",
      entry: {
        type: "cleanup-picker",
        choices: CLEANUP_PICKER,
        targetId,
        actionId,
        actionLabel,
        auditChannelId,
      },
    });
  }

  // Fresh Manage Messages checks happen here, so a cleanup requested by
  // reaction is authorized exactly like a typed one.
  async function runCleanup(
    message,
    { targetId, window, actionId, actionLabel, auditChannelId }
  ) {
    const serverId = message.server?.id ?? message.channel?.serverId;
    if (purgeLocks.has(serverId)) {
      await respond(
        message.channelId,
        "⏳ Cleanup Already Running",
        "Wait for the current server cleanup to finish before starting another.",
        "#E67E22"
      );
      return;
    }
    purgeLocks.add(serverId);
    try {
      const entries = selectMessages(serverId, targetId, PURGE_WINDOWS[window]);
      if (!(await preflightPurge(message, entries))) return;
      if (entries.length >= SLOW_CLEANUP_THRESHOLD) {
        await respond(
          message.channelId,
          "🧹 Cleaning Up",
          `Deleting up to ${Math.min(entries.length, MAX_CLEANUP_MESSAGES)} observed message(s) from <@${targetId}> within **${window}**. Messages older than a week are removed one at a time, so this can take a while.`,
          "#3498DB"
        );
      }
      const result = await purgeSelected(entries);
      const coverage = archive.getArchiveCoverage(serverId);
      try {
        await sendProtected(auditChannelId, {
          embeds: [
            buildStatusEmbed(
              "🧹 History Cleanup",
              [
                actionId ? `**Action ID:** \`${actionId}\`` : null,
                `**Follows:** ${actionLabel}`,
                `**Moderator:** <@${message.authorId}>`,
                `**Target:** <@${targetId}>`,
                `**Window:** ${window}`,
                `**Result:** ${cleanupSummary(result)}`,
                `**Archive coverage:** ${coverage.count} current record(s); earliest observed ${coverage.earliestAt ? new Date(coverage.earliestAt).toISOString() : "unavailable"}.`,
                "Protected audit records and evidence were preserved.",
              ]
                .filter(Boolean)
                .join("\n"),
              result.failed ? "#E67E22" : "#2ECC71"
            ),
          ],
        });
      } catch (error) {
        logFailure("protected cleanup log failed", error);
      }
      if (actionId) {
        store.updateModerationAction?.(actionId, {
          cleanup: { window, ...result },
        });
      }
      await respond(
        message.channelId,
        "🧹 History Cleanup Completed",
        `${cleanupSummary(result)} Coverage is limited to messages observed by Irminsul.`,
        result.failed ? "#E67E22" : "#2ECC71"
      );
    } finally {
      purgeLocks.delete(serverId);
    }
  }

  // A typed window is authorized before the action so a moderator without
  // Manage Messages is told up front instead of after the member is gone.
  async function prepareTypedCleanup(message, targetId, window) {
    if (!window) return { ok: true, entries: null };
    const serverId = message.server?.id ?? message.channel?.serverId;
    const entries = selectMessages(serverId, targetId, PURGE_WINDOWS[window]);
    if (!(await preflightPurge(message, entries))) return { ok: false };
    return { ok: true, entries };
  }

  function cleanupDetail(window, cleanup) {
    if (!cleanup) {
      return "**History cleanup:** offered as a reaction picker; any result is logged separately.";
    }
    return `**History cleanup (${window}):** ${cleanupSummary(cleanup)} Coverage is limited to messages observed by Irminsul.`;
  }

  async function applyMute(message, parsed, duration, auditChannelId) {
    const serverId = message.server?.id ?? message.channel?.serverId;
    if (!(await requireAccess(message, COMMAND_ACCESS.TIMEOUT))) return;
    if (!(await validateTarget(message, parsed.targetId))) return;
    const prepared = await prepareTypedCleanup(
      message,
      parsed.targetId,
      parsed.deleteWindow
    );
    if (!prepared.ok) return;
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
    const cleanup = prepared.entries
      ? await purgeSelected(prepared.entries)
      : null;
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
        cleanupDetail(parsed.deleteWindow, cleanup),
      ],
      reversible: true,
      metadata: { timeoutUntil, cleanup },
    });
    await respond(
      message.channelId,
      "🔇 Member Muted",
      `<@${parsed.targetId}> was timed out for **${duration}**.${cleanup ? ` ${cleanupSummary(cleanup)}` : ""}${recorded ? ` Action \`${recorded.actionId}\` was logged.` : " The action succeeded, but protected logging failed."}`,
      cleanup?.failed ? "#E67E22" : "#2ECC71"
    );
    if (!cleanup) {
      await offerCleanup(message, {
        targetId: parsed.targetId,
        actionId: recorded?.actionId ?? null,
        actionLabel: `mute (${duration})`,
        auditChannelId,
      });
    }
  }

  async function handleMute(message, parsed, auditChannelId) {
    if (parsed.duration) {
      await applyMute(message, parsed, parsed.duration, auditChannelId);
      return;
    }
    await openPicker(message, {
      title: "⏱️ Choose Mute Duration",
      description: [
        `**Target:** <@${parsed.targetId}>`,
        pickerLegend(MUTE_PICKER),
        "React within two minutes. Only the invoking moderator can choose.",
      ].join("\n"),
      colour: "#3498DB",
      entry: {
        type: "mute-picker",
        choices: MUTE_PICKER,
        parsed,
        auditChannelId,
      },
    });
  }

  async function handleKick(message, parsed, auditChannelId) {
    const serverId = message.server?.id ?? message.channel?.serverId;
    if (!(await requireAccess(message, COMMAND_ACCESS.KICK))) return;
    if (!(await validateTarget(message, parsed.targetId))) return;
    const prepared = await prepareTypedCleanup(
      message,
      parsed.targetId,
      parsed.deleteWindow
    );
    if (!prepared.ok) return;
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
    const cleanup = prepared.entries
      ? await purgeSelected(prepared.entries)
      : null;
    const recorded = await recordAction({
      type: "kick",
      serverId,
      auditChannelId,
      actorId: message.authorId,
      targetId: parsed.targetId,
      reason: parsed.reason,
      details: [
        "**Undo:** unavailable; the member must rejoin through an invite.",
        cleanupDetail(parsed.deleteWindow, cleanup),
      ],
      reversible: false,
    });
    await respond(
      message.channelId,
      "👢 Member Kicked",
      `<@${parsed.targetId}> was removed. This cannot be undone; they must rejoin.${cleanup ? ` ${cleanupSummary(cleanup)}` : ""}${recorded ? ` Action \`${recorded.actionId}\` was logged.` : " Protected logging failed after the kick."}`,
      cleanup?.failed ? "#E67E22" : "#2ECC71"
    );
    if (!cleanup) {
      await offerCleanup(message, {
        targetId: parsed.targetId,
        actionId: recorded?.actionId ?? null,
        actionLabel: "kick",
        auditChannelId,
      });
    }
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
    const prepared = await prepareTypedCleanup(
      message,
      parsed.targetId,
      parsed.deleteWindow
    );
    if (!prepared.ok) return;
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
    const cleanup = prepared.entries
      ? await purgeSelected(prepared.entries)
      : null;
    const recorded = await recordAction({
      type: "ban",
      serverId,
      auditChannelId,
      actorId: message.authorId,
      targetId: parsed.targetId,
      reason: parsed.reason,
      details: [
        cleanupDetail(parsed.deleteWindow, cleanup),
        "Undo removes the ban only; it cannot restore membership or deleted messages.",
      ],
      reversible: true,
      metadata: { cleanup },
    });
    await respond(
      message.channelId,
      "🔨 Member Banned",
      `<@${parsed.targetId}> was banned.${cleanup ? ` ${cleanupSummary(cleanup)}` : ""}${recorded ? ` Action \`${recorded.actionId}\` was logged.` : " Protected logging failed after the ban."}`,
      cleanup?.failed ? "#E67E22" : "#2ECC71"
    );
    if (!cleanup) {
      await offerCleanup(message, {
        targetId: parsed.targetId,
        actionId: recorded?.actionId ?? null,
        actionLabel: "ban",
        auditChannelId,
      });
    }
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
      if (entries.length >= SLOW_CLEANUP_THRESHOLD) {
        await respond(
          message.channelId,
          "🧹 Purge Running",
          `Deleting up to ${Math.min(entries.length, MAX_CLEANUP_MESSAGES)} observed message(s) from <@${parsed.targetId}> within **${parsed.window}**. Messages older than a week are removed one at a time, so this can take a while.`,
          "#3498DB"
        );
      }
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
          `**Result:** ${cleanupSummary(result)}`,
          `**Archive coverage:** ${coverage.count} current record(s); earliest observed ${coverage.earliestAt ? new Date(coverage.earliestAt).toISOString() : "unavailable"}.`,
          "Protected audit records and evidence were preserved.",
        ],
        reversible: false,
      });
      await respond(
        message.channelId,
        "🧹 User Purge Completed",
        `${cleanupSummary(result)} Coverage is limited to messages observed while audit logging was active.`,
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
    if (!parsed.window) {
      await openPicker(message, {
        title: "🧹 Choose Purge Window",
        description: [
          `**Target:** <@${parsed.targetId}>`,
          "How far back should Irminsul delete this member's observed messages?",
          pickerLegend(CLEANUP_PICKER),
          "React within two minutes and then confirm. Only the invoking moderator can choose.",
        ].join("\n"),
        colour: "#E67E22",
        entry: {
          type: "purge-window-picker",
          choices: CLEANUP_PICKER,
          parsed,
          auditChannelId,
        },
      });
      return;
    }
    await confirmPurge(message, parsed, auditChannelId);
  }

  async function confirmPurge(message, parsed, auditChannelId) {
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
          interaction.type === "cleanup-picker"
            ? `No messages were deleted. The ${interaction.actionLabel} still stands.`
            : "No member or message state was changed.",
          "#808080"
        );
        return;
      }
      const choice = interaction.choices
        ? pickerChoice(interaction.choices, event.emoji_id)
        : null;
      if (interaction.type === "mute-picker") {
        if (!choice) return;
        pending.delete(event.id);
        await applyMute(
          interaction.message,
          interaction.parsed,
          choice,
          interaction.auditChannelId
        );
        return;
      }
      if (interaction.type === "cleanup-picker") {
        if (!choice) return;
        pending.delete(event.id);
        await runCleanup(interaction.message, {
          targetId: interaction.targetId,
          window: choice,
          actionId: interaction.actionId,
          actionLabel: interaction.actionLabel,
          auditChannelId: interaction.auditChannelId,
        });
        return;
      }
      if (interaction.type === "purge-window-picker") {
        if (!choice) return;
        pending.delete(event.id);
        await confirmPurge(
          interaction.message,
          { ...interaction.parsed, window: choice },
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
