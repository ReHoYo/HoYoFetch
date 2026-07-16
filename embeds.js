// embeds.js — Build Revolt SendableEmbed objects for code announcements
// ────────────────────────────────────────────────────────────────────
import { GAMES } from "./config.js";
import { formatRewards } from "./api.js";
import { isEvidenceEnabled, perFileCapBytes } from "./evidence-store.js";

/**
 * Build an embed for a batch of codes for one game.
 *
 * Revolt SendableEmbed spec:
 *   { title, description, colour, icon_url, url }
 *
 * Revolt embeds do NOT have "fields" like Discord; we simulate them
 * with bold text and newlines inside the description.
 *
 * @param  {string}  gameKey
 * @param  {Array}   codes     — array of normalised code objects
 * @param  {Object}  opts
 * @param  {boolean} opts.isAuto  — whether this is an auto-fetch (only new codes)
 * @return {Object}  SendableEmbed
 */
export function buildCodesEmbed(
  gameKey,
  codes,
  { isAuto = false, page = null } = {}
) {
  const game = GAMES[gameKey];
  if (!game) throw new Error(`Unknown game: ${gameKey}`);

  const pageLabel = page ? ` (${page})` : "";
  const title = isAuto
    ? `🆕 New ${game.name} Code${codes.length > 1 ? "s" : ""}!${pageLabel}`
    : `🎁 Active ${game.name} Code${codes.length > 1 ? "s" : ""}${pageLabel}`;

  const lines = [];

  for (const entry of codes) {
    // Code header
    lines.push(`**\`${entry.code}\`**`);

    // Rewards with emoji
    const rewards = formatRewards(entry.rewards, gameKey);
    lines.push(rewards);

    // Clickable redeem link (or in-game note for HI3)
    if (game.redeemUrl) {
      lines.push(`[🔗 Click to redeem](${game.redeemUrl}${entry.code})`);
    } else if (gameKey === "honkai3rd") {
      lines.push("_⚠️ Redeem in-game: Account → Exchange Rewards_");
    } else if (gameKey === "nte") {
      lines.push("_⚠️ Redeem in-game from the Redeem Code menu_");
    }

    lines.push(""); // blank separator
  }

  // Source attribution
  const sourceLabel = getSourceLabel(game);
  lines.push(`_Fetched from ${sourceLabel}_`);

  return {
    title,
    description: lines.join("\n"),
    colour: game.colour,
    icon_url: game.icon,
  };
}

/**
 * Build a "no codes" embed when the API returns an empty list.
 */
export function buildNoCodesEmbed(gameKey) {
  const game = GAMES[gameKey];
  return {
    title: `${game.name} — No Active Codes`,
    description:
      "There are currently no active redemption codes for this game.\nCheck back later or watch for livestream announcements!",
    colour: "#808080",
    icon_url: game.icon,
  };
}

const HELP_ICON =
  "https://img-os-static.hoyolab.com/communityWeb/upload/1d7dd8f33c5ccdfdeac86e1e86ddd652.png";

function commandList(commands) {
  return commands
    .map(([command, description]) => `**\`${command}\`**\n${description}`)
    .join("\n\n");
}

/**
 * Build the paginated help reference. Stoat has no interaction buttons, so
 * callers can attach ◀️/▶️ reactions and replace the embed in place.
 */
