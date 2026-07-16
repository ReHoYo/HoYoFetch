// spam-report.js — abuse-resistant member reports for private spam/scam activity
import { randomBytes } from "crypto";
import { buildStatusEmbed } from "./embeds.js";
import {
  createSpamReport,
  findRecentSpamReport,
  getAuditLogChannel,
  getRecentSpamReports,
  pruneSpamReports,
} from "./store.js";
import {
  auditAlias,
  authorizeServerActor,
  COMMAND_ACCESS,
  isSafeId,
  safeErrorSummary,
} from "./security.js";

export const SPAM_REPORT_WINDOW_MS = 24 * 60 * 60_000;
export const SPAM_REPORT_ATTEMPT_COOLDOWN_MS = 60_000;
export const SPAM_REPORT_DAILY_LIMIT = 3;
export const SPAM_REPORT_PRIORITY_THRESHOLD = 3;
export const SPAM_REPORT_MIN_REASON_LENGTH = 10;
export const SPAM_REPORT_MAX_REASON_LENGTH = 300;

const MAX_ATTEMPT_ACTORS = 5_000;

const DEFAULT_STORE = Object.freeze({
  createSpamReport,
  findRecentSpamReport,
  getAuditLogChannel,
  getRecentSpamReports,
  pruneSpamReports,
});

export function createSpamReportId() {
  return `SR${randomBytes(8).toString("hex").toUpperCase()}`;
}

function parseTarget(value) {
  const token = String(value ?? "").trim();
  const mention = token.match(/^<@!?([A-Za-z0-9]+)>$/);
  const id = mention?.[1] ?? token;
  return isSafeId(id) ? id : null;
}

export function isSpamReportInvocation(content, prefix = "/") {
  const raw = String(content ?? "").trim();
  const commandPrefix = String(prefix ?? "");
  if (
    !commandPrefix ||
    !raw.toLowerCase().startsWith(commandPrefix.toLowerCase())
  ) {
    return false;
  }
  const body = raw.slice(commandPrefix.length).trimStart();
  const [command = ""] = body.split(/\s+/, 1);
  return command.toLowerCase() === "report-spam";
}

export function parseSpamReportCommand(rawArgs) {
  const input = String(rawArgs ?? "").trim();
  const separator = input.search(/\s/);
  const targetToken = separator < 0 ? input : input.slice(0, separator);
  const remainder = separator < 0 ? "" : input.slice(separator).trim();
  const targetId = parseTarget(targetToken);
  if (!targetId) {
    return {
      ok: false,
      error: "Mention one current member or provide one valid user ID.",
    };
  }

  const reasonMatch = remainder.match(/^reason:\s*([\s\S]*)$/i);
  if (!reasonMatch) {
    return {
      ok: false,
      error:
        "Use `/Report-Spam @member reason: what happened` with no extra options.",
    };
  }
  const reason = reasonMatch[1].replace(/\s+/g, " ").trim();
  if (reason.length < SPAM_REPORT_MIN_REASON_LENGTH) {
    return {
      ok: false,
      error: `The reason must be at least ${SPAM_REPORT_MIN_REASON_LENGTH} characters.`,
    };
  }
  if (reason.length > SPAM_REPORT_MAX_REASON_LENGTH) {
    return {
      ok: false,
      error: `The reason must be ${SPAM_REPORT_MAX_REASON_LENGTH} characters or fewer.`,
    };
  }
  return { ok: true, targetId, reason };
}

