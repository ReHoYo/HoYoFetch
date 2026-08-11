---
title: Custom emoji
description: Auto-provision a dedicated Revolt emoji hub for game-themed reward icons.
---

Irminsul uses Unicode reward emoji by default. A self-hosted installation can instead render real game icons by pointing Irminsul at a hub server and letting it provision the emoji itself — there is no manual download/upload/copy-the-ID step.

## Set up an emoji hub

1. Create a dedicated Revolt server, such as “Irminsul Emoji Hub.”
2. Invite the bot with **Manage Customisation**.
3. Set `EMOJI_HUB_SERVER_ID` in `.env` to that server's ID.
4. Run `/EmojiSetup` in that server (or `npm run emoji:provision` on the host). It downloads every icon listed in `emoji-icons.js` and uploads it as a server emoji, then reports what was created, reused, skipped, or failed.
5. Set `EMOJI_MODE=custom`, or switch at runtime with `/EmojiMode custom`.

`/EmojiSetup` is safe to run again later — it reads the hub server's existing emoji first, so an already-provisioned keyword is reused rather than re-uploaded. Running it outside the hub server (or with `/EmojiSetup status`) only reports coverage; it never uploads.

Provisioned IDs persist to `data/emoji_registry.json`. If that file is ever lost, re-running `/EmojiSetup` costs nothing extra: it rebuilds the registry from the hub server's own emoji list.

## Why a hub works

Revolt custom emoji are referenced globally by ID. If the bot belongs to the emoji hub, it can include those emoji in messages it sends to other servers. Revolt has no equivalent of Discord's application-owned emoji, so a hub server can't be eliminated — only the manual work of populating it can, which is what `/EmojiSetup` does.

## Switch modes safely

- `/EmojiMode` shows the current runtime mode.
- `/EmojiMode custom` enables provisioned custom emoji.
- `/EmojiMode unicode` returns to portable Unicode fallbacks.

Changing the mode affects future code embeds and does not rewrite older messages.