export function buildHelpEmbeds(prefix) {
  const utilityCommands = [
    [`${prefix}FetchGI`, "Fetch active **Genshin Impact** redemption codes"],
    [
      `${prefix}FetchHSR`,
      "Fetch active **Honkai: Star Rail** redemption codes",
    ],
    [
      `${prefix}FetchZZZ`,
      "Fetch active **Zenless Zone Zero** redemption codes",
    ],
    [`${prefix}FetchHI3`, "Fetch active **Honkai Impact 3rd** codes"],
    [`${prefix}FetchNTE`, "Fetch active **Neverness to Everness** codes"],
    [
      `${prefix}EnableFetch`,
      "Enable hourly auto-fetch of **HoYoverse + NTE** codes in this channel _(admins/mods only)_",
    ],
    [
      `${prefix}EnableFetchHoyo`,
      "Enable hourly auto-fetch of **HoYoverse-only** codes in this channel _(admins/mods only)_",
    ],
    [
      `${prefix}EnableFetchNTE`,
      "Enable hourly auto-fetch of **NTE-only** codes in this channel _(admins/mods only)_",
    ],
    [
      `${prefix}DisableFetch`,
      "Disable auto-fetch in this channel _(admins/mods only)_",
    ],
    [
      `${prefix}EmojiMode [unicode|custom]`,
      "Show or switch how reward emoji are rendered _(admins/mods only)_",
    ],
    [
      `${prefix}Restart`,
      "Restart the bot process after deploying updates _(admins/mods only)_",
    ],
    [
      `${prefix}AuditLog [status|here|#channel|off]`,
      "Log messages, moderation, username changes, and server settings _(admins/mods only)_",
    ],
    [
      `${prefix}Test-AuditLog`,
      "Test protected delivery and show settings-monitor coverage _(admins/mods only)_",
    ],
    [`${prefix}HelpHoyoFetch`, "Show this help message"],
  ];

  const moderationCommands = [
    [
      `${prefix}Ban @member [delete:1h|6h|1d|3d|7d] reason: ...`,
      "Ban immediately; optional cleanup covers messages observed by HoYoFetch. The 10-minute ↩️ undo only unbans _(Ban Members; cleanup also needs Manage Messages)_",
    ],
    [
      `${prefix}Kick @member reason: ...`,
      "Kick immediately. There is no undo; the member must rejoin with an invite _(Kick Members)_",
    ],
    [
      `${prefix}Mute @member [10m|30m|1h|4h|24h|3d|7d] reason: ...`,
      "Apply a timeout, or omit the duration for the 1️⃣–7️⃣ picker. The 10-minute ↩️ undo releases it _(Timeout Members)_",
    ],
    [
      `${prefix}Purge-User @member window:1h|6h|1d|3d|7d reason: ...`,
      "Use ✅/❌ to confirm deletion of messages observed by HoYoFetch. Audit evidence is preserved _(Manage Messages)_",
    ],
    [
      `${prefix}Automod release @member reason: ...`,
      "Release the timeout immediately and reset that member's automod strikes _(Timeout Members)_",
    ],
    [
      `${prefix}Automod [status|monitor|enforce|off|quorum|approve]`,
      "Configure anti-raid moderation. Enforcement escalates 10m → 1h → 24h → 7d; strikes reset after 14 quiet days _(ban approval: Ban Members)_",
    ],
  ];

  return [
    {
      title: "📖 HoyoFetch Help — Codes & Setup (1/2)",
      description:
        commandList(utilityCommands) +
        "\n\n_Use ▶️ for moderation commands. Command names are case-insensitive._\n" +
        "_Sources: [HoYo](https://hoyo-codes.seria.moe), [HI3](https://api.ennead.cc/mihoyo), [NTE](https://game8.co/games/Neverness-to-Everness/archives/593718)_",
      colour: "#5865F2",
      icon_url: HELP_ICON,
    },
    {
      title: "🛡️ HoyoFetch Help — Moderation (2/2)",
      description:
        "🔒 **Moderator-only commands:** regular members cannot use the commands on this page. Each action requires the matching moderation permission shown below.\n\n" +
        "**Before taking a manual action:** configure an audit channel with `/AuditLog here`. Ban, kick, mute, purge, and release require exactly one member/ID plus a mandatory `reason:` (maximum 300 characters).\n\n" +
        commandList(moderationCommands) +
        "\n\n_History cleanup is best-effort and only covers messages HoYoFetch observed. Use ◀️ to return._",
      colour: "#E67E22",
      icon_url: HELP_ICON,
    },
  ];
}

/**
 * Backwards-compatible single-page helper for consumers that only need the
 * first page. Interactive help should use buildHelpEmbeds().
 */
