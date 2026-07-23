// audit-log-configuration.js — 2FA-gated audit destination management
import { randomBytes } from "crypto";
import { APPROVAL_MAX_ATTEMPTS, ENKA_APPROVER_TAG } from "./approval-gate.js";
import { parseChannelArg } from "./auditlog.js";
import { buildAuditEmbed, buildStatusEmbed } from "./embeds.js";
import {
  disableAuditLog,
  enableAuditLog,
  getAuditLogChannel,
} from "./store.js";
import { auditAlias, isSafeId, safeErrorSummary } from "./security.js";

const CHALLENGE_KIND = "audit_log_configuration";

const DEFAULT_STORE = Object.freeze({
  disableAuditLog,
  enableAuditLog,
  getAuditLogChannel,
});

function defaultRequestIdFactory() {
  return `AL${randomBytes(8).toString("hex").toUpperCase()}`;
}

function channelIdFrom(message) {
  return message?.channelId ?? message?.channel?.id;
}

function serverIdFrom(message) {
  return message?.server?.id ?? message?.channel?.serverId;
}

export function createAuditLogConfiguration(
  client,
  {
    send,
    sendProtected,
    approvalGate,
    prefix = "/",
    store = DEFAULT_STORE,
    logger = console,
    requestIdFactory = defaultRequestIdFactory,
    configurationChanged = async () => {},
  } = {}
) {
  if (typeof send !== "function") {
    throw new TypeError("Audit-log configuration requires a sender.");
  }
  if (typeof sendProtected !== "function") {
    throw new TypeError("Audit-log configuration requires a protected sender.");
  }
  if (!approvalGate) {
    throw new TypeError("Audit-log configuration requires an approval gate.");
  }

  function commandName() {
    return `${prefix}AuditLog`;
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

  async function sendProtectedNotice(channelId, title, lines, colour) {
    if (!isSafeId(channelId)) return undefined;
    try {
      return await sendProtected(channelId, {
        embeds: [buildAuditEmbed(title, lines, colour)],
      });
    } catch (error) {
      logger.warn?.(
        `audit-log-configuration: protected notice failed channel=${auditAlias(
          channelId
        )} ${safeErrorSummary(error)}`
      );
      return undefined;
    }
  }

  async function notifyApprover(title, description, colour) {
    await approvalGate.sendApprover({
      embeds: [buildStatusEmbed(title, description, colour)],
    });
  }

  function resolveTarget(serverId, channelId) {
    if (!isSafeId(channelId)) return null;
    const channel = client.channels?.get?.(channelId);
    let canSend = false;
    try {
      canSend = Boolean(channel?.havePermission?.("SendMessage"));
    } catch {
      canSend = false;
    }
    return channel &&
      channel.serverId === serverId &&
      channel.type === "TextChannel" &&
      canSend
      ? channel
      : null;
  }

  function actionDescription(action, channelId, previousChannelId) {
    if (action === "disable") return "disable audit logging";
    if (isSafeId(previousChannelId)) {
      return `move audit logging from ${channelLabel(
        previousChannelId
      )} to ${channelLabel(channelId)}`;
    }
    return `enable audit logging in ${channelLabel(channelId)}`;
  }

  async function status(message) {
    const serverId = serverIdFrom(message);
    const configured = store.getAuditLogChannel(serverId);
    const pending = approvalGate.getPending(serverId);
    const auditPending = pending?.kind === CHALLENGE_KIND ? pending : null;
    const pendingLine = auditPending
      ? `\n**Pending:** request \`${auditPending.requestId}\` to ${actionDescription(
          auditPending.data.action,
          auditPending.data.channelId,
          auditPending.data.previousChannelId
        )}.`
      : pending
        ? `\n**Pending protected action:** request \`${pending.requestId}\`.`
        : "";
    await respond(
      channelIdFrom(message),
      "📋 Audit Log Status",
      configured
        ? `Audit logging is active in ${channelLabel(
            configured
          )}.${pendingLine}\nUse \`${commandName()} here\`, \`${commandName()} #channel\`, or \`${commandName()} off\` to request a change.`
        : `Audit logging is off.${pendingLine}\nUse \`${commandName()} here\` or \`${commandName()} #channel\` to request enabling it.`,
      configured ? "#3498DB" : "#808080"
    );
    return {
      outcome: "status",
      channelId: configured,
      pending: auditPending,
    };
  }

  async function sendLifecycle(challenge, title, extraLines, colour) {
    const previousChannelId = challenge.data.previousChannelId;
    return sendProtectedNotice(
      previousChannelId,
      title,
      [
        `**Request:** \`${challenge.requestId}\``,
        `**Action:** ${actionDescription(
          challenge.data.action,
          challenge.data.channelId,
          previousChannelId
        )}`,
        `**Requested by:** ${actorLabel(challenge.requestedBy)}`,
        ...extraLines,
      ],
      colour
    );
  }

  async function onExpired(challenge) {
    await sendLifecycle(
      challenge,
      "⌛ Audit Log Change Request Expired",
      ["No audit-log configuration changed."],
      "#E67E22"
    );
    await notifyApprover(
      "⌛ Audit Log Request Expired",
      `Request \`${challenge.requestId}\` expired without changing audit logging.`,
      "#E67E22"
    );
  }

  async function onDenied(challenge) {
    await sendLifecycle(
      challenge,
      "🚫 Audit Log Change Request Denied",
      [
        `**Denied by:** ${ENKA_APPROVER_TAG}`,
        "No audit-log configuration changed.",
      ],
      "#E74C3C"
    );
    await notifyApprover(
      "🚫 Audit Log Request Denied",
      `Request \`${challenge.requestId}\` was denied. Audit logging is unchanged.`,
      "#E74C3C"
    );
  }

  async function onCancelled(challenge, actorId) {
    await sendLifecycle(
      challenge,
      "🚫 Audit Log Change Request Cancelled",
      [
        `**Cancelled by:** ${actorLabel(actorId)}`,
        "No audit-log configuration changed.",
      ],
      "#E67E22"
    );
    await notifyApprover(
      "🚫 Audit Log Request Cancelled",
      `Request \`${challenge.requestId}\` was cancelled by ${actorLabel(
        actorId
      )}.`,
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
    await sendLifecycle(
      challenge,
      "🛑 Audit Log Request Attempts Exhausted",
      [
        `**Attempts:** ${APPROVAL_MAX_ATTEMPTS}`,
        "No audit-log configuration changed.",
      ],
      "#E74C3C"
    );
    await notifyApprover(
      "🛑 Audit Log Request Cancelled",
      `Request \`${challenge.requestId}\` was destroyed after ${APPROVAL_MAX_ATTEMPTS} incorrect code attempts.`,
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

  async function stale(challenge, responseChannelId, reason) {
    await sendLifecycle(
      challenge,
      "⚠️ Audit Log Change Became Stale",
      [reason, "No additional configuration change was made."],
      "#E67E22"
    );
    await notifyApprover(
      "⚠️ Audit Log Request Became Stale",
      `Request \`${challenge.requestId}\` no longer matches current state. Start a fresh request if needed.`,
      "#E67E22"
    );
    if (isSafeId(responseChannelId)) {
      await respond(
        responseChannelId,
        "⚠️ Audit Log Request Became Stale",
        `${reason} Start a fresh request.`,
        "#E67E22"
      );
    }
    return { outcome: "stale" };
  }

  async function onApproved(challenge, approvedBy, responseChannelId) {
    const { action, channelId, previousChannelId } = challenge.data;
    const currentChannelId = store.getAuditLogChannel(challenge.serverId);
    if ((currentChannelId ?? null) !== (previousChannelId ?? null)) {
      return stale(
        challenge,
        responseChannelId,
        "The configured audit destination changed before approval."
      );
    }
    if (action !== "disable" && !resolveTarget(challenge.serverId, channelId)) {
      return stale(
        challenge,
        responseChannelId,
        "The requested destination is no longer an available text channel where Irminsul can send messages."
      );
    }

    const approvalLines = [
      `**Approved by:** ${ENKA_APPROVER_TAG} (<@${approvedBy}>)`,
    ];
    if (isSafeId(previousChannelId)) {
      await sendLifecycle(
        challenge,
        action === "disable"
          ? "🔕 Audit Log Disable Approved"
          : "🔁 Audit Log Move Approved",
        approvalLines,
        action === "disable" ? "#E67E22" : "#2ECC71"
      );
    }

    let outcome;
    let publicTitle;
    let publicDescription;
    let colour;
    if (action === "disable") {
      store.disableAuditLog(challenge.serverId);
      outcome = "disabled";
      publicTitle = "🔕 Audit Log Disabled";
      publicDescription =
        "Enka approved the request. This server will no longer receive audit log messages.";
      colour = "#E67E22";
    } else {
      const result = store.enableAuditLog(challenge.serverId, channelId);
      outcome = result.wasEnabled ? "moved" : "enabled";
      publicTitle = result.wasEnabled
        ? "✅ Audit Log Destination Updated"
        : "✅ Audit Log Enabled";
      publicDescription = result.wasEnabled
        ? `Enka approved the request. Audit logging moved to ${channelLabel(
            channelId
          )}.`
        : `Enka approved the request. Audit logging is now active in ${channelLabel(
            channelId
          )}.`;
      colour = "#2ECC71";
    }

    await configurationChanged(challenge.serverId);

    if (action !== "disable") {
      await sendProtectedNotice(
        channelId,
        outcome === "moved"
          ? "🔁 Audit Log Destination Updated"
          : "✅ Audit Log Enabled",
        [
          `**Request:** \`${challenge.requestId}\``,
          `**Requested by:** ${actorLabel(challenge.requestedBy)}`,
          `**Approved by:** ${ENKA_APPROVER_TAG} (<@${approvedBy}>)`,
          outcome === "moved" && isSafeId(previousChannelId)
            ? `**Previous destination:** ${channelLabel(previousChannelId)}`
            : "**Previous destination:** audit logging was off",
          `**Current destination:** ${channelLabel(channelId)}`,
        ],
        "#2ECC71"
      );
    }

    await notifyApprover(
      publicTitle,
      `Request \`${challenge.requestId}\` completed. ${publicDescription}`,
      colour
    );
    if (isSafeId(responseChannelId)) {
      await respond(responseChannelId, publicTitle, publicDescription, colour);
    }
    logger.log?.(
      `🔐  audit-log ${outcome} request=${auditAlias(
        challenge.requestId
      )} server=${auditAlias(challenge.serverId)}`
    );
    return { outcome, channelId: action === "disable" ? null : channelId };
  }

  async function requestChange(message, action, channelId = null) {
    const serverId = serverIdFrom(message);
    const responseChannelId = channelIdFrom(message);
    const requestedBy = message.authorId;
    const previousChannelId = store.getAuditLogChannel(serverId);

    if (action === "disable" && !isSafeId(previousChannelId)) {
      await respond(
        responseChannelId,
        "ℹ️ Audit Log Already Off",
        "Audit logging was already off for this server. No approval is needed.",
        "#3498DB"
      );
      return { outcome: "no_change" };
    }
    if (action !== "disable") {
      if (!resolveTarget(serverId, channelId)) {
        await respond(
          responseChannelId,
          "⚠️ Unavailable Audit Log Channel",
          "Choose a text channel in this server where I have **Send Messages** permission.",
          "#E74C3C"
        );
        return { outcome: "invalid_channel" };
      }
      if (previousChannelId === channelId) {
        await respond(
          responseChannelId,
          "ℹ️ Already Enabled",
          `Audit logging is already active in ${channelLabel(
            channelId
          )}. No approval is needed.`,
          "#3498DB"
        );
        return { outcome: "no_change", channelId };
      }
    }

    const result = await approvalGate.requestChallenge({
      kind: CHALLENGE_KIND,
      requestId: requestIdFactory(),
      serverId,
      requestedBy,
      requestChannelId: responseChannelId,
      data: { action, channelId, previousChannelId },
      buildDmPayload: (challenge, code) => ({
        embeds: [
          buildStatusEmbed(
            action === "disable"
              ? "🔕 Approve Audit Log Disable"
              : isSafeId(previousChannelId)
                ? "🔁 Approve Audit Log Move"
                : "✅ Approve Audit Log Enable",
            [
              `**Request:** \`${challenge.requestId}\``,
              `**Server:** ${serverLabel(serverId)}`,
              `**Requested by:** ${actorLabel(requestedBy)}`,
              `**Action:** ${actionDescription(
                action,
                channelId,
                previousChannelId
              )}`,
              `**One-time code:** \`${code}\``,
              "",
              `Reply \`approve ${code}\`, \`deny ${code}\`, or just \`${code}\` to approve. A recognized moderator may also use \`${commandName()} confirm ${code}\` in the server.`,
              "This code expires in 10 minutes after 3 incorrect attempts.",
            ].join("\n"),
            action === "disable" ? "#E67E22" : "#9B59B6"
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
        `${ENKA_APPROVER_TAG} is unavailable, so audit logging remains unchanged.`,
        "#E74C3C"
      );
      return result;
    }
    if (result.outcome === "dm_failed") {
      await respond(
        responseChannelId,
        "⚠️ Approval DM Failed",
        `${ENKA_APPROVER_TAG} could not be reached, so no request was retained and audit logging remains unchanged.`,
        "#E74C3C"
      );
      return result;
    }

    const challenge = result.challenge;
    await sendLifecycle(
      challenge,
      "🔐 Audit Log Change Requested",
      [
        `**Approval:** awaiting ${ENKA_APPROVER_TAG}; expires in 10 minutes.`,
        "Audit logging remains unchanged until approval.",
      ],
      "#9B59B6"
    );
    await respond(
      responseChannelId,
      "📨 Enka Approval Requested",
      `Request \`${challenge.requestId}\` was sent to ${ENKA_APPROVER_TAG}. Audit logging has not changed yet.`,
      "#9B59B6"
    );
    return { outcome: "requested", requestId: challenge.requestId };
  }

  async function confirm(message, code) {
    const result = await approvalGate.confirm({
      serverId: serverIdFrom(message),
      kind: CHALLENGE_KIND,
      code,
      responseChannelId: channelIdFrom(message),
    });
    if (result.outcome === "no_pending") {
      await respond(
        channelIdFrom(message),
        "ℹ️ No Pending Audit Log Request",
        "Request an audit-log configuration change first.",
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
    const result = await approvalGate.cancel({
      serverId: serverIdFrom(message),
      kind: CHALLENGE_KIND,
      actorId: message.authorId,
    });
    if (result.outcome === "no_pending") {
      await respond(
        channelIdFrom(message),
        "ℹ️ No Pending Audit Log Request",
        "There is no audit-log request to cancel.",
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
        "🚫 Audit Log Request Cancelled",
        "The pending request was cancelled. Audit logging is unchanged.",
        "#E67E22"
      );
    }
    return result;
  }

  async function handleCommand(message, args = []) {
    const serverId = serverIdFrom(message);
    if (!isSafeId(serverId)) {
      await respond(
        channelIdFrom(message),
        "🔒 Server Only",
        "Audit logging can only be configured inside a server.",
        "#E74C3C"
      );
      return { outcome: "server_only" };
    }

    await approvalGate.expireDueChallenges();
    const [first = "status", second, ...extra] = args;
    const action = first.toLowerCase();
    if (!args.length || action === "status") return status(message);
    if (action === "cancel" && !second && !extra.length) {
      return cancel(message);
    }
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
      return confirm(message, second);
    }
    if (action === "off" && !second && !extra.length) {
      return requestChange(message, "disable");
    }
    if (second || extra.length) {
      await respond(
        channelIdFrom(message),
        "⚠️ Invalid Audit Log Command",
        `Use \`${commandName()} status\`, \`${commandName()} here\`, \`${commandName()} #channel\`, \`${commandName()} off\`, \`${commandName()} confirm CODE\`, or \`${commandName()} cancel\`.`,
        "#E74C3C"
      );
      return { outcome: "invalid_command" };
    }

    const targetId =
      action === "here" ? channelIdFrom(message) : parseChannelArg(first);
    if (!targetId) {
      await respond(
        channelIdFrom(message),
        "⚠️ Invalid Audit Log Channel",
        `Use \`${commandName()} here\`, a channel mention or ID, \`${commandName()} status\`, or \`${commandName()} off\`.`,
        "#E74C3C"
      );
      return { outcome: "invalid_channel" };
    }
    return requestChange(message, "enable", targetId);
  }

  async function handleLegacyEnable(message) {
    return requestChange(message, "enable", channelIdFrom(message));
  }

  async function handleLegacyDisable(message) {
    return requestChange(message, "disable");
  }

  return {
    handleCommand,
    handleLegacyEnable,
    handleLegacyDisable,
    getPending(serverId) {
      const pending = approvalGate.getPending(serverId);
      return pending?.kind === CHALLENGE_KIND ? pending : null;
    },
  };
}