export function sanitizeSpamReportReason(value) {
  return String(value)
    .replace(/https?:\/\/\S+|www\.\S+/gi, "\uE000")
    .replace(/<([@#])/g, "<$1\u200B")
    .replace(/@(everyone|here)/gi, "@\u200B$1")
    .replace(/`/g, "ˋ")
    .replace(/\*/g, "∗")
    .replace(/_/g, "＿")
    .replace(/~/g, "∼")
    .replace(/\|/g, "¦")
    .replace(/>/g, "›")
    .replace(/#/g, "＃")
    .replace(/\[/g, "［")
    .replace(/\]/g, "］")
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll("\uE000", "[link removed]");
}

class ReportAttemptLimiter {
  constructor({
    windowMs = SPAM_REPORT_ATTEMPT_COOLDOWN_MS,
    maxActors = MAX_ATTEMPT_ACTORS,
    now = Date.now,
  } = {}) {
    this.windowMs = windowMs;
    this.maxActors = maxActors;
    this.now = now;
    this.attempts = new Map();
  }

  check(key) {
    const current = this.now();
    this.prune(current);
    const retryAt = this.attempts.get(key) ?? 0;
    if (retryAt > current) {
      return { allowed: false, retryAfterMs: retryAt - current };
    }
    this.attempts.delete(key);
    this.attempts.set(key, current + this.windowMs);
    while (this.attempts.size > this.maxActors) {
      this.attempts.delete(this.attempts.keys().next().value);
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  prune(current = this.now()) {
    for (const [key, retryAt] of this.attempts) {
      if (retryAt <= current) this.attempts.delete(key);
    }
  }
}

export function createSpamReporter(
  client,
  {
    send,
    sendProtected,
    request,
    store = DEFAULT_STORE,
    logger = console,
    now = Date.now,
    reportIdFactory = createSpamReportId,
    prefix = "/",
  } = {}
) {
  if (typeof send !== "function") {
    throw new TypeError("Spam reporting requires a sender.");
  }
  if (typeof sendProtected !== "function") {
    throw new TypeError("Spam reporting requires a protected sender.");
  }
  if (typeof request !== "function") {
    throw new TypeError("Spam reporting requires an HTTP requester.");
  }

  const attempts = new ReportAttemptLimiter({ now });
  const archiveDecisions = new Map();
  let reportQueue = Promise.resolve();

  function serialise(operation) {
    const result = reportQueue.catch(() => undefined).then(operation);
    reportQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  function logFailure(label, error) {
    logger.warn?.(`spam-report: ${label} ${safeErrorSummary(error)}`);
  }

  async function respond(channelId, title, description, colour = "#3498DB") {
    return send(channelId, {
      embeds: [buildStatusEmbed(title, description, colour)],
    });
  }

  async function verifyMember(serverId, userId, { requireHuman = false } = {}) {
    try {
      const [user, memberResponse] = await Promise.all([
        client.api.get(`/users/${userId}`),
        client.api.get(`/servers/${serverId}/members/${userId}`, {
          roles: false,
        }),
      ]);
      const member = memberResponse?.member ?? memberResponse;
      if (
        user?._id !== userId ||
        member?._id?.server !== serverId ||
        member?._id?.user !== userId ||
        (requireHuman && user.bot)
      ) {
        return null;
      }
      return { user, member };
    } catch (error) {
      logFailure("member verification failed", error);
      return null;
    }
  }

  async function handleCommand(message, rawArgs) {
    const serverId = message.server?.id ?? message.channel?.serverId;
    const channelId = message.channelId ?? message.channel?.id;
    const reporterId = message.authorId;
    const messageId = message.id ?? message._id;
    if (
      !isSafeId(serverId) ||
      !isSafeId(channelId) ||
      !isSafeId(reporterId) ||
      !isSafeId(messageId)
    ) {
      return;
    }

    let archiveDecisionResolved = false;
    let resolveArchiveDecision;
    const archiveDecision = new Promise((resolve) => {
      resolveArchiveDecision = (excluded) => {
        if (archiveDecisionResolved) return;
        archiveDecisionResolved = true;
        resolve(Boolean(excluded));
      };
    });
    archiveDecisions.set(messageId, archiveDecision);

    try {
      const botAccess = await authorizeServerActor(
        client,
        {
          serverId,
          channelId,
          authorId: client.user?.id,
        },
        COMMAND_ACCESS.MANAGE_MESSAGES,
        { allowBot: true, logger }
      );
      if (!botAccess.allowed || botAccess.permissionSource !== "refreshed") {
        resolveArchiveDecision(false);
        await respond(
          channelId,
          "🔒 Secure Reporting Unavailable",
          "Use this command only in a server channel where Irminsul has Manage Messages permission.",
          "#E74C3C"
        );
        return;
      }

      const deleted = await request(
        "DELETE",
        `/channels/${channelId}/messages/${messageId}`
      );
      if (!deleted.ok) {
        resolveArchiveDecision(false);
        await respond(
          channelId,
          "🔒 Report Not Accepted",
          "Irminsul could not remove the report command, so no report was recorded.",
          "#E74C3C"
        );
        return;
      }
      resolveArchiveDecision(true);

      const attempt = attempts.check(`${serverId}:${reporterId}`);
      if (!attempt.allowed) {
        const seconds = Math.max(1, Math.ceil(attempt.retryAfterMs / 1_000));
        await respond(
          channelId,
          "⏳ Report Not Accepted",
          `Wait ${seconds} second(s) before trying the safety report command again.`,
          "#E67E22"
        );
        return;
      }

      const parsed = parseSpamReportCommand(rawArgs);
      if (!parsed.ok) {
        await respond(channelId, "⚠️ Invalid Report", parsed.error, "#E74C3C");
        return;
      }

      const auditChannelId = store.getAuditLogChannel(serverId);
      if (!isSafeId(auditChannelId)) {
        await respond(
          channelId,
          "📝 Report Not Accepted",
          "This server must configure a protected audit channel before member safety reports can be recorded.",
          "#E67E22"
        );
        return;
      }

      let server;
      try {
        server = await client.api.get(`/servers/${serverId}`);
      } catch (error) {
        logFailure("server verification failed", error);
      }
      if (server?._id !== serverId) {
        await respond(
          channelId,
          "⚠️ Report Not Accepted",
          "The server and member state could not be freshly verified.",
          "#E74C3C"
        );
        return;
      }
      if (
        parsed.targetId === reporterId ||
        parsed.targetId === client.user?.id ||
        parsed.targetId === server.owner
      ) {
        await respond(
          channelId,
          "⚠️ Invalid Report Target",
          "That account cannot be targeted by this command.",
          "#E74C3C"
        );
        return;
      }

      const [reporter, target] = await Promise.all([
        verifyMember(serverId, reporterId, { requireHuman: true }),
        verifyMember(serverId, parsed.targetId),
      ]);
      if (!reporter || !target) {
        await respond(
          channelId,
          "⚠️ Report Not Accepted",
          "Both the reporter and reported account must be current members of this server.",
          "#E74C3C"
        );
        return;
      }

      return serialise(async () => {
        const current = now();
        const since = current - SPAM_REPORT_WINDOW_MS;
        store.pruneSpamReports(current);
        const recent = store.getRecentSpamReports(serverId, since);
        const reporterCount = recent.filter(
          (record) => record.reporterId === reporterId
        ).length;
        if (reporterCount >= SPAM_REPORT_DAILY_LIMIT) {
          await respond(
            channelId,
            "⏳ Report Limit Reached",
            "You have reached this server's 24-hour safety report limit.",
            "#E67E22"
          );
          return { outcome: "daily_limit" };
        }
        if (
          store.findRecentSpamReport(
            serverId,
            reporterId,
            parsed.targetId,
            since
          )
        ) {
          await respond(
            channelId,
            "ℹ️ Report Already Recorded",
            "You already reported that account within the last 24 hours.",
            "#3498DB"
          );
          return { outcome: "duplicate" };
        }

        const uniqueReporters = new Set(
          recent
            .filter((record) => record.targetId === parsed.targetId)
            .map((record) => record.reporterId)
        );
        uniqueReporters.add(reporterId);
        const correlationCount = uniqueReporters.size;
        const priority = correlationCount >= SPAM_REPORT_PRIORITY_THRESHOLD;
        const reportId = reportIdFactory();
        if (!isSafeId(reportId)) {
          logFailure("invalid generated report id", new Error("invalid id"));
          await respond(
            channelId,
            "⚠️ Report Not Accepted",
            "Irminsul could not create a safe report record.",
            "#E74C3C"
          );
          return { outcome: "invalid_report_id" };
        }

        let protectedMessage;
        try {
          protectedMessage = await sendProtected(auditChannelId, {
            embeds: [
              {
                title: priority
                  ? "🚨 Priority Member Spam Report"
                  : "🛡️ Member Spam Report",
                description: [
                  `**Report ID:** \`${reportId}\``,
                  `**Reporter:** <@${reporterId}>`,
                  `**Reported account:** <@${parsed.targetId}>`,
                  `**Source channel:** <#${channelId}>`,
                  `**Reason:** ${sanitizeSpamReportReason(parsed.reason)}`,
                  `**Unique reporters in 24 hours:** ${correlationCount}`,
                  priority
                    ? `**Priority:** threshold reached (${SPAM_REPORT_PRIORITY_THRESHOLD} unique reporters).`
                    : "**Priority:** standard review.",
                  "**Action:** No automatic timeout, deletion, kick, ban, or automod strike was applied. Staff must verify the allegation independently.",
                ].join("\n"),
                colour: priority ? "#E74C3C" : "#F39C12",
              },
            ],
          });
        } catch (error) {
          logFailure("protected report delivery failed", error);
        }
        if (!isSafeId(protectedMessage?._id)) {
          await respond(
            channelId,
            "⚠️ Report Not Accepted",
            "The protected staff record could not be delivered, so no report was retained.",
            "#E74C3C"
          );
          return { outcome: "delivery_failed" };
        }

        store.createSpamReport({
          reportId,
          serverId,
          reporterId,
          targetId: parsed.targetId,
          sourceChannelId: channelId,
          protectedChannelId: auditChannelId,
          protectedMessageId: protectedMessage._id,
          createdAt: current,
        });
        logger.log?.(
          `🛡️  spam-report accepted report=${auditAlias(reportId)} ` +
            `server=${auditAlias(serverId)} reporter=${auditAlias(reporterId)} ` +
            `target=${auditAlias(parsed.targetId)} priority=${priority}`
        );
        await respond(
          channelId,
          "✅ Safety Report Delivered",
          `Report \`${reportId}\` was delivered to the protected staff log.`,
          "#2ECC71"
        );
        return { outcome: "accepted", reportId, correlationCount, priority };
      });
    } finally {
      resolveArchiveDecision(false);
      archiveDecisions.delete(messageId);
    }
  }

  async function shouldExcludeMessage(message) {
    if (!isSpamReportInvocation(message?.content, prefix)) return false;
    await Promise.resolve();
    const decision = archiveDecisions.get(message?.id ?? message?._id);
    return decision ? decision : false;
  }

  async function shouldExcludeMessageDelete(messageId) {
    const decision = archiveDecisions.get(messageId);
    return decision ? decision : false;
  }

  return {
    handleCommand,
    shouldExcludeMessage,
    shouldExcludeMessageDelete,
  };
}
