// approval-gate.js — Enka-approved 2FA for high-risk in-house actions
import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { buildStatusEmbed } from "./embeds.js";
import {
  auditAlias,
  CommandRateLimiter,
  isSafeId,
  safeErrorSummary,
} from "./security.js";

export const APPROVAL_CHALLENGE_TTL_MS = 10 * 60 * 1_000;
export const APPROVAL_MAX_ATTEMPTS = 3;
export const ENKA_APPROVER_USER_ID = "01H2VRZSN1AY7QASPNKXMP52HZ";
export const ENKA_APPROVER_TAG = "Enka#4961";

function hashCode(code, salt) {
  return createHash("sha256").update(salt).update(String(code)).digest();
}

function defaultCodeFactory() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function serverIdFrom(message) {
  return message?.server?.id ?? message?.channel?.serverId;
}

/**
 * Coordinate one process-local, fixed-approver challenge per server.
 *
 * Feature modules own their validation, mutations, public replies, and
 * accountability records. This gate owns the secret, expiry, attempts,
 * cancellation authorization, and the single Enka DM channel.
 */
export function createEnkaApprovalGate(
  client,
  {
    request,
    logger = console,
    now = Date.now,
    codeFactory = defaultCodeFactory,
    approverUserId = ENKA_APPROVER_USER_ID,
    scheduleTimeout = setTimeout,
    saltFactory = () => randomBytes(16),
  } = {}
) {
  if (typeof request !== "function") {
    throw new TypeError("The approval gate requires an HTTP requester.");
  }

  const pendingByServer = new Map();
  const dmRateLimiter = new CommandRateLimiter();
  const approverId = isSafeId(approverUserId) ? approverUserId : null;
  let approverWarningLogged = false;
  let approverDmId = null;

  function resolveApprover() {
    if (!approverId && !approverWarningLogged) {
      approverWarningLogged = true;
      logger.warn?.(
        "approval-gate: Enka approver id is invalid; protected mutations are disabled"
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
        `approval-gate: Enka approval DM failed ${safeErrorSummary(error)}`
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

  async function expireChallenge(challenge) {
    if (pendingByServer.get(challenge.serverId) !== challenge) return false;
    if (challenge.expiresAt > now()) return false;
    clearPending(challenge);
    await challenge.onExpired?.(challenge);
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

  async function requestChallenge({
    kind,
    requestId,
    serverId,
    requestedBy,
    requestChannelId,
    data,
    buildDmPayload,
    onApproved,
    onDenied,
    onExpired,
    onCancelled,
    onWrongCode,
    onAttemptsExhausted,
  }) {
    await expireDueChallenges();
    if (!isSafeId(resolveApprover())) {
      return { outcome: "approver_unavailable" };
    }
    if (
      typeof kind !== "string" ||
      !kind ||
      !isSafeId(requestId) ||
      !isSafeId(serverId) ||
      !isSafeId(requestedBy) ||
      typeof buildDmPayload !== "function" ||
      typeof onApproved !== "function"
    ) {
      throw new TypeError("The approval challenge is incomplete.");
    }

    const existing = pendingByServer.get(serverId);
    if (existing) {
      return {
        outcome: "pending_exists",
        pending: existing,
      };
    }

    const code = codeFactory();
    if (!/^\d{6}$/.test(code)) {
      throw new Error("The approval code factory returned an invalid code.");
    }
    const salt = Buffer.from(saltFactory());
    if (!salt.length) {
      throw new Error("The approval salt factory returned an invalid salt.");
    }
    const challenge = {
      kind,
      requestId,
      serverId,
      requestedBy,
      requestChannelId,
      data,
      codeHash: hashCode(code, salt),
      salt,
      expiresAt: now() + APPROVAL_CHALLENGE_TTL_MS,
      attempts: 0,
      timeout: null,
      onApproved,
      onDenied,
      onExpired,
      onCancelled,
      onWrongCode,
      onAttemptsExhausted,
    };
    pendingByServer.set(serverId, challenge);

    const delivered = await sendApprover(buildDmPayload(challenge, code));
    if (!delivered) {
      clearPending(challenge);
      return { outcome: "dm_failed" };
    }

    armExpiry(challenge);
    return { outcome: "requested", challenge };
  }

  async function rejectWrongCode(challenge, responseChannelId) {
    challenge.attempts += 1;
    const attemptsRemaining = APPROVAL_MAX_ATTEMPTS - challenge.attempts;
    if (attemptsRemaining <= 0) {
      clearPending(challenge);
      await challenge.onAttemptsExhausted?.(challenge, responseChannelId);
      return { outcome: "attempts_exhausted", attemptsRemaining: 0 };
    }
    await challenge.onWrongCode?.(
      challenge,
      attemptsRemaining,
      responseChannelId
    );
    return { outcome: "wrong_code", attemptsRemaining };
  }

  async function confirm({ serverId, kind, code, responseChannelId = null }) {
    await expireDueChallenges();
    const challenge = pendingByServer.get(serverId);
    if (!challenge) return { outcome: "no_pending" };
    if (challenge.kind !== kind) {
      return { outcome: "different_pending", pending: challenge };
    }
    if (!codeMatches(challenge, code)) {
      return rejectWrongCode(challenge, responseChannelId);
    }
    if (await expireChallenge(challenge)) return { outcome: "expired" };
    clearPending(challenge);
    return (
      (await challenge.onApproved(
        challenge,
        approverId,
        responseChannelId
      )) ?? { outcome: "approved" }
    );
  }

  async function cancel({ serverId, kind, actorId }) {
    await expireDueChallenges();
    const challenge = pendingByServer.get(serverId);
    if (!challenge) return { outcome: "no_pending" };
    if (challenge.kind !== kind) {
      return { outcome: "different_pending", pending: challenge };
    }
    if (actorId !== challenge.requestedBy && actorId !== approverId) {
      return { outcome: "not_requester" };
    }
    clearPending(challenge);
    await challenge.onCancelled?.(challenge, actorId);
    return { outcome: "cancelled" };
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
      const result = await rejectWrongCode(challenge, null);
      if (result.outcome === "wrong_code") {
        await sendApprover({
          embeds: [
            buildStatusEmbed(
              "⚠️ Incorrect Approval Code",
              `${result.attemptsRemaining} attempt(s) remain.`,
              "#E67E22"
            ),
          ],
        });
      }
      return true;
    }
    if (action === "deny") {
      clearPending(challenge);
      await challenge.onDenied?.(challenge, approverId);
      return true;
    }

    clearPending(challenge);
    try {
      await challenge.onApproved(challenge, approverId, null);
    } catch (error) {
      logger.warn?.(
        `approval-gate: approval callback failed kind=${challenge.kind} request=${auditAlias(
          challenge.requestId
        )} ${safeErrorSummary(error)}`
      );
      await sendApprover({
        embeds: [
          buildStatusEmbed(
            "⚠️ Approval Could Not Be Applied",
            `Request \`${challenge.requestId}\` failed closed without completing the requested change.`,
            "#E74C3C"
          ),
        ],
      });
    }
    return true;
  }

  return {
    requestChallenge,
    confirm,
    cancel,
    handleDirectMessage,
    resolveApprover,
    sendApprover,
    expireDueChallenges,
    getPending(serverId) {
      return pendingByServer.get(serverId) ?? null;
    },
  };
}
