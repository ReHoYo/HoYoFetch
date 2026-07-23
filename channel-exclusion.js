// channel-exclusion.js — Enka-approved privacy exclusions for audit logging
import { randomBytes } from "crypto";
import {
  APPROVAL_CHALLENGE_TTL_MS,
  APPROVAL_MAX_ATTEMPTS,
  createEnkaApprovalGate,
  ENKA_APPROVER_TAG,
  ENKA_APPROVER_USER_ID,
} from "./approval-gate.js";
import { parseChannelArg } from "./auditlog.js";
import { buildAuditEmbed, buildStatusEmbed } from "./embeds.js";
import { deleteEvidence } from "./evidence-store.js";
import { purgeChannelFromArchive } from "./message-archive.js";
import {
  addChannelExclusion,
  getAllChannelExclusions,
  getAuditLogChannel,
  getExcludedChannels,
  isChannelExcluded,
  removeChannelExclusion,
} from "./store.js";
import { auditAlias, isSafeId, safeErrorSummary } from "./security.js";

export { ENKA_APPROVER_TAG, ENKA_APPROVER_USER_ID };
export const EXCLUSION_CHALLENGE_TTL_MS = APPROVAL_CHALLENGE_TTL_MS;
export const EXCLUSION_MAX_ATTEMPTS = APPROVAL_MAX_ATTEMPTS;

const CHALLENGE_KIND = "channel_exclusion";
const DIGEST_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const DEFAULT_STORE = Object.freeze({
  addChannelExclusion,
  getAllChannelExclusions,
  getAuditLogChannel,
  getExcludedChannels,
  isChannelExcluded,
  removeChannelExclusion,
});

function defaultRequestIdFactory() {
  return `CE${randomBytes(8).toString("hex").toUpperCase()}`;
}

function channelIdFrom(message) {
  return message?.channelId ?? message?.channel?.id;
}

function serverIdFrom(message) {
  return message?.server?.id ?? message?.channel?.serverId;
}

function terminalTitle(action) {
  return action === "exclude"
    ? "✅ Privacy Exclusion Approved"
    : "🔓 Privacy Exclusion Removed";
}

