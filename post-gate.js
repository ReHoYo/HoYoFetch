// post-gate.js — First-post review and server lockdown policy
// ────────────────────────────────────────────────────────────────────
// A raid account that joins and immediately posts a link or attachment
// passes straight through automod.js's behavioural detection, which needs
// several messages (rapid burst, duplicate flood, mention flood) to
// accumulate before it triggers. Levels 1–2 close that gap by holding a new
// member's link or attachment for one moderator's ✅/❌ review. Levels 3–4
// lock Send Messages on the server default role and reactively remove any
// regular-member messages that still slip through explicit overrides.
//
// Turning the gate on, moving its review channel, or turning it off all
// require a ten-minute one-time code sent exclusively to Enka#4961 — the
// same approval gate used by /AuditLog and /Exclude-Channel — since a
// misconfigured review channel would either hide every new member's first
// post or silently stop holding anything. Day-to-day review (approve/
// reject) does not require Enka: a held post is reversible and needs a
// fast single-moderator response, matching how automod's own containment
// (as opposed to its permanent-ban approval) works.
import { randomBytes } from "crypto";
import {
  APPROVAL_CHALLENGE_TTL_MS,
  APPROVAL_MAX_ATTEMPTS,
  createEnkaApprovalGate,
  ENKA_APPROVER_TAG,
  ENKA_APPROVER_USER_ID,
} from "./approval-gate.js";
import {
  finaliseArchiveDescriptors,
  humanReadableSize,
  prepareAttachmentCopies,
} from "./attachment-evidence.js";
import { AUTOMOD_LIMITS, nextStrikeLevel } from "./automod.js";
import { parseChannelArg } from "./auditlog.js";
import { buildAuditEmbed, buildStatusEmbed } from "./embeds.js";
import { countArchivedMessages } from "./message-archive.js";
import { deriveAccountCreatedAt } from "./user-info.js";
import {
  clearAutomodStrike,
  createHeldPost,
  findHeldPostByReviewMessage,
  getAutomodStrike,
  getExpiredPendingPosts,
  getHeldPost,
  getAllPostGateConfigs,
  getPendingHeldPosts,
  getPostGateConfig,
  isChannelExcluded,
  prunePostGateQueue,
  setAutomodStrike,
  setPostGateConfig,
  updateHeldPost,
} from "./store.js";
import {
  auditAlias,
  authorizeServerActor,
  COMMAND_ACCESS,
  evaluatePermissionSnapshot,
  isSafeId,
  safeErrorSummary,
} from "./security.js";

export { ENKA_APPROVER_TAG, ENKA_APPROVER_USER_ID };
export const POST_GATE_CHALLENGE_TTL_MS = APPROVAL_CHALLENGE_TTL_MS;
export const POST_GATE_MAX_ATTEMPTS = APPROVAL_MAX_ATTEMPTS;

const CHALLENGE_KIND = "post_gate";
export const REVIEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
export const LEVEL_CONFIRM_WINDOW_MS = 2 * 60 * 1_000;
export const DEGRADED_NOTICE_WINDOW_MS = 10 * 60 * 1_000;
export const PERMISSION_RECONCILE_INTERVAL_MS = 5 * 60 * 1_000;
const QUEUE_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const MAX_LOCKDOWN_ACTORS = 5_000;
const APPROVE_EMOJI = "✅";
const REJECT_EMOJI = "❌";
const LOCKDOWN_BAN_REASON =
  "Irminsul Level 4 lockdown: posted through the server permission lock while automatic bans were enabled";
const PERMISSION_BITS = Object.freeze({
  ManagePermissions: 1n << 2n,
  ViewChannel: 1n << 20n,
  SendMessage: 1n << 22n,
  ManageMessages: 1n << 23n,
});

// Stoat messages are much shorter than this, but keep normalization bounded
// so an unexpected payload cannot turn link protection into expensive work.
const LINK_SCAN_LIMIT = 8_192;
const INVISIBLE_LINK_CHARACTERS =
  /(?:\u00AD|\u034F|\u061C|\u180E|[\u200B-\u200F]|[\u202A-\u202E]|[\u2060-\u206F]|\uFEFF)/gu;
const DOT_LIKE_CHARACTERS =
  /[\u2024\u2027\u2219\u22C5\u3002\uFE52\uFF0E\uFF61]/gu;
const COLON_LIKE_CHARACTERS = /[\u02D0\u0589\u2236\uFE13\uFE55\uFF1A]/gu;
const SLASH_LIKE_CHARACTERS = /[\u2044\u2215\u29F8\uFF0F]/gu;
const DOMAIN_PATTERN =
  /(?<![\p{L}\p{N}_-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:[\p{L}]{2,63}|xn--[a-z0-9-]{2,59})(?![\p{L}\p{N}_-])/iu;
const IPV4_PATTERN =
  /(?<!\d)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\d)/u;
