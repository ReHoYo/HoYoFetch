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
// same approval gate used by AuditLog destination and privacy changes — since a
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
import { hasRecentIdentitySignal, nextStrikeLevel } from "./automod.js";
import { parseChannelArg } from "./auditlog.js";
import { buildReason, findTargetToken, tokenizeArgs } from "./command-args.js";
import { buildAuditEmbed, buildStatusEmbed } from "./embeds.js";
import { formatAccountLabel, usernameSnapshot } from "./identity-label.js";
import { matchContactSolicitation } from "./contact-solicitation.js";
import { countArchivedMessages } from "./message-archive.js";
import { resolveModerationPolicy } from "./moderation-policy.js";
import {
  hasPermission,
  PERMISSION_BITS,
  removePermission,
  toPermissionBits,
} from "./permission-bits.js";
import {
  BUILT_IN_PROHIBITED_TERMS,
  BUILT_IN_TERM_ALLOWLIST,
  compileProhibitedTerms,
  describeProhibitedTermList,
  matchProhibitedTerm,
} from "./prohibited-terms.js";
import { deriveAccountCreatedAt } from "./user-info.js";
import {
  clearAutomodStrike,
  clearPostGateApproved,
  createHeldPost,
  createUserHold,
  findHeldPostByReviewMessage,
  findUserHoldByCardMessage,
  getActiveUserHolds,
  getAutomodConfig,
  getAutomodStrike,
  getDueUserHoldReminders,
  getExpiredPendingPosts,
  getHeldPost,
  getAllPostGateConfigs,
  getPendingHeldPosts,
  getPostGateConfig,
  getProhibitedTermList,
  getUserHold,
  isChannelExcluded,
  isPostGateApproved,
  isUserHeld,
  prunePostGateQueue,
  prunePostGateUserHolds,
  releaseUserHold,
  reloadProhibitedTermList,
  setAutomodStrike,
  setPostGateApproved,
  setPostGateConfig,
  updateHeldPost,
  updateUserHold,
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
export const PROFILE_CONTACT_CACHE_TTL_MS = 10 * 60 * 1_000;
export const PROFILE_CONTACT_RETRY_MS = 60 * 1_000;
export const PROFILE_CONTACT_CACHE_MAX_ENTRIES = 5_000;
const QUEUE_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const MAX_LOCKDOWN_ACTORS = 5_000;
export const USER_HOLD_REMINDER_MS = 24 * 60 * 60 * 1_000;
const MIN_HOLD_REMINDER_MS = 60 * 60 * 1_000;
const MAX_HOLD_REMINDER_MS = 168 * 60 * 60 * 1_000;
const MAX_HOLD_REASON_LENGTH = 300;
// Stoat has no interactive components, so every moderator control in this file
// is a reaction the bot seeds on a card it posted, plus an equivalent command.
const APPROVE_EMOJI = "✅";
const REJECT_EMOJI = "❌";
const DENY_HOLD_EMOJI = "🔒";
const RELEASE_EMOJI = "🔓";
const CONTINUE_EMOJI = "⏳";
const REVIEW_EMOJI = new Set([
  APPROVE_EMOJI,
  REJECT_EMOJI,
  DENY_HOLD_EMOJI,
  RELEASE_EMOJI,
  CONTINUE_EMOJI,
]);
const TRIGGER_LABELS = Object.freeze({
  first_post: "link or attachment from a new or first-time poster",
  prohibited_term: "prohibited-term filter",
  prohibited_identity: "prohibited-term filter (username/nickname)",
  contact_solicitation: "DM or off-platform contact solicitation",
  user_hold: "author is currently in Post Gate",
});
// Surfaces the identity screener checks, in the fixed order matchIdentityTerm
// reports them, plus the label each renders as on a review or control card —
// never the matched text itself.
const IDENTITY_SURFACE_LABELS = Object.freeze({
  username: "username",
  display_name: "display name",
  nickname: "server nickname",
});
const IDENTITY_TRIGGER_SURFACES = new Set(Object.keys(IDENTITY_SURFACE_LABELS));
const LOCKDOWN_BAN_REASON =
  "Irminsul Level 4 lockdown: posted through the server permission lock while automatic bans were enabled";
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
  clearPostGateApproved,
  createHeldPost,
  createUserHold,
  findHeldPostByReviewMessage,
  findUserHoldByCardMessage,
  getActiveUserHolds,
  getAutomodConfig,
  getAutomodStrike,
  getDueUserHoldReminders,
  getExpiredPendingPosts,
  getHeldPost,
  getAllPostGateConfigs,
  getPendingHeldPosts,
  getPostGateConfig,
  getProhibitedTermList,
  getUserHold,
  isChannelExcluded,
  isPostGateApproved,
  isUserHeld,
  prunePostGateQueue,
  prunePostGateUserHolds,
  releaseUserHold,
  reloadProhibitedTermList,
  setAutomodStrike,
  setPostGateApproved,
  setPostGateConfig,
  updateHeldPost,
  updateUserHold,
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
    holdReminderMs = USER_HOLD_REMINDER_MS,
    profileCacheTtlMs = PROFILE_CONTACT_CACHE_TTL_MS,
    profileRetryMs = PROFILE_CONTACT_RETRY_MS,
    profileCacheMaxEntries = PROFILE_CONTACT_CACHE_MAX_ENTRIES,
    policyForServer = (serverId) =>
      resolveModerationPolicy(store.getPostGateConfig(serverId), now()),
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

  const reminderMs = Number.isFinite(holdReminderMs)
    ? Math.min(
        Math.max(holdReminderMs, MIN_HOLD_REMINDER_MS),
        MAX_HOLD_REMINDER_MS
      )
    : USER_HOLD_REMINDER_MS;
  const contactProfileTtlMs =
    Number.isFinite(profileCacheTtlMs) && profileCacheTtlMs >= 0
      ? profileCacheTtlMs
      : PROFILE_CONTACT_CACHE_TTL_MS;
  const contactProfileRetryMs =
    Number.isFinite(profileRetryMs) && profileRetryMs >= 0
      ? profileRetryMs
      : PROFILE_CONTACT_RETRY_MS;
  const contactProfileCacheLimit =
    Number.isInteger(profileCacheMaxEntries) && profileCacheMaxEntries > 0
      ? profileCacheMaxEntries
      : PROFILE_CONTACT_CACHE_MAX_ENTRIES;

  let pruneStarted = false;
  const pendingDecisions = new Map();
  const pendingLevelPrompts = new Map();
  const lockdownActorState = new Map();
  const degradedNotices = new Map();
  const permissionReconcileLocks = new Set();
  const permissionEventTimers = new Map();
  // Serialise decisions per held post and per held user, so two moderators
  // acting in the same instant produce one outcome rather than two.
  const reviewLocks = new Map();
  const userHoldLocks = new Map();
  const contactProfileCache = new Map();
  const contactProfileLookups = new Map();
  const contactProfileRetryAfter = new Map();
  let compiledTerms = null;

  /**
   * Run `operation` after any operation already queued for `key`, and clean the
   * queue up once it drains. The previous tail is awaited with the same handler
   * for both settle paths, so one failure cannot wedge the key forever.
   */
  function withLock(locks, key, operation) {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = () => operation();
    const result = previous.then(run, run);
    const cleaned = result.then(
      () => {
        if (locks.get(key) === cleaned) locks.delete(key);
      },
      () => {
        if (locks.get(key) === cleaned) locks.delete(key);
      }
    );
    locks.set(key, cleaned);
    return result;
  }

  /**
   * The operator's data/prohibited_terms.json *extends* the built-in seed list;
   * it never replaces it, so an operator allowlist entry is the only way to
   * soften a built-in rule. Deliberately no file watcher: data/ is edited over
   * SSH and reloadProhibitedTermList costs one stat() unless the file changed.
   */
  function ensureCompiledTerms(force = false) {
    const list = store.reloadProhibitedTermList(force ? { force: true } : {});
    if (!compiledTerms || list.changed) {
      compiledTerms = compileProhibitedTerms({
        terms: [...BUILT_IN_PROHIBITED_TERMS, ...(list.terms ?? [])],
        allowlist: [...BUILT_IN_TERM_ALLOWLIST, ...(list.allowlist ?? [])],
      });
      compiledTerms.list = list;
    }
    return compiledTerms;
  }

  /**
   * Screen an account's identity fields — username, display name, and server
   * nickname — against the same compiled prohibited-term list message
   * content is screened against, so a slur used as an identity is caught
   * exactly as a slur posted in a message would be. Checked in a fixed order
   * (matching IDENTITY_SURFACE_LABELS) so which surface gets reported is
   * deterministic. Unlike the contact-solicitation bio check, this is
   * synchronous and I/O-free — no API call, no cache — so it is cheap enough
   * to run on every message and every join or nickname change.
   */
  function matchIdentityTerm({ username, displayName, nickname } = {}) {
    const compiled = ensureCompiledTerms();
    const fields = { username, display_name: displayName, nickname };
    for (const surface of Object.keys(IDENTITY_SURFACE_LABELS)) {
      const value = fields[surface];
      if (!value) continue;
      const match = matchProhibitedTerm(value, compiled);
      if (match) return { ...match, surface };
    }
    return null;
  }

  function commandName() {
    return `${prefix}Post-Gate`;
  }

  function levelCommandName() {
    return `${prefix}Level`;
  }

  function actorLabel(userId) {
    return isSafeId(userId)
      ? formatAccountLabel(client, userId)
      : "*(author id not recorded)*";
  }

  // Same as actorLabel, but omits the username. Used whenever an account's
  // own name is the thing that triggered the record: a review or control
  // card that flags a slur used as a username, display name, or nickname
  // must not repeat it, the same discipline the prohibited-term message
  // filter already applies by naming only a rule id.
  function redactedActorLabel(userId) {
    return isSafeId(userId)
      ? formatAccountLabel(client, userId, { redacted: true })
      : "*(author id not recorded)*";
  }

  /** actorLabel for a held-post queue record, redacted for an identity trigger. */
  function queueActorLabel(record) {
    return record?.trigger === "prohibited_identity"
      ? redactedActorLabel(record.userId)
      : formatAccountLabel(client, record?.userId, {
          username: record?.usernameSnapshot,
        });
  }

  /** actorLabel for a user-hold record, redacted for an identity-sourced hold. */
  function holdActorLabel(record) {
    return IDENTITY_TRIGGER_SURFACES.has(record?.triggerSurface)
      ? redactedActorLabel(record.userId)
      : formatAccountLabel(client, record?.userId, {
          username: record?.usernameSnapshot,
        });
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
    const protection = store.getAutomodConfig?.(serverId) ?? {
      mode: "off",
      logChannelId: null,
      quorum: 2,
    };
    const policy = policyForServer(serverId);
    const pending = gate.getPending(serverId);
    const gatePending = pending?.kind === CHALLENGE_KIND ? pending : null;
    const heldCount = store.getPendingHeldPosts(serverId).length;
    const terms = ensureCompiledTerms();
    const lines = [
      `**Mode:** ${config.mode}`,
      `**Configured level:** ${config.level || "off"}`,
      `**Effective level:** ${config.mode === "hold" ? policy.effectiveLevel : "off"}`,
      `**Shared Raid Mode:** ${policy.raidActive ? `active until ${new Date(policy.raidModeExpiresAt).toISOString()}` : "inactive"}`,
      `**Default Send Messages lock:** ${permissionLockLabel(config)}`,
      `**Review channel:** ${
        config.reviewChannelId
          ? channelLabel(config.reviewChannelId)
          : "not configured"
      }`,
      `**Protection:** ${protection.mode}${protection.logChannelId ? ` in ${channelLabel(protection.logChannelId)}` : ""} · ban quorum ${protection.quorum}`,
      `**Currently held for review:** ${heldCount}`,
      `**Users in Post Gate:** ${store.getActiveUserHolds(serverId).length}`,
      `**Prohibited terms:** ${describeProhibitedTermList(terms, terms.list ?? {})} — also screened against usernames, display names, and server nicknames on join, nickname change, and every message.`,
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
    return {
      outcome: "status",
      config,
      protection,
      policy,
      pending: gatePending,
    };
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
      const lockedPermissions = removePermission(
        currentPermissions,
        PERMISSION_BITS.SendMessage
      );
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
    const effectivePolicy = policyForServer(serverId);
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
          : level === 2
            ? "Links and media from accounts under 14 days, members under 3 days, or first-time posters will be held for moderator review. Ordinary text continues to flow."
            : "Links and media from accounts under 7 days, members under 24 hours, or first-time posters will be held for moderator review.";
    const fallbackWarning =
      level >= 3 && !lockdownPreflight?.deletionFallbackAvailable
        ? "Irminsul could not verify Manage Messages in the protected review channel. The permission lock is active, but deletion of any slipped messages is best effort until that permission is granted."
        : null;
    const automaticFloorNote =
      effectivePolicy.effectiveLevel !== current.level
        ? `Shared Raid Mode keeps the effective policy at Level ${effectivePolicy.effectiveLevel} until ${new Date(effectivePolicy.raidModeExpiresAt).toISOString()}.`
        : null;

    await sendAccountability(
      serverId,
      title,
      [
        `**Changed by:** ${actorLabel(actorId)}`,
        `**Previous level:** ${previous.level || "off"}`,
        `**Configured level:** ${current.level}`,
        `**Effective level:** ${effectivePolicy.effectiveLevel}`,
        description,
        ...(automaticFloorNote ? [automaticFloorNote] : []),
        ...(fallbackWarning ? [`⚠️ ${fallbackWarning}`] : []),
      ],
      level >= 3 ? "#E74C3C" : "#E67E22"
    );
    if (isSafeId(responseChannelId)) {
      await respond(
        responseChannelId,
        title,
        fallbackWarning
          ? `${description}${automaticFloorNote ? `\n\n${automaticFloorNote}` : ""}\n\n⚠️ ${fallbackWarning}`
          : `${description}${automaticFloorNote ? `\n\n${automaticFloorNote}` : ""}`,
        level >= 3 ? "#E74C3C" : "#E67E22"
      );
    }
    logger.log?.(
      `🛑  post-gate level=${level} actor=${auditAlias(actorId)} server=${auditAlias(serverId)}`
    );
    return {
      outcome: "level_changed",
      level,
      effectiveLevel: effectivePolicy.effectiveLevel,
    };
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
    const policy = policyForServer(serverId);
    const [rawAction = "status", rawConfirm, ...extra] = args;
    const action = String(rawAction).toLowerCase();
    if (!args.length || action === "status") {
      await respond(
        responseChannelId,
        "🛡️ Server Moderation Level",
        [
          `**Configured level:** ${config.level || "off"}`,
          `**Effective level:** ${config.mode === "hold" ? policy.effectiveLevel : "off"}`,
          `**Shared Raid Mode:** ${policy.raidActive ? `active until ${new Date(policy.raidModeExpiresAt).toISOString()}` : "inactive"}`,
          `**Post Gate:** ${config.mode}`,
          `**Review channel:** ${config.reviewChannelId ? channelLabel(config.reviewChannelId) : "not configured"}`,
          `**Default Send Messages lock:** ${permissionLockLabel(config)}`,
          "Level 1 uses 7-day account/24-hour membership checks; Level 2 widens them to 14 days/3 days without holding ordinary text. Level 3 locks default-role sending and Level 4 also automatically bans slipped-message authors.",
        ].join("\n"),
        config.level >= 3 ? "#E74C3C" : "#3498DB"
      );
      return { outcome: "status", config, policy };
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
      const automaticFloor = policy.raidActive && level === 1;
      await respond(
        responseChannelId,
        "ℹ️ No Change Needed",
        automaticFloor
          ? `Configured Level 1 is already set. Shared Raid Mode keeps the effective policy at Level 2 until ${new Date(policy.raidModeExpiresAt).toISOString()}.`
          : `Moderation Level ${level} is already enabled.`,
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
    // A control card left behind in the old review channel is a control nobody
    // sees. Hold records themselves are untouched by a config change — turning
    // the gate off leaves them inert, and re-enabling it honours them again.
    if (
      action !== "off" &&
      previousConfig.reviewChannelId !== updatedConfig.reviewChannelId
    ) {
      await repostUserHoldCards(challenge.serverId);
    }

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
        `**Approved by:** ${formatAccountLabel(client, approvedBy, { username: ENKA_APPROVER_TAG.replace(/^@/u, "") })}`,
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

  function touchContactProfileCache(userId, entry) {
    contactProfileCache.delete(userId);
    contactProfileCache.set(userId, entry);
    while (contactProfileCache.size > contactProfileCacheLimit) {
      contactProfileCache.delete(contactProfileCache.keys().next().value);
    }
  }

  function recentContactProfile(userId) {
    const entry = contactProfileCache.get(userId);
    if (!entry || now() - entry.checkedAt >= contactProfileTtlMs) return null;
    touchContactProfileCache(userId, entry);
    return entry;
  }

  async function fetchContactProfile(userId) {
    const cached = recentContactProfile(userId);
    if (cached) return cached;
    if ((contactProfileRetryAfter.get(userId) ?? 0) > now()) return null;

    const inFlight = contactProfileLookups.get(userId);
    if (inFlight) return inFlight;

    const lookup = (async () => {
      let response;
      try {
        response = await request(
          "GET",
          `/users/${encodeURIComponent(userId)}/profile`
        );
      } catch (error) {
        logger.warn?.(
          `post-gate: profile contact check failed actor=${auditAlias(userId)} error=${safeErrorSummary(error)}`
        );
      }

      if (response?.ok && response.data && typeof response.data === "object") {
        const entry = {
          bio:
            typeof response.data.content === "string"
              ? response.data.content
              : "",
          checkedAt: now(),
        };
        contactProfileRetryAfter.delete(userId);
        touchContactProfileCache(userId, entry);
        return entry;
      }
      // Stoat returns 404 when an account has no profile document. That is a
      // successful, cacheable "no bio" result rather than an outage.
      if (response?.status === 404) {
        const entry = { bio: "", checkedAt: now() };
        contactProfileRetryAfter.delete(userId);
        touchContactProfileCache(userId, entry);
        return entry;
      }

      contactProfileRetryAfter.set(userId, now() + contactProfileRetryMs);
      if (response) {
        logger.warn?.(
          `post-gate: profile contact check unavailable actor=${auditAlias(userId)} status=${response.status || "unknown"}`
        );
      }
      return null;
    })();
    contactProfileLookups.set(userId, lookup);
    try {
      return await lookup;
    } finally {
      if (contactProfileLookups.get(userId) === lookup) {
        contactProfileLookups.delete(userId);
      }
    }
  }

  async function matchContactProfile(userId) {
    const profile = await fetchContactProfile(userId);
    return profile ? matchContactSolicitation(profile.bio) : null;
  }

  function canInspectProfile(config, { channelId }) {
    return (
      config.level < 3 &&
      channelId !== config.reviewChannelId &&
      !store.isChannelExcluded(channelId)
    );
  }

  /**
   * Decide *why* a message would be held, or null for "leave it alone".
   * Synchronous by contract and free of archive reads, so handleMessage can
   * call it before its first await and shouldExcludeMessage can share it —
   * the two must never disagree about whether a message is being held.
   *
   * Order matters:
   *  - a full-user hold wins first: it is a plain lookup, and it is the one
   *    trigger that must ignore link, attachment, and tenure signals entirely;
   *  - recent-identity contact solicitation comes next so its automatic hold
   *    records the stable contact rule rather than a less-specific trigger;
   *  - a prohibited term follows, ahead of the first-post gate, because a
   *    slur has to be reviewable no matter how long the author has been here,
   *    so it deliberately never consults isFirstPostCandidate;
   *  - a prohibited term used as the author's username, display name, or
   *    server nickname comes right after, for the same reason — this is a
   *    safety net for a member who joined or renamed before a restart picked
   *    up the current term list, since the join/nickname-change listeners
   *    below normally catch it first and place a full hold before any
   *    message is ever sent;
   *  - links and attachments stay last, unchanged.
   *
   * `approved` marks an author who was previously released from a full hold
   * (/Post-Gate release, or 🔓). It skips the three "unknown/new account"
   * triggers — contact solicitation, the prohibited-term identity match, and
   * first-post link/media — but never the content-based prohibited-term
   * match or lockdown: approval isn't a blanket moderation bypass.
   */
  function classifyTrigger(
    message,
    config,
    { serverId, channelId, authorId, contactEligible, policy, approved }
  ) {
    if (policy.effectiveLevel >= 3) return { trigger: "lockdown" };
    if (channelId === config.reviewChannelId) return null;
    if (store.isChannelExcluded(channelId)) return null;
    if (store.isUserHeld(serverId, authorId)) return { trigger: "user_hold" };
    if (contactEligible && !approved) {
      const contact = matchContactSolicitation(message?.content);
      if (contact) {
        return {
          trigger: "contact_solicitation",
          match: contact,
          triggerSurface: "message",
        };
      }
    }
    const match = matchProhibitedTerm(message?.content, ensureCompiledTerms());
    if (match) return { trigger: "prohibited_term", match };
    if (!approved) {
      const identityMatch = matchIdentityTerm({
        username: message?.author?.username,
        displayName: message?.author?.displayName,
        nickname: message?.member?.nickname,
      });
      if (identityMatch) {
        return {
          trigger: "prohibited_identity",
          match: identityMatch,
          triggerSurface: identityMatch.surface,
        };
      }
    }
    if (!approved && hasLinkOrAttachment(message)) {
      return { trigger: "first_post" };
    }
    return null;
  }

  /**
   * Called synchronously (before any await in handleMessage) so the archive
   * snapshot it reads predates any interleaving from other messageCreate
   * listeners — in particular auditlog.js's own archive write for this same
   * message, which only happens after an await of its own.
   */
  function isRecentIdentityCandidate(authorId, message, current = now()) {
    const accountCreatedAt =
      message.author?.createdAt ?? deriveAccountCreatedAt(authorId);
    const joinedAt = message.member?.joinedAt ?? null;
    return hasRecentIdentitySignal(
      { accountCreatedAt, joinedAt },
      { now: current }
    );
  }

  function isFirstPostCandidate(serverId, authorId, message, policy) {
    const current = now();
    const accountCreatedAt =
      message.author?.createdAt ?? deriveAccountCreatedAt(authorId);
    const joinedAt = message.member?.joinedAt ?? null;
    const hasRecentIdentity = hasRecentIdentitySignal(
      { accountCreatedAt, joinedAt },
      {
        now: current,
        recentAccountMs: policy.recentAccountMs,
        recentMemberMs: policy.recentMemberMs,
      }
    );
    const isFirstMessage = countArchivedMessages({ serverId, authorId }) === 0;
    return hasRecentIdentity || isFirstMessage;
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
      `**Author:** ${queueActorLabel(record)}`,
      `**Channel:** ${channelLabel(record.channelId)}`,
      `**Reason:** ${TRIGGER_LABELS[record.trigger] ?? TRIGGER_LABELS.first_post}`,
    ];
    // The rule id, never the matched text: a review card is posted to a
    // channel, and repeating the term there would republish the very thing the
    // hold removed.
    if (record.ruleId) lines.push(`**Matched rule:** \`${record.ruleId}\``);
    if (
      record.trigger === "contact_solicitation" &&
      (record.triggerSurface === "message" || record.triggerSurface === "bio")
    ) {
      lines.push(
        `**Signal source:** ${record.triggerSurface === "bio" ? "profile bio (content withheld)" : "message"}`
      );
    } else if (
      record.trigger === "prohibited_identity" &&
      IDENTITY_TRIGGER_SURFACES.has(record.triggerSurface)
    ) {
      lines.push(
        `**Signal source:** ${IDENTITY_SURFACE_LABELS[record.triggerSurface]} (name withheld)`
      );
    }
    lines.push(
      `**Content:** ${record.content ? record.content.slice(0, 1000) : "*(no text — attachment/link only)*"}`
    );
    if (record.attachments.length) {
      lines.push(
        "",
        "**Attachments:**",
        ...record.attachments.map(describeHeldAttachment)
      );
    }
    lines.push(
      "",
      `React ${APPROVE_EMOJI} to clear the author and reset their protection strike, ${REJECT_EMOJI} to discard and strike, or ${DENY_HOLD_EMOJI} to discard, strike, and hold every later message from this author for review.`,
      `Or use \`${commandName()} approve ${record.queueId}\`, \`${commandName()} reject ${record.queueId}\`, or \`${commandName()} deny-hold ${record.queueId}\`.`,
      "Approving does not repost the content — the author may post it again themselves.",
      `This request expires in 7 days if left unreviewed.`
    );
    return buildAuditEmbed(
      "🛑 Held First Post — Review Needed",
      lines,
      "#E67E22"
    );
  }

  async function seedReviewReactions(
    channelId,
    messageId,
    emojis = [APPROVE_EMOJI, REJECT_EMOJI]
  ) {
    for (const emoji of emojis) {
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
      usernameSnapshot: held.usernameSnapshot,
      messageId,
      content: held.content,
      attachments: prepared.descriptors,
      trigger: held.trigger ?? "first_post",
      ruleId: held.ruleId ?? null,
      triggerSurface: held.triggerSurface ?? null,
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
      await seedReviewReactions(config.reviewChannelId, posted._id, [
        APPROVE_EMOJI,
        REJECT_EMOJI,
        DENY_HOLD_EMOJI,
      ]);
    } else {
      store.updateHeldPost(record.queueId, { attachments: finalAttachments });
      logger.warn?.(
        `post-gate: could not post review card for queue=${auditAlias(record.queueId)}`
      );
    }
    logger.log?.(
      `🛑  post-gate held queue=${auditAlias(record.queueId)} actor=${auditAlias(held.authorId)} server=${auditAlias(serverId)} trigger=${held.trigger ?? "first_post"} rule=${held.ruleId ?? "-"}`
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
    const policy = policyForServer(serverId);
    const contactEligible = isRecentIdentityCandidate(authorId, message);
    // A previously released author is exempt from the "unknown/new account"
    // triggers going forward — see classifyTrigger's docblock for exactly
    // what that does and does not cover.
    const approved = store.isPostGateApproved(serverId, authorId);
    let classified = classifyTrigger(message, config, {
      serverId,
      channelId,
      authorId,
      contactEligible,
      policy,
      approved,
    });
    // The first-post signal is only meaningful for a message actually eligible
    // for a hold on that trigger, so this stays inside the gate rather than
    // running (and racing the archive) on every message — and it still runs
    // synchronously, before the first await below.
    if (
      classified?.trigger === "first_post" &&
      !isFirstPostCandidate(serverId, authorId, message, policy)
    ) {
      classified = null;
    }

    if (
      !classified &&
      !(
        contactEligible &&
        !approved &&
        canInspectProfile(config, { channelId })
      )
    ) {
      return;
    }

    // revolt.js Message fields are live getters into the client's message
    // collection. holdMessage deletes the message before it needs these
    // values, and our own DELETE triggers a MessageDelete gateway event that
    // clears that collection entry — so anything read off `message` after
    // that point can come back undefined. Snapshot now, before any await.
    const held = {
      id: messageId,
      authorId,
      usernameSnapshot:
        classified?.trigger === "prohibited_identity"
          ? null
          : usernameSnapshot(client, authorId, message?.author?.username),
      content: message.content ?? "",
      attachments: message.attachments ?? [],
      trigger: classified?.trigger ?? null,
      ruleId: classified?.match?.ruleId ?? null,
      triggerSurface: classified?.triggerSurface ?? null,
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
      if (
        contactEligible &&
        !approved &&
        canInspectProfile(config, { channelId }) &&
        classified?.trigger !== "contact_solicitation" &&
        classified?.trigger !== "user_hold"
      ) {
        const profileMatch = await matchContactProfile(authorId);
        if (profileMatch) {
          classified = {
            trigger: "contact_solicitation",
            match: profileMatch,
            triggerSurface: "bio",
          };
          held.trigger = classified.trigger;
          held.ruleId = profileMatch.ruleId;
          held.triggerSurface = "bio";
        }
      }
      if (!classified) {
        resolveDecision(false);
        return;
      }

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

      if (classified.trigger === "lockdown") {
        resolveDecision(true);
        await enforceLockdown(
          serverId,
          channelId,
          messageId,
          authorId,
          config.level
        );
      } else {
        if (
          classified.trigger === "contact_solicitation" ||
          classified.trigger === "prohibited_identity"
        ) {
          await holdUser(serverId, authorId, null, {
            holdSource: "automatic",
            usernameSnapshot: held.usernameSnapshot,
            triggerSurface: classified.triggerSurface,
            triggerRuleId: classified.match?.ruleId ?? null,
            originMessageId: messageId,
          });
        }
        await holdMessage(serverId, channelId, held, config, resolveDecision);
      }
    } catch (error) {
      logFailure("hold decision failed", error);
      resolveDecision(false);
    } finally {
      pendingDecisions.delete(messageId);
    }
  }

  // ── Identity screening (join / nickname change) ─────────────────

  /**
   * Shared preconditions and moderator exemption for the join and
   * nickname-change entry points below. Mirrors the checks handleMessage
   * applies before creating an automatic hold: Post Gate must be in hold
   * mode with a review channel configured, Levels 3–4 lockdown takes
   * precedence over the queue entirely, an already-held account is left
   * alone, and a verified moderator is always exempt — failing closed
   * whenever that verification itself is unavailable, exactly as
   * handleMessage does.
   */
  async function screenIdentity(serverId, userId, fields) {
    if (
      !isSafeId(serverId) ||
      !isSafeId(userId) ||
      userId === client.user?.id
    ) {
      return;
    }
    const config = store.getPostGateConfig(serverId);
    const policy = policyForServer(serverId);
    if (
      config.mode !== "hold" ||
      !isSafeId(config.reviewChannelId) ||
      policy.effectiveLevel >= 3
    ) {
      return;
    }
    if (store.isUserHeld(serverId, userId)) return;
    if (store.isPostGateApproved(serverId, userId)) return;

    const match = matchIdentityTerm(fields);
    if (!match) return;

    // SERVER_MODERATOR, not FETCH_MANAGER: there is no message channel here
    // to check the account's permission *in*, and the review channel often
    // grants Manage Messages broadly by default — checking FETCH_MANAGER
    // against it would exempt any ordinary member posting there, not just
    // moderators. The review channel id is still required to satisfy the
    // permission-refresh plumbing; SERVER_MODERATOR simply ignores it.
    const authorization = await authorizeServerActor(
      client,
      { serverId, channelId: config.reviewChannelId, authorId: userId },
      COMMAND_ACCESS.SERVER_MODERATOR,
      { logger }
    );
    if (
      authorization.isBot ||
      !authorization.identityVerified ||
      authorization.permissionSource !== "refreshed" ||
      authorization.allowed
    ) {
      return;
    }

    await holdUser(serverId, userId, null, {
      holdSource: "automatic",
      triggerSurface: match.surface,
      triggerRuleId: match.ruleId,
    });
  }

  /**
   * A raid or harassment account can carry its slur in the username or
   * display name from the moment it joins, before it has ever posted a
   * message for classifyTrigger to inspect. Screening on join closes that
   * window instead of waiting for a first message that may never come.
   */
  async function handleMemberJoin(member) {
    if (member?.user?.bot) return;
    await screenIdentity(member?.id?.server, member?.id?.user, {
      username: member?.user?.username,
      displayName: member?.user?.displayName,
      nickname: member?.nickname,
    });
  }

  /**
   * A server nickname can be changed to a slur at any time after joining,
   * independent of posting a message, so it gets its own listener rather
   * than waiting on the next message. Username and display-name changes are
   * still caught the next time the account posts, via classifyTrigger.
   */
  async function handleMemberUpdate(member, previousMember) {
    if (member?.user?.bot) return;
    if (member?.nickname === previousMember?.nickname) return;
    await screenIdentity(member?.id?.server, member?.id?.user, {
      nickname: member?.nickname,
    });
  }

  function memberIdsFromDeparture(event) {
    const asId = (value) => (typeof value === "string" && value ? value : null);
    return {
      serverId: asId(event?.id?.server ?? event?.server ?? event?.id),
      userId: asId(event?.user ?? event?.user_id ?? event?.id?.user),
    };
  }

  function departureReasonLabel(reason) {
    if (reason === "Leave") return "left the server";
    if (reason === "Kick") return "was kicked from the server";
    if (reason === "Ban") return "was banned from the server";
    return "left or was removed from the server";
  }

  /**
   * A full-user hold is meaningful only while the account is a member. Both
   * the hydrated and raw gateway paths call this function; the per-user lock
   * and active-state re-check make the duplicate delivery a harmless no-op.
   */
  async function handleMemberLeave(memberOrEvent) {
    const { serverId, userId } = memberIdsFromDeparture(memberOrEvent);
    if (!isSafeId(serverId) || !isSafeId(userId)) {
      return { outcome: "invalid_departure" };
    }
    return withLock(userHoldLocks, `${serverId}:${userId}`, async () => {
      const existing = store.getUserHold(serverId, userId);
      if (!existing?.active) return { outcome: "not_held" };

      const releasedAt = now();
      const { released, record } = store.releaseUserHold(serverId, userId, {
        releasedAt,
        reason: "member_departure",
      });
      if (!released) return { outcome: "not_held" };

      const cardDeletes = await Promise.allSettled([
        deleteCard(record.cardChannelId, record.cardMessageId),
        deleteCard(record.cardChannelId, record.lastReminderMessageId),
      ]);
      if (
        cardDeletes.some(
          (result) => result.status === "rejected" || result.value === false
        )
      ) {
        logger.warn?.(
          `post-gate: departed-user card cleanup incomplete actor=${auditAlias(userId)}`
        );
      }
      const pending = pendingHeldCountFor(serverId, userId);
      const departure = departureReasonLabel(memberOrEvent?.reason);
      await sendAccountability(
        serverId,
        "📤 Post Gate — Departed User Removed",
        [
          `${holdActorLabel(record)} was removed from Post Gate automatically because the account ${departure}.`,
          "",
          `**Held by:** ${holdSourceLabel(record)} since ${timestampLabel(record.heldAt)}`,
          `**Held for:** ${durationLabel(releasedAt - (record.heldAt ?? releasedAt))}`,
          `**Still queued:** ${pending} held message(s) remain pending individual review; the departure only stops the account-level hold and its reminders.`,
        ],
        "#E67E22"
      );
      logger.log?.(
        `🛑  post-gate departed-user-released server=${auditAlias(serverId)} actor=${auditAlias(userId)} reason=${memberOrEvent?.reason ?? "unknown"} pending=${pending}`
      );
      return { outcome: "released", pending, record };
    });
  }

  // ── Review ───────────────────────────────────────────────────

  async function notifyReviewOutcome(
    record,
    outcome,
    moderatorId,
    { strikeCleared = false, strikeSkipped = false, exempted = false } = {}
  ) {
    const title =
      outcome === "approved"
        ? "✅ Held Post Approved"
        : "❌ Held Post Rejected";
    const authorStillHeld =
      isSafeId(record.userId) &&
      store.isUserHeld(record.serverId, record.userId);
    const description =
      outcome === "approved"
        ? authorStillHeld
          ? `This queue item from ${queueActorLabel(record)} was approved${strikeCleared ? " and their protection strike was reset" : ""}, but the account remains in Post Gate until a moderator releases it. The content was **not** reposted to ${channelLabel(record.channelId)}.`
          : `${queueActorLabel(record)} was cleared${strikeCleared ? " and their protection strike was reset" : ""}. The content was **not** reposted to ${channelLabel(record.channelId)} — they can post it again themselves.${exempted ? " They are now exempt from future contact-solicitation, prohibited-identity, and first-post link/media screening, until a moderator holds them again." : ""}`
        : `The held content from ${queueActorLabel(record)} was discarded${strikeSkipped ? " (no protection strike was recorded — the original author's id was not captured)" : " and their protection strike stage was increased"}.`;
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

  async function authorizeReviewChannelActor(serverId, moderatorId) {
    // Manage Messages is checked in the review channel — where the
    // moderator is actually acting — not the (possibly inaccessible)
    // source channel the held content originally came from.
    const config = store.getPostGateConfig(serverId);
    const reviewer = await authorizeServerActor(
      client,
      {
        serverId,
        channelId: config.reviewChannelId,
        authorId: moderatorId,
      },
      COMMAND_ACCESS.MANAGE_MESSAGES,
      { logger }
    );
    return reviewer.allowed && reviewer.permissionSource === "refreshed";
  }

  async function authorizeReviewer(record, moderatorId) {
    return authorizeReviewChannelActor(record.serverId, moderatorId);
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

  /**
   * Every path that resolves a queue entry runs through here. The lock
   * serialises two moderators reacting in the same instant; the re-read after
   * the (asynchronous) permission check closes the window where both calls
   * read "pending" before either of them wrote.
   */
  function resolveHeldPost(queueId, moderatorId, apply) {
    return withLock(reviewLocks, queueId, async () => {
      const record = store.getHeldPost(queueId);
      if (!record) return { outcome: "missing" };
      if (record.status !== "pending") return { outcome: record.status };

      if (!(await authorizeReviewer(record, moderatorId))) {
        return { outcome: "unauthorized" };
      }

      const current = store.getHeldPost(queueId);
      if (!current) return { outcome: "missing" };
      if (current.status !== "pending") return { outcome: current.status };
      return apply(current);
    });
  }

  async function approve(queueId, moderatorId) {
    return resolveHeldPost(queueId, moderatorId, async (record) => {
      // Approval clears the author, not the content. Republishing held material
      // through the bot means a moderator's "this account is fine" also
      // relaunches whatever they posted — during a troll wave that turns the
      // review queue into a delivery mechanism. The author keeps the right to
      // post it again themselves; the archived copy stays on the review card as
      // the evidence record.
      const reviewDeleted = await deleteReviewCard(record);
      if (!reviewDeleted)
        logger.warn?.("post-gate: review card cleanup failed");
      // Legacy queue entries from before the authorId-snapshot fix may have no
      // userId recorded — never touch the strike store under a phantom key.
      const strikeCleared =
        isSafeId(record.userId) &&
        Boolean(store.clearAutomodStrike(record.serverId, record.userId));
      // Approving a queued post is the everyday "this member is fine" signal
      // — most held posts (a first link/media, a term match) never place a
      // full account hold, so /Post-Gate release has nothing to undo for
      // them. Approval grants the same standing exemption release does: the
      // author skips contact-solicitation, prohibited-identity, and
      // first-post link/media screening going forward, but the content-based
      // prohibited-term (slur) filter still applies regardless. A moderator
      // revokes it the same way — /Post-Gate hold or 🔒 Deny + Hold User.
      const approvedAt = now();
      const exempted =
        isSafeId(record.userId) &&
        Boolean(
          store.setPostGateApproved(record.serverId, record.userId, {
            approvedAt,
            approvedBy: moderatorId,
          })
        );
      store.updateHeldPost(queueId, {
        status: "approved",
        reviewedBy: moderatorId,
        reviewedAt: approvedAt,
      });
      await notifyReviewOutcome(record, "approved", moderatorId, {
        strikeCleared,
        exempted,
      });
      logger.log?.(
        `🛑  post-gate approved queue=${auditAlias(queueId)} moderator=${auditAlias(moderatorId)} strike_cleared=${strikeCleared} exempted=${exempted}`
      );
      return { outcome: "approved", strikeCleared, exempted };
    });
  }

  /**
   * Shared by ❌ Deny and 🔒 Deny + Hold User: both discard the content and
   * advance the strike stage. Only the follow-up differs.
   */
  async function applyRejection(record, moderatorId, { notify = true } = {}) {
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

    store.updateHeldPost(record.queueId, {
      status: "rejected",
      reviewedBy: moderatorId,
      reviewedAt: current,
    });
    if (notify) {
      await notifyReviewOutcome(record, "rejected", moderatorId, {
        strikeSkipped,
      });
      logger.log?.(
        `🛑  post-gate rejected queue=${auditAlias(record.queueId)} moderator=${auditAlias(moderatorId)} strike=${level ?? "skipped"}`
      );
    }
    return { outcome: "rejected", strikeLevel: level, strikeSkipped };
  }

  async function reject(queueId, moderatorId) {
    return resolveHeldPost(queueId, moderatorId, (record) =>
      applyRejection(record, moderatorId)
    );
  }

  // ── Full-user Post Gate ──────────────────────────────────────

  function pendingHeldCountFor(serverId, userId) {
    return store
      .getPendingHeldPosts(serverId)
      .filter((entry) => entry.userId === userId).length;
  }

  async function deleteCard(channelId, messageId) {
    if (!isSafeId(channelId) || !isSafeId(messageId)) return true;
    const operation = async () => {
      const response = await request(
        "DELETE",
        `/channels/${channelId}/messages/${messageId}`
      );
      return Boolean(response.ok);
    };
    return typeof runIntentionalDelete === "function"
      ? runIntentionalDelete(messageId, operation)
      : operation();
  }

  function timestampLabel(value) {
    return Number.isFinite(value)
      ? new Date(value).toUTCString()
      : "*(not recorded)*";
  }

  function durationLabel(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "an unknown time";
    const hours = Math.floor(ms / (60 * 60 * 1_000));
    if (hours < 1) return "under an hour";
    if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
    return `${Math.floor(hours / 24)} days`;
  }

  function holdSourceLabel(record) {
    return record.holdSource === "automatic"
      ? "Irminsul (automatic screening)"
      : formatAccountLabel(client, record.heldBy, {
          username: record.heldByUsernameSnapshot,
        });
  }

  // Never "content withheld" for message/bio and "name withheld" for an
  // identity surface by accident — one lookup keeps the two families in sync.
  const HOLD_SIGNAL_SOURCE_LABELS = Object.freeze({
    message: "message",
    bio: "profile bio (content withheld)",
    ...Object.fromEntries(
      Object.entries(IDENTITY_SURFACE_LABELS).map(([surface, label]) => [
        surface,
        `${label} (name withheld)`,
      ])
    ),
  });

  function describeHoldSignalSource(triggerSurface) {
    return HOLD_SIGNAL_SOURCE_LABELS[triggerSurface] ?? "unknown";
  }

  function buildUserHoldCardEmbed(record) {
    const lines = [
      `${holdActorLabel(record)} is currently in Post Gate.`,
      "All new messages from this user in this server are held for moderator approval.",
      "",
      `**Held by:** ${holdSourceLabel(record)}`,
      `**Held since:** ${timestampLabel(record.heldAt)}`,
    ];
    if (record.holdSource === "automatic") {
      lines.push(
        `**Signal source:** ${describeHoldSignalSource(record.triggerSurface)}`,
        `**Matched rule:** \`${record.triggerRuleId ?? "unknown"}\``
      );
    }
    if (record.originQueueId) {
      lines.push(`**Origin:** denied queue entry \`${record.originQueueId}\``);
    }
    if (record.holdReason) {
      lines.push(`**Reason:** ${record.holdReason}`);
    }
    lines.push(
      "",
      `React ${RELEASE_EMOJI} to release them, or use \`${commandName()} release <@${record.userId}>\`.`,
      "Releasing restores normal posting straight away. Messages already in the review queue stay queued and are reviewed individually.",
      "This hold never expires on a timer while the account remains a member. A moderator release or member departure ends it."
    );
    return buildAuditEmbed("🔒 Post Gate — User Held", lines, "#E67E22");
  }

  function buildUserHoldReminderEmbed(record, pending) {
    return buildAuditEmbed(
      "⏰ Post Gate — User Still Held",
      [
        `${holdActorLabel(record)} has been in Post Gate for ${durationLabel(now() - (record.heldAt ?? now()))}.`,
        "",
        `**Held by:** ${holdSourceLabel(record)}`,
        `**Held since:** ${timestampLabel(record.heldAt)}`,
        `**Still queued:** ${pending} held message(s) awaiting review`,
        "",
        `React ${RELEASE_EMOJI} to release them, or ${CONTINUE_EMOJI} to keep holding and be reminded again in ${durationLabel(reminderMs)}.`,
        "This is a reminder, not a deadline. Irminsul releases the hold automatically only if the member leaves or is removed.",
      ],
      "#E67E22"
    );
  }

  async function postUserHoldCard(record) {
    const config = store.getPostGateConfig(record.serverId);
    if (!isSafeId(config.reviewChannelId)) return null;
    const posted = await sendProtected(config.reviewChannelId, {
      embeds: [buildUserHoldCardEmbed(record)],
    });
    if (!isSafeId(posted?._id)) {
      logger.warn?.(
        `post-gate: could not post the Post Gate control card for actor=${auditAlias(record.userId)}`
      );
      return null;
    }
    store.updateUserHold(record.serverId, record.userId, {
      cardChannelId: config.reviewChannelId,
      cardMessageId: posted._id,
    });
    await seedReviewReactions(config.reviewChannelId, posted._id, [
      RELEASE_EMOJI,
    ]);
    return posted._id;
  }

  /**
   * Idempotent: an author already in Post Gate keeps the original record, and
   * the control card is reposted only when a previous attempt failed to leave
   * one behind. Repeatedly denying that author never stacks cards or rewrites
   * who first held them.
   */
  async function holdUser(serverId, userId, moderatorId, origin = {}) {
    return withLock(userHoldLocks, `${serverId}:${userId}`, async () => {
      // Any moderator-initiated hold — the new `/Post-Gate hold` command or
      // the existing 🔒 deny + hold user reaction — means "back to being
      // screened normally": it revokes a standing release exemption. The two
      // automatic call sites always pass holdSource: "automatic" and never
      // reach here for an exempt author anyway, since classifyTrigger and
      // screenIdentity already skip them upstream.
      if (origin.holdSource !== "automatic") {
        store.clearPostGateApproved(serverId, userId);
      }
      const existing = store.getUserHold(serverId, userId);
      if (existing?.active) {
        if (!existing.cardMessageId) {
          try {
            await postUserHoldCard(existing);
          } catch (error) {
            logFailure("user-hold card post failed", error);
          }
        }
        return { outcome: "already_held", record: existing };
      }

      const heldAt = now();
      const config = store.getPostGateConfig(serverId);
      const { created, record } = store.createUserHold({
        serverId,
        userId,
        heldAt,
        heldBy: moderatorId,
        usernameSnapshot: IDENTITY_TRIGGER_SURFACES.has(origin.triggerSurface)
          ? null
          : usernameSnapshot(client, userId, origin.usernameSnapshot),
        heldByUsernameSnapshot: usernameSnapshot(client, moderatorId),
        holdSource: origin.holdSource === "automatic" ? "automatic" : "manual",
        triggerSurface: origin.triggerSurface ?? null,
        triggerRuleId: origin.triggerRuleId ?? null,
        originQueueId: origin.originQueueId ?? null,
        originMessageId: origin.originMessageId ?? null,
        holdReason: origin.holdReason ?? null,
        cardChannelId: config.reviewChannelId,
        reminderAt: heldAt + reminderMs,
      });
      if (!created) return { outcome: "already_held", record };

      try {
        await postUserHoldCard(record);
      } catch (error) {
        logFailure("user-hold card post failed", error);
      }
      logger.log?.(
        `🛑  post-gate user-held server=${auditAlias(serverId)} actor=${auditAlias(userId)} source=${origin.holdSource === "automatic" ? "automatic" : "manual"} moderator=${auditAlias(moderatorId)} origin=${auditAlias(origin.originQueueId ?? "-")}`
      );
      return { outcome: "held", record };
    });
  }

  /**
   * Post Gate has two independent layers: the account-level full hold, and
   * per-message queuing (a first link/media post, a contact-solicitation or
   * identity match). Most accounts a moderator wants to "release" only ever
   * hit the second layer — a queued post never creates a full hold — so
   * release cannot be conditioned on a hold actually existing. Once
   * authorized, it always grants the standing Post Gate exemption from
   * future contact-solicitation, prohibited-identity, and first-post
   * link/media screening (never the content-based term filter), and also
   * releases the account-level hold when one happens to be active. A
   * moderator can withdraw the exemption at any time with /Post-Gate hold or
   * 🔒 Deny + Hold User, regardless of which action originally granted it.
   */
  async function releaseUser(
    serverId,
    userId,
    moderatorId,
    { reason = "manual" } = {}
  ) {
    return withLock(userHoldLocks, `${serverId}:${userId}`, async () => {
      if (!(await authorizeReviewChannelActor(serverId, moderatorId))) {
        return { outcome: "unauthorized" };
      }

      const releasedAt = now();
      store.setPostGateApproved(serverId, userId, {
        approvedAt: releasedAt,
        approvedBy: moderatorId,
      });

      const { released, record } = store.releaseUserHold(serverId, userId, {
        releasedBy: moderatorId,
        releasedAt,
        reason,
      });
      if (!released) {
        logger.log?.(
          `🛑  post-gate exempted-only server=${auditAlias(serverId)} actor=${auditAlias(userId)} moderator=${auditAlias(moderatorId)}`
        );
        await sendAccountability(
          serverId,
          "✅ Post Gate — Member Exempted",
          [
            `${actorLabel(userId)} was not in full Post Gate, so there was no hold to release.`,
            "",
            `**Marked exempt by:** ${actorLabel(moderatorId)}`,
            "They are now exempt from future contact-solicitation, prohibited-identity, and first-post link/media screening, until a moderator holds them again.",
          ],
          "#2ECC71"
        );
        return { outcome: "exempted" };
      }

      await deleteCard(record.cardChannelId, record.cardMessageId);
      await deleteCard(record.cardChannelId, record.lastReminderMessageId);

      // Releasing stops future holds only. Anything already queued keeps its
      // own review card, because a release is a judgement about the author and
      // not about content no moderator has looked at yet.
      const pending = pendingHeldCountFor(serverId, userId);
      await sendAccountability(
        serverId,
        "🔓 Post Gate — User Released",
        [
          `${holdActorLabel(record)} is no longer in Post Gate and can post normally again.`,
          "",
          `**Released by:** ${actorLabel(moderatorId)}`,
          `**Held by:** ${holdSourceLabel(record)} since ${timestampLabel(record.heldAt)}`,
          `**Held for:** ${durationLabel(releasedAt - (record.heldAt ?? releasedAt))}`,
          `**Still queued:** ${pending} held message(s) from this author remain pending individual review — releasing only stops future messages from being held.`,
        ],
        "#2ECC71"
      );
      logger.log?.(
        `🛑  post-gate user-released server=${auditAlias(serverId)} actor=${auditAlias(userId)} moderator=${auditAlias(moderatorId)} reason=${reason} pending=${pending} held_for_ms=${releasedAt - (record.heldAt ?? releasedAt)}`
      );
      return { outcome: "released", pending, record };
    });
  }

  async function continueHold(serverId, userId, moderatorId) {
    return withLock(userHoldLocks, `${serverId}:${userId}`, async () => {
      const existing = store.getUserHold(serverId, userId);
      if (!existing?.active) return { outcome: "not_held" };
      if (!(await authorizeReviewChannelActor(serverId, moderatorId))) {
        return { outcome: "unauthorized" };
      }

      const nextReminderAt = now() + reminderMs;
      await deleteCard(existing.cardChannelId, existing.lastReminderMessageId);
      store.updateUserHold(serverId, userId, {
        reminderAt: nextReminderAt,
        lastReminderMessageId: null,
      });
      await sendAccountability(
        serverId,
        "⏳ Post Gate — Hold Continued",
        [
          `${actorLabel(moderatorId)} chose to keep ${holdActorLabel(existing)} in Post Gate.`,
          `**Next reminder:** ${timestampLabel(nextReminderAt)}`,
        ],
        "#E67E22"
      );
      logger.log?.(
        `🛑  post-gate hold-continued server=${auditAlias(serverId)} actor=${auditAlias(userId)} moderator=${auditAlias(moderatorId)}`
      );
      return { outcome: "continued", reminderAt: nextReminderAt };
    });
  }

  /**
   * Forgotten-hold protection. A hold is never released automatically; when one
   * has stood for the configured period, moderators get a card offering
   * Release / Continue Holding and the clock is re-armed. Driven by the
   * existing hourly sweep, so a reminder lands within an hour of coming due.
   */
  async function remindHeldUsers() {
    for (const due of store.getDueUserHoldReminders(now())) {
      await withLock(
        userHoldLocks,
        `${due.serverId}:${due.userId}`,
        async () => {
          const record = store.getUserHold(due.serverId, due.userId);
          if (!record?.active) return;
          if (
            !Number.isFinite(record.reminderAt) ||
            record.reminderAt > now()
          ) {
            return;
          }
          const config = store.getPostGateConfig(record.serverId);
          if (config.mode !== "hold" || !isSafeId(config.reviewChannelId)) {
            return;
          }

          // Only one reminder is ever outstanding per hold.
          await deleteCard(record.cardChannelId, record.lastReminderMessageId);
          const pending = pendingHeldCountFor(record.serverId, record.userId);
          const posted = await sendProtected(config.reviewChannelId, {
            embeds: [buildUserHoldReminderEmbed(record, pending)],
          });
          const reminderMessageId = isSafeId(posted?._id) ? posted._id : null;
          store.updateUserHold(record.serverId, record.userId, {
            reminderAt: now() + reminderMs,
            reminderCount: (record.reminderCount ?? 0) + 1,
            lastReminderMessageId: reminderMessageId,
          });
          if (reminderMessageId) {
            await seedReviewReactions(
              config.reviewChannelId,
              reminderMessageId,
              [RELEASE_EMOJI, CONTINUE_EMOJI]
            );
          }
          logger.log?.(
            `🛑  post-gate hold-reminder server=${auditAlias(record.serverId)} actor=${auditAlias(record.userId)} count=${(record.reminderCount ?? 0) + 1}`
          );
        }
      );
    }
  }

  /**
   * A control card stranded in the old review channel is a control nobody sees,
   * so every active hold gets a fresh card when the review channel moves.
   */
  async function repostUserHoldCards(serverId) {
    for (const record of store.getActiveUserHolds(serverId)) {
      await withLock(
        userHoldLocks,
        `${record.serverId}:${record.userId}`,
        async () => {
          await deleteCard(record.cardChannelId, record.cardMessageId);
          await deleteCard(record.cardChannelId, record.lastReminderMessageId);
          const moved = store.updateUserHold(record.serverId, record.userId, {
            cardMessageId: null,
            lastReminderMessageId: null,
          });
          if (moved?.active) await postUserHoldCard(moved);
        }
      );
    }
  }

  async function notifyDenyHold(record, moderatorId, rejection, hold) {
    const lines = [
      `**Queue ID:** \`${record.queueId}\``,
      `**Denied by:** ${actorLabel(moderatorId)}`,
      `The held content from ${queueActorLabel(record)} was discarded${
        rejection.strikeSkipped
          ? " (no protection strike was recorded — the original author's id was not captured)"
          : " and their protection strike stage was increased"
      }.`,
    ];
    if (hold.outcome === "held") {
      lines.push(
        "",
        `${queueActorLabel(record)} is now in Post Gate: every message they send is held for moderator approval until a moderator releases them.`,
        `**Hold began:** ${timestampLabel(hold.record?.heldAt)}`
      );
    } else if (hold.outcome === "already_held") {
      lines.push(
        "",
        `${queueActorLabel(record)} was already in Post Gate — the existing hold, placed by ${holdSourceLabel(hold.record ?? {})} on ${timestampLabel(hold.record?.heldAt)}, is unchanged.`
      );
    } else {
      lines.push(
        "",
        "No Post Gate hold was placed: this queue entry predates author-id capture, so there is no account to hold."
      );
    }
    await sendAccountability(
      record.serverId,
      "🔒 Held Post Denied — Author Placed in Post Gate",
      lines,
      "#E74C3C"
    );
  }

  async function denyHold(queueId, moderatorId) {
    return resolveHeldPost(queueId, moderatorId, async (record) => {
      const rejection = await applyRejection(record, moderatorId, {
        notify: false,
      });
      // The same legacy guard the strike uses: never create a hold keyed on a
      // phantom user id.
      const hold = isSafeId(record.userId)
        ? await holdUser(record.serverId, record.userId, moderatorId, {
            usernameSnapshot: record.usernameSnapshot,
            originQueueId: record.queueId,
            originMessageId: record.messageId,
          })
        : { outcome: "skipped_legacy" };
      await notifyDenyHold(record, moderatorId, rejection, hold);
      logger.log?.(
        `🛑  post-gate deny-hold queue=${auditAlias(queueId)} moderator=${auditAlias(moderatorId)} actor=${auditAlias(record.userId ?? "-")} strike=${rejection.strikeLevel ?? "skipped"} hold=${hold.outcome}`
      );
      return { ...rejection, userHold: hold.outcome };
    });
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
    if (event?.type === "ServerMemberLeave") {
      await handleMemberLeave(event);
      return;
    }
    if (event?.type === "ServerUpdate") {
      schedulePermissionReconcile(event.id);
      return;
    }
    if (
      event?.type !== "MessageReact" ||
      !isSafeId(event.id) ||
      !isSafeId(event.user_id) ||
      event.user_id === client.user?.id ||
      !REVIEW_EMOJI.has(event.emoji_id)
    ) {
      return;
    }
    if (await handleLevelReaction(event)) return;

    // Dispatch is keyed on the message id, and a review-channel message is
    // exactly one kind of card, so the three card types can never be confused.
    // A reaction a card does not offer is ignored rather than guessed at.
    const record = store.findHeldPostByReviewMessage(event.id);
    if (record) {
      let result;
      if (event.emoji_id === APPROVE_EMOJI) {
        result = await approve(record.queueId, event.user_id);
      } else if (event.emoji_id === REJECT_EMOJI) {
        result = await reject(record.queueId, event.user_id);
      } else if (event.emoji_id === DENY_HOLD_EMOJI) {
        result = await denyHold(record.queueId, event.user_id);
      } else {
        return;
      }
      logger.log?.(
        `🛑  post-gate reaction-review queue=${auditAlias(record.queueId)} actor=${auditAlias(event.user_id)} outcome=${result.outcome}`
      );
      return;
    }

    const card = store.findUserHoldByCardMessage(event.id);
    if (!card) return;
    if (event.emoji_id === RELEASE_EMOJI) {
      const result = await releaseUser(
        card.record.serverId,
        card.record.userId,
        event.user_id,
        { reason: "reaction" }
      );
      logger.log?.(
        `🛑  post-gate reaction-release actor=${auditAlias(card.record.userId)} moderator=${auditAlias(event.user_id)} outcome=${result.outcome}`
      );
      return;
    }
    // "Continue holding" is only offered on a reminder card.
    if (event.emoji_id === CONTINUE_EMOJI && card.cardKind === "reminder") {
      await continueHold(
        card.record.serverId,
        card.record.userId,
        event.user_id
      );
    }
  }

  // ── Command routing ──────────────────────────────────────────

  async function listHolds(message, serverId) {
    const holds = store.getActiveUserHolds(serverId);
    const lines = holds.length
      ? holds
          .slice(0, 10)
          .map(
            (record) =>
              `- ${holdActorLabel(record)} — held by ${holdSourceLabel(record)} since ${timestampLabel(record.heldAt)} (${pendingHeldCountFor(serverId, record.userId)} message(s) queued)`
          )
      : ["No members are currently in Post Gate."];
    if (holds.length > 10) {
      lines.push(`…and ${holds.length - 10} more.`);
    }
    await respond(
      channelIdFrom(message),
      "🔒 Members In Post Gate",
      lines.join("\n"),
      holds.length ? "#E67E22" : "#3498DB"
    );
    return { outcome: "holds", count: holds.length };
  }

  async function describeTerms(message) {
    const compiled = ensureCompiledTerms(true);
    const list = compiled.list ?? store.getProhibitedTermList();
    const lines = [describeProhibitedTermList(compiled, list)];
    if (list.status === "malformed") {
      lines.push(
        "",
        `The operator list could not be parsed (\`${safeErrorSummary(list.error)}\`) and was ignored. The built-in list is still active.`
      );
    } else if (list.status === "missing") {
      lines.push(
        "",
        "No `prohibited_terms.json` is present in the data directory, so only the built-in list is active."
      );
    } else if (list.skipped) {
      lines.push("", `${list.skipped} malformed entr(y/ies) were skipped.`);
    }
    lines.push(
      "",
      "A match holds the message for review. It never bans, times out, or strikes anyone on its own."
    );
    await respond(
      channelIdFrom(message),
      "🔤 Prohibited Terms",
      lines.join("\n"),
      list.status === "malformed" ? "#E74C3C" : "#3498DB"
    );
    return { outcome: "terms", status: list.status };
  }

  async function releaseCommand(message, serverId, args) {
    const target = findTargetToken(tokenizeArgs(args));
    if (!target) {
      await respond(
        channelIdFrom(message),
        "⚠️ Which Member?",
        `Use \`${commandName()} release @member\`.`,
        "#E74C3C"
      );
      return { outcome: "invalid_target" };
    }
    const result = await releaseUser(
      serverId,
      target.targetId,
      message.authorId,
      { reason: "command" }
    );
    const descriptions = {
      released: `${result.record ? holdActorLabel(result.record) : actorLabel(target.targetId)} was released and can post normally again. ${result.pending} held message(s) from them stay queued for individual review.`,
      exempted: `${actorLabel(target.targetId)} was not currently in full Post Gate, so there was no hold to release — but they've been marked exempt from future contact-solicitation, prohibited-identity, and first-post link/media screening, until a moderator holds them again.`,
      unauthorized:
        "Fresh permission verification did not confirm Manage Messages in the review channel.",
    };
    const positiveOutcome =
      result.outcome === "released" || result.outcome === "exempted";
    await respond(
      channelIdFrom(message),
      result.outcome === "released"
        ? "🔓 User Released"
        : result.outcome === "exempted"
          ? "✅ Member Exempted"
          : "🛑 Release Result",
      descriptions[result.outcome] ?? `Release status: ${result.outcome}.`,
      positiveOutcome ? "#2ECC71" : "#E74C3C"
    );
    return result;
  }

  /**
   * Manually place a member in full Post Gate. Mirrors releaseCommand's
   * shape: same target-mention parsing, same Manage Messages check in the
   * review channel. Unlike the automatic paths, holdUser performs no
   * authorization of its own, so this command checks it before calling in —
   * the same invariant every other holdUser caller already upholds.
   */
  async function holdCommand(message, serverId, args) {
    const tokens = tokenizeArgs(args);
    const target = findTargetToken(tokens);
    if (!target) {
      await respond(
        channelIdFrom(message),
        "⚠️ Which Member?",
        `Use \`${commandName()} hold @member <reason>\`.`,
        "#E74C3C"
      );
      return { outcome: "invalid_target" };
    }
    const reason = buildReason(tokens, new Set([target.index]));
    if (!reason) {
      await respond(
        channelIdFrom(message),
        "⚠️ Reason Required",
        `Use \`${commandName()} hold @member <reason>\`, for example \`${commandName()} hold @member repeated boundary-pushing after a warning\`.`,
        "#E74C3C"
      );
      return { outcome: "invalid_reason" };
    }
    if (reason.length > MAX_HOLD_REASON_LENGTH) {
      await respond(
        channelIdFrom(message),
        "⚠️ Reason Too Long",
        `The reason must be ${MAX_HOLD_REASON_LENGTH} characters or fewer.`,
        "#E74C3C"
      );
      return { outcome: "invalid_reason" };
    }
    if (!(await authorizeReviewChannelActor(serverId, message.authorId))) {
      await respond(
        channelIdFrom(message),
        "🛑 Hold Result",
        "Fresh permission verification did not confirm Manage Messages in the review channel.",
        "#E74C3C"
      );
      return { outcome: "unauthorized" };
    }
    const result = await holdUser(serverId, target.targetId, message.authorId, {
      holdSource: "manual",
      holdReason: reason,
    });
    const descriptions = {
      held: `${result.record ? holdActorLabel(result.record) : actorLabel(target.targetId)} was placed in Post Gate. Every message they send now is held for review until a moderator releases them. Any standing release exemption for this member was revoked.`,
      already_held: "That member is already in Post Gate.",
    };
    await respond(
      channelIdFrom(message),
      result.outcome === "held" ? "🔒 User Held" : "🛑 Hold Result",
      descriptions[result.outcome] ?? `Hold status: ${result.outcome}.`,
      result.outcome === "held" ? "#E67E22" : "#E74C3C"
    );
    return result;
  }

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
    if (action === "holds") return listHolds(message, serverId);
    if (action === "terms") return describeTerms(message);
    if (action === "release")
      return releaseCommand(message, serverId, [second, ...extra]);
    if (action === "hold")
      return holdCommand(message, serverId, [second, ...extra]);
    if (
      action === "approve" ||
      action === "reject" ||
      action === "deny-hold" ||
      action === "denyhold"
    ) {
      const denyHoldRequested = action.startsWith("deny");
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
      const result = denyHoldRequested
        ? await denyHold(queueId, message.authorId)
        : action === "approve"
          ? await approve(queueId, message.authorId)
          : await reject(queueId, message.authorId);
      const alreadyResolved = (outcome) =>
        `That queue entry was already resolved as ${outcome} by another moderator; nothing was changed.`;
      const approvedDescription = `The author was cleared and their protection strike reset. The content was not reposted — they can post it again themselves.${
        result.exempted
          ? ` They are now exempt from future contact-solicitation, prohibited-identity, and first-post link/media screening, until a moderator holds them again with \`${commandName()} hold @member reason\` or 🔒 Deny + Hold User.`
          : ""
      }`;
      const descriptions = {
        approved:
          action === "approve"
            ? approvedDescription
            : alreadyResolved("approved"),
        rejected: denyHoldRequested
          ? result.userHold === "held"
            ? "The held post was discarded, the author's protection strike stage was increased, and every later message from them will now be held for review."
            : result.userHold === "already_held"
              ? "The held post was discarded and the strike stage increased. The author was already in Post Gate, so their existing hold is unchanged."
              : "The held post was discarded. No Post Gate hold was placed: this entry predates author-id capture."
          : action === "reject"
            ? "The held post was discarded and the author's protection strike stage was increased."
            : alreadyResolved("rejected"),
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
            ? denyHoldRequested
              ? "🔒 Post Denied — Author Held"
              : "❌ Post Rejected"
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
        `Use \`${commandName()} status\`, \`${commandName()} here\`, \`${commandName()} #channel\`, \`${commandName()} off\`, \`${commandName()} confirm CODE\`, \`${commandName()} cancel\`, \`${commandName()} approve QUEUE_ID\`, \`${commandName()} reject QUEUE_ID\`, \`${commandName()} deny-hold QUEUE_ID\`, \`${commandName()} release @member\`, \`${commandName()} hold @member reason\`, \`${commandName()} holds\`, or \`${commandName()} terms\`.`,
        "#E74C3C"
      );
      return { outcome: "invalid_command" };
    }
    return requestChange(message, "set", first);
  }

  // ── Expiry + queue maintenance ───────────────────────────────

  async function expireOverdue() {
    const current = now();
    const expiredByServer = new Map();
    for (const record of store.getExpiredPendingPosts(current)) {
      const reviewDeleted = await deleteReviewCard(record);
      if (!reviewDeleted)
        logger.warn?.("post-gate: review card cleanup failed");
      store.updateHeldPost(record.queueId, {
        status: "expired",
        reviewedAt: current,
      });
      const expired = expiredByServer.get(record.serverId) ?? [];
      expired.push(record);
      expiredByServer.set(record.serverId, expired);
    }
    for (const [serverId, records] of expiredByServer) {
      const shown = records.slice(0, 20);
      const omitted = records.length - shown.length;
      await sendAccountability(
        serverId,
        "⌛ Held Posts Expired",
        [
          `**Expired:** ${records.length} held post${records.length === 1 ? "" : "s"}`,
          ...shown.map(
            (record) => `- \`${record.queueId}\` — ${queueActorLabel(record)}`
          ),
          ...(omitted > 0
            ? [`- …and ${omitted} more expired queue entries`]
            : []),
          "",
          "The 7-day review window elapsed with no moderator decision. The content was discarded with no protection strike.",
        ],
        "#E67E22"
      );
    }
  }

  async function maintainQueue() {
    try {
      await expireOverdue();
      // Forgotten-hold reminders ride the existing hourly sweep rather than
      // adding a second timer, so a reminder lands within an hour of its due
      // time and nothing has to be rescheduled after a restart.
      await remindHeldUsers();
      ensureCompiledTerms();
      store.prunePostGateQueue(now());
      store.prunePostGateUserHolds(now());
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
    const policy = isSafeId(serverId)
      ? policyForServer(serverId)
      : resolveModerationPolicy(config, now());
    if (config.mode !== "hold") return false;
    // Bio matching is asynchronous. The messageCreate listener above registers
    // a pending decision synchronously for every recent-identity message that
    // is profile-eligible, so the command, automod, and archive listeners can
    // share the exact outcome instead of racing the profile request.
    if (
      !canInspectProfile(config, { channelId: channelIdFrom(message) }) &&
      policy.effectiveLevel < 3
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
    handleMemberJoin,
    handleMemberLeave,
    handleMemberUpdate,
    handleRawEvent,
    handleDirectMessage: gate.handleDirectMessage,
    resolveApprover: gate.resolveApprover,
    shouldExcludeMessage,
    shouldExcludeMessageDelete,
    startQueuePrune,
    maintainQueue,
    denyHold,
    releaseUser,
    continueHold,
    remindHeldUsers,
    getActiveUserHolds: (serverId) => store.getActiveUserHolds(serverId),
    reloadProhibitedTerms: () => ensureCompiledTerms(true),
    reconcilePermissionLock,
    reconcilePermissionLocks,
    getPending(serverId) {
      const pending = gate.getPending(serverId);
      return pending?.kind === CHALLENGE_KIND ? pending : null;
    },
  };
}
