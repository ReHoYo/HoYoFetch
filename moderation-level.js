// moderation-level.js — server-wide moderation posture (/Level 1|2|3)
// ────────────────────────────────────────────────────────────────────────────
// Levels 1 and 2 only re-tune thresholds that automod.js and post-gate.js
// already own, so this module just persists the choice. Level 3 is different:
// it kicks new joins and deletes messages from members below a tenure
// threshold, and that enforcement lives here.
//
// Two rules govern every level-3 action:
//
//   1. No enforcement without a record. Level 3 needs automod configured with
//      a log channel, because an unlogged automatic kick is indistinguishable
//      from the bot malfunctioning.
//   2. Fail closed means "do not act". Everywhere else in this bot a failed
//      permission refresh downgrades to observation; the same rule applies
//      here, so an unverifiable joiner is reported rather than kicked.
import { AUTOMOD_LIMITS, formatAge, nextStrikeLevel } from "./automod.js";
import { buildAuditEmbed, buildStatusEmbed } from "./embeds.js";
import {
  DEFAULT_TENURE_DAYS,
  MAX_TENURE_DAYS,
  MIN_TENURE_DAYS,
  getAutomodConfig,
  getAutomodStrike,
  getModerationLevel,
  isChannelExcluded,
  setAutomodStrike,
  setModerationLevel,
} from "./store.js";
import { MODERATION_LEVEL_POLICIES, policyFor } from "./moderation-policy.js";
import {
  auditAlias,
  authorizeServerActor,
  COMMAND_ACCESS,
  isSafeId,
  safeErrorSummary,
} from "./security.js";

export { MODERATION_LEVEL_POLICIES, policyFor };

// A sub-tenure member sending four messages in a row would otherwise walk the
// strike ladder 1→2→3→4 in seconds: nextStrikeLevel enforces a 14-day quiet
// reset but no minimum spacing. Every message is still deleted; only the
// escalation (and its audit notice) is rate limited.
export const STRIKE_COOLDOWN_MS = AUTOMOD_LIMITS.dedupeWindowMs;
const MAX_TRACKED_MEMBERS = 5_000;

const DEFAULT_STORE = Object.freeze({
  getAutomodConfig,
  getAutomodStrike,
  getModerationLevel,
  isChannelExcluded,
  setAutomodStrike,
  setModerationLevel,
});

function serverIdFrom(message) {
  return message?.server?.id ?? message?.channel?.serverId;
}

