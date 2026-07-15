// help-menu.js — invoker-only reaction pagination for the help reference
import { buildHelpEmbeds } from "./embeds.js";
import { auditAlias, isSafeId, safeErrorSummary } from "./security.js";

export const HELP_PREVIOUS_EMOJI = "◀️";
export const HELP_NEXT_EMOJI = "▶️";
export const HELP_MENU_LIFETIME_MS = 5 * 60 * 1000;
const MAX_OPEN_MENUS = 250;

export function createHelpMenu(
  client,
  {
    send,
    request,
    prefix = "/",
    logger = console,
    now = Date.now,
    attach = true,
  } = {}
) {
  if (typeof send !== "function")
    throw new TypeError("Help menu requires a sender.");
  if (typeof request !== "function") {
    throw new TypeError("Help menu requires an HTTP requester.");
  }

  const openMenus = new Map();

  function prune() {
    const current = now();
    for (const [messageId, menu] of openMenus) {
      if (menu.expiresAt <= current) openMenus.delete(messageId);
    }
    while (openMenus.size > MAX_OPEN_MENUS) {
      openMenus.delete(openMenus.keys().next().value);
    }
  }

  async function seedReaction(channelId, messageId, emoji) {
    const result = await request(
      "PUT",
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`
    );
    if (!result.ok) {
      logger.warn?.(
        `help: reaction seed failed channel=${auditAlias(channelId)} status=${result.status}`
      );
    }
  }

  async function open(message) {
    prune();
    const channelId = message.channelId ?? message.channel?.id;
    if (!isSafeId(channelId) || !isSafeId(message.authorId)) return;
    const pages = buildHelpEmbeds(prefix);
    const sent = await send(channelId, { embeds: [pages[0]] });
    if (!isSafeId(sent?._id) || pages.length < 2) return;

    openMenus.set(sent._id, {
      authorId: message.authorId,
      channelId,
      expiresAt: now() + HELP_MENU_LIFETIME_MS,
      index: 0,
      pages,
    });
    await Promise.all([
      seedReaction(channelId, sent._id, HELP_PREVIOUS_EMOJI),
      seedReaction(channelId, sent._id, HELP_NEXT_EMOJI),
    ]);
  }

  async function handleRawEvent(event) {
    if (
      event?.type !== "MessageReact" ||
      !isSafeId(event.id) ||
      !isSafeId(event.user_id) ||
      event.user_id === client.user?.id ||
      ![HELP_PREVIOUS_EMOJI, HELP_NEXT_EMOJI].includes(event.emoji_id)
    ) {
      return;
    }
    prune();
    const menu = openMenus.get(event.id);
    if (!menu || event.user_id !== menu.authorId) return;

    const direction = event.emoji_id === HELP_NEXT_EMOJI ? 1 : -1;
    const nextIndex =
      (menu.index + direction + menu.pages.length) % menu.pages.length;
    const update = await request(
      "PATCH",
      `/channels/${menu.channelId}/messages/${event.id}`,
      { embeds: [menu.pages[nextIndex]] }
    );
    if (!update.ok) {
      logger.warn?.(
        `help: page update failed channel=${auditAlias(menu.channelId)} status=${update.status}`
      );
      return;
    }
    menu.index = nextIndex;

    // Remove the invoker's reaction so the same arrow can be used repeatedly.
    const removal = await request(
      "DELETE",
      `/channels/${menu.channelId}/messages/${event.id}/reactions/${encodeURIComponent(event.emoji_id)}?user_id=${event.user_id}`
    );
    if (!removal.ok) {
      logger.warn?.(
        `help: reaction reset failed channel=${auditAlias(menu.channelId)} status=${removal.status}`
      );
    }
  }

  if (attach) {
    client.events.on("event", (event) => {
      handleRawEvent(event).catch((error) =>
        logger.warn?.(
          `help: reaction handler failed ${safeErrorSummary(error)}`
        )
      );
    });
  }

  return { handleRawEvent, open };
}