const URL_SCHEME_PATTERN = /\bhttps?:\/\/[^\s<>{}]+/iu;
const COMMON_OBFUSCATED_DOMAIN_PATTERN =
  /(?<![a-z0-9_-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|gg|co|dev|xyz|app|me|link|gift|shop|info|biz|ai|tv|us|uk|ca|de|fr|jp|ru|cn|in|ly|to|cc|pw|pro|site|online|store|tech|cloud|live|news|world|club|space|website|top|vip|win|work|digital|one|today)(?![a-z0-9_-])/iu;

function normaliseLinkCandidate(value) {
  return String(value ?? "")
    .slice(0, LINK_SCAN_LIMIT)
    .normalize("NFKC")
    .toLowerCase()
    .replace(INVISIBLE_LINK_CHARACTERS, "")
    .replace(DOT_LIKE_CHARACTERS, ".")
    .replace(COLON_LIKE_CHARACTERS, ":")
    .replace(SLASH_LIKE_CHARACTERS, "/")
    .replace(
      /(?:\[\s*(?:\.|dot)\s*\]|\(\s*(?:\.|dot)\s*\)|\{\s*(?:\.|dot)\s*\})/giu,
      "."
    )
    .replace(/\bh\s*t\s*t\s*p\s*s\s*:\s*\/\s*\/\s*/gu, "https://")
    .replace(/\bh\s*t\s*t\s*p\s*:\s*\/\s*\/\s*/gu, "http://")
    .replace(/\bh\s*x\s*x\s*p\s*s\s*:\s*\/\s*\/\s*/gu, "https://")
    .replace(/\bh\s*x\s*x\s*p\s*:\s*\/\s*\/\s*/gu, "http://")
    .replace(/\bw\s*w\s*w\s*\.\s*/gu, "www.")
    .replace(/\s*([:/@?#=&%])\s*/gu, "$1");
}

function hasProtectedLink(value) {
  const candidate = normaliseLinkCandidate(value);
  const whitespaceCompacted = candidate.replace(/\s+/gu, "");
  return (
    URL_SCHEME_PATTERN.test(candidate) ||
    DOMAIN_PATTERN.test(candidate) ||
    IPV4_PATTERN.test(candidate) ||
    IPV4_PATTERN.test(whitespaceCompacted) ||
    COMMON_OBFUSCATED_DOMAIN_PATTERN.test(whitespaceCompacted)
  );
}

function hasLinkOrAttachment(message) {
  return Boolean(
    (message?.attachments && message.attachments.length > 0) ||
    hasProtectedLink(message?.content)
  );
}

const DEFAULT_STORE = Object.freeze({
  clearAutomodStrike,
  createHeldPost,
  findHeldPostByReviewMessage,
  getAutomodStrike,
  getExpiredPendingPosts,
  getHeldPost,
  getAllPostGateConfigs,
  getPendingHeldPosts,
  getPostGateConfig,
  isChannelExcluded,
  prunePostGateQueue,
  setAutomodStrike,
  setPostGateConfig,
  updateHeldPost,
});

function defaultQueueIdFactory() {
  return `PG${randomBytes(8).toString("hex").toUpperCase()}`;
}

function serverIdFrom(message) {
  return message?.server?.id ?? message?.channel?.serverId;
}

function channelIdFrom(message) {
  return message?.channelId ?? message?.channel?.id;
}

function terminalTitle(action) {
  return action === "off" ? "🔕 Post Gate Disabled" : "🛑 Post Gate Enabled";
}

export function createPostGate(
  client,
  {
    send,
    sendProtected,
    request,
    prefix = "/",
    store = DEFAULT_STORE,
    logger = console,
    now = Date.now,
    fetchImpl = fetch,
    queueIdFactory = defaultQueueIdFactory,
    requestIdFactory = defaultQueueIdFactory,
    codeFactory,
    approverUserId,
    approvalGate,
    runIntentionalDelete,
    scheduleTimeout = setTimeout,
    scheduleInterval = setInterval,
  } = {}
) {
  if (typeof send !== "function") {
    throw new TypeError("The post gate requires a sender.");
  }
  if (typeof sendProtected !== "function") {
    throw new TypeError("The post gate requires a protected sender.");
  }
  if (typeof request !== "function" && !approvalGate) {
    throw new TypeError("The post gate requires an HTTP requester.");
  }

  const gate =
    approvalGate ??
    createEnkaApprovalGate(client, {
      request,
      logger,
      now,
      ...(codeFactory ? { codeFactory } : {}),
      ...(approverUserId ? { approverUserId } : {}),
      scheduleTimeout,
    });

  let pruneStarted = false;
  const pendingDecisions = new Map();
  const pendingLevelPrompts = new Map();
  const lockdownActorState = new Map();
  const degradedNotices = new Map();
  const permissionReconcileLocks = new Set();
  const permissionEventTimers = new Map();

  function commandName() {
    return `${prefix}Post-Gate`;
  }

  function levelCommandName() {
    return `${prefix}Level`;
  }

  function actorLabel(userId) {
    if (!isSafeId(userId)) return "*(unknown — author id not recorded)*";
    const username = client.users?.get?.(userId)?.username;
    return username ? `@${username} (<@${userId}>)` : `<@${userId}>`;
  }

  function channelLabel(channelId) {
    const name = client.channels?.get?.(channelId)?.name;
    return name ? `#${name} (<#${channelId}>)` : `<#${channelId}>`;
  }

  function serverLabel(serverId) {
    const name = client.servers?.get?.(serverId)?.name;
    return name ? `${name} (\`${serverId}\`)` : `\`${serverId}\``;
  }

  function logFailure(label, error) {
    logger.warn?.(`post-gate: ${label} ${safeErrorSummary(error)}`);
  }

  async function respond(channelId, title, description, colour = "#3498DB") {
    return send(channelId, {
      embeds: [buildStatusEmbed(title, description, colour)],
    });
  }

  async function sendAccountability(serverId, title, lines, colour) {
    const config = store.getPostGateConfig(serverId);
    if (!isSafeId(config.reviewChannelId)) return undefined;
    try {
      return await sendProtected(config.reviewChannelId, {
        embeds: [buildAuditEmbed(title, lines, colour)],
      });
    } catch (error) {
      logger.warn?.(
        `post-gate: protected notice failed server=${auditAlias(serverId)} ${safeErrorSummary(error)}`
      );
      return undefined;
    }
  }

  async function notifyTerminal(title, description, colour) {
    await gate.sendApprover({
      embeds: [buildStatusEmbed(title, description, colour)],
    });
  }

  // ── Configuration (Enka-gated) ─────────────────────────────────

  async function resolveTarget(serverId, token, message) {
    const channelId =
      token?.toLowerCase() === "here"
        ? channelIdFrom(message)
        : parseChannelArg(token);
    if (!isSafeId(channelId)) return null;

    const cached = client.channels?.get?.(channelId);
    if (cached) {
      return cached.serverId === serverId && cached.type === "TextChannel"
        ? { id: channelId }
        : null;
    }

    const response = await request("GET", `/channels/${channelId}`);
    const data = response?.data;
    return response?.ok &&
      data?._id === channelId &&
      data?.server === serverId &&
      data?.channel_type === "TextChannel"
      ? { id: channelId }
      : null;
  }

  async function status(message) {
    const serverId = serverIdFrom(message);
    const config = store.getPostGateConfig(serverId);
    const pending = gate.getPending(serverId);
    const gatePending = pending?.kind === CHALLENGE_KIND ? pending : null;
    const heldCount = store.getPendingHeldPosts(serverId).length;
    const lines = [
      `**Mode:** ${config.mode}`,
      `**Server level:** ${config.level || "off"}`,
      `**Default Send Messages lock:** ${permissionLockLabel(config)}`,
      `**Review channel:** ${
        config.reviewChannelId
          ? channelLabel(config.reviewChannelId)
          : "not configured"
      }`,
      `**Currently held for review:** ${heldCount}`,
    ];
    if (gatePending) {
      lines.push(
        "",
        `**Pending:** ${gatePending.data.action} requested by ${actorLabel(gatePending.requestedBy)}`
      );
    } else if (pending) {
      lines.push("", `**Pending protected action:** \`${pending.requestId}\``);
    }
    await respond(
      channelIdFrom(message),
      "🛑 Post Gate Status",
      lines.join("\n"),
      config.mode === "hold" ? "#E67E22" : "#3498DB"
    );
    return { outcome: "status", config, pending: gatePending };
  }

  function configSignature(config) {
    return [
      config.mode,
      config.level,
      config.reviewChannelId ?? "",
      config.updatedAt ?? "",
    ].join(":");
  }

  function pruneLevelPrompts() {
    const current = now();
    for (const [messageId, prompt] of pendingLevelPrompts) {
      if (prompt.expiresAt <= current) pendingLevelPrompts.delete(messageId);
    }
  }

  function pendingLevelPromptFor(serverId) {
    pruneLevelPrompts();
    return [...pendingLevelPrompts.values()].find(
      (prompt) => prompt.serverId === serverId
    );
  }

  function clearLockdownActors(serverId) {
    for (const key of lockdownActorState.keys()) {
      if (key.startsWith(`${serverId}:`)) lockdownActorState.delete(key);
    }
  }

  function toPermissionBits(value) {
    if (typeof value === "bigint") return value >= 0n ? value : null;
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
      const parsed = BigInt(value);
      return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? parsed : null;
    }
    return null;
  }

  function hasPermission(bits, permission) {
    return (bits & permission) === permission;
  }

  function permissionLockLabel(config) {
    if (config.level < 3) return "not active";
    if (!config.defaultSendLock) return "pending reconciliation";
    return config.defaultSendLock.restoreOnUnlock
      ? "applied; Send Messages will be restored on unlock"
      : "applied; Send Messages was already disabled";
  }

  async function fetchDefaultPermissionContext(serverId, reviewChannelId) {
    if (
      !client?.api?.get ||
      !isSafeId(serverId) ||
      !isSafeId(reviewChannelId) ||
      !isSafeId(client.user?.id)
    ) {
      return { ok: false, outcome: "invalid_context" };
    }
    try {
      const [serverResponse, memberResponse, channel, user] = await Promise.all(
        [
          client.api.get(`/servers/${serverId}`),
          client.api.get(`/servers/${serverId}/members/${client.user.id}`, {
            roles: false,
          }),
          client.api.get(`/channels/${reviewChannelId}`),
          client.api.get(`/users/${client.user.id}`),
        ]
      );
      const server = serverResponse?.server ?? serverResponse;
      const member = memberResponse?.member ?? memberResponse;
      const currentPermissions = toPermissionBits(server?.default_permissions);
      if (
        server?._id !== serverId ||
        member?._id?.server !== serverId ||
        member?._id?.user !== client.user.id ||
        channel?._id !== reviewChannelId ||
        channel?.server !== serverId ||
        user?._id !== client.user.id ||
        !user.bot ||
        currentPermissions === null
      ) {
        return { ok: false, outcome: "invalid_snapshot" };
      }
      const lockedPermissions =
        currentPermissions & ~PERMISSION_BITS.SendMessage;
      const evaluated = evaluatePermissionSnapshot({
        authorId: client.user.id,
        server: {
          ...server,
          default_permissions: Number(lockedPermissions),
        },
        member,
        channel,
        now: now(),
      });
      if (!evaluated.valid) {
        return { ok: false, outcome: "invalid_snapshot" };
      }
      const canManage =
        evaluated.isOwner ||
        hasPermission(
          evaluated.serverPermissions,
          PERMISSION_BITS.ManagePermissions
        );
      const retainsControl =
        evaluated.isOwner ||
        (hasPermission(
          evaluated.channelPermissions,
          PERMISSION_BITS.ViewChannel
        ) &&
          hasPermission(
            evaluated.channelPermissions,
            PERMISSION_BITS.SendMessage
          ));
      return {
        ok: true,
        canManage,
        retainsControl,
        currentPermissions,
        lockedPermissions,
        deletionFallbackAvailable:
          evaluated.isOwner ||
          hasPermission(
            evaluated.channelPermissions,
            PERMISSION_BITS.ManageMessages
          ),
      };
    } catch (error) {
      logFailure("default permission preflight failed", error);
      return { ok: false, outcome: "snapshot_failed" };
    }
  }

  async function putDefaultPermissions(serverId, permissions) {
    try {
      return await request("PUT", `/servers/${serverId}/permissions/default`, {
        permissions: Number(permissions),
      });
    } catch (error) {
      logFailure("default permission update failed", error);
      return { ok: false, status: null };
    }
  }

  async function ensureDefaultSendLocked(serverId, config) {
    if (permissionReconcileLocks.has(serverId)) {
      return { ok: false, outcome: "in_progress" };
    }
    permissionReconcileLocks.add(serverId);
    let createdLock = false;
    try {
      const context = await fetchDefaultPermissionContext(
        serverId,
        config.reviewChannelId
      );
      if (!context.ok) return context;
      if (!context.canManage) {
        return { ok: false, outcome: "manage_permissions_required" };
      }
      if (!context.retainsControl) {
        return { ok: false, outcome: "control_access_required" };
      }

      let lock = config.defaultSendLock;
      if (!lock) {
        lock = {
          restoreOnUnlock: hasPermission(
            context.currentPermissions,
            PERMISSION_BITS.SendMessage
          ),
          capturedAt: new Date(now()).toISOString(),
        };
        store.setPostGateConfig(serverId, { defaultSendLock: lock });
        createdLock = true;
      }

      if (
        !hasPermission(context.currentPermissions, PERMISSION_BITS.SendMessage)
      ) {
        return {
          ok: true,
          changed: false,
          lock,
          deletionFallbackAvailable: context.deletionFallbackAvailable,
        };
      }
      const response = await putDefaultPermissions(
        serverId,
        context.lockedPermissions
      );
      if (!response?.ok) {
        if (createdLock) {
          store.setPostGateConfig(serverId, { defaultSendLock: null });
        }
        return {
          ok: false,
          outcome: "permission_update_failed",
          status: response?.status ?? null,
        };
      }
      return {
        ok: true,
        changed: true,
        lock,
        deletionFallbackAvailable: context.deletionFallbackAvailable,
      };
    } finally {
      permissionReconcileLocks.delete(serverId);
    }
  }

  async function restoreDefaultSend(serverId, config) {
    const lock = config.defaultSendLock;
    if (!lock) return { ok: true, changed: false };
    if (permissionReconcileLocks.has(serverId)) {
      return { ok: false, outcome: "in_progress" };
    }
    permissionReconcileLocks.add(serverId);
    try {
      if (!lock.restoreOnUnlock) {
        store.setPostGateConfig(serverId, { defaultSendLock: null });
        return { ok: true, changed: false };
      }
      const context = await fetchDefaultPermissionContext(
        serverId,
        config.reviewChannelId
      );
      if (!context.ok) return context;
      if (!context.canManage) {
        return { ok: false, outcome: "manage_permissions_required" };
      }
      if (
        hasPermission(context.currentPermissions, PERMISSION_BITS.SendMessage)
      ) {
        store.setPostGateConfig(serverId, { defaultSendLock: null });
        return { ok: true, changed: false };
      }
      const restored = context.currentPermissions | PERMISSION_BITS.SendMessage;
      const response = await putDefaultPermissions(serverId, restored);
      if (!response?.ok) {
        return {
          ok: false,
          outcome: "permission_restore_failed",
          status: response?.status ?? null,
        };
      }
      store.setPostGateConfig(serverId, { defaultSendLock: null });
      return { ok: true, changed: true };
    } finally {
      permissionReconcileLocks.delete(serverId);
    }
  }

  async function authorizeLevelActor(serverId, channelId, authorId) {
    return authorizeServerActor(
      client,
      { serverId, channelId, authorId },
      COMMAND_ACCESS.FETCH_MANAGER,
      { logger }
    );
  }

  async function verifyBotBanCapability(serverId, channelId) {
    return authorizeServerActor(
      client,
      { serverId, channelId, authorId: client.user?.id },
      COMMAND_ACCESS.BAN,
      { allowBot: true, logger }
    );
  }

  function permissionFailureDescription(result, action = "enable lockdown") {
    if (result.outcome === "manage_permissions_required") {
      return `Irminsul needs Manage Permissions to ${action}. No level changed.`;
    }
    if (result.outcome === "control_access_required") {
      return "Irminsul would lose View Channel or Send Messages in the protected review channel after locking the default role. Give its bot role explicit access first.";
    }
    if (result.outcome === "in_progress") {
      return "Another permission reconciliation is already running. Try again shortly.";
    }
    return `The server's default Send Messages permission could not be updated${result.status ? ` (HTTP ${result.status})` : ""}. No level changed.`;
  }

  async function applyLevel(serverId, level, actorId, responseChannelId) {
    const initial = store.getPostGateConfig(serverId);
    let lockdownPreflight = null;
    if (level >= 3) {
      const locked = await ensureDefaultSendLocked(serverId, initial);
      if (!locked.ok) {
        if (isSafeId(responseChannelId)) {
          await respond(
            responseChannelId,
            "🔒 Lockdown Permission Change Failed",
            permissionFailureDescription(locked),
            "#E74C3C"
          );
        }
        return { outcome: locked.outcome, level: initial.level };
      }
      lockdownPreflight = locked;
    } else if (initial.level >= 3 || initial.defaultSendLock) {
      const restored = await restoreDefaultSend(serverId, initial);
      if (!restored.ok) {
        if (isSafeId(responseChannelId)) {
          await respond(
            responseChannelId,
            "🔒 Lockdown Permission Restore Failed",
            permissionFailureDescription(
              restored,
              "restore default Send Messages"
            ),
            "#E74C3C"
          );
        }
        return { outcome: restored.outcome, level: initial.level };
      }
    }
    const { previous, current } = store.setPostGateConfig(serverId, { level });
    clearLockdownActors(serverId);

    const title =
      level === 4
        ? "🚫 Level 4 Automatic-Ban Lockdown Enabled"
        : level === 3
          ? "🔒 Level 3 Lockdown Enabled"
          : `🛑 Moderation Level ${level} Enabled`;
    const description =
      level === 4
        ? "Level 4 lockdown is currently enabled. Default Send Messages is locked, slipped posts are automatically denied, and the authors of messages that reach Irminsul are automatically banned. Individual messages are not added to the moderation queue."
        : level === 3
          ? "Lockdown mode is currently enabled. Default Send Messages is locked, and slipped posts are automatically denied to avoid flooding the moderation queue."
          : "Links and media from new or first-time members will be held for moderator review.";
    const fallbackWarning =
      level >= 3 && !lockdownPreflight?.deletionFallbackAvailable
        ? "Irminsul could not verify Manage Messages in the protected review channel. The permission lock is active, but deletion of any slipped messages is best effort until that permission is granted."
        : null;

    await sendAccountability(
      serverId,
      title,
      [
        `**Changed by:** ${actorLabel(actorId)}`,
        `**Previous level:** ${previous.level || "off"}`,
        `**Current level:** ${current.level}`,
        description,
        ...(fallbackWarning ? [`⚠️ ${fallbackWarning}`] : []),
      ],
      level >= 3 ? "#E74C3C" : "#E67E22"
    );
    if (isSafeId(responseChannelId)) {
      await respond(
        responseChannelId,
        title,
        fallbackWarning
          ? `${description}\n\n⚠️ ${fallbackWarning}`
          : description,
        level >= 3 ? "#E74C3C" : "#E67E22"
      );
    }
    logger.log?.(
      `🛑  post-gate level=${level} actor=${auditAlias(actorId)} server=${auditAlias(serverId)}`
    );
    return { outcome: "level_changed", level };
  }

  async function openLevelFourPrompt(message, config) {
    const serverId = serverIdFrom(message);
    const responseChannelId = channelIdFrom(message);
    const existing = pendingLevelPromptFor(serverId);
    if (existing) {
      await respond(
        responseChannelId,
        "⏳ Level 4 Confirmation Already Pending",
        `A Level 4 confirmation requested by ${actorLabel(existing.requestedBy)} is already awaiting a reaction.`,
        "#E67E22"
      );
      return { outcome: "confirmation_pending" };
    }

    const prompt = await send(responseChannelId, {
      embeds: [
        buildStatusEmbed(
          "🚨 Confirm Level 4 Automatic Bans",
          "Level 4 locks the server default role's Send Messages permission, deletes any regular-member messages that slip through, and automatically bans each slipped-message author. React ✅ within two minutes to enable it, or ❌ to cancel.",
          "#E74C3C"
        ),
      ],
    });
    if (!isSafeId(prompt?._id)) {
      return { outcome: "prompt_failed" };
    }
    pendingLevelPrompts.set(prompt._id, {
      serverId,
      channelId: responseChannelId,
      requestedBy: message.authorId,
      configSignature: configSignature(config),
      expiresAt: now() + LEVEL_CONFIRM_WINDOW_MS,
    });
    await seedReviewReactions(responseChannelId, prompt._id);
    return { outcome: "confirmation_requested", promptMessageId: prompt._id };
  }

  async function handleLevelCommand(message, args = []) {
    const serverId = serverIdFrom(message);
    const responseChannelId = channelIdFrom(message);
    if (!isSafeId(serverId)) {
      await respond(
        responseChannelId,
        "🔒 Server Only",
        "Moderation levels can only be managed inside a server.",
        "#E74C3C"
      );
      return { outcome: "server_only" };
    }

    const config = store.getPostGateConfig(serverId);
    const [rawAction = "status", rawConfirm, ...extra] = args;
    const action = String(rawAction).toLowerCase();
    if (!args.length || action === "status") {
      await respond(
        responseChannelId,
        "🛡️ Server Moderation Level",
        [
          `**Level:** ${config.level || "off"}`,
          `**Post Gate:** ${config.mode}`,
          `**Review channel:** ${config.reviewChannelId ? channelLabel(config.reviewChannelId) : "not configured"}`,
          `**Default Send Messages lock:** ${permissionLockLabel(config)}`,
          "Levels 1–2 hold qualifying links/media; Level 3 locks default-role sending and deletes slipped regular-member posts; Level 4 also automatically bans slipped-message authors.",
        ].join("\n"),
        config.level >= 3 ? "#E74C3C" : "#3498DB"
      );
      return { outcome: "status", config };
    }

    if (!["1", "2", "3", "4"].includes(action) || extra.length) {
      await respond(
        responseChannelId,
        "⚠️ Invalid Moderation Level",
        `Use \`${levelCommandName()} status\`, \`${levelCommandName()} 1|2|3\`, or \`${levelCommandName()} 4 confirm\`.`,
        "#E74C3C"
      );
      return { outcome: "invalid_level" };
    }
    const level = Number(action);
    if (level === 4 && String(rawConfirm).toLowerCase() !== "confirm") {
      await respond(
        responseChannelId,
        "⚠️ Level 4 Requires Confirmation",
        `Use \`${levelCommandName()} 4 confirm\` to open the final reaction prompt.`,
        "#E74C3C"
      );
      return { outcome: "confirmation_required" };
    }
    if (level !== 4 && rawConfirm !== undefined) {
      await respond(
        responseChannelId,
        "⚠️ Invalid Moderation Level",
        `Use \`${levelCommandName()} ${level}\` with no extra arguments.`,
        "#E74C3C"
      );
      return { outcome: "invalid_level" };
    }
    if (config.mode !== "hold" || !isSafeId(config.reviewChannelId)) {
      await respond(
        responseChannelId,
        "🔒 Post Gate Not Configured",
        `Configure an Enka-approved review channel with \`${commandName()} here\` or \`${commandName()} #channel\` first.`,
        "#E74C3C"
      );
      return { outcome: "post_gate_required" };
    }
    if (config.level === level) {
      await respond(
        responseChannelId,
        "ℹ️ No Change Needed",
        `Moderation Level ${level} is already enabled.`,
        "#3498DB"
      );
      return { outcome: "no_change", level };
    }

    const actor = await authorizeLevelActor(
      serverId,
      responseChannelId,
      message.authorId
    );
    if (
      !actor.allowed ||
      !actor.identityVerified ||
      actor.permissionSource !== "refreshed"
    ) {
      await respond(
        responseChannelId,
        "🔒 Permission Verification Failed",
        "Fresh permission verification did not confirm a recognized moderator. No level changed.",
        "#E74C3C"
      );
      return { outcome: "unauthorized" };
    }

    return level === 4
      ? openLevelFourPrompt(message, config)
      : applyLevel(serverId, level, message.authorId, responseChannelId);
  }

  async function onExpired(challenge) {
    await sendAccountability(
      challenge.serverId,
      "⌛ Post Gate Request Expired",
      [
        `**Request:** \`${challenge.requestId}\``,
        `**Requested by:** ${actorLabel(challenge.requestedBy)}`,
        "No configuration was changed.",
      ],
      "#E67E22"
    );
    await notifyTerminal(
      "⌛ Post Gate Request Expired",
      `Request \`${challenge.requestId}\` expired without changing configuration.`,
      "#E67E22"
    );
  }

  async function onWrongCode(_challenge, attemptsRemaining, responseChannelId) {
    if (!isSafeId(responseChannelId)) return;
    await respond(
      responseChannelId,
      "⚠️ Incorrect Approval Code",
      `${attemptsRemaining} attempt(s) remain.`,
      "#E67E22"
    );
  }

  async function onAttemptsExhausted(challenge, responseChannelId) {
    await sendAccountability(
      challenge.serverId,
      "🛑 Post Gate Request Attempts Exhausted",
      [
        `**Request:** \`${challenge.requestId}\``,
        `**Requested by:** ${actorLabel(challenge.requestedBy)}`,
        `**Attempts:** ${POST_GATE_MAX_ATTEMPTS}`,
        "No configuration was changed.",
      ],
      "#E74C3C"
    );
    await notifyTerminal(
      "🛑 Post Gate Request Cancelled",
      `Request \`${challenge.requestId}\` was destroyed after ${POST_GATE_MAX_ATTEMPTS} incorrect code attempts.`,
      "#E74C3C"
    );
    if (isSafeId(responseChannelId)) {
      await respond(
        responseChannelId,
        "🛑 Too Many Incorrect Codes",
        "The pending request was destroyed. Start a new request to try again.",
        "#E74C3C"
      );
    }
  }

  async function onDenied(challenge) {
    await sendAccountability(
      challenge.serverId,
      "🚫 Post Gate Request Denied",
      [
        `**Request:** \`${challenge.requestId}\``,
        `**Requested by:** ${actorLabel(challenge.requestedBy)}`,
        `**Denied by:** ${ENKA_APPROVER_TAG}`,
        "No configuration was changed.",
      ],
      "#E74C3C"
    );
    await notifyTerminal(
      "🚫 Post Gate Request Denied",
      `Request \`${challenge.requestId}\` was denied. No configuration changed.`,
      "#E74C3C"
    );
  }

  async function onCancelled(challenge, actorId) {
    await sendAccountability(
      challenge.serverId,
      "🚫 Post Gate Request Cancelled",
      [
        `**Request:** \`${challenge.requestId}\``,
        `**Cancelled by:** ${actorLabel(actorId)}`,
        "No configuration was changed.",
      ],
      "#E67E22"
    );
    await notifyTerminal(
      "🚫 Post Gate Request Cancelled",
      `Request \`${challenge.requestId}\` was cancelled by ${actorLabel(actorId)}.`,
      "#E67E22"
    );
  }

  async function onApproved(challenge, approvedBy, responseChannelId) {
    const { action, channelId } = challenge.data;
    const previousConfig = store.getPostGateConfig(challenge.serverId);
    if (
      action === "off" &&
      (previousConfig.level >= 3 || previousConfig.defaultSendLock)
    ) {
      const restored = await restoreDefaultSend(
        challenge.serverId,
        previousConfig
      );
      if (!restored.ok) {
        throw new Error(
          `default Send Messages restore failed: ${restored.outcome}`
        );
      }
    }
    if (action !== "off" && previousConfig.level >= 3) {
      const targetContext = await fetchDefaultPermissionContext(
        challenge.serverId,
        channelId
      );
      if (
        !targetContext.ok ||
        !targetContext.canManage ||
        !targetContext.retainsControl
      ) {
        throw new Error(
          "the new review channel would not retain lockdown control access"
        );
      }
    }
    store.setPostGateConfig(challenge.serverId, {
      mode: action === "off" ? "off" : "hold",
      level:
        action === "off"
          ? 0
          : previousConfig.mode === "hold"
            ? previousConfig.level
            : 1,
      reviewChannelId: action === "off" ? null : channelId,
    });
    clearLockdownActors(challenge.serverId);
    const updatedConfig = store.getPostGateConfig(challenge.serverId);

    const title = terminalTitle(action);
    const description =
      action === "off"
        ? "The post gate is now off. New links and attachments from new or first-time posters will no longer be held."
        : updatedConfig.level >= 3
          ? `The protected moderation destination is now ${channelLabel(channelId)}. Server Level ${updatedConfig.level} remains enabled.`
          : `New links and attachments from new or first-time posters will be held in ${channelLabel(channelId)} for review.`;
    await sendAccountability(
      challenge.serverId,
      title,
      [
        `**Request:** \`${challenge.requestId}\``,
        `**Requested by:** ${actorLabel(challenge.requestedBy)}`,
        `**Approved by:** ${ENKA_APPROVER_TAG} (<@${approvedBy}>)`,
        description,
      ],
      action === "off" ? "#E67E22" : "#2ECC71"
    );
    await notifyTerminal(
      title,
      `Request \`${challenge.requestId}\` completed. ${description}`,
      action === "off" ? "#E67E22" : "#2ECC71"
    );
    if (isSafeId(responseChannelId)) {
      await respond(
        responseChannelId,
        title,
        description,
        action === "off" ? "#E67E22" : "#2ECC71"
      );
    }
    logger.log?.(
      `🛑  post-gate ${action} request=${auditAlias(challenge.requestId)} server=${auditAlias(challenge.serverId)}`
    );
    return { outcome: action === "off" ? "disabled" : "enabled" };
  }

  async function requestChange(message, action, targetToken) {
    const serverId = serverIdFrom(message);
    const requesterId = message.authorId;
    const responseChannelId = channelIdFrom(message);
    if (!isSafeId(gate.resolveApprover())) {
      await respond(
        responseChannelId,
        "🔒 Approver Unavailable",
        `${ENKA_APPROVER_TAG} could not be resolved as the fixed approver, so the post gate cannot be changed.`,
        "#E74C3C"
      );
      return { outcome: "approver_unavailable" };
    }

    let channelId = null;
    if (action !== "off") {
      const target = await resolveTarget(serverId, targetToken, message);
      if (!target) {
        await respond(
          responseChannelId,
          "⚠️ Invalid Review Channel",
          `Choose a text channel in this server using \`${commandName()} here\`, a channel mention, or a channel ID.`,
          "#E74C3C"
        );
        return { outcome: "invalid_channel" };
      }
      channelId = target.id;
    }

    const config = store.getPostGateConfig(serverId);
    if (action === "off" && config.mode === "off") {
      await respond(
        responseChannelId,
        "ℹ️ No Change Needed",
        "The post gate is already off.",
        "#3498DB"
      );
      return { outcome: "no_change" };
    }
    if (
      action !== "off" &&
      config.mode === "hold" &&
      config.reviewChannelId === channelId
    ) {
      await respond(
        responseChannelId,
        "ℹ️ No Change Needed",
        `The post gate already reviews into ${channelLabel(channelId)}.`,
        "#3498DB"
      );
      return { outcome: "no_change" };
    }

    const result = await gate.requestChallenge({
      kind: CHALLENGE_KIND,
      requestId: requestIdFactory(),
      serverId,
      requestedBy: requesterId,
      requestChannelId: responseChannelId,
      data: { action, channelId },
      buildDmPayload: (challenge, code) => ({
        embeds: [
          buildStatusEmbed(
            action === "off"
              ? "🔕 Approve Post Gate Disable"
              : "🛑 Approve Post Gate Configuration",
            [
              `**Request:** \`${challenge.requestId}\``,
              `**Server:** ${serverLabel(serverId)}`,
              action === "off"
                ? "**Action:** turn the post gate off"
                : `**Review channel:** ${channelLabel(channelId)}`,
              `**Requested by:** ${actorLabel(requesterId)}`,
              `**One-time code:** \`${code}\``,
              "",
              `Reply \`approve ${code}\`, \`deny ${code}\`, or just \`${code}\` to approve. A recognized moderator may also use \`${commandName()} confirm ${code}\` in the server.`,
              "This code expires in 10 minutes after 3 incorrect attempts.",
            ].join("\n"),
            "#E67E22"
          ),
        ],
      }),
      onApproved,
      onDenied,
      onExpired,
      onCancelled,
      onWrongCode,
      onAttemptsExhausted,
    });

    if (result.outcome === "pending_exists") {
      await respond(
        responseChannelId,
        "⏳ Protected Request Already Pending",
        `Request \`${result.pending.requestId}\` is already awaiting approval. Approve, deny, cancel, or wait for it to expire first.`,
        "#E67E22"
      );
      return result;
    }
    if (result.outcome === "approver_unavailable") {
      await respond(
        responseChannelId,
        "🔒 Approver Unavailable",
        `${ENKA_APPROVER_TAG} is unavailable, so no configuration changed.`,
        "#E74C3C"
      );
      return result;
    }
    if (result.outcome === "dm_failed") {
      await respond(
        responseChannelId,
        "⚠️ Approval DM Failed",
        `${ENKA_APPROVER_TAG} could not be reached, so no request was retained and no configuration changed.`,
        "#E74C3C"
      );
      return result;
    }

    const challenge = result.challenge;
    await sendAccountability(
      serverId,
      "🛑 Post Gate Change Requested",
      [
        `**Request:** \`${challenge.requestId}\``,
        `**Requested by:** ${actorLabel(requesterId)}`,
        `**Approval:** awaiting ${ENKA_APPROVER_TAG}; expires in 10 minutes.`,
      ],
      "#E67E22"
    );
    await respond(
      responseChannelId,
      "📨 Enka Approval Requested",
      `Request \`${challenge.requestId}\` was sent to ${ENKA_APPROVER_TAG}. No configuration has changed yet.`,
      "#E67E22"
    );
    return { outcome: "requested", requestId: challenge.requestId };
  }

  async function confirmInServer(message, code) {
    const result = await gate.confirm({
      serverId: serverIdFrom(message),
      kind: CHALLENGE_KIND,
      code,
      responseChannelId: channelIdFrom(message),
    });
    if (result.outcome === "no_pending") {
      await respond(
        channelIdFrom(message),
        "ℹ️ No Pending Post Gate Request",
        "Start a configuration change first.",
        "#3498DB"
      );
    } else if (result.outcome === "different_pending") {
      await respond(
        channelIdFrom(message),
        "⏳ Different Protected Request Pending",
        `Request \`${result.pending.requestId}\` belongs to another protected action.`,
        "#E67E22"
      );
    }
    return result;
  }

  async function cancel(message) {
    const result = await gate.cancel({
      serverId: serverIdFrom(message),
      kind: CHALLENGE_KIND,
      actorId: message.authorId,
    });
    if (result.outcome === "no_pending") {
      await respond(
        channelIdFrom(message),
        "ℹ️ No Pending Post Gate Request",
        "There is no request to cancel.",
        "#3498DB"
      );
    } else if (result.outcome === "different_pending") {
      await respond(
        channelIdFrom(message),
        "⏳ Different Protected Request Pending",
        `Request \`${result.pending.requestId}\` belongs to another protected action.`,
        "#E67E22"
      );
    } else if (result.outcome === "not_requester") {
      await respond(
        channelIdFrom(message),
        "🔒 Cannot Cancel This Request",
        `Only the original requester or ${ENKA_APPROVER_TAG} can cancel it.`,
        "#E74C3C"
      );
    } else if (result.outcome === "cancelled") {
      await respond(
        channelIdFrom(message),
        "🚫 Post Gate Request Cancelled",
        "The pending request was cancelled.",
        "#E67E22"
      );
    }
    return result;
  }

  // ── Detection ────────────────────────────────────────────────

  /**
   * Called synchronously (before any await in handleMessage) so the archive
   * snapshot it reads predates any interleaving from other messageCreate
   * listeners — in particular auditlog.js's own archive write for this same
   * message, which only happens after an await of its own.
   */
  function isFirstPostCandidate(serverId, authorId, message) {
    const current = now();
    const accountCreatedAt =
      message.author?.createdAt ?? deriveAccountCreatedAt(authorId);
    const joinedAt = message.member?.joinedAt ?? null;
    const isNewAccount =
      accountCreatedAt instanceof Date &&
      current - accountCreatedAt.getTime() >= 0 &&
      current - accountCreatedAt.getTime() < AUTOMOD_LIMITS.recentAccountMs;
    const isNewMember =
      joinedAt instanceof Date &&
      current - joinedAt.getTime() >= 0 &&
      current - joinedAt.getTime() < AUTOMOD_LIMITS.recentMemberMs;
    const isFirstMessage = countArchivedMessages({ serverId, authorId }) === 0;
    return isNewAccount || isNewMember || isFirstMessage;
  }

  function describeHeldAttachment(att) {
    const sizeLabel = humanReadableSize(att.size);
    return att.archiveAttachmentId
      ? `- \`${att.filename}\` (${sizeLabel}) — Stoat-hosted below`
      : `- \`${att.filename}\` (${sizeLabel}) — not archived (${att.skipReason ?? "unknown"})`;
  }

  function buildHoldReviewEmbed(record) {
    const lines = [
      `**Queue ID:** \`${record.queueId}\``,
      `**Author:** ${actorLabel(record.userId)}`,
      `**Channel:** ${channelLabel(record.channelId)}`,
      `**Content:** ${record.content ? record.content.slice(0, 1000) : "*(no text — attachment/link only)*"}`,
    ];
    if (record.attachments.length) {
      lines.push(
        "",
        "**Attachments:**",
        ...record.attachments.map(describeHeldAttachment)
      );
    }
    lines.push(
      "",
      `React ${APPROVE_EMOJI} to clear the author and reset their automod strike, ${REJECT_EMOJI} to discard and strike, or use \`${commandName()} approve ${record.queueId}\` / \`${commandName()} reject ${record.queueId}\`.`,
      "Approving does not repost the content — the author may post it again themselves.",
      `This request expires in 7 days if left unreviewed.`
    );
    return buildAuditEmbed(
      "🛑 Held First Post — Review Needed",
      lines,
      "#E67E22"
    );
  }

  async function seedReviewReactions(channelId, messageId) {
    for (const emoji of [APPROVE_EMOJI, REJECT_EMOJI]) {
      const reaction = await request(
        "PUT",
        `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`
      );
      if (!reaction.ok) {
        logger.warn?.(
          `post-gate: could not seed ${emoji} reaction on a review message`
        );
      }
    }
  }

  async function holdMessage(
    serverId,
    channelId,
    held,
    config,
    resolveDecision
  ) {
    const messageId = held.id;
    const prepared = await prepareAttachmentCopies(client, held.attachments, {
      fetchImpl,
    });

    const deleted = await request(
      "DELETE",
      `/channels/${channelId}/messages/${messageId}`
    );
    if (!deleted.ok) {
      resolveDecision(false);
      logger.warn?.(
        `post-gate: could not remove held message=${auditAlias(messageId)} server=${auditAlias(serverId)}`
      );
      return;
    }
    resolveDecision(true);

    const createdAt = now();
    const record = store.createHeldPost({
      queueId: queueIdFactory(),
      serverId,
      channelId,
      userId: held.authorId,
      messageId,
      content: held.content,
      attachments: prepared.descriptors,
      reviewChannelId: config.reviewChannelId,
      reviewMessageId: null,
      status: "pending",
      createdAt,
      expiresAt: createdAt + REVIEW_WINDOW_MS,
    });

    const posted = await sendProtected(config.reviewChannelId, {
      embeds: [buildHoldReviewEmbed(record)],
      ...(prepared.uploadIds.length ? { attachments: prepared.uploadIds } : {}),
    });
    const finalAttachments = finaliseArchiveDescriptors(
      prepared.descriptors,
      posted
    );
    if (isSafeId(posted?._id)) {
      store.updateHeldPost(record.queueId, {
        reviewMessageId: posted._id,
        attachments: finalAttachments,
      });
      await seedReviewReactions(config.reviewChannelId, posted._id);
    } else {
      store.updateHeldPost(record.queueId, { attachments: finalAttachments });
      logger.warn?.(
        `post-gate: could not post review card for queue=${auditAlias(record.queueId)}`
      );
    }
    logger.log?.(
      `🛑  post-gate held queue=${auditAlias(record.queueId)} actor=${auditAlias(held.authorId)} server=${auditAlias(serverId)}`
    );
  }

  async function notifyDegraded(serverId, detail) {
    const lastPostedAt = degradedNotices.get(serverId) ?? 0;
    if (now() - lastPostedAt < DEGRADED_NOTICE_WINDOW_MS) return;
    degradedNotices.set(serverId, now());
    await sendAccountability(
      serverId,
      "⚠️ Lockdown Enforcement Degraded",
      [
        detail,
        "Further failure notices are suppressed for ten minutes to avoid flooding this channel.",
      ],
      "#E74C3C"
    );
  }

  async function reconcilePermissionLock(serverId) {
    if (!isSafeId(serverId)) return { ok: false, outcome: "invalid_server" };
    const config = store.getPostGateConfig(serverId);
    if (config.mode === "hold" && config.level >= 3) {
      const locked = await ensureDefaultSendLocked(serverId, config);
      if (!locked.ok && locked.outcome !== "in_progress") {
        await notifyDegraded(
          serverId,
          `${permissionFailureDescription(locked)} Reactive deletion remains active, and permission reconciliation will retry.`
        );
      }
      return locked;
    }
    if (config.defaultSendLock) {
      const restored = await restoreDefaultSend(serverId, config);
      if (!restored.ok && restored.outcome !== "in_progress") {
        await notifyDegraded(
          serverId,
          `${permissionFailureDescription(restored, "restore default Send Messages")} Permission reconciliation will retry.`
        );
      }
      return restored;
    }
    return { ok: true, changed: false };
  }

  async function reconcilePermissionLocks() {
    const results = [];
    for (const config of store.getAllPostGateConfigs()) {
      if (config.level < 3 && !config.defaultSendLock) continue;
      results.push(await reconcilePermissionLock(config.serverId));
    }
    return results;
  }

  function schedulePermissionReconcile(serverId) {
    if (!isSafeId(serverId)) return;
    const existing = permissionEventTimers.get(serverId);
    if (existing) clearTimeout(existing);
    const timer = scheduleTimeout(() => {
      permissionEventTimers.delete(serverId);
      void reconcilePermissionLock(serverId);
    }, 500);
    timer?.unref?.();
    permissionEventTimers.set(serverId, timer);
  }

  function rememberLockdownActor(key, value) {
    lockdownActorState.set(key, value);
    while (lockdownActorState.size > MAX_LOCKDOWN_ACTORS) {
      lockdownActorState.delete(lockdownActorState.keys().next().value);
    }
  }

  async function enforceLockdown(
    serverId,
    channelId,
    messageId,
    authorId,
    level
  ) {
    let deletion;
    try {
      deletion = await request(
        "DELETE",
        `/channels/${channelId}/messages/${messageId}`
      );
    } catch (error) {
      logFailure("lockdown delete request failed", error);
    }
    if (!deletion?.ok && deletion?.status !== 404) {
      logger.warn?.(
        `post-gate: lockdown delete failed server=${auditAlias(serverId)} channel=${auditAlias(channelId)} message=${auditAlias(messageId)} status=${deletion?.status || "unknown"}`
      );
      await notifyDegraded(
        serverId,
        "A lockdown message could not be deleted. Check Irminsul's Manage Messages permission and Stoat availability."
      );
    }
    if (level !== 4) return;

    const key = `${serverId}:${authorId}`;
    const state = lockdownActorState.get(key);
    if (state === "banned" || state === "pending") return;
    if (Number.isFinite(state) && now() - state < DEGRADED_NOTICE_WINDOW_MS) {
      return;
    }
    rememberLockdownActor(key, "pending");
    let ban;
    try {
      ban = await request("PUT", `/servers/${serverId}/bans/${authorId}`, {
        reason: LOCKDOWN_BAN_REASON,
      });
    } catch (error) {
      logFailure("lockdown ban request failed", error);
    }
    if (ban?.ok || ban?.status === 409) {
      rememberLockdownActor(key, "banned");
      return;
    }
    rememberLockdownActor(key, now());
    logger.warn?.(
      `post-gate: lockdown ban failed server=${auditAlias(serverId)} actor=${auditAlias(authorId)} status=${ban?.status || "unknown"}`
    );
    await notifyDegraded(
      serverId,
      "A Level 4 automatic ban failed. Check Irminsul's Ban Members permission and Stoat availability."
    );
  }

  async function handleMessage(message) {
    const serverId = serverIdFrom(message);
    const authorId = message?.authorId;
    const channelId = message?.channelId;
    const messageId = message?.id ?? message?._id;
    if (
      !isSafeId(serverId) ||
      !isSafeId(authorId) ||
      !isSafeId(channelId) ||
      !isSafeId(messageId) ||
      message.webhook ||
      message.systemMessage ||
      message.author?.bot ||
      authorId === client.user?.id
    ) {
      return;
    }

    const config = store.getPostGateConfig(serverId);
    if (config.mode !== "hold" || !isSafeId(config.reviewChannelId)) return;
    const lockdown = config.level >= 3;
    if (!lockdown) {
      if (channelId === config.reviewChannelId) return;
      if (store.isChannelExcluded(channelId)) return;
      if (!hasLinkOrAttachment(message)) return;
      // The first-post signal is only meaningful for a message actually
      // eligible for a hold, so this stays inside the gate rather than
      // running (and racing the archive) on every message.
      if (!isFirstPostCandidate(serverId, authorId, message)) return;
    }

    // revolt.js Message fields are live getters into the client's message
    // collection. holdMessage deletes the message before it needs these
    // values, and our own DELETE triggers a MessageDelete gateway event that
    // clears that collection entry — so anything read off `message` after
    // that point can come back undefined. Snapshot now, before any await.
    const held = {
      id: messageId,
      authorId,
      content: message.content ?? "",
      attachments: message.attachments ?? [],
    };

    let resolveDecisionPromise;
    let decisionResolved = false;
    const decision = new Promise((resolve) => {
      resolveDecisionPromise = resolve;
    });
    const resolveDecision = (value) => {
      if (decisionResolved) return;
      decisionResolved = true;
      resolveDecisionPromise(value);
    };
    pendingDecisions.set(messageId, decision);

    try {
      const authorization = await authorizeServerActor(
        client,
        { serverId, channelId, authorId },
        COMMAND_ACCESS.FETCH_MANAGER,
        { logger }
      );
      // Fail closed: never hold when the fresh permission refresh itself is
      // unavailable, and always exempt a verified moderator.
      if (
        authorization.isBot ||
        !authorization.identityVerified ||
        authorization.permissionSource !== "refreshed" ||
        authorization.allowed
      ) {
        resolveDecision(false);
        return;
      }

      if (lockdown) {
        resolveDecision(true);
        await enforceLockdown(
          serverId,
          channelId,
          messageId,
          authorId,
          config.level
        );
      } else {
        await holdMessage(serverId, channelId, held, config, resolveDecision);
      }
    } catch (error) {
      logFailure("hold decision failed", error);
      resolveDecision(false);
    } finally {
      pendingDecisions.delete(messageId);
    }
  }

  // ── Review ───────────────────────────────────────────────────

  async function notifyReviewOutcome(
    record,
    outcome,
    moderatorId,
    { strikeCleared = false, strikeSkipped = false } = {}
  ) {
    const title =
      outcome === "approved"
        ? "✅ Held Post Approved"
        : "❌ Held Post Rejected";
    const description =
      outcome === "approved"
        ? `${actorLabel(record.userId)} was cleared${strikeCleared ? " and their automod strike was reset" : ""}. The content was **not** reposted to ${channelLabel(record.channelId)} — they can post it again themselves.`
        : `The held content from ${actorLabel(record.userId)} was discarded${strikeSkipped ? " (no automod strike was recorded — the original author's id was not captured)" : " and their automod strike stage was increased"}.`;
    await sendAccountability(
      record.serverId,
      title,
      [
        `**Queue ID:** \`${record.queueId}\``,
        `**Reviewed by:** ${actorLabel(moderatorId)}`,
        description,
      ],
      outcome === "approved" ? "#2ECC71" : "#E74C3C"
    );
  }

  async function authorizeReviewer(record, moderatorId) {
    // Manage Messages is checked in the review channel — where the
    // moderator is actually acting — not the (possibly inaccessible)
    // source channel the held content originally came from.
    const config = store.getPostGateConfig(record.serverId);
    return authorizeServerActor(
      client,
      {
        serverId: record.serverId,
        channelId: config.reviewChannelId,
        authorId: moderatorId,
      },
      COMMAND_ACCESS.MANAGE_MESSAGES,
      { logger }
    );
  }

  async function deleteReviewCard(record) {
    if (!isSafeId(record.reviewMessageId)) return true;
    const operation = async () => {
      const response = await request(
        "DELETE",
        `/channels/${record.reviewChannelId ?? store.getPostGateConfig(record.serverId).reviewChannelId}/messages/${record.reviewMessageId}`
      );
      return Boolean(response.ok);
    };
    return typeof runIntentionalDelete === "function"
      ? runIntentionalDelete(record.reviewMessageId, operation)
      : operation();
  }

  async function approve(queueId, moderatorId) {
    const record = store.getHeldPost(queueId);
    if (!record) return { outcome: "missing" };
    if (record.status !== "pending") return { outcome: record.status };

    const reviewer = await authorizeReviewer(record, moderatorId);
    if (!reviewer.allowed || reviewer.permissionSource !== "refreshed") {
      return { outcome: "unauthorized" };
    }

    // Approval clears the author, not the content. Republishing held material
    // through the bot means a moderator's "this account is fine" also
    // relaunches whatever they posted — during a troll wave that turns the
    // review queue into a delivery mechanism. The author keeps the right to
    // post it again themselves; the archived copy stays on the review card as
    // the evidence record.
    const reviewDeleted = await deleteReviewCard(record);
    if (!reviewDeleted) logger.warn?.("post-gate: review card cleanup failed");
    // Legacy queue entries from before the authorId-snapshot fix may have no
    // userId recorded — never touch the strike store under a phantom key.
    const strikeCleared =
      isSafeId(record.userId) &&
      Boolean(store.clearAutomodStrike(record.serverId, record.userId));
    store.updateHeldPost(queueId, {
      status: "approved",
      reviewedBy: moderatorId,
      reviewedAt: now(),
    });
    await notifyReviewOutcome(record, "approved", moderatorId, {
      strikeCleared,
    });
    logger.log?.(
      `🛑  post-gate approved queue=${auditAlias(queueId)} moderator=${auditAlias(moderatorId)} strike_cleared=${strikeCleared}`
    );
    return { outcome: "approved", strikeCleared };
  }

  async function reject(queueId, moderatorId) {
    const record = store.getHeldPost(queueId);
    if (!record) return { outcome: "missing" };
    if (record.status !== "pending") return { outcome: record.status };

    const reviewer = await authorizeReviewer(record, moderatorId);
    if (!reviewer.allowed || reviewer.permissionSource !== "refreshed") {
      return { outcome: "unauthorized" };
    }

    const reviewDeleted = await deleteReviewCard(record);
    if (!reviewDeleted) logger.warn?.("post-gate: review card cleanup failed");

    const current = now();
    // Legacy queue entries from before the authorId-snapshot fix may have no
    // userId recorded — never strike a phantom "serverId:undefined" user.
    const strikeSkipped = !isSafeId(record.userId);
    let level = null;
    if (!strikeSkipped) {
      const stored = store.getAutomodStrike(record.serverId, record.userId);
      level = nextStrikeLevel(stored, current);
      store.setAutomodStrike(record.serverId, record.userId, {
        level,
        lastContainedAt: current,
        timeoutUntil: stored?.timeoutUntil ?? null,
      });
    }

    store.updateHeldPost(queueId, {
      status: "rejected",
      reviewedBy: moderatorId,
      reviewedAt: current,
    });
    await notifyReviewOutcome(record, "rejected", moderatorId, {
      strikeSkipped,
    });
    logger.log?.(
      `🛑  post-gate rejected queue=${auditAlias(queueId)} moderator=${auditAlias(moderatorId)} strike=${level ?? "skipped"}`
    );
    return { outcome: "rejected", strikeLevel: level };
  }

  async function handleLevelReaction(event) {
    pruneLevelPrompts();
    const prompt = pendingLevelPrompts.get(event.id);
    if (!prompt) return false;
    if (event.user_id !== prompt.requestedBy) return true;
    if (event.emoji_id === REJECT_EMOJI) {
      pendingLevelPrompts.delete(event.id);
      await respond(
        prompt.channelId,
        "❌ Level 4 Activation Cancelled",
        "The server moderation level was not changed.",
        "#808080"
      );
      return true;
    }
    if (event.emoji_id !== APPROVE_EMOJI) return true;
    pendingLevelPrompts.delete(event.id);

    const config = store.getPostGateConfig(prompt.serverId);
    if (configSignature(config) !== prompt.configSignature) {
      await respond(
        prompt.channelId,
        "⚠️ Level 4 Confirmation Is Stale",
        "The Post Gate configuration or moderation level changed after this prompt was opened. Start a fresh confirmation.",
        "#E74C3C"
      );
      return true;
    }
    const [actor, bot] = await Promise.all([
      authorizeLevelActor(
        prompt.serverId,
        prompt.channelId,
        prompt.requestedBy
      ),
      verifyBotBanCapability(prompt.serverId, prompt.channelId),
    ]);
    if (
      !actor.allowed ||
      !actor.identityVerified ||
      actor.permissionSource !== "refreshed"
    ) {
      await respond(
        prompt.channelId,
        "🔒 Level 4 Activation Denied",
        "Fresh permission verification no longer confirms the requesting moderator. No level changed.",
        "#E74C3C"
      );
      return true;
    }
    if (
      !bot.allowed ||
      !bot.identityVerified ||
      bot.permissionSource !== "refreshed"
    ) {
      await respond(
        prompt.channelId,
        "🔒 Ban Permission Required",
        "Irminsul could not freshly verify its Ban Members permission. Level 4 was not enabled.",
        "#E74C3C"
      );
      return true;
    }
    await applyLevel(prompt.serverId, 4, prompt.requestedBy, prompt.channelId);
    return true;
  }

  async function handleRawEvent(event) {
    if (event?.type === "ServerUpdate") {
      schedulePermissionReconcile(event.id);
      return;
    }
    if (
      event?.type !== "MessageReact" ||
      !isSafeId(event.id) ||
      !isSafeId(event.user_id) ||
      event.user_id === client.user?.id ||
      (event.emoji_id !== APPROVE_EMOJI && event.emoji_id !== REJECT_EMOJI)
    ) {
      return;
    }
    if (await handleLevelReaction(event)) return;
    const record = store.findHeldPostByReviewMessage(event.id);
    if (!record) return;
    const result =
      event.emoji_id === APPROVE_EMOJI
        ? await approve(record.queueId, event.user_id)
        : await reject(record.queueId, event.user_id);
    logger.log?.(
      `🛑  post-gate reaction-review queue=${auditAlias(record.queueId)} actor=${auditAlias(event.user_id)} outcome=${result.outcome}`
    );
  }

  // ── Command routing ──────────────────────────────────────────

  async function handleCommand(message, args = []) {
    await gate.expireDueChallenges();
    const serverId = serverIdFrom(message);
    if (!isSafeId(serverId)) {
      await respond(
        channelIdFrom(message),
        "🔒 Server Only",
        "The post gate can only be managed inside a server.",
        "#E74C3C"
      );
      return { outcome: "server_only" };
    }

    const [first = "status", second, ...extra] = args;
    const action = first.toLowerCase();
    if (!args.length || action === "status") return status(message);
    if (action === "cancel") return cancel(message);
    if (action === "confirm") {
      if (extra.length || !/^\d{6}$/.test(second ?? "")) {
        await respond(
          channelIdFrom(message),
          "⚠️ Invalid Confirmation",
          `Use \`${commandName()} confirm 123456\`.`,
          "#E74C3C"
        );
        return { outcome: "invalid_confirmation" };
      }
      if (!isSafeId(gate.resolveApprover())) {
        await respond(
          channelIdFrom(message),
          "🔒 Approver Unavailable",
          `${ENKA_APPROVER_TAG} is not available as the fixed approver, so the request cannot be approved.`,
          "#E74C3C"
        );
        return { outcome: "approver_unavailable" };
      }
      return confirmInServer(message, second);
    }
    if (action === "off") {
      if (second || extra.length) {
        await respond(
          channelIdFrom(message),
          "⚠️ Invalid Post Gate Command",
          `Use \`${commandName()} off\` with no extra arguments.`,
          "#E74C3C"
        );
        return { outcome: "invalid_command" };
      }
      return requestChange(message, "off", null);
    }
    if (action === "approve" || action === "reject") {
      const queueId = String(second ?? "").trim();
      if (!isSafeId(queueId) || extra.length) {
        await respond(
          channelIdFrom(message),
          "⚠️ Invalid Queue ID",
          `Use \`${commandName()} ${action} QUEUE_ID\`.`,
          "#E74C3C"
        );
        return { outcome: "invalid_queue_id" };
      }
      const result =
        action === "approve"
          ? await approve(queueId, message.authorId)
          : await reject(queueId, message.authorId);
      const descriptions = {
        approved:
          "The author was cleared and their automod strike reset. The content was not reposted — they can post it again themselves.",
        rejected:
          "The held post was discarded and the author's automod strike stage was increased.",
        missing:
          "That queue entry does not exist or has already been cleaned up.",
        pending: "That queue entry is already pending.",
        expired: "That queue entry's 7-day review window already expired.",
        unauthorized:
          "Fresh permission verification did not confirm Manage Messages.",
      };
      await respond(
        channelIdFrom(message),
        result.outcome === "approved"
          ? "✅ Post Approved"
          : result.outcome === "rejected"
            ? "❌ Post Rejected"
            : "🛑 Review Result",
        descriptions[result.outcome] ?? `Queue status: ${result.outcome}.`,
        result.outcome === "approved"
          ? "#2ECC71"
          : result.outcome === "rejected"
            ? "#E67E22"
            : "#E74C3C"
      );
      return result;
    }
    if (second || extra.length) {
      await respond(
        channelIdFrom(message),
        "⚠️ Invalid Post Gate Command",
        `Use \`${commandName()} status\`, \`${commandName()} here\`, \`${commandName()} #channel\`, \`${commandName()} off\`, \`${commandName()} confirm CODE\`, \`${commandName()} cancel\`, \`${commandName()} approve QUEUE_ID\`, or \`${commandName()} reject QUEUE_ID\`.`,
        "#E74C3C"
      );
      return { outcome: "invalid_command" };
    }
    return requestChange(message, "set", first);
  }

  // ── Expiry + queue maintenance ───────────────────────────────

  async function expireOverdue() {
    const current = now();
    for (const record of store.getExpiredPendingPosts(current)) {
      const reviewDeleted = await deleteReviewCard(record);
      if (!reviewDeleted)
        logger.warn?.("post-gate: review card cleanup failed");
      store.updateHeldPost(record.queueId, {
        status: "expired",
        reviewedAt: current,
      });
      await sendAccountability(
        record.serverId,
        "⌛ Held Post Expired",
        [
          `**Queue ID:** \`${record.queueId}\``,
          `**Author:** ${actorLabel(record.userId)}`,
          "The 7-day review window elapsed with no moderator decision; the content was discarded.",
        ],
        "#E67E22"
      );
    }
  }

  async function maintainQueue() {
    try {
      await expireOverdue();
      store.prunePostGateQueue(now());
    } catch (error) {
      logFailure("queue maintenance failed", error);
    }
  }

  function startQueuePrune() {
    if (pruneStarted) return;
    pruneStarted = true;
    void maintainQueue();
    const interval = scheduleInterval(
      () => void maintainQueue(),
      QUEUE_PRUNE_INTERVAL_MS
    );
    interval?.unref?.();
    const permissionInterval = scheduleInterval(
      () => void reconcilePermissionLocks(),
      PERMISSION_RECONCILE_INTERVAL_MS
    );
    permissionInterval?.unref?.();
  }

  async function shouldExcludeMessage(message) {
    const messageId = message?.id ?? message?._id;
    const serverId = serverIdFrom(message);
    const config = isSafeId(serverId)
      ? store.getPostGateConfig(serverId)
      : { mode: "off", level: 0 };
    if (
      config.mode !== "hold" ||
      (config.level < 3 && !hasLinkOrAttachment(message))
    ) {
      return false;
    }
    await Promise.resolve();
    const decision = pendingDecisions.get(messageId);
    return decision ? decision : false;
  }

  async function shouldExcludeMessageDelete(messageId) {
    const decision = pendingDecisions.get(messageId);
    return decision ? decision : false;
  }

  return {
    handleCommand,
    handleLevelCommand,
    handleMessage,
    handleRawEvent,
    handleDirectMessage: gate.handleDirectMessage,
    resolveApprover: gate.resolveApprover,
    shouldExcludeMessage,
    shouldExcludeMessageDelete,
    startQueuePrune,
    maintainQueue,
    reconcilePermissionLock,
    reconcilePermissionLocks,
    getPending(serverId) {
      const pending = gate.getPending(serverId);
      return pending?.kind === CHALLENGE_KIND ? pending : null;
    },
  };
}
