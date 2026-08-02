// user-info.js — account intelligence shared by the enriched join log and
// /Get-Info. Collects every locally-available field revolt.js/Stoat exposes
// for one account, then flags the subset of conditions that correlate with
// bot/raid accounts. Signals are heuristics for a moderator to look at, not
// proof of anything.
import { UserBadges, UserFlags } from "revolt.js";
import { decodeTime } from "ulid";
import { LOOKUP_SCOPE } from "./account-lookup.js";
import { AUTOMOD_LIMITS, formatAge } from "./automod.js";
import {
  BARE_ID_PATTERN,
  findTargetToken,
  tokenizeArgs,
  ULID_PATTERN,
} from "./command-args.js";
import { buildAuditEmbed } from "./embeds.js";
import {
  countArchivedMessages,
  getArchiveCoverage,
} from "./message-archive.js";
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

// Message counts require a full archive scan, so this seam is left null by
// default — the join-log path (evaluateBotSignals fires on every join) must
// stay cache-only, and only /Get-Info's handler passes this in.
export const DEFAULT_ARCHIVE = Object.freeze({
  countArchivedMessages,
  getArchiveCoverage,
});

// Cap the roles list so a role-heavy member can't push the fields that
// follow (strike level, spam reports, message count) past the embed's
// truncation budget.
const MAX_RENDERED_ROLES = 15;

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

/** ULIDs embed their mint time, so an account's creation date needs no network. */
export function deriveAccountCreatedAt(userId) {
  if (!ULID_PATTERN.test(userId)) return null;
  try {
    const ms = decodeTime(userId);
    return Number.isFinite(ms) ? new Date(ms) : null;
  } catch {
    return null;
  }
}

export function promoteScopeWithLocalEvidence(
  scope,
  { messageCount, automodStrikeLevel, spamReportCount }
) {
  if (
    [
      LOOKUP_SCOPE.OUTSIDE,
      LOOKUP_SCOPE.PLATFORM,
      LOOKUP_SCOPE.UNKNOWN,
      LOOKUP_SCOPE.MISSING,
    ].includes(scope) &&
    (messageCount > 0 || automodStrikeLevel || spamReportCount > 0)
  ) {
    return LOOKUP_SCOPE.FORMER;
  }
  return scope;
}

/**
 * Gather every locally-cached (or explicitly supplied) fact about one
 * account. Never throws — a missing user/member simply yields fewer fields,
 * which matters for the join-log path (cache-only, no network) and for
 * /Get-Info targets who already left the server.
 */
