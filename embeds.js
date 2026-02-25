// embeds.js — Build Revolt SendableEmbed objects for code announcements
// ────────────────────────────────────────────────────────────────────
import { GAMES, HI3_SOURCES } from "./config.js";
import { formatRewards } from "./api.js";

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
      `${prefix}EnableFetch`,
      "Enable hourly auto-fetch of new codes in this channel",
    ],
    [
      `${prefix}DisableFetch`,
      "Disable auto-fetch in this channel",
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
      "_GI / HSR / ZZZ codes from [hoyo-codes.seria.moe](https://hoyo-codes.seria.moe)_\n" +
      "_HI3 codes from [api.ennead.cc](https://api.ennead.cc/mihoyo)_",
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

// ── Helpers ────────────────────────────────────────

function getSourceLabel(game) {
  if (game.source === "hi3_multi") {
    return "[ennead API](https://api.ennead.cc/mihoyo)";
  }
  return "[hoyo-codes](https://hoyo-codes.seria.moe)";
}