export function createChannelExclusion(
  client,
  {
    send,
    sendProtected,
    request,
    prefix = "/",
    store = DEFAULT_STORE,
    logger = console,
    now = Date.now,
    codeFactory,
    requestIdFactory = defaultRequestIdFactory,
    approverUserId,
    approvalGate,
    purgeArchive = purgeChannelFromArchive,
    removeEvidence = deleteEvidence,
    scheduleTimeout = setTimeout,
    scheduleInterval = setInterval,
  } = {}
) {
  if (typeof send !== "function") {
    throw new TypeError("Channel exclusions require a sender.");
  }
  if (typeof sendProtected !== "function") {
    throw new TypeError("Channel exclusions require a protected sender.");
  }
  if (typeof request !== "function" && !approvalGate) {
    throw new TypeError("Channel exclusions require an HTTP requester.");
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
  let digestStarted = false;

  function commandName() {
    return `${prefix}Exclude-Channel`;
  }

  function actorLabel(userId) {
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

  async function respond(channelId, title, description, colour = "#3498DB") {
    return send(channelId, {
      embeds: [buildStatusEmbed(title, description, colour)],
    });
  }

  async function sendAccountability(challenge, title, lines, colour) {
    const auditChannelId = store.getAuditLogChannel(challenge.serverId);
    if (!isSafeId(auditChannelId)) return undefined;
    try {
      return await sendProtected(auditChannelId, {
        embeds: [buildAuditEmbed(title, lines, colour)],
      });
    } catch (error) {
      logger.warn?.(
        `channel-exclusion: protected notice failed server=${auditAlias(
          challenge.serverId
        )} ${safeErrorSummary(error)}`
      );
      return undefined;
    }
  }

  async function notifyTerminal(title, description, colour) {
    await gate.sendApprover({
      embeds: [buildStatusEmbed(title, description, colour)],
    });
  }

  async function resolveTarget(serverId, token, message) {
    const channelId =
      token?.toLowerCase() === "here"
        ? channelIdFrom(message)
        : parseChannelArg(token);
    if (!isSafeId(channelId)) return null;

    const cached = client.channels?.get?.(channelId);
    if (cached) {
      return cached.serverId === serverId && cached.type === "TextChannel"
        ? { id: channelId, serverId, type: "TextChannel" }
        : null;
    }

    const response = await request("GET", `/channels/${channelId}`);
    const data = response?.data;
    return response?.ok &&
      data?._id === channelId &&
      data?.server === serverId &&
      data?.channel_type === "TextChannel"
      ? { id: channelId, serverId, type: "TextChannel" }
      : null;
  }

  async function status(message) {
    const serverId = serverIdFrom(message);
    const excluded = store.getExcludedChannels(serverId);
    const pending = gate.getPending(serverId);
    const privacyPending = pending?.kind === CHALLENGE_KIND ? pending : null;
    const lines = excluded.length
      ? excluded.map(
          (record) =>
            `- ${channelLabel(record.channelId)} — excluded <t:${Math.floor(
              record.excludedAt / 1000
            )}:R>`
        )
      : ["- *(none)*"];
    if (privacyPending) {
      lines.push(
        "",
        `**Pending:** ${privacyPending.data.action} ${channelLabel(
          privacyPending.data.channelId
        )} requested by ${actorLabel(privacyPending.requestedBy)}`
      );
    } else if (pending) {
      lines.push("", `**Pending protected action:** \`${pending.requestId}\``);
    }
    await respond(
      channelIdFrom(message),
      "🔐 Audit Privacy Exclusions",
      lines.join("\n"),
      excluded.length ? "#9B59B6" : "#3498DB"
    );
    return { outcome: "status", excluded, pending: privacyPending };
  }

  async function onExpired(challenge) {
    const { action, channelId } = challenge.data;
    await sendAccountability(
      challenge,
      "⌛ Privacy Exclusion Request Expired",
      [
        `**Request:** \`${challenge.requestId}\``,
        `**Action:** ${action}`,
        `**Channel:** ${channelLabel(channelId)}`,
        `**Requested by:** ${actorLabel(challenge.requestedBy)}`,
        "No exclusion state was changed.",
      ],
      "#E67E22"
    );
    await notifyTerminal(
      "⌛ Privacy Request Expired",
      `Request \`${challenge.requestId}\` for ${channelLabel(
        channelId
      )} expired without changing exclusion state.`,
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
      challenge,
      "🛑 Privacy Request Attempts Exhausted",
      [
        `**Request:** \`${challenge.requestId}\``,
        `**Channel:** ${channelLabel(challenge.data.channelId)}`,
        `**Requested by:** ${actorLabel(challenge.requestedBy)}`,
        `**Attempts:** ${EXCLUSION_MAX_ATTEMPTS}`,
        "No exclusion state was changed.",
      ],
      "#E74C3C"
    );
    await notifyTerminal(
      "🛑 Privacy Request Cancelled",
      `Request \`${challenge.requestId}\` was destroyed after ${EXCLUSION_MAX_ATTEMPTS} incorrect code attempts.`,
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
    const { action, channelId } = challenge.data;
    await sendAccountability(
      challenge,
      "🚫 Privacy Exclusion Request Denied",
      [
        `**Request:** \`${challenge.requestId}\``,
        `**Action:** ${action}`,
        `**Channel:** ${channelLabel(channelId)}`,
        `**Requested by:** ${actorLabel(challenge.requestedBy)}`,
        `**Denied by:** ${ENKA_APPROVER_TAG}`,
        "No exclusion state was changed.",
      ],
      "#E74C3C"
    );
    await notifyTerminal(
      "🚫 Privacy Request Denied",
      `Request \`${challenge.requestId}\` was denied. No exclusion state changed.`,
      "#E74C3C"
    );
  }

  async function onCancelled(challenge, actorId) {
    await sendAccountability(
      challenge,
      "🚫 Privacy Exclusion Request Cancelled",
      [
        `**Request:** \`${challenge.requestId}\``,
        `**Channel:** ${channelLabel(challenge.data.channelId)}`,
        `**Cancelled by:** ${actorLabel(actorId)}`,
        "No exclusion state was changed.",
      ],
      "#E67E22"
    );
    await notifyTerminal(
      "🚫 Privacy Request Cancelled",
      `Request \`${challenge.requestId}\` was cancelled by ${actorLabel(
        actorId
      )}.`,
      "#E67E22"
    );
  }

  async function onApproved(challenge, approvedBy, responseChannelId) {
    const { action, channelId } = challenge.data;
    const stateStillValid =
      action === "exclude"
        ? !store.isChannelExcluded(channelId)
        : store.isChannelExcluded(channelId);
    if (!stateStillValid) {
      await sendAccountability(
        challenge,
        "⚠️ Privacy Request Became Stale",
        [
          `**Request:** \`${challenge.requestId}\``,
          `**Channel:** ${channelLabel(channelId)}`,
          "The exclusion state changed before approval. No additional change was made.",
        ],
        "#E67E22"
      );
      await notifyTerminal(
        "⚠️ Privacy Request Became Stale",
        `Request \`${challenge.requestId}\` no longer matches current state. Start a fresh request if needed.`,
        "#E67E22"
      );
      if (isSafeId(responseChannelId)) {
        await respond(
          responseChannelId,
          "⚠️ Privacy Request Became Stale",
          "The exclusion state changed before approval. Start a fresh request.",
          "#E67E22"
        );
      }
      return { outcome: "stale" };
    }

    let purgedEvidence = 0;
    if (action === "exclude") {
      store.addChannelExclusion({
        channelId,
        serverId: challenge.serverId,
        excludedAt: now(),
        requestedBy: challenge.requestedBy,
        approvedBy,
        requestId: challenge.requestId,
      });
      const paths = purgeArchive(channelId);
      for (const path of paths) {
        if (removeEvidence(path)) purgedEvidence += 1;
      }
    } else {
      store.removeChannelExclusion(channelId);
    }

    const title = terminalTitle(action);
    const description =
      action === "exclude"
        ? `${channelLabel(
            channelId
          )} will no longer archive or relay message content. Existing archived content and ${purgedEvidence} evidence file(s) were purged.`
        : `${channelLabel(
            channelId
          )} will resume message-content logging for new activity.`;
    await sendAccountability(
      challenge,
      title,
      [
        `**Request:** \`${challenge.requestId}\``,
        `**Channel:** ${channelLabel(channelId)}`,
        `**Requested by:** ${actorLabel(challenge.requestedBy)}`,
        `**Approved by:** ${ENKA_APPROVER_TAG} (<@${approvedBy}>)`,
        description,
      ],
      action === "exclude" ? "#9B59B6" : "#2ECC71"
    );
    await notifyTerminal(
      title,
      `Request \`${challenge.requestId}\` completed. ${description}`,
      action === "exclude" ? "#9B59B6" : "#2ECC71"
    );
    if (isSafeId(responseChannelId)) {
      await respond(
        responseChannelId,
        title,
        description,
        action === "exclude" ? "#9B59B6" : "#2ECC71"
      );
    }
    logger.log?.(
      `🔐  channel-exclusion ${action} request=${auditAlias(
        challenge.requestId
      )} server=${auditAlias(challenge.serverId)} channel=${auditAlias(
        channelId
      )}`
    );
    return {
      outcome: action === "exclude" ? "excluded" : "removed",
      purgedEvidence,
    };
  }

  async function requestChange(message, action, targetToken) {
    const serverId = serverIdFrom(message);
    const requesterId = message.authorId;
    const responseChannelId = channelIdFrom(message);
    if (!isSafeId(gate.resolveApprover())) {
      await respond(
        responseChannelId,
        "🔒 Approver Unavailable",
        `${ENKA_APPROVER_TAG} could not be resolved as the fixed approver, so privacy exclusions cannot be changed. Audit logging remains active.`,
        "#E74C3C"
      );
      return { outcome: "approver_unavailable" };
    }

    const auditChannelId = store.getAuditLogChannel(serverId);
    if (!isSafeId(auditChannelId)) {
      await respond(
        responseChannelId,
        "⚠️ Audit Log Required",
        "Enable the protected audit log before requesting a channel exclusion.",
        "#E74C3C"
      );
      return { outcome: "audit_log_required" };
    }

    const target = await resolveTarget(serverId, targetToken, message);
    if (!target) {
      await respond(
        responseChannelId,
        "⚠️ Invalid Privacy Channel",
        `Choose a text channel in this server using \`${commandName()} here\`, a channel mention, or a channel ID.`,
        "#E74C3C"
      );
      return { outcome: "invalid_channel" };
    }
    if (target.id === auditChannelId) {
      await respond(
        responseChannelId,
        "🛑 Audit Channel Cannot Be Excluded",
        "The protected audit-log destination must remain visible.",
        "#E74C3C"
      );
      return { outcome: "audit_channel" };
    }

    const alreadyExcluded = store.isChannelExcluded(target.id);
    if (
      (action === "exclude" && alreadyExcluded) ||
      (action === "remove" && !alreadyExcluded)
    ) {
      await respond(
        responseChannelId,
        "ℹ️ No Change Needed",
        action === "exclude"
          ? `${channelLabel(target.id)} is already privacy-excluded.`
          : `${channelLabel(target.id)} is not privacy-excluded.`,
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
      data: { action, channelId: target.id },
      buildDmPayload: (challenge, code) => ({
        embeds: [
          buildStatusEmbed(
            action === "exclude"
              ? "🔐 Approve Channel Privacy Exclusion"
              : "🔓 Approve Privacy Exclusion Removal",
            [
              `**Request:** \`${challenge.requestId}\``,
              `**Server:** ${serverLabel(serverId)}`,
              `**Channel:** ${channelLabel(target.id)}`,
              `**Requested by:** ${actorLabel(requesterId)}`,
              `**Action:** ${action}`,
              `**One-time code:** \`${code}\``,
              "",
              `Reply \`approve ${code}\`, \`deny ${code}\`, or just \`${code}\` to approve. A recognized moderator may also use \`${commandName()} confirm ${code}\` in the server.`,
              "This code expires in 10 minutes after 3 incorrect attempts.",
            ].join("\n"),
            "#9B59B6"
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
      const pending = result.pending;
      await respond(
        responseChannelId,
        "⏳ Protected Request Already Pending",
        `Request \`${pending.requestId}\` is already awaiting approval. Approve, deny, cancel, or wait for it to expire first.`,
        "#E67E22"
      );
      return result;
    }
    if (result.outcome === "approver_unavailable") {
      await respond(
        responseChannelId,
        "🔒 Approver Unavailable",
        `${ENKA_APPROVER_TAG} is unavailable, so no privacy state changed.`,
        "#E74C3C"
      );
      return result;
    }
    if (result.outcome === "dm_failed") {
      await respond(
        responseChannelId,
        "⚠️ Approval DM Failed",
        `${ENKA_APPROVER_TAG} could not be reached, so no request was retained and no exclusion state changed.`,
        "#E74C3C"
      );
      return result;
    }

    const challenge = result.challenge;
    await sendAccountability(
      challenge,
      "🔐 Privacy Exclusion Requested",
      [
        `**Request:** \`${challenge.requestId}\``,
        `**Action:** ${action}`,
        `**Channel:** ${channelLabel(target.id)}`,
        `**Requested by:** ${actorLabel(requesterId)}`,
        `**Approval:** awaiting ${ENKA_APPROVER_TAG}; expires in 10 minutes.`,
      ],
      "#9B59B6"
    );
    await respond(
      responseChannelId,
      "📨 Enka Approval Requested",
      `Request \`${challenge.requestId}\` was sent to ${ENKA_APPROVER_TAG}. No exclusion state has changed yet.`,
      "#9B59B6"
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
        "ℹ️ No Pending Privacy Request",
        "Start an exclusion or removal request first.",
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
        "ℹ️ No Pending Privacy Request",
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
        "🚫 Privacy Request Cancelled",
        "The pending request was cancelled.",
        "#E67E22"
      );
    }
    return result;
  }

  async function handleCommand(message, args = []) {
    await gate.expireDueChallenges();
    const serverId = serverIdFrom(message);
    if (!isSafeId(serverId)) {
      await respond(
        channelIdFrom(message),
        "🔒 Server Only",
        "Privacy exclusions can only be managed inside a server.",
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
    if (action === "remove") {
      if (!second || extra.length) {
        await respond(
          channelIdFrom(message),
          "⚠️ Missing Privacy Channel",
          `Use \`${commandName()} remove here\` or mention one text channel.`,
          "#E74C3C"
        );
        return { outcome: "missing_channel" };
      }
      return requestChange(message, "remove", second);
    }
    if (second || extra.length) {
      await respond(
        channelIdFrom(message),
        "⚠️ Invalid Privacy Command",
        `Use \`${commandName()} status\`, \`${commandName()} here\`, \`${commandName()} #channel\`, \`${commandName()} remove #channel\`, \`${commandName()} confirm CODE\`, or \`${commandName()} cancel\`.`,
        "#E74C3C"
      );
      return { outcome: "invalid_command" };
    }
    return requestChange(message, "exclude", first);
  }

  async function postDigest() {
    const grouped = new Map();
    for (const record of store.getAllChannelExclusions()) {
      const records = grouped.get(record.serverId) ?? [];
      records.push(record);
      grouped.set(record.serverId, records);
    }
    for (const [serverId, records] of grouped) {
      const auditChannelId = store.getAuditLogChannel(serverId);
      if (!isSafeId(auditChannelId)) continue;
      try {
        await sendProtected(auditChannelId, {
          embeds: [
            buildAuditEmbed(
              "🔐 Daily Privacy Exclusion Digest",
              [
                `**Server:** ${serverLabel(serverId)}`,
                "**Currently excluded channels:**",
                ...records.map(
                  (record) =>
                    `- ${channelLabel(record.channelId)} — approved <t:${Math.floor(
                      record.excludedAt / 1000
                    )}:R>`
                ),
                "Only message content is withheld; channel, role, permission, moderation, and membership events remain logged.",
              ],
              "#9B59B6"
            ),
          ],
        });
      } catch (error) {
        logger.warn?.(
          `channel-exclusion: digest failed server=${auditAlias(
            serverId
          )} ${safeErrorSummary(error)}`
        );
      }
    }
  }

  function startDigest() {
    if (digestStarted) return;
    digestStarted = true;
    const interval = scheduleInterval(
      () => void postDigest(),
      DIGEST_INTERVAL_MS
    );
    interval?.unref?.();
  }

  return {
    handleCommand,
    handleDirectMessage: gate.handleDirectMessage,
    resolveApprover: gate.resolveApprover,
    startDigest,
    postDigest,
    getPending(serverId) {
      const pending = gate.getPending(serverId);
      return pending?.kind === CHALLENGE_KIND ? pending : null;
    },
  };
}
