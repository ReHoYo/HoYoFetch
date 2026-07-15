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

/**
 * Build the help embed listing all commands.
 */
export function buildHelpEmbed(prefix) {
  const cmds = [
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
      "View or configure the server audit log _(admins/mods only)_",
    ],
    [
      `${prefix}Automod [status|monitor|enforce|off|quorum|approve]`,
      "Configure anti-raid monitoring or approve a contained case _(configuration: admins/mods; bans: Ban Members)_",
    ],
    [`${prefix}HelpHoyoFetch`, "Show this help message"],
  ];

  const description = cmds
    .map(([cmd, desc]) => `**\`${cmd}\`**\n${desc}`)
    .join("\n\n");

  return {
    title: "📖 HoyoFetch — Command Reference",
    description:
      description +
      "\n\n_Command names are **case-insensitive**; IDs are preserved exactly._\n" +
      "_Commands are accepted from human server members only._\n" +
      "_GI / HSR / ZZZ codes from [hoyo-codes.seria.moe](https://hoyo-codes.seria.moe)_\n" +
      "_HI3 codes from [api.ennead.cc](https://api.ennead.cc/mihoyo)_\n" +
      "_NTE codes from [Game8](https://game8.co/games/Neverness-to-Everness/archives/593718)_",
    colour: "#5865F2",
    icon_url:
      "https://img-os-static.hoyolab.com/communityWeb/upload/1d7dd8f33c5ccdfdeac86e1e86ddd652.png",
  };
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
      "member joins/leaves, bans, timeouts, nickname and role changes, and emoji changes.\n\n" +
      "**⚠️ Platform limitations (Stoat has no native audit log, so these can't be worked around):**\n" +
      "- Deletes never say **who** performed them. Delete entries show a clearly labeled heuristic list of the author and members with **Manage Messages**; it is not proof of who acted.\n" +
      '- Newer Stoat backends may identify a member departure as a leave, kick, or ban. Older backends are logged as "left or was removed".\n' +
      "- Bans are detected when a member leaves; unbans are detected by periodic polling (up to ~5 min delay).\n" +
      `${evidenceBullet}\n` +
      "- Messages sent before enablement or while I was offline can't be recovered.\n" +
      "- Invites, webhooks, permission overrides, and voice actions aren't reported by the platform at all.\n\n" +
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
