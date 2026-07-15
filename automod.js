// automod.js — opt-in, fail-closed anti-raid detection and containment
// ────────────────────────────────────────────────────────────────────────────
import { randomBytes } from "crypto";
import { parseChannelArg } from "./auditlog.js";
import { buildStatusEmbed } from "./embeds.js";
import {
  createAutomodCase,
  findActiveAutomodCase,
  findAutomodCaseByPromptMessage,
  getAutomodCase,
  getAutomodConfig,
  getAutomodStrike,
  pruneAutomodCases,
  setAutomodConfig,
  setAutomodStrike,
  updateAutomodCase,
} from "./store.js";
import {
  auditAlias,
  authorizeServerActor,
  COMMAND_ACCESS,
  isSafeId,
  safeErrorSummary,
} from "./security.js";

export const AUTOMOD_BAN_EMOJI = "🔨";
export const AUTOMOD_TIMEOUT_LADDER = Object.freeze([
  10 * 60 * 1_000,
  60 * 60 * 1_000,
  24 * 60 * 60 * 1_000,
  7 * 24 * 60 * 60 * 1_000,
]);
export const AUTOMOD_LIMITS = Object.freeze({
  rapidMessages: 5,
  rapidWindowMs: 5_000,
  duplicateMessages: 4,
  duplicateWindowMs: 10_000,
  uniqueMentions: 5,
  mentionWindowMs: 10_000,
  recentAccountMs: 7 * 24 * 60 * 60 * 1_000,
  recentMemberMs: 24 * 60 * 60 * 1_000,
  joinSurgeCount: 5,
  joinSurgeWindowMs: 60_000,
  raidModeMs: 10 * 60 * 1_000,
  timeoutMs: 10 * 60 * 1_000,
  strikeResetMs: 14 * 24 * 60 * 60 * 1_000,
  approvalWindowMs: 10 * 60 * 1_000,
  dedupeWindowMs: 15 * 60 * 1_000,
});

const MAX_ACTORS = 5_000;
const MAX_MESSAGES_PER_ACTOR = 40;
const MAX_JOIN_SERVERS = 1_000;
const MAX_JOINS_PER_SERVER = 100;
const MAX_RAID_JOINERS_PER_SERVER = 500;

const DEFAULT_STORE = Object.freeze({
  createAutomodCase,
  findActiveAutomodCase,
  findAutomodCaseByPromptMessage,
  getAutomodCase,
  getAutomodConfig,
  getAutomodStrike,
  pruneAutomodCases,
  setAutomodConfig,
  setAutomodStrike,
  updateAutomodCase,
});