export function buildHelpEmbed(prefix) {
  return buildHelpEmbeds(prefix)[0];
}

/**
 * Simple status embed (e.g. "Auto-fetch enabled").
 */
export function buildStatusEmbed(title, description, colour = "#2ECC71") {
  return { title, description, colour };
}

// Revolt's embed description cap; leave headroom for the notice itself.
const MAX_DESCRIPTION_LENGTH = 2000;

/**
 * Build the tamper notice appended to a restored audit-log message.
 * @param  {number} count — restoration number (1-indexed)
 * @return {string}
 */
export function buildTamperNotice(count) {
  return `🔒 **Restored** — audit log entries cannot be deleted. Restoration #${count}`;
}

/**
 * Re-derive the restored version of a pristine audit-log embed. Always
 * builds from the original embed (never from a previously-restored one) so
 * notices never stack across repeated deletions.
 *
 * @param  {Object} originalEmbed — pristine embed, as originally sent
 * @param  {number} count — restoration number (1-indexed)
 * @return {Object} a new embed object; originalEmbed is never mutated
 */
export function buildRestoredEmbed(originalEmbed, count) {
  const notice = buildTamperNotice(count);
  const originalDescription = originalEmbed.description || "";

  // Reserve room for the notice + separating blank line so it always survives.
  const budget = MAX_DESCRIPTION_LENGTH - notice.length - 2;
  const truncated =
    originalDescription.length > budget
      ? `${originalDescription.slice(0, Math.max(0, budget - 1))}…`
      : originalDescription;

  return {
    ...originalEmbed,
    description: `${truncated}\n\n${notice}`,
  };
}

/**
 * Build an audit-log embed with a trailing timestamp line.
 * @param  {string}   title
 * @param  {string[]} lines   — body lines, joined with newlines
 * @param  {string}   colour
 * @return {Object}   SendableEmbed
 */
export function buildAuditEmbed(title, lines, colour) {
  const timestamp = `_${new Date().toUTCString()}_`;
  const body = lines.join("\n");
  const budget = MAX_DESCRIPTION_LENGTH - timestamp.length - 2;
  const boundedBody =
    body.length > budget ? `${body.slice(0, Math.max(0, budget - 1))}…` : body;
  const description = `${boundedBody}\n\n${timestamp}`;
  return { title, description, colour };
}

