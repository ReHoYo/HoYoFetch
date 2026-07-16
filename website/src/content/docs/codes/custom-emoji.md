---
title: Custom emoji
description: Use a dedicated Revolt emoji hub for game-themed reward icons.
---

Irminsul uses Unicode reward emoji by default. A self-hosted installation can instead reference custom Revolt emoji by their unique IDs.

## Set up an emoji hub

1. Create a dedicated Revolt server, such as “Irminsul Emoji Hub.”
2. Upload square game and reward icons.
3. Copy each emoji's alphanumeric ID.
4. Invite the bot to the hub server.
5. Fill the matching values in `custom_emojis.json`.
6. Set `EMOJI_MODE=custom`, or switch at runtime with `/EmojiMode custom`.

```json title="custom_emojis.json"
{
  "genshin": {
    "primogem": "01H7ABCDEF123456",
    "mora": "01H7ABCDEF789012"
  },
  "hkrpg": {
    "stellar jade": "01H7XYZXYZXYZ123"
  },
  "_global": {
    "crystal": "01H7GLOBALEMOJI01"
  }
}
```

Game-specific entries override `_global` entries. Empty or missing values fall back to Unicode. Keys named `_comment` are ignored.

## Why a hub works

Revolt custom emoji are referenced globally by ID. If the bot belongs to the emoji hub, it can include those emoji in messages it sends to other servers.

## Switch modes safely

- `/EmojiMode` shows the current runtime mode.
- `/EmojiMode custom` enables configured custom emoji.
- `/EmojiMode unicode` returns to portable Unicode fallbacks.

Changing the mode affects future code embeds and does not rewrite older messages.
