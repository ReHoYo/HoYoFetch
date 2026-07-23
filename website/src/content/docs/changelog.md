---
title: Changelog
description: Major public Irminsul capabilities and documentation milestones.
---

## Version 2.0.0

### Manual moderation and cleanup

- Added `/Ban`, `/Kick`, `/Mute`, `/Purge-User`, and `/Automod release`, backed by fresh actor, target, bot-permission, and audit-destination checks.
- Manual moderation commands now accept plain sentences, such as `/Ban @member for spamming and stuff`. The member, reason, and options may appear in any order; the older `reason:`, `delete:`, and `window:` delimiters remain compatible.
- `/Ban`, `/Kick`, and `/Mute` now require a ✅/❌ confirmation that names the action, target, reason, and typed cleanup window before anything is sent to Stoat. Only the invoking moderator can answer their picker or confirmation.
- Added reaction pickers for mute duration and message-cleanup windows. Cleanup supports 1h, 6h, 1d, 3d, 7d, 14d, or 29d; `/Purge-User` uses the same picker before confirmation.
- Extended cleanup from 7 to 29 days and added a 2,000-message safety cap. Recent messages use bulk deletion, while older messages are paced and deleted individually.
- Cleanup results now distinguish messages already gone from Stoat, missing Manage Messages permission, persistent rate limits, genuine errors, and messages left beyond the safety cap.
- Missing remote messages are reconciled into the local archive so later cleanups do not retry impossible deletions. Rate-limit waits now honor Stoat's response headers and use a slower final retry when needed.
- Successful moderation actions are written through the protected audit pipeline. Freshly authorized moderators also receive a short undo or release window where the action supports it.

### Anti-raid automod

- Added persistent off, monitor, and enforce modes with `/Automod`, including configurable protected log destinations.
- Added scored detection for message bursts, normalized duplicates, mention floods, young accounts or memberships, and join surges. Bots, webhooks, owners, and recognized moderators are excluded.
- Added a persistent containment ladder from 10 minutes through 7 days, a 14-day quiet reset, cleanup of triggering messages, and monitor-only fallback whenever fresh enforcement permissions cannot be verified.
- Permanent bans are never automatic: cases require distinct authorized staff approvals, with a production-default quorum of two.
- Added `/Automod release` to remove a timeout, reset escalation history, and close related pending ban reviews.

### Audit log, evidence, and privacy

- Added `/AuditLog` configuration and the compatibility `/Enable-AuditLog` commands to provide a protected server activity log where Stoat has no native equivalent.
- Audit-log enable, move, and disable requests now require a ten-minute one-time code sent exclusively to Enka#4961, approved or denied via `/AuditLog confirm CODE` or `/AuditLog cancel`. Status, diagnostics, and no-op requests remain immediate, while failed or stale approvals leave configuration unchanged.
- Only one protected audit-log or privacy request may be pending per server at a time. Approved moves and disables leave a lifecycle notice in the previous destination; approved enables and moves record completion in the new one.
- Added raw gateway handling and a bounded 30-day message archive so edits, single deletes, and bulk deletes can retain content the bot previously observed.
- Added `/Test-AuditLog` to exercise protected delivery and report archive, evidence, settings-baseline, and webhook coverage.
- Added bounded local attachment capture so qualifying files can be re-uploaded after their original message disappears.
- Added tamper protection that detects deleted audit records and reposts their stored payload, including across restarts.
- Expanded coverage to membership, moderation, identity, nickname, role, server, channel, emoji, invite, webhook, category, system-message, and permission-override changes. Persisted server settings are reconciled at startup and periodically to catch changes made while the bot was offline.
- Actor attribution now states Stoat's limits instead of guessing. Delete records may show possible moderators as a heuristic, never as proof; noisy avatar-change notices were removed.
- Added `/Exclude-Channel` for recognized moderators. Both adding and removing a message-content exclusion require a ten-minute approval code sent exclusively to Enka#4961.
- Excluded channels do not archive messages or attachments and do not relay message create, edit, delete, or bulk-delete content. Approval purges existing archive entries and evidence; automod continues detecting while withholding excerpts.
- Protected lifecycle notices and a daily digest make active exclusions visible, and the audit destination itself cannot be excluded.

### Member safety reporting

- Added `/Report-Spam` for protected member-submitted friend-request, DM, commission, and scam-spam reports. It accepts natural-language reasons while preserving the 10–300 character limit.
- The public invocation must be deleted before intake continues. Fresh membership checks, per-reporter limits, same-target deduplication, sanitized staff-visible reasons, and 24-hour unique-reporter correlation reduce abuse.
- Correlation metadata is retained for 30 days without duplicating the supplied reason. Priority reports remain staff-review signals and never trigger automatic punishment.

### Redemption codes

- Added Wuthering Waves through cached Game8 parsing of limited-time and permanent active-code tables.
- Added `/FetchWuWa`, `/EnableFetchWuWa`, and `/EnableFetchNTEWuWa`.
- Expanded the all-games feed to include WuWa while preserving existing HoYoverse-only and NTE-only subscriptions.
- Added independent NTE and WuWa caches, case-insensitive Game8 identities, source attribution, and in-game redemption guidance.
- Hardened command access and deduplicated concurrent code fetches and announcements.

### Documentation and usability

- Added a permanent searchable documentation site, `/Docs`, a FAQ, and a link to the full guide from the in-chat help menu.
- Split the in-chat command reference into navigable pages and moved public command metadata into one catalog shared by the bot and website.
- Added automated checks for documented routes, command metadata, and permissions.
- Broadened `/Emoji-Mode` and `/Restart` access to members with the documented management capabilities while keeping sensitive commands behind fresh effective-permission checks.

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