function auditText(value, max, fallback = "*(none)*") {
  const text = typeof value === "string" ? value : "";
  if (!text) return fallback;
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

export function buildAuditMessageDeleteEmbed({
  author = "Unknown user",
  channelId,
  content,
  messageId,
  attachmentLines = [],
  suspects = "the author or a moderator",
} = {}) {
  const lines = [
    `**Author:** ${author}`,
    `**Channel:** <#${channelId}>`,
    `**Content:** ${
      content === undefined
        ? `*content unavailable — sent before the bot started or expired from cache${messageId ? ` (${messageId})` : ""}*`
        : auditText(content, 1200, "*(no text — attachment/embed only)*")
    }`,
  ];
  if (attachmentLines.length)
    lines.push("", "**Attachments:**", ...attachmentLines);
  lines.push(
    `**Possible deleter (heuristic — the platform does not report who deleted):** ${auditText(suspects, 300, "the author or a moderator")}`
  );
  return buildAuditEmbed("🗑️ Message Deleted", lines, "#E74C3C");
}

export function buildAuditBulkDeleteEmbed({
  channelId,
  count = 0,
  entries = [],
  suspects,
} = {}) {
  const shown = entries.slice(0, 5);
  if (entries.length > 5) shown.push(`_…and ${entries.length - 5} more_`);
  const lines = [
    `**Channel:** <#${channelId}>`,
    `**Count:** ${count}`,
    "",
    ...shown,
  ];
  if (suspects) {
    lines.push(
      "",
      `**Possible deleter (heuristic — the platform does not report who deleted):** ${auditText(suspects, 300)}`
    );
  }
  return buildAuditEmbed("🗑️ Bulk Message Delete", lines, "#C0392B");
}

export function buildAuditMessageEditEmbed({
  author = "Unknown user",
  channelId,
  before,
  after,
} = {}) {
  return buildAuditEmbed(
    "✏️ Message Edited",
    [
      `**Author:** ${author}`,
      `**Channel:** <#${channelId}>`,
      `**Before:** ${auditText(before, 800, "*content unavailable — message predates the archive*")}`,
      `**After:** ${auditText(after, 800, "*(no text)*")}`,
    ],
    "#F1C40F"
  );
}

export function buildAuditMemberEmbed({
  title,
  user = "Unknown user",
  lines = [],
  colour = "#E67E22",
} = {}) {
  return buildAuditEmbed(
    title ?? "👤 Member Updated",
    [`**User:** ${user}`, ...lines],
    colour
  );
}

export function buildAuditChannelEmbed({
  title,
  channelId,
  lines = [],
  colour = "#3498DB",
} = {}) {
  const channelLine = channelId ? [`**Channel:** <#${channelId}>`] : [];
  return buildAuditEmbed(
    title ?? "📁 Channel Updated",
    [...channelLine, ...lines],
    colour
  );
}

export function buildAuditServerUpdateEmbed(lines = []) {
  return buildAuditEmbed("⚙️ Server Updated", lines, "#9B59B6");
}

/**
 * Build the confirmation embed shown when audit logging is enabled,
 * including the platform limitations that can't be worked around.
 */
export function buildAuditLogEnabledEmbed(
  prefix,
  { moved = false, previousChannelId = null } = {}
) {
  const intro = moved
    ? `Audit logging has been **moved** here from <#${previousChannelId}>.`
    : "Audit logging is now **active** in this channel.";

  const evidenceBullet = isEvidenceEnabled()
    ? `- Attachments up to **${Math.round(perFileCapBytes() / (1024 * 1024))} MB** are downloaded and kept as evidence when their message is deleted, so the file itself — not just a link — shows up in the delete log. Evidence and message content are both kept for **30 days**.`
    : "- Message content is recorded from this moment on and kept for **30 days**, so deletes/edits show the original text even after I restart. Attachment evidence capture is currently **disabled**.";

  return {
    title: "✅ Audit Log Enabled",
    description:
      `${intro}\n\n` +
      "I will post a record of server actions here: message edits/deletes, channel/role/server changes, " +
      "member joins/leaves, bans, timeouts, username changes, nickname and role changes, emoji changes, invites, and webhooks. " +
      "Server settings are also reconciled after restarts and gateway outages.\n\n" +
      "**⚠️ Platform limitations (Stoat has no native audit log, so these can't be worked around):**\n" +
      "- Server, channel, role, member, and user-profile update events do not identify who acted. Those records say **Actor unavailable from Stoat** instead of guessing. Emoji and invite creators are shown when Stoat supplies them.\n" +
      "- Deletes never say **who** performed them. Delete entries show a clearly labeled heuristic list of the author and members with **Manage Messages**; it is not proof of who acted.\n" +
      '- Newer Stoat backends may identify a member departure as a leave, kick, or ban. Older backends are logged as "left or was removed".\n' +
      "- Bans are detected when a member leaves; unbans are detected by periodic polling (up to ~5 min delay).\n" +
      `${evidenceBullet}\n` +
      "- Messages sent before enablement or while I was offline can't be recovered.\n" +
      "- Invites and webhooks have no gateway events, so REST reconciliation detects them later and requires the corresponding bot permissions. Voice participation is not treated as a server-setting change.\n\n" +
      `Use \`${prefix}AuditLog off\` to turn this off.`,
    colour: "#2ECC71",
  };
}

// ── Helpers ────────────────────────────────────────

function getSourceLabel(game) {
  if (game.source === "hi3_multi") {
    return "[ennead API](https://api.ennead.cc/mihoyo)";
  }
  if (game.source === "game8") {
    return "[Game8](https://game8.co/games/Neverness-to-Everness/archives/593718)";
  }
  return "[hoyo-codes](https://hoyo-codes.seria.moe)";
}
