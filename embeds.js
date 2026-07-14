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
export function buildCodesEmbed(gameKey, codes, { isAuto = false, page = null } = {}) {
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
    [
      `${prefix}FetchGI`,
      "Fetch active **Genshin Impact** redemption codes",
    ],
    [
      `${prefix}FetchHSR`,
      "Fetch active **Honkai: Star Rail** redemption codes",
    ],
    [
      `${prefix}FetchZZZ`,
      "Fetch active **Zenless Zone Zero** redemption codes",
    ],
    [
      `${prefix}FetchHI3`,
      "Fetch active **Honkai Impact 3rd** codes",
    ],
    [
      `${prefix}FetchNTE`,
      "Fetch active **Neverness to Everness** codes",
    ],
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
      "Show or switch how reward emoji are rendered",
    ],
    [
      `${prefix}Restart`,
      "Restart the bot process after deploying updates _(owner/admin only)_",
    ],
    [
      `${prefix}Enable-AuditLog`,
      "**Mods only.** Post a live log of server actions (deletes, edits, joins/leaves, bans, channel/role changes) to this channel",
    ],
    [
      `${prefix}Disable-AuditLog`,
      "Turn off audit logging for this server",
    ],
    [
      `${prefix}Test-AuditLog`,
      "Send a test event through the audit log to verify it is working",
    ],
    [
      `${prefix}HelpHoyoFetch`,
      "Show this help message",
    ],
  ];

  const description = cmds
    .map(([cmd, desc]) => `**\`${cmd}\`**\n${desc}`)
    .join("\n\n");

  return {
    title: "📖 HoyoFetch — Command Reference",
    description:
      description +
      "\n\n_All commands are **case-insensitive**._\n" +
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
  const description = [...lines, "", `_${new Date().toUTCString()}_`].join("\n");
  return { title, description, colour };
}

/**
 * Build the confirmation embed shown when audit logging is enabled,
 * including the platform limitations that can't be worked around.
 */
export function buildAuditLogEnabledEmbed(prefix, { moved = false, previousChannelId = null } = {}) {
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
      "- Deletes/edits never say **who** performed them — only the change itself is shown.\n" +
      "- A kick and a voluntary leave look identical — logged as \"left or was kicked\".\n" +
      "- Bans are detected when a member leaves; unbans are detected by periodic polling (up to ~5 min delay).\n" +
      `${evidenceBullet}\n` +
      "- Messages sent before enablement or while I was offline can't be recovered.\n" +
      "- Invites, webhooks, permission overrides, and voice actions aren't reported by the platform at all.\n\n" +
      `Use \`${prefix}Disable-AuditLog\` to turn this off.`,
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
