---
title: Changelog
description: Major public Irminsul capabilities and documentation milestones.
---

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
