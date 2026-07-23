---
title: Changelog
description: Major public Irminsul capabilities and documentation milestones.
---

## Unreleased — Natural-language moderation

- Manual moderation commands now accept plain sentences: `/Ban @member for spamming and stuff`. The member, the reason, and any option may appear in any order, and the older `reason:`, `delete:`, and `window:` delimiters still work.
- `/Report-Spam` reads the same way: `/Report-Spam @member sent me a scam DM`. The 10–300 character bound and every anti-abuse limit are unchanged.
- `/Ban`, `/Kick`, and `/Mute` now post a ✅/❌ confirmation naming the action, target, and reason before anything is sent to Stoat. A duration chosen from the `/Mute` picker is its own confirmation, so that path is unchanged.
- `/Ban`, `/Kick`, and `/Mute` offer a reaction picker for message cleanup — 1h, 6h, 1d, 3d, 7d, 14d, or 29d — instead of requiring typed delete syntax. `/Purge-User` picks its window the same way before its ✅/❌ confirmation.
- Only the moderator who ran the command can answer their own picker or confirmation.
- Extended cleanup coverage from 7 to 29 days, deleting anything older than the bulk-delete limit one message at a time, capped at 2,000 messages per run with the remainder reported.
- Cleanup results now say _why_ a message was not deleted — already gone from Stoat, missing Manage Messages, still rate limited, or a genuine error — instead of one undifferentiated "failed" count.
- A message Stoat no longer has is reconciled into the message archive rather than counted as a failure, so repeat cleanups stop retrying an ID that can never be deleted.
- Individual deletes are paced to stay inside Stoat's rate limit, the retry wait is read from the rate-limit response headers instead of defaulting to one second, and anything still throttled gets one slower retry before being reported.

## Unreleased — Wuthering Waves

- Added Wuthering Waves through cached Game8 parsing of limited-time and permanent active-code tables.
- Added `/FetchWuWa`, `/EnableFetchWuWa`, and `/EnableFetchNTEWuWa`.
- Expanded the all-games feed to include WuWa while preserving existing HoYoverse-only and NTE-only subscriptions.
- Added independent NTE and WuWa caches, case-insensitive Game8 identities, source attribution, and in-game redemption guidance.

## Member safety reporting

- Added `/Report-Spam` for protected member-submitted friend-request, DM, commission, and scam-spam reports.
- Added secure invocation deletion, fresh membership checks, per-member abuse limits, and 24-hour unique-reporter correlation.
- Priority reports remain staff-review signals only and never trigger automatic moderation.

## Documentation site

- Added a permanent searchable reference for members, moderators, and operators.
- Added `/Docs` and linked the full guide from the in-chat help menu.
- Moved public command metadata into one catalog shared by the bot and website.
- Added automated checks for documented routes and permissions.

## Version 1.1.0

- Added Neverness to Everness support through cached Game8 parsing.
- Added all-games, HoYoverse-only, and NTE-only auto-fetch scopes.
- Added process restart support after deployment.
- Restored Honkai Impact 3rd support through a community API with fallback behavior.
- Added runtime Unicode/custom emoji modes and an optional emoji hub.
- Included HI3 in scheduled fetching and source attribution in code embeds.

## Version 1.0.0

- Launched Genshin Impact, Honkai: Star Rail, and Zenless Zone Zero support.
- Added rich reward embeds and direct redemption links.
- Added hourly new-code detection and persistent channel subscriptions.

For implementation-level history, see the [GitHub repository](https://github.com/ReHoYo/HoYoFetch).