export function collectUserInfo(
  client,
  {
    serverId,
    userId,
    user = undefined,
    member = null,
    profile = null,
    store = DEFAULT_STORE,
    archive = null,
    lookup = null,
  }
) {
  const resolvedUser = user === undefined ? client.users.get(userId) : user;

  const strike = store.getAutomodStrike(serverId, userId);
  const activeCase = store.findActiveAutomodCase(serverId, userId);
  const spamReportCount = store
    .getRecentSpamReports(serverId, Date.now() - SPAM_REPORT_RETENTION_MS)
    .filter((report) => report.targetId === userId).length;

  let messageCount = null;
  let messageCountSince = null;
  if (archive) {
    messageCount = archive.countArchivedMessages({
      serverId,
      authorId: userId,
    });
    messageCountSince = archive.getArchiveCoverage(serverId).earliestAt;
  }

  const accountCreatedAt =
    resolvedUser?.createdAt ?? deriveAccountCreatedAt(userId);
  const accountCreatedAtSource = resolvedUser?.createdAt
    ? "user"
    : accountCreatedAt
      ? "id"
      : null;
  const identity = lookup?.identity;
  const promotedLookup = lookup
    ? Object.freeze({
        ...lookup,
        scope: promoteScopeWithLocalEvidence(lookup.scope, {
          messageCount,
          automodStrikeLevel: strike?.level ?? null,
          spamReportCount,
        }),
      })
    : null;

  return {
    userId,
    serverId,
    username: resolvedUser?.username ?? identity?.username ?? null,
    discriminator:
      resolvedUser?.discriminator ?? identity?.discriminator ?? null,
    displayName: resolvedUser?.displayName ?? identity?.displayName ?? null,
    accountCreatedAt,
    accountCreatedAtSource,
    hasCustomAvatar:
      resolvedUser != null
        ? Boolean(resolvedUser.avatar)
        : (identity?.hasCustomAvatar ?? false),
    badges: flagNames(UserBadges, resolvedUser?.badges),
    flags: flagNames(
      UserFlags,
      resolvedUser?.flags ?? lookup?.platformFlags ?? 0
    ),
    isBot: Boolean(resolvedUser?.bot),
    botOwnerId: resolvedUser?.bot?.owner ?? null,
    online: resolvedUser?.online ?? null,
    bio: profile?.content ?? null,
    profileFetched: profile !== null,
    nickname: member?.nickname ?? null,
    joinedAt: member?.joinedAt ?? null,
    roleIds: member?.roles ?? [],
    timeoutUntil: member?.timeout ?? null,
    automodStrikeLevel: strike?.level ?? null,
    hasActiveAutomodCase: Boolean(activeCase),
    spamReportCount,
    messageCount,
    messageCountSince,
    lookup: promotedLookup,
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

  if (
    !record.hasCustomAvatar &&
    (record.lookup ? record.lookup.identitySource !== "none" : true)
  ) {
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

  if (record.lookup?.banned) {
    signals.push("Banned from this server");
  }

  if (
    record.lookup?.accountExists === false &&
    (record.messageCount > 0 ||
      record.automodStrikeLevel ||
      record.spamReportCount > 0)
  ) {
    signals.push(
      "Stoat no longer has an account with this ID (deleted, or the ID is wrong)"
    );
  }

  return signals;
}

function formatRoles(roleIds) {
  const shown = roleIds.slice(0, MAX_RENDERED_ROLES).map((id) => `<@&${id}>`);
  const remaining = roleIds.length - shown.length;
  return remaining > 0
    ? `${shown.join(", ")}, …and ${remaining} more`
    : shown.join(", ");
}

const SCOPE_SENTENCES = Object.freeze({
  [LOOKUP_SCOPE.MEMBER]: "Current member of this server.",
  [LOOKUP_SCOPE.BANNED]:
    "Not a member — banned from this server. Identity below comes from the ban list.",
  [LOOKUP_SCOPE.FORMER]: "No longer a member of this server.",
  [LOOKUP_SCOPE.OUTSIDE]:
    "Not a member of this server; visible to me through another community I'm in.",
  [LOOKUP_SCOPE.PLATFORM]:
    "Not visible to me — the account exists on Stoat but shares no server with me, so only ID-derived facts are shown.",
  [LOOKUP_SCOPE.UNKNOWN]:
    "Not visible to me, and Stoat did not confirm whether this account exists.",
  [LOOKUP_SCOPE.MISSING]: "Stoat reports that no account has this ID.",
});

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatMutualServers(servers) {
  const shown = servers.slice(0, 3).map((server) => server.name ?? server.id);
  const remaining = servers.length - shown.length;
  return remaining > 0
    ? `${shown.join(", ")}, …and ${remaining} more`
    : shown.join(", ");
}

/**
 * Build the `**Label:** value` lines this record renders as. Revolt embeds
 * have no field array, so this is what both the join log and /Get-Info send.
 *
 * `verbose: false` (the join log's default) omits a field entirely when it
 * has nothing to say, keeping every-join embeds short. `verbose: true`
 * (/Get-Info) instead lists every field the record carries, with an
 * explicit "none"/"unknown" fallback, plus fields the compact form never
 * shows (display name, user ID, online status, bot owner, timeout, and the
 * archived message count).
 */
export function buildUserInfoLines(
  record,
  signals,
  { now = Date.now(), verbose = false } = {}
) {
  const lines = [];

  if (signals.length) {
    lines.push(
      `**⚠️ Signals (${signals.length}):**`,
      ...signals.map((signal) => `- ${signal}`),
      ""
    );
  }

  if (record.lookup) {
    let scope = SCOPE_SENTENCES[record.lookup.scope] ?? SCOPE_SENTENCES.unknown;
    if (
      !record.lookup.banListChecked &&
      record.lookup.scope !== LOOKUP_SCOPE.MEMBER
    ) {
      scope +=
        " I can't read this server's ban list (needs Ban Members), so a ban here isn't ruled out.";
    }
    lines.push(`**Lookup scope:** ${scope}`);
    if (record.lookup.banned) {
      lines.push(
        `**Ban reason:** ${record.lookup.banReason ? truncate(record.lookup.banReason, 200) : "*(none given)*"}`
      );
    }
    if (record.lookup.mutualServers?.length) {
      lines.push(
        `**Also seen in:** ${formatMutualServers(record.lookup.mutualServers)}`
      );
    }
  }

  lines.push(
    `**Username:** ${record.username ? `@${record.username}` : "unknown"}${record.discriminator ? `#${record.discriminator}` : ""}`
  );
  if (verbose) {
    lines.push(`**Display name:** ${record.displayName ?? "none"}`);
  }
  if (record.nickname || verbose) {
    lines.push(`**Nickname:** ${record.nickname ?? "none"}`);
  }
  if (verbose) lines.push(`**User ID:** \`${record.userId}\``);
  lines.push(
    `**Account created:** ${formatTimestamp(record.accountCreatedAt, now)}${record.accountCreatedAtSource === "id" ? " — derived from the account ID" : ""}`
  );
  if (record.joinedAt || verbose) {
    lines.push(
      record.joinedAt
        ? `**Joined this server:** ${formatTimestamp(record.joinedAt, now)}`
        : "**Joined this server:** not currently a member"
    );
  }
  lines.push(
    `**Avatar:** ${record.lookup?.identitySource === "none" ? "unknown" : record.hasCustomAvatar ? "custom" : "default"}`
  );
  if (record.profileFetched || verbose) {
    lines.push(
      `**Bio:** ${
        !record.profileFetched
          ? "not fetched"
          : record.bio
            ? record.bio.slice(0, 200)
            : "*(none)*"
      }`
    );
  }
  if (record.badges.length || verbose) {
    lines.push(
      `**Badges:** ${record.badges.length ? record.badges.join(", ") : "none"}`
    );
  }
  if (record.flags.length || verbose) {
    lines.push(
      `**Platform flags:** ${record.flags.length ? record.flags.join(", ") : "none"}`
    );
  }
  lines.push(`**Bot account:** ${record.isBot ? "yes" : "no"}`);
  if (verbose) {
    lines.push(
      `**Online:** ${record.online === null ? "unknown" : record.online ? "yes" : "no"}`
    );
    lines.push(
      `**Bot owner:** ${record.isBot ? (record.botOwnerId ? `<@${record.botOwnerId}>` : "unknown") : "n/a"}`
    );
    lines.push(
      `**Timed out until:** ${record.timeoutUntil && record.timeoutUntil.getTime() > now ? formatTimestamp(record.timeoutUntil, now) : "none"}`
    );
  }
  if (record.roleIds.length || verbose) {
    lines.push(
      `**Roles:** ${record.roleIds.length ? formatRoles(record.roleIds) : "none"}`
    );
  }
  if (record.automodStrikeLevel || verbose) {
    lines.push(`**Automod strike level:** ${record.automodStrikeLevel ?? 0}/4`);
  }
  if (record.hasActiveAutomodCase || verbose) {
    lines.push(
      `**Open automod case:** ${record.hasActiveAutomodCase ? "yes" : "no"}`
    );
  }
  if (record.spamReportCount > 0 || verbose) {
    lines.push(`**Prior spam reports:** ${record.spamReportCount}`);
  }
  if (verbose && record.messageCount !== null) {
    lines.push(
      record.messageCount > 0
        ? `**Messages sent:** ${record.messageCount.toLocaleString()} recorded since ${formatTimestamp(new Date(record.messageCountSince), now)} — only messages observed while audit logging was active; deleted and purged messages are excluded.`
        : "**Messages sent:** 0 recorded — either none were observed while audit logging was active, or all were deleted or purged."
    );
  }

  return lines;
}

/**
 * Build the /Get-Info reply embed for one account.
 */
export function buildUserInfoEmbed(record, signals, { now = Date.now() } = {}) {
  const lines = buildUserInfoLines(record, signals, { now, verbose: true });
  const label = record.username ? `@${record.username}` : record.userId;
  return buildAuditEmbed(
    `🪪 Account Info — ${label}`,
    lines,
    signals.length ? "#E67E22" : "#3498DB"
  );
}

/** True only for a well-formed ID Stoat denied with no local evidence. */
export function isEmptyLookup(record) {
  return Boolean(
    record.lookup?.idWellFormed &&
    record.lookup.accountExists === false &&
    record.lookup.banListChecked &&
    !record.username &&
    !record.lookup.banned &&
    !record.joinedAt &&
    !(record.messageCount > 0) &&
    !record.automodStrikeLevel &&
    !(record.spamReportCount > 0)
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
