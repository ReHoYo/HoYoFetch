---
title: Manual moderation
description: Ban, kick, mute, purge, release, confirmation, cleanup, and undo behavior.
---

All manual actions require an active Irminsul audit channel.

## Ban

```text
/Ban @member reason: repeated spam
/Ban @member delete:1d reason: raid cleanup
```

`/Ban` acts immediately after verifying Ban Members. Optional `delete:` cleanup accepts `1h`, `6h`, `1d`, `3d`, or `7d` and also requires Manage Messages.

The protected record accepts a ↩️ reaction for ten minutes from a freshly authorized ban moderator. Undo unbans the account but cannot restore membership or deleted messages.

## Kick

```text
/Kick @member reason: raid account
```

`/Kick` verifies Kick Members and acts immediately. A kick cannot be undone by the bot; the member needs a new invite to return.

## Mute

```text
/Mute @member 1h reason: cooldown
/Mute @member reason: choose a duration
```

Supported durations are `10m`, `30m`, `1h`, `4h`, `24h`, `3d`, and `7d`. Omitting the duration opens a two-minute picker for the command invoker. The protected record offers a ten-minute ↩️ release window to freshly authorized timeout moderators.

## Purge observed messages

```text
/Purge-User @member window:1d reason: cleanup
```

Supported windows are `1h`, `6h`, `1d`, `3d`, and `7d`. The command opens a two-minute ✅/❌ confirmation and allows one purge per server at a time.

Only messages recorded by Irminsul can be selected. Protected audit entries, retained evidence, quotations, reactions, and external copies are not erased.

## Release and reset automod history

```text
/Automod release @member reason: false positive
```

This removes a native timeout, resets the member's automod strike history, and closes pending ban reviews for the containment. It can also release a manually applied timeout.

:::caution[History cleanup is best-effort]
Stoat's ban route has no message-history option, and its bulk-delete route accepts only recent messages. Irminsul deletes archived message IDs separately in bounded batches and reports partial failures.
:::
