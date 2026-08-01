// user-info.js — account intelligence shared by the enriched join log and
// /Get-Info. Collects every locally-available field revolt.js/Stoat exposes
// for one account, then flags the subset of conditions that correlate with
// bot/raid accounts. Signals are heuristics for a moderator to look at, not
// proof of anything.
import { UserBadges, UserFlags } from "revolt.js";
import { AUTOMOD_LIMITS, formatAge } from "./automod.js";
import {
  BARE_ID_PATTERN,
  findTargetToken,
  tokenizeArgs,
} from "./command-args.js";
import { buildAuditEmbed } from "./embeds.js";
import { isSafeId } from "./security.js";
import {
  findActiveAutomodCase,
  getAutomodStrike,
  getRecentSpamReports,
  SPAM_REPORT_RETENTION_MS,
} from "./store.js";

const DEFAULT_STORE = Object.freeze({
  findActiveAutomodCase,
  getAutomodStrike,
  getRecentSpamReports,
});

// The throwaway-farm tell: an account minted moments before it joined.
const FRESH_ACCOUNT_JOIN_GAP_MS = 60 * 60_000;

function flagNames(enumObject, value) {
  if (!Number.isFinite(value) || value <= 0) return [];
  return Object.entries(enumObject)
    .filter(([, bit]) => typeof bit === "number" && (value & bit) !== 0)
    .map(([name]) => name);
}

function formatTimestamp(value, now) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return "unknown";
  }
  return `${value.toISOString().replace("T", " ").slice(0, 16)} UTC (${formatAge(value, now)})`;
}

/**
 * Gather every locally-cached (or explicitly supplied) fact about one
 * account. Never throws — a missing user/member simply yields fewer fields,
 * which matters for the join-log path (cache-only, no network) and for
 * /Get-Info targets who already left the server.
 */
export function collectUserInfo(
  client,
  { serverId, userId, member = null, profile = null, store = DEFAULT_STORE }
) {
  const user = client.users.get(userId);

  const strike = store.getAutomodStrike(serverId, userId);
  const activeCase = store.findActiveAutomodCase(serverId, userId);
  const spamReportCount = store
    .getRecentSpamReports(serverId, Date.now() - SPAM_REPORT_RETENTION_MS)
    .filter((report) => report.targetId === userId).length;

  return {
    userId,
    serverId,
    username: user?.username ?? null,
    discriminator: user?.discriminator ?? null,
    displayName: user?.displayName ?? null,
    accountCreatedAt: user?.createdAt ?? null,
    hasCustomAvatar: Boolean(user?.avatar),
    badges: flagNames(UserBadges, user?.badges),
    flags: flagNames(UserFlags, user?.flags),
    isBot: Boolean(user?.bot),
    botOwnerId: user?.bot?.owner ?? null,
    online: user?.online ?? null,
    bio: profile?.content ?? null,
    profileFetched: profile !== null,
    nickname: member?.nickname ?? null,
    joinedAt: member?.joinedAt ?? null,
    roleIds: member?.roles ?? [],
    timeoutUntil: member?.timeout ?? null,
    automodStrikeLevel: strike?.level ?? null,
    hasActiveAutomodCase: Boolean(activeCase),
    spamReportCount,
  };
}

/**
 * Return only the conditions actually present for this record — an empty
 * array means nothing here reads as suspicious.
 */