function asTime(value) {
  const time =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function isRecent(time, now, windowMs) {
  return time !== null && time <= now && now - time < windowMs;
}

function formatDuration(durationMs) {
  if (durationMs < 60 * 60_000) return `${durationMs / 60_000} minutes`;
  if (durationMs < 24 * 60 * 60_000) {
    const hours = durationMs / (60 * 60_000);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = durationMs / (24 * 60 * 60_000);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function normalizeAutomodContent(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 500);
}

export function buildEvidenceExcerpt(value) {
  const compact = String(value ?? "")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/<@/g, "<@\u200B")
    .replace(/`/g, "ˋ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "*(no text content)*";
  return compact.length > 120 ? `${compact.slice(0, 119)}…` : compact;
}

export class AntiRaidDetector {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.messages = new Map();
    this.joinStates = new Map();
  }

  recordJoin(serverId, userId) {
    const now = this.now();
    let state = this.joinStates.get(serverId);
    if (!state) {
      state = { joins: [], raidUntil: 0, joinedDuringRaid: new Map() };
      this.joinStates.set(serverId, state);
      while (this.joinStates.size > MAX_JOIN_SERVERS) {
        this.joinStates.delete(this.joinStates.keys().next().value);
      }
    }

    state.joins = state.joins
      .filter((entry) => now - entry.at < AUTOMOD_LIMITS.joinSurgeWindowMs)
      .slice(-(MAX_JOINS_PER_SERVER - 1));
    state.joins.push({ userId, at: now });
    for (const [joinedUserId, expiry] of state.joinedDuringRaid) {
      if (expiry <= now) state.joinedDuringRaid.delete(joinedUserId);
    }

    let raidActivated = false;
    if (
      state.raidUntil <= now &&
      state.joins.length >= AUTOMOD_LIMITS.joinSurgeCount
    ) {
      state.raidUntil = now + AUTOMOD_LIMITS.raidModeMs;
      raidActivated = true;
    }
    if (state.raidUntil > now) {
      state.joinedDuringRaid.set(userId, state.raidUntil);
      while (state.joinedDuringRaid.size > MAX_RAID_JOINERS_PER_SERVER) {
        state.joinedDuringRaid.delete(
          state.joinedDuringRaid.keys().next().value
        );
      }
    }

    return {
      raidActivated,
      raidUntil: state.raidUntil,
      joinCount: state.joins.length,
    };
  }

  recordMessage({
    serverId,
    userId,
    messageId,
    channelId,
    content,
    mentionIds = [],
    accountCreatedAt,
    joinedAt,
  }) {
    const now = this.now();
    const key = `${serverId}:${userId}`;
    const normalised = normalizeAutomodContent(content);
    const existing = (this.messages.get(key) ?? []).filter(
      (entry) => now - entry.at < AUTOMOD_LIMITS.duplicateWindowMs
    );
    existing.push({
      at: now,
      messageId,
      channelId,
      content: String(content ?? ""),
      normalised,
      mentionIds: Array.isArray(mentionIds) ? mentionIds.filter(isSafeId) : [],
    });
    const history = existing.slice(-MAX_MESSAGES_PER_ACTOR);
    this.messages.delete(key);
    this.messages.set(key, history);
    while (this.messages.size > MAX_ACTORS) {
      this.messages.delete(this.messages.keys().next().value);
    }

    const rapid = history.filter(
      (entry) => now - entry.at < AUTOMOD_LIMITS.rapidWindowMs
    );
    const duplicates = normalised
      ? history.filter((entry) => entry.normalised === normalised)
      : [];
    const uniqueMentions = new Set(
      history.flatMap((entry) => entry.mentionIds)
    );
    const raidState = this.joinStates.get(serverId);
    const joinedDuringRaid =
      (raidState?.joinedDuringRaid.get(userId) ?? 0) > now;
    const recentIdentity =
      isRecent(asTime(accountCreatedAt), now, AUTOMOD_LIMITS.recentAccountMs) ||
      isRecent(asTime(joinedAt), now, AUTOMOD_LIMITS.recentMemberMs);

    const signals = {
      rapidBurst: rapid.length >= AUTOMOD_LIMITS.rapidMessages,
      duplicateFlood: duplicates.length >= AUTOMOD_LIMITS.duplicateMessages,
      mentionFlood: uniqueMentions.size >= AUTOMOD_LIMITS.uniqueMentions,
      recentIdentity,
      joinedDuringRaid,
      rapidCount: rapid.length,
      duplicateCount: duplicates.length,
      uniqueMentionCount: uniqueMentions.size,
    };
    const behaviourSignal =
      signals.rapidBurst || signals.duplicateFlood || signals.mentionFlood;
    const score =
      (signals.rapidBurst ? 1 : 0) +
      (signals.duplicateFlood ? 2 : 0) +
      (signals.mentionFlood ? 2 : 0) +
      (signals.recentIdentity ? 1 : 0) +
      (signals.joinedDuringRaid ? 1 : 0);

    return {
      triggered: behaviourSignal && score >= 2,
      score,
      signals,
      messages: history.map((entry) => ({
        messageId: entry.messageId,
        channelId: entry.channelId,
        excerpt: buildEvidenceExcerpt(entry.content),
      })),
    };
  }

  clearActor(serverId, userId) {
    this.messages.delete(`${serverId}:${userId}`);
  }

  clearServer(serverId) {
    for (const key of this.messages.keys()) {
      if (key.startsWith(`${serverId}:`)) this.messages.delete(key);
    }
  }
}

function createCaseId() {
  return `AM${randomBytes(6).toString("hex").toUpperCase()}`;
}

function formatAge(value, now) {
  const time = asTime(value);
  if (time === null || time > now) return "unknown";
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatCaseEmbed({
  caseId,
  userId,
  result,
  mode,
  now,
  accountCreatedAt,
  joinedAt,
  verification,
  containment,
  escalation,
  repeat = false,
}) {
  const activeSignals = [
    result.signals.rapidBurst
      ? `rapid burst (${result.signals.rapidCount}/5s)`
      : null,
    result.signals.duplicateFlood
      ? `duplicate flood (${result.signals.duplicateCount}/10s)`
      : null,
    result.signals.mentionFlood
      ? `mention flood (${result.signals.uniqueMentionCount} unique/10s)`
      : null,
    result.signals.recentIdentity ? "recent account or server join" : null,
    result.signals.joinedDuringRaid ? "joined during active raid mode" : null,
  ].filter(Boolean);
  const actionLines =
    mode === "monitor"
      ? ["**Action:** monitor only; no messages or member state were changed."]
      : [
          `**Timeout:** ${containment?.timeoutOk ? `applied/extended for ${formatDuration(escalation.durationMs)}` : "failed or skipped"}`,
          `**Cleanup:** ${containment?.deletedCount ?? 0} message(s) deleted across ${containment?.deletedChannels ?? 0} channel(s); ${containment?.deleteFailures ?? 0} channel operation(s) failed`,
        ];
  const evidence = result.messages
    .slice(-5)
    .map((entry) => `- ${entry.excerpt}`)
    .join("\n");
  const verificationNote =
    verification === "refreshed"
      ? "fresh permission snapshot"
      : "permission refresh unavailable; enforcement suppressed";

  return {
    title: repeat ? "🛡️ Automod Case Re-triggered" : "🛡️ Automod Case Opened",
    description: [
      `**Case:** \`${caseId}\``,
      `**Target:** <@${userId}>`,
      `**Mode:** ${mode}`,
      `**Score:** ${result.score}`,
      `**Escalation:** strike ${escalation.level}/4 (${formatDuration(escalation.durationMs)})${mode === "monitor" ? " projected" : ""}`,
      `**Signals:** ${activeSignals.join(", ")}`,
      `**Account age:** ${formatAge(accountCreatedAt, now)}`,
      `**Server membership age:** ${formatAge(joinedAt, now)}`,
      `**Identity check:** ${verificationNote}`,
      ...actionLines,
      "",
      "**Bounded evidence excerpts:**",
      evidence || "- *(none)*",
    ].join("\n"),
    colour: mode === "monitor" ? "#3498DB" : "#E67E22",
  };
}

