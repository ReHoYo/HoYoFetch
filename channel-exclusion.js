// channel-exclusion.js — Enka-approved 2FA for audit-log message privacy
import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";
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
import {
  auditAlias,
  CommandRateLimiter,
  isSafeId,
  safeErrorSummary,
} from "./security.js";

export const EXCLUSION_CHALLENGE_TTL_MS = 10 * 60 * 1_000;
export const EXCLUSION_MAX_ATTEMPTS = 3;
export const ENKA_APPROVER_USER_ID = "01H2VRZSN1AY7QASPNKXMP52HZ";
export const ENKA_APPROVER_TAG = "Enka#4961";
const DIGEST_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const DEFAULT_STORE = Object.freeze({
  addChannelExclusion,
  getAllChannelExclusions,
  getAuditLogChannel,
  getExcludedChannels,
  isChannelExcluded,
  removeChannelExclusion,
});

function hashCode(code, salt) {
  return createHash("sha256").update(salt).update(String(code)).digest();
}

function defaultCodeFactory() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

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

/**
 * Create the channel-exclusion coordinator.
 *
 * Pending challenges are deliberately process-local: restarting the bot
 * invalidates every outstanding code.
 */
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
    codeFactory = defaultCodeFactory,
    requestIdFactory = defaultRequestIdFactory,
    approverUserId = ENKA_APPROVER_USER_ID,
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
  if (typeof request !== "function") {
    throw new TypeError("Channel exclusions require an HTTP requester.");
  }

  const pendingByServer = new Map();
  const dmRateLimiter = new CommandRateLimiter();
  const approverId = isSafeId(approverUserId) ? approverUserId : null;
  let approverWarningLogged = false;
  let approverDmId = null;
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

  function resolveApprover() {
    if (!approverId && !approverWarningLogged) {
      approverWarningLogged = true;
      logger.warn?.(
        "channel-exclusion: Enka approver id is invalid; mutations are disabled"
      );
    }
    return approverId;
  }

  async function getApproverDmId() {
    if (isSafeId(approverDmId)) return approverDmId;
    if (!isSafeId(approverId)) return null;
    const response = await request("GET", `/users/${approverId}/dm`);
    const dmId = response?.data?._id;
    if (!response?.ok || !isSafeId(dmId)) return null;
    approverDmId = dmId;
    return approverDmId;
  }

  async function sendApprover(payload) {
    try {
      const dmId = await getApproverDmId();
      if (!dmId) return false;
      const response = await request("POST", `/channels/${dmId}/messages`, {
        ...(payload.embeds?.length && !payload.content ? { content: " " } : {}),
        ...payload,
      });
      return Boolean(response?.ok && isSafeId(response?.data?._id));
    } catch (error) {
      logger.warn?.(
        `channel-exclusion: Enka approval DM failed ${safeErrorSummary(error)}`
      );
      return false;
    }
  }

  function codeMatches(challenge, code) {
    if (!/^\d{6}$/.test(String(code ?? ""))) return false;
    const actual = hashCode(code, challenge.salt);
    return (
      actual.length === challenge.codeHash.length &&
      timingSafeEqual(actual, challenge.codeHash)
    );
  }

  function clearPending(challenge) {
    if (pendingByServer.get(challenge.serverId) !== challenge) return;
    pendingByServer.delete(challenge.serverId);
    if (challenge.timeout) clearTimeout(challenge.timeout);
  }

  async function notifyTerminal(challenge, title, description, colour) {
    await sendApprover({
      embeds: [buildStatusEmbed(title, description, colour)],
    });
  }

  async function expireChallenge(challenge) {
    if (pendingByServer.get(challenge.serverId) !== challenge) return false;
    if (challenge.expiresAt > now()) return false;
    clearPending(challenge);
    await sendAccountability(
      challenge,
      "⌛ Privacy Exclusion Request Expired",
      [
        `**Request:** \`${challenge.requestId}\``,
        `**Action:** ${challenge.action}`,
        `**Channel:** ${channelLabel(challenge.channelId)}`,
        `**Requested by:** ${actorLabel(challenge.requestedBy)}`,
        "No exclusion state was changed.",
      ],
      "#E67E22"
    );
    await notifyTerminal(
      challenge,
      "⌛ Privacy Request Expired",
      `Request \`${challenge.requestId}\` for ${channelLabel(
        challenge.channelId
      )} expired without changing exclusion state.`,
      "#E67E22"
    );
    return true;
  }

  async function expireDueChallenges() {
    for (const challenge of [...pendingByServer.values()]) {
      await expireChallenge(challenge);
    }
  }

  function armExpiry(challenge) {
    const timeout = scheduleTimeout(
      () => void expireChallenge(challenge),
      Math.max(0, challenge.expiresAt - now())
    );
    timeout?.unref?.();
    challenge.timeout = timeout;
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
    const pending = pendingByServer.get(serverId);
    const lines = excluded.length
      ? excluded.map(
          (record) =>
            `- ${channelLabel(record.channelId)} — excluded <t:${Math.floor(
              record.excludedAt / 1000
            )}:R>`
        )
      : ["- *(none)*"];
    if (pending) {
      lines.push(
        "",
        `**Pending:** ${pending.action} ${channelLabel(
          pending.channelId
        )} requested by ${actorLabel(pending.requestedBy)}`
      );
    }
    await respond(
      channelIdFrom(message),
      "🔐 Audit Privacy Exclusions",
      lines.join("\n"),
      excluded.length ? "#9B59B6" : "#3498DB"
    );
    return { outcome: "status", excluded, pending: pending ?? null };
  }

  async function requestChange(message, action, targetToken) {
    const serverId = serverIdFrom(message);
    const requesterId = message.authorId;
    const responseChannelId = channelIdFrom(message);
    if (!isSafeId(resolveApprover())) {
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

    const existingPending = pendingByServer.get(serverId);
    if (existingPending) {
      await respond(
        responseChannelId,
        "⏳ Privacy Request Already Pending",
        `Request \`${existingPending.requestId}\` already targets ${channelLabel(
          existingPending.channelId
        )}. Approve, deny, cancel, or wait for it to expire first.`,
        "#E67E22"
      );
      return { outcome: "pending_exists" };
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

    const code = codeFactory();
    if (!/^\d{6}$/.test(code)) {
      throw new Error("The exclusion code factory returned an invalid code.");
    }
    const salt = randomBytes(16);
    const challenge = {
      requestId: requestIdFactory(),
      serverId,
      channelId: target.id,
      action,
      requestedBy: requesterId,
      requestChannelId: responseChannelId,
      codeHash: hashCode(code, salt),
      salt,
      expiresAt: now() + EXCLUSION_CHALLENGE_TTL_MS,
      attempts: 0,
      timeout: null,
    };
    pendingByServer.set(serverId, challenge);

    const delivered = await sendApprover({
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
            `Reply \`approve ${code}\`, \`deny ${code}\`, or just \`${code}\` to approve. The requester may also use \`${commandName()} confirm ${code}\` in the server.`,
            "This code expires in 10 minutes after 3 incorrect attempts.",
          ].join("\n"),
          "#9B59B6"
        ),
      ],
    });

    if (!delivered) {
      clearPending(challenge);
      await respond(
        responseChannelId,
        "⚠️ Approval DM Failed",
        `${ENKA_APPROVER_TAG} could not be reached, so no request was retained and no exclusion state changed.`,
        "#E74C3C"
      );
      return { outcome: "dm_failed" };
    }

    armExpiry(challenge);
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

  async function attemptsExhausted(challenge, responseChannelId) {
    clearPending(challenge);
    await sendAccountability(
      challenge,
      "🛑 Privacy Request Attempts Exhausted",
      [
        `**Request:** \`${challenge.requestId}\``,
        `**Channel:** ${channelLabel(challenge.channelId)}`,
        `**Requested by:** ${actorLabel(challenge.requestedBy)}`,
        `**Attempts:** ${EXCLUSION_MAX_ATTEMPTS}`,
        "No exclusion state was changed.",
      ],
      "#E74C3C"
    );
    await notifyTerminal(
      challenge,
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
    return { outcome: "attempts_exhausted" };
  }

  async function rejectWrongCode(challenge, responseChannelId) {
    challenge.attempts += 1;
    if (challenge.attempts >= EXCLUSION_MAX_ATTEMPTS) {
      return attemptsExhausted(challenge, responseChannelId);
    }
    if (isSafeId(responseChannelId)) {
      await respond(
        responseChannelId,
        "⚠️ Incorrect Approval Code",
        `${EXCLUSION_MAX_ATTEMPTS - challenge.attempts} attempt(s) remain.`,
        "#E67E22"
      );
    }
    return {
      outcome: "wrong_code",
      attemptsRemaining: EXCLUSION_MAX_ATTEMPTS - challenge.attempts,
    };
  }

  async function approve(challenge, approvedBy, responseChannelId) {
    if (await expireChallenge(challenge)) {
      if (isSafeId(responseChannelId)) {
        await respond(
          responseChannelId,
          "⌛ Approval Code Expired",
          "Start a new privacy request to receive a fresh code.",
          "#E67E22"
        );
      }
      return { outcome: "expired" };
    }
    clearPending(challenge);

    let purgedEvidence = 0;
    if (challenge.action === "exclude") {
      store.addChannelExclusion({
        channelId: challenge.channelId,
        serverId: challenge.serverId,
        excludedAt: now(),
        requestedBy: challenge.requestedBy,
        approvedBy,
        requestId: challenge.requestId,
      });
      const paths = purgeArchive(challenge.channelId);
      for (const path of paths) {
        if (removeEvidence(path)) purgedEvidence += 1;
      }
    } else {
      store.removeChannelExclusion(challenge.channelId);
    }

    const title = terminalTitle(challenge.action);
    const description =
      challenge.action === "exclude"
        ? `${channelLabel(
            challenge.channelId
          )} will no longer archive or relay message content. Existing archived content and ${purgedEvidence} evidence file(s) were purged.`
        : `${channelLabel(
            challenge.channelId
          )} will resume message-content logging for new activity.`;
    await sendAccountability(
      challenge,
      title,
      [
        `**Request:** \`${challenge.requestId}\``,
        `**Channel:** ${channelLabel(challenge.channelId)}`,
        `**Requested by:** ${actorLabel(challenge.requestedBy)}`,
        `**Approved by:** ${ENKA_APPROVER_TAG} (<@${approvedBy}>)`,
        description,
      ],
      challenge.action === "exclude" ? "#9B59B6" : "#2ECC71"
    );
    await notifyTerminal(
      challenge,
      title,
      `Request \`${challenge.requestId}\` completed. ${description}`,
      challenge.action === "exclude" ? "#9B59B6" : "#2ECC71"
    );
    if (isSafeId(responseChannelId)) {
      await respond(
        responseChannelId,
        title,
        description,
        challenge.action === "exclude" ? "#9B59B6" : "#2ECC71"
      );
    }
    logger.log?.(
      `🔐  channel-exclusion ${challenge.action} request=${auditAlias(
        challenge.requestId
      )} server=${auditAlias(challenge.serverId)} channel=${auditAlias(
        challenge.channelId
      )}`
    );
    return {
      outcome: challenge.action === "exclude" ? "excluded" : "removed",
      purgedEvidence,
    };
  }

  async function confirmInServer(message, code) {
    const serverId = serverIdFrom(message);
    const challenge = pendingByServer.get(serverId);
    if (!challenge) {
      await respond(
        channelIdFrom(message),
        "ℹ️ No Pending Privacy Request",
        "Start an exclusion or removal request first.",
        "#3498DB"
      );
      return { outcome: "no_pending" };
    }
    if (!codeMatches(challenge, code)) {
      return rejectWrongCode(challenge, channelIdFrom(message));
    }
    return approve(challenge, approverId, channelIdFrom(message));
  }

  async function cancel(message) {
    const serverId = serverIdFrom(message);
    const challenge = pendingByServer.get(serverId);
    if (!challenge) {
      await respond(
        channelIdFrom(message),
        "ℹ️ No Pending Privacy Request",
        "There is no request to cancel.",
        "#3498DB"
      );
      return { outcome: "no_pending" };
    }
    if (
      message.authorId !== challenge.requestedBy &&
      message.authorId !== approverId
    ) {
      await respond(
        channelIdFrom(message),
        "🔒 Cannot Cancel This Request",
        `Only the original requester or ${ENKA_APPROVER_TAG} can cancel it.`,
        "#E74C3C"
      );
      return { outcome: "not_requester" };
    }
    clearPending(challenge);
    await sendAccountability(
      challenge,
      "🚫 Privacy Exclusion Request Cancelled",
      [
        `**Request:** \`${challenge.requestId}\``,
        `**Channel:** ${channelLabel(challenge.channelId)}`,
        `**Cancelled by:** ${actorLabel(message.authorId)}`,
        "No exclusion state was changed.",
      ],
      "#E67E22"
    );
    await notifyTerminal(
      challenge,
      "🚫 Privacy Request Cancelled",
      `Request \`${challenge.requestId}\` was cancelled by ${actorLabel(
        message.authorId
      )}.`,
      "#E67E22"
    );
    await respond(
      channelIdFrom(message),
      "🚫 Privacy Request Cancelled",
      `Request \`${challenge.requestId}\` was cancelled.`,
      "#E67E22"
    );
    return { outcome: "cancelled" };
  }

  async function handleCommand(message, args = []) {
    await expireDueChallenges();
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
      if (!isSafeId(resolveApprover())) {
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

  function findDirectChallenge(code) {
    const challenges = [...pendingByServer.values()];
    const matching = challenges.filter((challenge) =>
      codeMatches(challenge, code)
    );
    if (matching.length === 1) return matching[0];
    if (matching.length === 0 && challenges.length === 1) return challenges[0];
    return null;
  }

  async function handleDirectMessage(message) {
    if (isSafeId(serverIdFrom(message))) return false;
    if (message.authorId !== approverId) return false;

    const raw = String(message.content ?? "").trim();
    const match = raw.match(/^(?:(approve|deny)\s+)?(\d{6})$/i);
    if (!match) return false;

    const rate = dmRateLimiter.check(message.authorId);
    if (!rate.allowed) {
      if (rate.notify) {
        await sendApprover({
          embeds: [
            buildStatusEmbed(
              "⏳ Too Many Approval Attempts",
              `Try again in ${Math.max(
                1,
                Math.ceil(rate.retryAfterMs / 1000)
              )} seconds.`,
              "#E67E22"
            ),
          ],
        });
      }
      return true;
    }

    await expireDueChallenges();
    const action = (match[1] ?? "approve").toLowerCase();
    const code = match[2];
    const challenge = findDirectChallenge(code);
    if (!challenge) {
      await sendApprover({
        embeds: [
          buildStatusEmbed(
            "⚠️ Approval Code Not Found",
            "No unique pending request matches that code.",
            "#E74C3C"
          ),
        ],
      });
      return true;
    }
    if (!codeMatches(challenge, code)) {
      await rejectWrongCode(challenge, null);
      if (pendingByServer.get(challenge.serverId) === challenge) {
        await sendApprover({
          embeds: [
            buildStatusEmbed(
              "⚠️ Incorrect Approval Code",
              `${EXCLUSION_MAX_ATTEMPTS - challenge.attempts} attempt(s) remain.`,
              "#E67E22"
            ),
          ],
        });
      }
      return true;
    }
    if (action === "deny") {
      clearPending(challenge);
      await sendAccountability(
        challenge,
        "🚫 Privacy Exclusion Request Denied",
        [
          `**Request:** \`${challenge.requestId}\``,
          `**Action:** ${challenge.action}`,
          `**Channel:** ${channelLabel(challenge.channelId)}`,
          `**Requested by:** ${actorLabel(challenge.requestedBy)}`,
          `**Denied by:** ${ENKA_APPROVER_TAG}`,
          "No exclusion state was changed.",
        ],
        "#E74C3C"
      );
      await notifyTerminal(
        challenge,
        "🚫 Privacy Request Denied",
        `Request \`${challenge.requestId}\` was denied. No exclusion state changed.`,
        "#E74C3C"
      );
      return true;
    }
    await approve(challenge, approverId, null);
    return true;
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
    handleDirectMessage,
    resolveApprover,
    startDigest,
    postDigest,
    getPending(serverId) {
      return pendingByServer.get(serverId) ?? null;
    },
  };
}