export function evaluateBotSignals(record, now = Date.now()) {
  const signals = [];

  if (record.accountCreatedAt) {
    const accountAgeMs = now - record.accountCreatedAt.getTime();
    if (accountAgeMs >= 0 && accountAgeMs < AUTOMOD_LIMITS.recentAccountMs) {
      signals.push(
        `Account created ${formatAge(record.accountCreatedAt, now)} ago`
      );
    }
  }

  if (record.accountCreatedAt && record.joinedAt) {
    const gapMs = record.joinedAt.getTime() - record.accountCreatedAt.getTime();
    if (gapMs >= 0 && gapMs < FRESH_ACCOUNT_JOIN_GAP_MS) {
      signals.push("Account was created less than an hour before joining");
    }
  }

  if (!record.hasCustomAvatar) {
    signals.push("Using the default avatar");
  }

  if (record.profileFetched && !record.bio) {
    signals.push("No bio set");
  }

  for (const flag of record.flags) {
    signals.push(`Stoat has flagged this account as ${flag}`);
  }

  if (record.timeoutUntil && record.timeoutUntil.getTime() > now) {
    signals.push(
      `Currently timed out until ${formatTimestamp(record.timeoutUntil, now)}`
    );
  }

  if (record.automodStrikeLevel) {
    signals.push(
      `Existing automod strike (level ${record.automodStrikeLevel}/4)`
    );
  }

  if (record.hasActiveAutomodCase) {
    signals.push("Has an open automod case");
  }

  if (record.spamReportCount > 0) {
    signals.push(
      `${record.spamReportCount} spam report${record.spamReportCount === 1 ? "" : "s"} filed against this account`
    );
  }

  return signals;
}

/**
 * Build the `**Label:** value` lines this record renders as. Revolt embeds
 * have no field array, so this is what both the join log and /Get-Info send.
 */
export function buildUserInfoLines(record, signals, { now = Date.now() } = {}) {
  const lines = [];

  if (signals.length) {
    lines.push(
      `**⚠️ Signals (${signals.length}):**`,
      ...signals.map((signal) => `- ${signal}`),
      ""
    );
  }

  lines.push(
    `**Username:** ${record.username ? `@${record.username}` : "unknown"}${record.discriminator ? `#${record.discriminator}` : ""}`
  );
  if (record.nickname) lines.push(`**Nickname:** ${record.nickname}`);
  lines.push(
    `**Account created:** ${formatTimestamp(record.accountCreatedAt, now)}`
  );
  if (record.joinedAt) {
    lines.push(
      `**Joined this server:** ${formatTimestamp(record.joinedAt, now)}`
    );
  }
  lines.push(`**Avatar:** ${record.hasCustomAvatar ? "custom" : "default"}`);
  if (record.profileFetched) {
    lines.push(
      `**Bio:** ${record.bio ? record.bio.slice(0, 200) : "*(none)*"}`
    );
  }
  if (record.badges.length)
    lines.push(`**Badges:** ${record.badges.join(", ")}`);
  if (record.flags.length)
    lines.push(`**Platform flags:** ${record.flags.join(", ")}`);
  lines.push(`**Bot account:** ${record.isBot ? "yes" : "no"}`);
  if (record.roleIds.length) {
    lines.push(
      `**Roles:** ${record.roleIds.map((id) => `<@&${id}>`).join(", ")}`
    );
  }
  if (record.automodStrikeLevel) {
    lines.push(`**Automod strike level:** ${record.automodStrikeLevel}/4`);
  }
  if (record.hasActiveAutomodCase) lines.push("**Open automod case:** yes");
  if (record.spamReportCount > 0) {
    lines.push(`**Prior spam reports:** ${record.spamReportCount}`);
  }

  return lines;
}

/**
 * Build the /Get-Info reply embed for one account.
 */
export function buildUserInfoEmbed(record, signals, { now = Date.now() } = {}) {
  const lines = buildUserInfoLines(record, signals, { now });
  const label = record.username ? `@${record.username}` : record.userId;
  return buildAuditEmbed(
    `🪪 Account Info — ${label}`,
    lines,
    signals.length ? "#E67E22" : "#3498DB"
  );
}

/**
 * Locate the member being looked up anywhere in the sentence, same rules as
 * every other member-targeting command (see command-args.js).
 */
export function parseUserInfoCommand(rawArgs) {
  const tokens = tokenizeArgs(rawArgs);
  const found = findTargetToken(tokens);
  if (found) return { ok: true, targetId: found.targetId };
  if (BARE_ID_PATTERN.test(tokens[0] ?? "") && isSafeId(tokens[0])) {
    return { ok: true, targetId: tokens[0] };
  }
  return {
    ok: false,
    error: "Mention one member or provide one valid user ID.",
  };
}
