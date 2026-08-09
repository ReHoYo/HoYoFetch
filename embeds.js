// embeds.js — Build Revolt SendableEmbed objects for code announcements
// ────────────────────────────────────────────────────────────────────
import { GAMES } from "./config.js";
import { formatRewards } from "./api.js";
import {
  COMMAND_SECTIONS,
  DOCS_URL,
  getHelpCommandTuples,
} from "./command-catalog.js";

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

    // Clickable redeem link or game-specific in-game instructions.
    if (game.redeemUrl) {
      lines.push(`[🔗 Click to redeem](${game.redeemUrl}${entry.code})`);
    } else if (game.redeemInstructions) {
      lines.push(`_⚠️ Redeem in-game: ${game.redeemInstructions}_`);
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
 *
 * Split by section rather than one page per few sections — Member and Setup
 * used to share a page, but the catalog has grown past a single 2,000-char
 * embed description, so each section now gets its own page. help-menu.js's
 * navigation is page-count-agnostic, so this scales without further changes.
 */
export function buildHelpEmbeds(prefix) {
  const memberCommands = getHelpCommandTuples(COMMAND_SECTIONS.MEMBER, prefix);
  const setupCommands = getHelpCommandTuples(COMMAND_SECTIONS.SETUP, prefix);
  const moderationCommands = getHelpCommandTuples(
    COMMAND_SECTIONS.MODERATION,
    prefix
  );
  const total = 3;

  return [
    {
      title: `📖 Irminsul Help — Codes & Games (1/${total})`,
      description:
        commandList(memberCommands) +
        "\n\n_Use ▶️. Commands ignore case._\n" +
        `_Full reference: [Irminsul Docs](${DOCS_URL})_\n` +
        "_Sources: [HoYo](https://hoyo-codes.seria.moe), [HI3](https://api.ennead.cc), [Game8: NTE + WuWa](https://game8.co)_",
      colour: "#5865F2",
      icon_url: HELP_ICON,
    },
    {
      title: `⚙️ Irminsul Help — Safety & Setup (2/${total})`,
      description:
        "🔒 **Admin/mod-only commands:** regular members cannot use the commands on this page.\n\n" +
        commandList(setupCommands) +
        "\n\n_Use ◀️/▶️ to move between pages._",
      colour: "#3498DB",
      icon_url: HELP_ICON,
    },
    {
      title: `🛡️ Irminsul Help — Moderation (3/${total})`,
      description:
        "🔒 **Moderator-only commands:** regular members cannot use the commands on this page. Each action requires the matching moderation permission shown below.\n\n" +
        "**Before taking a manual action:** configure an audit channel with `/AuditLog here`. Ban, kick, mute, purge, and release require exactly one member/ID plus a plain-language reason (maximum 300 characters).\n\n" +
        commandList(moderationCommands) +
        "\n\n_History cleanup is best-effort and only covers messages Irminsul observed. Use ◀️ to return._",
      colour: "#E67E22",
      icon_url: HELP_ICON,
    },
  ];
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
  attachmentLines = [],
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
  if (attachmentLines.length)
    lines.push("", "**Attachments:**", ...attachmentLines);
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
  attachmentCount = 0,
} = {}) {
  const lines = [
    `**Author:** ${author}`,
    `**Channel:** <#${channelId}>`,
    `**Before:** ${auditText(before, 800, "*content unavailable — message predates the archive*")}`,
    `**After:** ${auditText(after, 800, "*(no text)*")}`,
  ];
  if (attachmentCount > 0) {
    lines.push(
      `**Attachments:** ${attachmentCount} unchanged file${attachmentCount === 1 ? "" : "s"} on this message (edits cannot change attachments)`
    );
  }
  return buildAuditEmbed("✏️ Message Edited", lines, "#F1C40F");
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

// ── Helpers ────────────────────────────────────────

function getSourceLabel(game) {
  if (game.source === "hi3_multi") {
    return "[ennead API](https://api.ennead.cc/mihoyo)";
  }
  if (game.source === "game8") {
    return `[Game8](${game.sourceUrl})`;
  }
  return "[hoyo-codes](https://hoyo-codes.seria.moe)";
}
