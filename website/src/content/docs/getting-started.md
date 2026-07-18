---
title: Getting started
description: Start using Irminsul as a member, moderator, or server operator.
---

Irminsul uses message-based commands in server channels. The default prefix is `/`, so using a command looks familiar even though Stoat does not provide Discord-style slash interactions.

## Use the bot as a member

Run the command for the game you want:

```text
/FetchGI
/FetchHSR
/FetchZZZ
/FetchHI3
/FetchNTE
/FetchWuWa
```

Irminsul returns active codes with reward details and a redemption link when the game supports web redemption. HI3, NTE, and WuWa codes are redeemed in-game.

To privately notify server staff about suspected friend-request or DM spam, use a channel where Irminsul has Manage Messages:

```text
/Report-Spam @member reason: sent an unsolicited commission scam DM
```

Irminsul removes the invocation before processing it. Reports never punish an account automatically.

For an in-chat summary, run `/HelpHoyoFetch`. For this full site, run `/Docs`.

## Set up code announcements

An authorized moderator can enable hourly announcements in the channel where the command is sent:

```text
/EnableFetch
```

Choose a narrower feed when needed:

```text
/EnableFetchHoyo
/EnableFetchNTE
/EnableFetchWuWa
/EnableFetchNTEWuWa
```

Run `/DisableFetch` in the channel to stop its announcements. Irminsul remembers subscribed channels across restarts.

`/EnableFetch` covers every supported game. The narrower commands select HoYoverse-only, NTE-only, WuWa-only, or the combined NTE + WuWa feed.

:::tip[No old-code flood]
On a fresh installation, Irminsul seeds the codes it can already see. Existing codes are not announced as newly discovered codes.
:::

## Prepare moderation features

Before using `/Ban`, `/Kick`, `/Mute`, `/Purge-User`, or `/Automod release`, configure a protected audit destination:

```text
/AuditLog here
```

Then verify it through the real delivery path:

```text
/Test-AuditLog
```

Manual moderation fails closed when Irminsul cannot verify the actor's matching permission or cannot use the configured audit channel.

## Command rules

- Commands work only for human members in server channels.
- Direct messages, webhooks, and other bots are ignored.
- Command names are case-insensitive.
- Reasons use the literal `reason:` delimiter and may be up to 300 characters.
- Spam-report reasons must be at least 10 characters, and the command has separate anti-abuse limits.
- Each member can trigger up to five recognized commands within 30 seconds.
- Multiple simultaneous requests for the same game's codes share one upstream fetch.

Next, browse the [complete command reference](/HoYoFetch/commands/) or review the [permissions model](/HoYoFetch/permissions/).
