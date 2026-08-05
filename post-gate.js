// post-gate.js — First-post gate for very new or first-time accounts
// ────────────────────────────────────────────────────────────────────
// A raid account that joins and immediately posts a link or attachment
// passes straight through automod.js's behavioural detection, which needs
// several messages (rapid burst, duplicate flood, mention flood) to
// accumulate before it triggers. This module closes that gap: when a link
// or attachment arrives from an account that is new, newly joined, or has
// never posted in this server before, the message is deleted and held for
// a single moderator's ✅/❌ review instead of staying visible unreviewed.
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
import { nextStrikeLevel } from "./automod.js";
import { parseChannelArg } from "./auditlog.js";
import { buildAuditEmbed, buildStatusEmbed } from "./embeds.js";
import { countArchivedMessages } from "./message-archive.js";
import { policyFor } from "./moderation-policy.js";
import { deriveAccountCreatedAt } from "./user-info.js";
import {
  clearAutomodStrike,
  createHeldPost,
  findHeldPostByReviewMessage,
  getAutomodStrike,
  getExpiredPendingPosts,
  getHeldPost,
  getModerationLevel,
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
  isSafeId,
  safeErrorSummary,
} from "./security.js";

export { ENKA_APPROVER_TAG, ENKA_APPROVER_USER_ID };
export const POST_GATE_CHALLENGE_TTL_MS = APPROVAL_CHALLENGE_TTL_MS;
export const POST_GATE_MAX_ATTEMPTS = APPROVAL_MAX_ATTEMPTS;

const CHALLENGE_KIND = "post_gate";
export const REVIEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const QUEUE_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const APPROVE_EMOJI = "✅";
const REJECT_EMOJI = "❌";

// Bare https/www links, plus a common-TLD bare-domain form (obfuscated
// links — spaced-out domains, homoglyphs — are intentionally out of scope;
// see moderation/post-gate.md).
const LINK_PATTERN =
  /(https?:\/\/[^\s<>]+|www\.[^\s<>]+\.[a-z]{2,}(?:\/\S*)?|\b[a-z0-9-]+\.(?:com|net|org|io|gg|co|dev|xyz|app|me|link|gift|shop)\b(?:\/\S*)?)/i;

function hasLinkOrAttachment(message) {
  return Boolean(
    (message?.attachments && message.attachments.length > 0) ||
    LINK_PATTERN.test(String(message?.content ?? ""))
  );
}

const DEFAULT_STORE = Object.freeze({
  clearAutomodStrike,
  createHeldPost,
  findHeldPostByReviewMessage,
  getAutomodStrike,
  getExpiredPendingPosts,
  getHeldPost,
  getModerationLevel,
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

  function commandName() {
    return `${prefix}Post-Gate`;
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
    store.setPostGateConfig(challenge.serverId, {
      mode: action === "off" ? "off" : "hold",
      reviewChannelId: action === "off" ? null : channelId,
    });

    const title = terminalTitle(action);
    const description =
      action === "off"
        ? "The post gate is now off. New links and attachments from new or first-time posters will no longer be held."
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
  function isFirstPostCandidate(serverId, authorId, message, policy) {
    const current = now();
    const accountCreatedAt =
      message.author?.createdAt ?? deriveAccountCreatedAt(authorId);
    const joinedAt = message.member?.joinedAt ?? null;
    const isNewAccount =
      accountCreatedAt instanceof Date &&
      current - accountCreatedAt.getTime() >= 0 &&
      current - accountCreatedAt.getTime() < policy.recentAccountMs;
    const isNewMember =
      joinedAt instanceof Date &&
      current - joinedAt.getTime() >= 0 &&
      current - joinedAt.getTime() < policy.recentMemberMs;
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
    message,
    config,
    resolveDecision
  ) {
    const messageId = message.id ?? message._id;
    const prepared = await prepareAttachmentCopies(
      client,
      message.attachments,
      {
        fetchImpl,
      }
    );

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
      userId: message.authorId,
      messageId,
      content: message.content ?? "",
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
      `🛑  post-gate held queue=${auditAlias(record.queueId)} actor=${auditAlias(message.authorId)} server=${auditAlias(serverId)}`
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
    if (channelId === config.reviewChannelId) return;
    if (store.isChannelExcluded(channelId)) return;
    // All levels hold only links and attachments; levels 2/3 widen who
    // counts as "new" and lower automod's trip threshold instead of
    // holding plain text.
    const policy = policyFor(store.getModerationLevel(serverId));
    if (!policy.holdEveryMessage && !hasLinkOrAttachment(message)) return;
    // The first-post signal is only meaningful for a message actually
    // eligible for a hold, so this stays inside the gate rather than
    // running (and racing the archive) on every message.
    if (!isFirstPostCandidate(serverId, authorId, message, policy)) return;

    let resolveDecision;
    const decision = new Promise((resolve) => {
      resolveDecision = resolve;
    });
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

      await holdMessage(serverId, channelId, message, config, resolveDecision);
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
    { strikeCleared = false } = {}
  ) {
    const title =
      outcome === "approved"
        ? "✅ Held Post Approved"
        : "❌ Held Post Rejected";
    const description =
      outcome === "approved"
        ? `${actorLabel(record.userId)} was cleared${strikeCleared ? " and their automod strike was reset" : ""}. The content was **not** reposted to ${channelLabel(record.channelId)} — they can post it again themselves.`
        : `The held content from ${actorLabel(record.userId)} was discarded and their automod strike level was increased.`;
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
    const strikeCleared = Boolean(
      store.clearAutomodStrike(record.serverId, record.userId)
    );
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
    const stored = store.getAutomodStrike(record.serverId, record.userId);
    const level = nextStrikeLevel(stored, current);
    store.setAutomodStrike(record.serverId, record.userId, {
      level,
      lastContainedAt: current,
      timeoutUntil: stored?.timeoutUntil ?? null,
    });

    store.updateHeldPost(queueId, {
      status: "rejected",
      reviewedBy: moderatorId,
      reviewedAt: current,
    });
    await notifyReviewOutcome(record, "rejected", moderatorId);
    logger.log?.(
      `🛑  post-gate rejected queue=${auditAlias(queueId)} moderator=${auditAlias(moderatorId)} strike=${level}`
    );
    return { outcome: "rejected", strikeLevel: level };
  }

  async function handleRawEvent(event) {
    if (
      event?.type !== "MessageReact" ||
      !isSafeId(event.id) ||
      !isSafeId(event.user_id) ||
      event.user_id === client.user?.id ||
      (event.emoji_id !== APPROVE_EMOJI && event.emoji_id !== REJECT_EMOJI)
    ) {
      return;
    }
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
          "The held post was discarded and the author's automod strike level was increased.",
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
  }

  async function shouldExcludeMessage(message) {
    const messageId = message?.id ?? message?._id;
    // Mirrors handleMessage's own eligibility check: only links/attachments
    // are ever held, and the archive must not record a message this module
    // is about to delete.
    const serverId = serverIdFrom(message);
    const policy = isSafeId(serverId)
      ? policyFor(store.getModerationLevel(serverId))
      : policyFor(null);
    if (!policy.holdEveryMessage && !hasLinkOrAttachment(message)) return false;
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
    handleMessage,
    handleRawEvent,
    handleDirectMessage: gate.handleDirectMessage,
    resolveApprover: gate.resolveApprover,
    shouldExcludeMessage,
    shouldExcludeMessageDelete,
    startQueuePrune,
    maintainQueue,
    getPending(serverId) {
      const pending = gate.getPending(serverId);
      return pending?.kind === CHALLENGE_KIND ? pending : null;
    },
  };
}