export function createModerationLevel(
  client,
  {
    sendProtected,
    request,
    prefix = "/",
    store = DEFAULT_STORE,
    logger = console,
    now = Date.now,
  } = {}
) {
  if (typeof sendProtected !== "function") {
    throw new TypeError("Moderation levels require a protected sender.");
  }
  if (typeof request !== "function") {
    throw new TypeError("Moderation levels require an HTTP requester.");
  }

  // key → timestamp after which this member may escalate again
  const strikeCooldowns = new Map();

  function commandName() {
    return `${prefix}Level`;
  }

  function logFailure(label, error) {
    logger.warn?.(`moderation-level: ${label} ${safeErrorSummary(error)}`);
  }

  function actorLabel(userId) {
    const username = client.users?.get?.(userId)?.username;
    return username ? `@${username} (<@${userId}>)` : `<@${userId}>`;
  }

  /**
   * The audit destination for level-3 enforcement. Returns null when automod
   * has no log channel, which is also the signal that enforcement must not run
   * at all — see rule 1 at the top of this file.
   */
  function enforcementChannel(serverId) {
    const config = store.getAutomodConfig(serverId);
    return isSafeId(config.logChannelId) ? config.logChannelId : null;
  }

  async function postAudit(channelId, title, lines, colour) {
    try {
      return await sendProtected(channelId, {
        embeds: [buildAuditEmbed(title, lines, colour)],
      });
    } catch (error) {
      logFailure("protected notice failed", error);
      return undefined;
    }
  }

  function activePolicy(serverId) {
    return policyFor(store.getModerationLevel(serverId));
  }

  /**
   * Fresh, fail-closed check of whether a member is exempt from level-3
   * enforcement. Returns "exempt" for bots and verified moderators, "unknown"
   * when the refresh itself could not complete, and "enforce" otherwise.
   */
  async function classifyMember(serverId, channelId, userId) {
    const authorization = await authorizeServerActor(
      client,
      { serverId, channelId, authorId: userId },
      COMMAND_ACCESS.FETCH_MANAGER,
      { logger }
    );
    if (authorization.isBot || authorization.allowed) return "exempt";
    if (
      !authorization.identityVerified ||
      authorization.permissionSource !== "refreshed"
    ) {
      return "unknown";
    }
    return "enforce";
  }

  // ── Level 3: new joins ───────────────────────────────────────

  async function handleMemberJoin(member) {
    const serverId = member?.id?.server;
    const userId = member?.id?.user;
    if (!isSafeId(serverId) || !isSafeId(userId) || member?.user?.bot) return;

    const policy = activePolicy(serverId);
    if (!policy.kickNewJoins) return;

    const logChannelId = enforcementChannel(serverId);
    if (!logChannelId) {
      logger.warn?.(
        `moderation-level: lockdown join not enforced (no automod log channel) server=${auditAlias(serverId)}`
      );
      return;
    }

    const classification = await classifyMember(serverId, logChannelId, userId);
    if (classification === "exempt") return;
    if (classification === "unknown") {
      await postAudit(
        logChannelId,
        "🔒 Lockdown — Join Not Actioned",
        [
          `**Member:** ${actorLabel(userId)}`,
          "Fresh permission verification was unavailable, so the automatic kick was withheld. Review this account manually.",
        ],
        "#E67E22"
      );
      return;
    }

    const kicked = await request(
      "DELETE",
      `/servers/${serverId}/members/${userId}`
    );
    await postAudit(
      logChannelId,
      kicked.ok ? "🔒 Lockdown — Member Kicked" : "⚠️ Lockdown — Kick Failed",
      [
        `**Member:** ${actorLabel(userId)}`,
        kicked.ok
          ? `Level 3 is active, so every new join is removed automatically. Lower the level with \`${commandName()} 1\` to accept members again.`
          : `Stoat rejected the kick request (HTTP ${kicked.status || "unknown"}). The account remains in the server.`,
      ],
      kicked.ok ? "#E67E22" : "#E74C3C"
    );
    logger.log?.(
      `🔒  lockdown-kick actor=${auditAlias(userId)} server=${auditAlias(serverId)} ok=${Boolean(kicked.ok)}`
    );
  }

  // ── Level 3: sub-tenure message restriction ──────────────────

  function claimStrike(serverId, userId, current) {
    const key = `${serverId}:${userId}`;
    const until = strikeCooldowns.get(key) ?? 0;
    if (until > current) return false;
    strikeCooldowns.delete(key);
    strikeCooldowns.set(key, current + STRIKE_COOLDOWN_MS);
    while (strikeCooldowns.size > MAX_TRACKED_MEMBERS) {
      strikeCooldowns.delete(strikeCooldowns.keys().next().value);
    }
    return true;
  }

  async function handleMessage(message) {
    const serverId = serverIdFrom(message);
    const userId = message?.authorId;
    const channelId = message?.channelId;
    const messageId = message?.id ?? message?._id;
    if (
      !isSafeId(serverId) ||
      !isSafeId(userId) ||
      !isSafeId(channelId) ||
      !isSafeId(messageId) ||
      message.webhook ||
      message.systemMessage ||
      message.author?.bot ||
      userId === client.user?.id
    ) {
      return;
    }

    const policy = activePolicy(serverId);
    if (!policy.restrictSubTenure) return;

    const logChannelId = enforcementChannel(serverId);
    if (!logChannelId || channelId === logChannelId) return;
    if (store.isChannelExcluded(channelId)) return;

    // An unknown join date is not evidence of a short tenure, so it is left
    // alone rather than treated as a violation.
    const joinedAt = message.member?.joinedAt;
    if (!(joinedAt instanceof Date)) return;
    const current = now();
    const tenureMs = current - joinedAt.getTime();
    if (!Number.isFinite(tenureMs) || tenureMs >= policy.tenureMs) return;

    try {
      const classification = await classifyMember(serverId, channelId, userId);
      if (classification !== "enforce") return;

      const removed = await request(
        "DELETE",
        `/channels/${channelId}/messages/${messageId}`
      );
      if (!removed.ok) {
        logger.warn?.(
          `moderation-level: could not remove sub-tenure message=${auditAlias(messageId)} server=${auditAlias(serverId)}`
        );
        return;
      }

      if (!claimStrike(serverId, userId, current)) return;

      const stored = store.getAutomodStrike(serverId, userId);
      const level = nextStrikeLevel(stored, current);
      store.setAutomodStrike(serverId, userId, {
        level,
        lastContainedAt: current,
        timeoutUntil: stored?.timeoutUntil ?? null,
      });

      await postAudit(
        logChannelId,
        "🔒 Lockdown — Message Restricted",
        [
          `**Member:** ${actorLabel(userId)}`,
          `**Channel:** <#${channelId}>`,
          `**Server tenure:** ${formatAge(joinedAt, current)} (threshold ${policy.tenureDays}d)`,
          `**Automod strike:** level ${level}`,
          `Further messages from this member are deleted without a new notice for ${Math.round(STRIKE_COOLDOWN_MS / 60_000)} minutes.`,
        ],
        "#E67E22"
      );
      logger.log?.(
        `🔒  lockdown-restrict actor=${auditAlias(userId)} server=${auditAlias(serverId)} strike=${level}`
      );
    } catch (error) {
      logFailure("sub-tenure restriction failed", error);
    }
  }

  // ── Command ──────────────────────────────────────────────────

  function describe(policy, tenureDays) {
    const lines = [
      `**Level ${policy.level} — ${policy.name}**`,
      policy.summary,
      "",
      `**New-account window:** ${policy.recentAccountMs / (24 * 60 * 60_000)}d`,
      `**Holds:** ${policy.holdEveryMessage ? "every message from a new account" : "links and attachments only"}`,
      `**Automod trips at:** score ${policy.scoreThreshold} with a behavioural signal`,
      `**Raid mode:** ${policy.joinSurgeCount} joins in 60s, lasting ${policy.raidModeMs / 60_000}m`,
    ];
    if (policy.kickNewJoins) {
      lines.push(
        "**New joins:** kicked automatically (bots and verified moderators are exempt)"
      );
    }
    if (policy.restrictSubTenure) {
      lines.push(
        `**Members in the server under ${tenureDays}d:** messages deleted and automod strike raised`
      );
    }
    return lines.join("\n");
  }

  async function announce(serverId, current, actorId) {
    const logChannelId = enforcementChannel(serverId);
    if (!logChannelId) return;
    await postAudit(
      logChannelId,
      `🛠️ Moderation Level Set — ${current.level} (${MODERATION_LEVEL_POLICIES[current.level].name})`,
      [
        `**Changed by:** ${actorLabel(actorId)}`,
        `**Tenure threshold:** ${current.tenureDays}d`,
        MODERATION_LEVEL_POLICIES[current.level].summary,
      ],
      current.level === 3
        ? "#E74C3C"
        : current.level === 2
          ? "#E67E22"
          : "#2ECC71"
    );
  }

  async function handleCommand(message, args = []) {
    const serverId = serverIdFrom(message);
    if (!isSafeId(serverId)) {
      return buildStatusEmbed(
        "🔒 Server Only",
        "Moderation levels can only be set inside a server.",
        "#E74C3C"
      );
    }

    const command = commandName();
    const action = String(args[0] ?? "status").toLowerCase();
    const stored = store.getModerationLevel(serverId);

    if (action === "status") {
      return buildStatusEmbed(
        "🛠️ Moderation Level",
        `${describe(policyFor(stored), stored.tenureDays)}\n\nUse \`${command} 1\`, \`${command} 2\`, \`${command} 3 confirm\`, or \`${command} tenure <${MIN_TENURE_DAYS}-${MAX_TENURE_DAYS}>\`.`,
        stored.level === 3
          ? "#E74C3C"
          : stored.level === 2
            ? "#E67E22"
            : "#3498DB"
      );
    }

    if (action === "tenure") {
      const days = Number(args[1]);
      if (
        !Number.isInteger(days) ||
        days < MIN_TENURE_DAYS ||
        days > MAX_TENURE_DAYS
      ) {
        return buildStatusEmbed(
          "⚠️ Invalid Tenure Threshold",
          `Use \`${command} tenure <${MIN_TENURE_DAYS}-${MAX_TENURE_DAYS}>\`. The default is ${DEFAULT_TENURE_DAYS} days. This only takes effect at level 3.`,
          "#E74C3C"
        );
      }
      const { current } = store.setModerationLevel(serverId, {
        tenureDays: days,
        updatedBy: message.authorId,
      });
      return buildStatusEmbed(
        "🛠️ Tenure Threshold Updated",
        `At level 3, members who joined less than ${current.tenureDays} days ago cannot post.${current.level === 3 ? "" : " Level 3 is not currently active."}`,
        "#2ECC71"
      );
    }

    const requested = Number(action);
    if (!MODERATION_LEVEL_POLICIES[requested]) {
      return buildStatusEmbed(
        "🛠️ Moderation Level Commands",
        `Use \`${command} status\`, \`${command} 1\`, \`${command} 2\`, \`${command} 3 confirm\`, or \`${command} tenure <${MIN_TENURE_DAYS}-${MAX_TENURE_DAYS}>\`.`,
        "#3498DB"
      );
    }

    if (requested === 3 && String(args[1] ?? "").toLowerCase() !== "confirm") {
      return buildStatusEmbed(
        "⚠️ Lockdown Requires Confirmation",
        `Level 3 kicks **every** new member on sight and deletes messages from anyone who joined in the last ${stored.tenureDays} days. Bots and verified moderators are exempt from the kick.\n\nRe-run \`${command} 3 confirm\` to enable it.`,
        "#E74C3C"
      );
    }

    if (requested === 3 && !enforcementChannel(serverId)) {
      return buildStatusEmbed(
        "⚠️ Lockdown Unavailable",
        `Level 3 needs an automod log channel so every automatic kick is recorded. Set one with \`${prefix}Automod enforce here\` first.`,
        "#E74C3C"
      );
    }

    const { current } = store.setModerationLevel(serverId, {
      level: requested,
      updatedBy: message.authorId,
    });
    await announce(serverId, current, message.authorId);
    logger.log?.(
      `🛠️  moderation-level set=${current.level} server=${auditAlias(serverId)} actor=${auditAlias(message.authorId)}`
    );

    return buildStatusEmbed(
      requested === 3
        ? "🔒 Lockdown Enabled"
        : requested === 2
          ? "🛡️ Heightened Moderation Enabled"
          : "✅ Standard Moderation Restored",
      `${describe(policyFor(current), current.tenureDays)}\n\nStand down with \`${command} 1\`.`,
      requested === 3 ? "#E74C3C" : requested === 2 ? "#E67E22" : "#2ECC71"
    );
  }

  return { handleCommand, handleMemberJoin, handleMessage };
}