function approvalEmbed(caseRecord) {
  return buildStatusEmbed(
    "🔨 Automod Ban Review",
    [
      `**Case:** \`${caseRecord.caseId}\``,
      `**Target:** <@${caseRecord.userId}>`,
      `The account is temporarily contained. A permanent ban requires **${caseRecord.quorum} distinct authorized staff approval${caseRecord.quorum === 1 ? "" : "s"}** within 10 minutes.`,
      `React with ${AUTOMOD_BAN_EMOJI} or use \`/Automod approve ${caseRecord.caseId}\`.`,
      "Only the server owner, Manage Server members, or Ban Members moderators are eligible.",
    ].join("\n"),
    "#E74C3C"
  );
}

export function createAutomod(
  client,
  {
    send,
    sendProtected,
    request,
    store = DEFAULT_STORE,
    logger = console,
    now = Date.now,
    detector = new AntiRaidDetector({ now }),
    caseIdFactory = createCaseId,
    attach = true,
  } = {}
) {
  if (typeof send !== "function") {
    throw new TypeError("Automod requires a sender.");
  }
  if (typeof sendProtected !== "function") {
    throw new TypeError("Automod requires a protected sender.");
  }
  if (typeof request !== "function") {
    throw new TypeError("Automod requires an HTTP requester.");
  }

  const actorLocks = new Set();
  const banLocks = new Set();
  const recentCases = new Map();

  function logFailure(label, error) {
    logger.warn?.(`automod: ${label} ${safeErrorSummary(error)}`);
  }

  function markRecent(serverId, userId, caseId, until) {
    recentCases.set(`${serverId}:${userId}`, { caseId, until });
    while (recentCases.size > MAX_ACTORS) {
      recentCases.delete(recentCases.keys().next().value);
    }
  }

  function getRecent(serverId, userId) {
    const key = `${serverId}:${userId}`;
    const cached = recentCases.get(key);
    if (cached && cached.until > now()) return cached;
    recentCases.delete(key);
    const persisted = store.findActiveAutomodCase(serverId, userId, now());
    if (!persisted) return null;
    const recent = { caseId: persisted.caseId, until: persisted.dedupeUntil };
    recentCases.set(key, recent);
    return recent;
  }

  async function freshTargetCheck(serverId, channelId, userId) {
    return authorizeServerActor(
      client,
      { serverId, channelId, authorId: userId },
      COMMAND_ACCESS.FETCH_MANAGER,
      { logger }
    );
  }

  function escalationFor(serverId, userId, memberTimeoutAt) {
    const current = now();
    const stored = store.getAutomodStrike(serverId, userId);
    const quietReset =
      !stored ||
      !Number.isFinite(stored.lastContainedAt) ||
      current - stored.lastContainedAt >= AUTOMOD_LIMITS.strikeResetMs;
    const memberTimeout = asTime(memberTimeoutAt) ?? 0;
    const active =
      !quietReset &&
      Number(stored.timeoutUntil) > current &&
      memberTimeout > current;
    const level = active
      ? stored.level
      : quietReset
        ? 1
        : Math.min(4, stored.level + 1);
    return {
      active,
      level,
      durationMs: AUTOMOD_TIMEOUT_LADDER[level - 1],
      stored,
    };
  }

  async function contain(serverId, targetAuthorization, messages, escalation) {
    const current = now();
    const existingTimeout = asTime(targetAuthorization.memberTimeoutAt) ?? 0;
    const timeoutUntilMs = Math.max(
      existingTimeout,
      current + escalation.durationMs
    );
    const timeoutUntil = new Date(timeoutUntilMs).toISOString();
    const timeout = await request(
      "PATCH",
      `/servers/${serverId}/members/${targetAuthorization.authorId}`,
      { timeout: timeoutUntil }
    );

    const byChannel = new Map();
    for (const entry of messages) {
      if (!isSafeId(entry.channelId) || !isSafeId(entry.messageId)) continue;
      const ids = byChannel.get(entry.channelId) ?? [];
      if (!ids.includes(entry.messageId)) ids.push(entry.messageId);
      byChannel.set(entry.channelId, ids);
    }

    let deletedCount = 0;
    let deletedChannels = 0;
    let deleteFailures = 0;
    for (const [channelId, ids] of byChannel) {
      const response = await request(
        "DELETE",
        `/channels/${channelId}/messages/bulk`,
        { ids }
      );
      if (response.ok) {
        deletedCount += ids.length;
        deletedChannels += 1;
      } else {
        deleteFailures += 1;
      }
    }

    return {
      timeoutOk: Boolean(timeout.ok),
      timeoutStatus: timeout.status,
      timeoutUntil: timeoutUntilMs,
      deletedCount,
      deletedChannels,
      deleteFailures,
    };
  }

  async function postProtected(channelId, embed) {
    try {
      return await sendProtected(channelId, { embeds: [embed] });
    } catch (error) {
      logFailure("protected log failed", error);
      return undefined;
    }
  }

  async function openCase(message, result, config) {
    const serverId = message.server?.id ?? message.channel?.serverId;
    const userId = message.authorId;
    const channelId = message.channelId;
    const key = `${serverId}:${userId}`;
    if (actorLocks.has(key)) return;
    actorLocks.add(key);

    try {
      const targetAuthorization = await freshTargetCheck(
        serverId,
        channelId,
        userId
      );

      // A verified moderator is exempt. An unavailable permission refresh
      // remains observable but can never cause a member mutation.
      if (targetAuthorization.isBot || targetAuthorization.allowed) {
        detector.clearActor(serverId, userId);
        return;
      }
      const verifiedOrdinary =
        targetAuthorization.identityVerified &&
        targetAuthorization.permissionSource === "refreshed" &&
        targetAuthorization.reason === "insufficient_permission";
      const effectiveMode =
        config.mode === "enforce" && verifiedOrdinary ? "enforce" : "monitor";
      const escalation = escalationFor(
        serverId,
        userId,
        targetAuthorization.memberTimeoutAt
      );
      // Only queued events while the native timeout is still active reuse a
      // case. Once it expires, another trigger is a new strike and gets a new
      // approval window even if the old 15-minute record still exists.
      const existing = escalation.active ? getRecent(serverId, userId) : null;
      const caseId = existing?.caseId ?? caseIdFactory();
      let containment = null;
      if (effectiveMode === "enforce") {
        containment = await contain(
          serverId,
          targetAuthorization,
          result.messages,
          escalation
        );
        if (containment.timeoutOk) {
          store.setAutomodStrike(serverId, userId, {
            level: escalation.level,
            lastContainedAt: now(),
            timeoutUntil: containment.timeoutUntil,
          });
        }
      }

      const openedAt = now();
      const evidence = await postProtected(
        config.logChannelId,
        formatCaseEmbed({
          caseId,
          userId,
          result,
          mode: effectiveMode,
          now: openedAt,
          accountCreatedAt: message.author?.createdAt,
          joinedAt: message.member?.joinedAt,
          verification: targetAuthorization.permissionSource,
          containment,
          escalation,
          repeat: Boolean(existing),
        })
      );

      if (!existing) {
        markRecent(
          serverId,
          userId,
          caseId,
          openedAt + AUTOMOD_LIMITS.dedupeWindowMs
        );
      }

      if (
        !existing &&
        effectiveMode === "enforce" &&
        containment?.timeoutOk &&
        isSafeId(evidence?._id)
      ) {
        let record = store.createAutomodCase({
          caseId,
          serverId,
          userId,
          channelId,
          logChannelId: config.logChannelId,
          evidenceMessageId: evidence._id,
          promptMessageId: null,
          approvals: [],
          quorum: config.quorum,
          score: result.score,
          createdAt: openedAt,
          expiresAt: openedAt + AUTOMOD_LIMITS.approvalWindowMs,
          dedupeUntil: openedAt + AUTOMOD_LIMITS.dedupeWindowMs,
          status: "pending",
        });
        const prompt = await send(config.logChannelId, {
          embeds: [approvalEmbed(record)],
        });
        if (isSafeId(prompt?._id)) {
          record = store.updateAutomodCase(caseId, {
            promptMessageId: prompt._id,
          });
          const reaction = await request(
            "PUT",
            `/channels/${config.logChannelId}/messages/${prompt._id}/reactions/${encodeURIComponent(AUTOMOD_BAN_EMOJI)}`
          );
          if (!reaction.ok) {
            logger.warn?.(
              `automod: could not seed approval reaction case=${auditAlias(caseId)}`
            );
          }
        }
      }

      detector.clearActor(serverId, userId);
      logger.log?.(
        `🛡️  automod case=${auditAlias(caseId)} actor=${auditAlias(userId)} ` +
          `server=${auditAlias(serverId)} mode=${effectiveMode} score=${result.score}`
      );
    } catch (error) {
      logFailure("case handling failed", error);
    } finally {
      actorLocks.delete(key);
    }
  }

  async function handleMessage(message) {
    const serverId = message?.server?.id ?? message?.channel?.serverId;
    const userId = message?.authorId;
    const channelId = message?.channelId;
    if (
      !isSafeId(serverId) ||
      !isSafeId(userId) ||
      !isSafeId(channelId) ||
      message.webhook ||
      message.systemMessage ||
      message.author?.bot ||
      userId === client.user?.id
    ) {
      return;
    }
    const config = store.getAutomodConfig(serverId);
    if (config.mode === "off" || !isSafeId(config.logChannelId)) return;

    const result = detector.recordMessage({
      serverId,
      userId,
      messageId: message.id,
      channelId,
      content: message.content,
      mentionIds: message.mentionIds,
      accountCreatedAt: message.author?.createdAt,
      joinedAt: message.member?.joinedAt,
    });
    if (result.triggered) await openCase(message, result, config);
  }

  async function handleMemberJoin(member) {
    const serverId = member?.id?.server;
    const userId = member?.id?.user;
    if (!isSafeId(serverId) || !isSafeId(userId) || member.user?.bot) return;
    const config = store.getAutomodConfig(serverId);
    if (config.mode === "off" || !isSafeId(config.logChannelId)) return;
    const result = detector.recordJoin(serverId, userId);
    if (!result.raidActivated) return;
    await postProtected(
      config.logChannelId,
      buildStatusEmbed(
        "🚨 Automod Raid Mode Activated",
        `${result.joinCount} members joined within 60 seconds. Heightened risk weighting is active for 10 minutes. **No member was punished by the join surge alone.**`,
        "#E67E22"
      )
    );
  }

  async function attemptBan(record) {
    if (banLocks.has(record.caseId)) return { outcome: "in_progress" };
    banLocks.add(record.caseId);
    try {
      const current = store.getAutomodCase(record.caseId);
      if (!current || current.status !== "pending") {
        return { outcome: current?.status ?? "missing" };
      }
      if (current.expiresAt <= now()) {
        store.updateAutomodCase(current.caseId, { status: "expired" });
        return { outcome: "expired" };
      }
      if ((current.approvals?.length ?? 0) < current.quorum) {
        return { outcome: "awaiting_quorum", record: current };
      }

      const target = await freshTargetCheck(
        current.serverId,
        current.channelId,
        current.userId
      );
      if (
        target.allowed ||
        target.permissionSource !== "refreshed" ||
        target.reason !== "insufficient_permission"
      ) {
        await postProtected(
          current.logChannelId,
          buildStatusEmbed(
            "🛑 Automod Ban Aborted",
            `Case \`${current.caseId}\` was not banned because the target is now exempt or could not be safely revalidated.`,
            "#E74C3C"
          )
        );
        return { outcome: "target_not_safe" };
      }

      const botAuthorization = await authorizeServerActor(
        client,
        {
          serverId: current.serverId,
          channelId: current.channelId,
          authorId: client.user?.id,
        },
        COMMAND_ACCESS.BAN_APPROVER,
        { allowBot: true, logger }
      );
      if (!botAuthorization.allowed) {
        await postProtected(
          current.logChannelId,
          buildStatusEmbed(
            "⚠️ Automod Ban Failed",
            `Case \`${current.caseId}\` reached quorum, but the bot does not currently have verified **Ban Members** permission. No fallback action was taken.`,
            "#E74C3C"
          )
        );
        return { outcome: "bot_cannot_ban" };
      }

      const response = await request(
        "PUT",
        `/servers/${current.serverId}/bans/${current.userId}`,
        {
          reason: `HoYoFetch automod case ${current.caseId}: approved by ${current.approvals.length} staff`,
        }
      );
      if (!response.ok) {
        await postProtected(
          current.logChannelId,
          buildStatusEmbed(
            "⚠️ Automod Ban Failed",
            `Case \`${current.caseId}\` reached quorum, but Stoat rejected the ban request (HTTP ${response.status || "unknown"}). No fallback action was taken.`,
            "#E74C3C"
          )
        );
        return { outcome: "ban_failed" };
      }

      const banned = store.updateAutomodCase(current.caseId, {
        status: "banned",
        bannedAt: now(),
      });
      await postProtected(
        current.logChannelId,
        buildStatusEmbed(
          "🔨 Automod Ban Approved",
          `Case \`${current.caseId}\` reached ${current.approvals.length}/${current.quorum} authorized approvals. <@${current.userId}> was banned with the case ID recorded as the reason.`,
          "#E74C3C"
        )
      );
      return { outcome: "banned", record: banned };
    } finally {
      banLocks.delete(record.caseId);
    }
  }

  async function approveCase(caseId, voterId) {
    store.pruneAutomodCases(now());
    const record = store.getAutomodCase(caseId);
    if (!record) return { outcome: "missing" };
    if (record.status !== "pending") return { outcome: record.status };
    if (record.expiresAt <= now()) {
      store.updateAutomodCase(caseId, { status: "expired" });
      return { outcome: "expired" };
    }
    if (record.userId === voterId) return { outcome: "self_vote" };

    const voter = await authorizeServerActor(
      client,
      {
        serverId: record.serverId,
        channelId: record.logChannelId,
        authorId: voterId,
      },
      COMMAND_ACCESS.BAN_APPROVER,
      { logger }
    );
    if (!voter.allowed || voter.permissionSource !== "refreshed") {
      return { outcome: "unauthorized" };
    }

    const approvals = [...new Set([...(record.approvals ?? []), voterId])];
    const updated = store.updateAutomodCase(caseId, { approvals });
    if (approvals.length < updated.quorum) {
      return { outcome: "approved", record: updated };
    }
    return attemptBan(updated);
  }

  async function handleRawEvent(event) {
    if (
      event?.type !== "MessageReact" ||
      event.emoji_id !== AUTOMOD_BAN_EMOJI ||
      !isSafeId(event.id) ||
      !isSafeId(event.user_id) ||
      event.user_id === client.user?.id
    ) {
      return;
    }
    const record = store.findAutomodCaseByPromptMessage(event.id);
    if (!record) return;
    const result = await approveCase(record.caseId, event.user_id);
    logger.log?.(
      `🛡️  automod approval case=${auditAlias(record.caseId)} ` +
        `actor=${auditAlias(event.user_id)} outcome=${result.outcome}`
    );
  }

  async function handleCommand(message, args = [], prefix = "/") {
    const serverId = message.server?.id;
    if (!isSafeId(serverId)) {
      return buildStatusEmbed(
        "🔒 Server Only",
        "Automod can only be configured inside a server.",
        "#E74C3C"
      );
    }
    const command = `${prefix}Automod`;
    const action = String(args[0] ?? "status").toLowerCase();
    const config = store.getAutomodConfig(serverId);

    if (action === "status") {
      const channel = config.logChannelId
        ? `<#${config.logChannelId}>`
        : "not configured";
      return buildStatusEmbed(
        "🛡️ Automod Status",
        `**Mode:** ${config.mode}\n**Logger:** ${channel}\n**Ban quorum:** ${config.quorum}\nAutomod is opt-in and permanent bans always require staff approval.`,
        config.mode === "off" ? "#808080" : "#3498DB"
      );
    }

    if (action === "off") {
      store.setAutomodConfig(serverId, { mode: "off" });
      for (const key of recentCases.keys()) {
        if (key.startsWith(`${serverId}:`)) recentCases.delete(key);
      }
      detector.clearServer(serverId);
      return buildStatusEmbed(
        "🔕 Automod Disabled",
        "Message and join activity will no longer be evaluated for this server.",
        "#E67E22"
      );
    }

    if (action === "quorum") {
      const quorum = Number(args[1]);
      if (quorum !== 1 && quorum !== 2) {
        return buildStatusEmbed(
          "⚠️ Invalid Automod Quorum",
          `Use \`${command} quorum 1\` for a single-moderator sandbox or \`${command} quorum 2\` for production. Existing cases keep the quorum they opened with.`,
          "#E74C3C"
        );
      }
      store.setAutomodConfig(serverId, { quorum });
      return buildStatusEmbed(
        "🔨 Automod Quorum Updated",
        `New cases will require ${quorum} distinct authorized staff approval${quorum === 1 ? "" : "s"} before banning.`,
        quorum === 1 ? "#E67E22" : "#2ECC71"
      );
    }

    if (action === "approve") {
      const caseId = String(args[1] ?? "").trim();
      if (!isSafeId(caseId)) {
        return buildStatusEmbed(
          "⚠️ Invalid Automod Case",
          `Use \`${command} approve CASE_ID\`.`,
          "#E74C3C"
        );
      }
      const result = await approveCase(caseId, message.authorId);
      const descriptions = {
        approved:
          "Your approval was recorded; the case is still waiting for quorum.",
        banned: "Quorum was reached and the target was banned.",
        missing: "That case does not exist or its retained state has expired.",
        expired: "That case's 10-minute approval window has expired.",
        unauthorized:
          "Fresh permission verification did not confirm Ban Members or Manage Server.",
        self_vote: "The target of a case cannot approve their own ban.",
        in_progress: "Another approval is already completing this case.",
        bot_cannot_ban:
          "Quorum was reached, but the bot lacks verified Ban Members permission.",
        target_not_safe:
          "The target became exempt or could not be safely revalidated.",
        ban_failed: "Quorum was reached, but Stoat rejected the ban request.",
      };
      return buildStatusEmbed(
        result.outcome === "banned"
          ? "🔨 Automod Ban Completed"
          : "🛡️ Automod Approval Result",
        descriptions[result.outcome] ?? `Case status: ${result.outcome}.`,
        result.outcome === "banned" || result.outcome === "approved"
          ? "#2ECC71"
          : "#E67E22"
      );
    }

    if (action === "monitor" || action === "enforce") {
      const rawTarget = args.slice(1).join(" ").trim() || "here";
      const channelId =
        rawTarget.toLowerCase() === "here"
          ? message.channelId
          : parseChannelArg(rawTarget);
      if (!isSafeId(channelId)) {
        return buildStatusEmbed(
          "⚠️ Invalid Automod Logger",
          `Use \`${command} ${action} here\` or choose a text channel in this server.`,
          "#E74C3C"
        );
      }
      const channel = client.channels.get(channelId);
      let canSend = false;
      try {
        canSend = Boolean(channel?.havePermission?.("SendMessage"));
      } catch {
        canSend = false;
      }
      if (
        !channel ||
        channel.serverId !== serverId ||
        channel.type !== "TextChannel" ||
        !canSend
      ) {
        return buildStatusEmbed(
          "⚠️ Unavailable Automod Logger",
          "Choose a text channel in this server where I have Send Messages permission.",
          "#E74C3C"
        );
      }
      store.setAutomodConfig(serverId, {
        mode: action,
        logChannelId: channelId,
      });
      for (const key of recentCases.keys()) {
        if (key.startsWith(`${serverId}:`)) recentCases.delete(key);
      }
      detector.clearServer(serverId);
      return buildStatusEmbed(
        action === "monitor"
          ? "👀 Automod Monitor Mode Enabled"
          : "🛡️ Automod Enforcement Enabled",
        action === "monitor"
          ? `Cases will be reported in <#${channelId}>, but no messages or members will be modified.`
          : `High-confidence cases will be timed out and cleaned up, then reported in <#${channelId}>. Permanent bans still require staff approval.`,
        action === "monitor" ? "#3498DB" : "#E67E22"
      );
    }

    return buildStatusEmbed(
      "🛡️ Automod Commands",
      `Use \`${command} status\`, \`${command} monitor [here|#channel]\`, \`${command} enforce [here|#channel]\`, \`${command} off\`, \`${command} quorum 1|2\`, \`${command} approve CASE_ID\`, or \`${command} release @member reason: ...\`.`,
      "#3498DB"
    );
  }

  store.pruneAutomodCases(now());
  if (attach) {
    client.on("messageCreate", (message) => {
      handleMessage(message).catch((error) =>
        logFailure("message handler failed", error)
      );
    });
    client.on("serverMemberJoin", (member) => {
      handleMemberJoin(member).catch((error) =>
        logFailure("join handler failed", error)
      );
    });
    client.events.on("event", (event) => {
      handleRawEvent(event).catch((error) =>
        logFailure("reaction handler failed", error)
      );
    });
  }

  return {
    approveCase,
    detector,
    handleCommand,
    handleMemberJoin,
    handleMessage,
    handleRawEvent,
  };
}
