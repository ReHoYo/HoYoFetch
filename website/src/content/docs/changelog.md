---
title: Changelog
description: Major public Irminsul capabilities and documentation milestones.
---

## Unreleased — breaking administrative command cleanup

Administrative setup is now grouped by resource so the same controllers can later back v4.5 dashboard panels. Superseded top-level commands are removed immediately, without aliases or warning handlers. Member commands, reporting, account lookup, manual moderation, `/Level`, `/Restart`, and `/Server-Info` are unchanged.

| Removed command or syntax                | Replacement                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `/EnableFetch [scope]`                   | `/Auto-Fetch enable [all\|hoyo\|nte\|wuwa\|nte-wuwa]`                       |
| `/DisableFetch`                          | `/Auto-Fetch off`                                                           |
| `/EmojiMode unicode\|custom`             | `/Emoji mode unicode\|custom`                                               |
| `/EmojiSetup status`                     | `/Emoji status`                                                             |
| `/EmojiSetup`                            | `/Emoji provision`                                                          |
| `/AuditLog here` or `/AuditLog #channel` | `/AuditLog set here\|#channel`                                              |
| `/Exclude-Channel status`                | `/AuditLog privacy status`                                                  |
| `/Exclude-Channel <channel>`             | `/AuditLog privacy exclude here\|#channel`                                  |
| `/Exclude-Channel remove <channel>`      | `/AuditLog privacy include here\|#channel`                                  |
| `/Automod status`                        | `/Post-Gate status`                                                         |
| Other `/Automod` actions                 | `/Post-Gate protection monitor\|enforce\|off\|quorum\|approve\|release ...` |

`/Post-Gate off` still disables the review queue. `/Post-Gate protection off` independently disables behavioral detection. Existing protection configuration and cases continue using the established `data/automod*.json` storage formats; no data migration is required.

## Version 3.3.1

### Post Gate departure cleanup and quieter expiry reporting

- Fixed full-user Post Gate holds surviving after the member left, was kicked, or was banned. Any member-departure event now deactivates the account-level hold, removes its control and reminder cards, and records one protected cleanup notice; already queued messages remain available for individual review.
- The hourly queue sweep now consolidates every held post that expires for a server into one protected notice instead of posting one card per queue entry. Each item is still discarded after seven days with no automod strike.

## Version 3.3.0

### Unified Raid Mode and Post Gate

- Five unique non-bot joins within 60 seconds now activate one shared, persisted Raid Mode when either Post Gate or Automod is enabled. It creates a restart-safe 30-minute effective Level 2 floor, refreshes during continuing bursts, and posts one protected activation and expiry notice to each unique configured review/logger destination.
- The automatic floor never enables Post Gate, never lowers a manual level, and never automatically enters Level 3 or 4. Post Gate-off/Automod-on installations still receive the shared heightened Automod policy; when both layers are off, joins are not tracked.
- Level 2 now widens targeted link/media review and Automod's recent-identity point to accounts under 14 days and memberships under 3 days. Ordinary text still flows, Automod retains its score-2 behavioral requirement, and contact/profile screening keeps its narrower 7-day/24-hour privacy boundary.
- Removed Automod's separate `joined during active raid mode` score point. The join surge itself adds no score, opens no case, and changes no member.
- `/Level status`, `/Post-Gate status`, `/Automod status`, and `/Server-Info` now distinguish configured and effective policy and show the automatic window and expiry.

## Version 3.2.4

### Reward backfill and article-link fallback

- The long-standing "Reward details unavailable" message is gone. `hoyo-codes.seria.moe` periodically returns a blank reward field for an otherwise-valid code; Irminsul now backfills it from a secondary source — ennead for Genshin/HSR/ZZZ, the Fandom wiki for Honkai Impact 3rd — matching by code identity. The backfill is cached, best-effort, and never blocks a fetch: a slow or failing secondary source just leaves the code as it was.
- When no source has reward text at all, the fallback line now links the game's Game8 (or, for HI3, Fandom) code article instead of a dead end. Only the first rewardless code in a batch carries the link, keeping a 10-code embed well under the 2,000-character description cap.
- Reward values of any shape (an array of strings, an array of `{name,count}` objects, a bare number) are now coerced into a clean display string in one place, closing a latent crash where an API returning an array for `rewards` could throw during emoji formatting.

### Automated reward-icon provisioning

- Custom reward emoji no longer require manually downloading an icon, uploading it to a hub server, and copying its ID into the config. `/EmojiSetup` (or `npm run emoji:provision` on the host) downloads every icon listed in `emoji-icons.js` and uploads it as a Revolt server emoji, reporting what was created, reused, skipped, or failed.
- Provisioning is idempotent: it reads the hub server's existing emoji first, so an already-provisioned keyword is reused rather than re-uploaded, and a wiped local registry self-heals from the server's own state on the next run.
- `/EmojiSetup` only uploads inside the server configured as `EMOJI_HUB_SERVER_ID`; run anywhere else (or with `/EmojiSetup status`), it reports coverage without touching the hub's emoji budget.
- `custom_emojis.json`, which no code actually read despite being the documented config file, is removed. The 11 previously-provisioned emoji IDs are preserved as a fallback seed.
- `EMOJI_HUB_SERVER_ID` now defaults to Irminsul's own in-house hub server, so this deployment needs no `.env` change to use `/EmojiSetup`; the variable still overrides it for a different install.
- Fixed `/EmojiSetup` reporting a confusing `Cannot read properties of undefined (reading 'partial')` for every icon that reached the create-emoji step. The cause: revolt.js's `Server.createEmoji()` hands whatever a `PUT /custom/emoji/{id}` call returns straight to its local object store, and that throws whenever the response has no `_id` — exactly what happens when Stoat rejects the request (for example, missing Manage Customisation) and revolt-api doesn't check the HTTP status before treating the error body as success. Irminsul now calls that endpoint directly and reports Stoat's actual rejection reason instead. Failed downloads also now include the HTTP status, so a blocked host (403) reads differently from a simply-renamed file (404).
- Replaced every Fandom-hosted icon in `emoji-icons.js` with a Game8-hosted one. Fandom's `Special:FilePath` media-serving endpoint rejects automated requests with a blanket HTTP 403 — confirmed against a live deployed run, not just guessed filenames — while its regular wiki _content_ pages (the ones the HI3 code scraper already reads) are unaffected. Every remaining URL was pulled from a live Game8 reward-icon `<img>` tag and verified with a HEAD request before being added.
- Fixed a second round of 404s in that same manifest: the fallback URLs used for Honkai: Star Rail's Adventure Log and every Honkai Impact 3rd item were themselves broken, reused from `GAMES[*].icon` community-upload links that had quietly rotted. Adventure Log now falls back to Game8's HSR hub icon instead (verified reachable). Honkai Impact 3rd has no reliable per-item or even per-game icon source left to fall back to — Game8 has no active hub for the game, Fandom's media endpoint is blocked, and every HoYoLAB community-upload URL tried for it 404s — so its six reward keywords are left out of the provisioning manifest entirely rather than guessing another broken filename; they still render fine through their Unicode fallback in custom mode.
- Fixed the same rotted-icon bug at its source: `GAMES.hkrpg.icon` and `GAMES.nap.icon` in `config.js` (used for the HSR/ZZZ code-announcement embed icon, not just emoji provisioning) were also 404 and are now Game8-hosted; `GAMES.honkai3rd.icon` now points at the official site's favicon as a lower-quality but working fallback.

## Version 3.2.3

### Prohibited-term identity screening

- The prohibited-term filter now also screens **usernames, display names, and server nicknames**, not only message content. A slur used as an identity is visible on every message and in the member list without ever tripping a content filter — this closes that gap using the same compiled term list, allowlist, and normalization the message filter already uses.
- Screening runs at three points: on join, on server nickname change, and on every message (a safety net for an account that joined or renamed before a restart picked up the current term list — username and display-name changes are not their own trigger and are caught the next time the account posts).
- A match places the account in [full Post Gate](/HoYoFetch/moderation/post-gate/#holding-a-whole-member) immediately, the same automatic hold DM/off-platform contact solicitation creates. It never bans, times out, or applies an automod strike by itself.
- The offending name is never shown anywhere Irminsul posts. A review or control card names only the rule id and which field matched (`username`, `display name`, or `nickname`) — the same discipline the message filter already applies by never repeating the matched text.
- The moderator-exemption check for join and nickname-change screening is server-wide (Kick/Ban/Timeout Members or admin), independent of any single channel's permissions — deliberately not the same channel-scoped check message-triggered holds use, since a review channel that grants Manage Messages broadly by default would otherwise exempt an ordinary member.

### Fixed: bare account ID rejected outside the leading word

- `/Ban`, `/Report-Spam`, and `/Get-Info` accept a mention (`<@ID>`) anywhere in the command, but previously only accepted a **bare** account ID either in the very first word or in the exact 26-character Crockford ULID shape — a bare ID placed after the reason, such as `/Ban for coordinating a raid 01ABC…`, was rejected with "Mention one member or provide one valid user ID," an error that named user IDs while refusing one that fit.
- A bare token is now recognized as the target anywhere in the command once it is at least 20 characters and carries a digit or capital letter — comfortably covering every real 26-character Stoat account ID while staying well above any ordinary reason word's length, so `/Kick for raiding` still asks for a member rather than trying to moderate someone called "for."
- `/Kick`, `/Mute`, and `/Automod release` now distinguish "this account is not a current member of this server" from a genuine permission-verification failure, and name `/Ban` as the command for a departed or never-joined account, instead of a single generic "could not be verified" message for both cases.
- `/Ban`, `/Report-Spam`, and `/Get-Info` now also resolve a plain-text `@Username#1234` (typed by hand, not selected from the mention picker) against Irminsul's local account cache — populated from servers it shares with the account, the same cache existing username display already reads from. Stoat's only username-resolution API is "send friend request," so this deliberately never calls it; an uncached account is left unresolved with an error naming the username and discriminator, rather than silently mistargeting the wrong account or falling back to the generic "no target" message. The match is case-sensitive and requires an exact discriminator, since a wrong guess here means moderating the wrong account.

## Version 3.2.2

### Automatic contact-solicitation holds

- Added a fourth Level 1–2 Post Gate trigger for DM availability and off-platform contact solicitation in a recent-identity member's message or current profile bio. It uses Automod's existing eligibility windows — account under 7 days or membership under 24 hours — and does not screen established accounts or established first-time posters.
- The built-in matcher covers open/available DMs, direct contact invitations, platform-labeled handles, supported profile and invite URLs, and explicit email invitations. Bounded normalization handles case, Unicode compatibility forms, invisible characters, diacritics, common homoglyphs, in-word leetspeak, inserted separators, and stretched letters while excluding clear opt-outs and ordinary unlabeled Stoat mentions.
- Automatic holds do not apply a strike, timeout, or ban. Protected cards retain only the stable rule id and whether the signal came from the message or bio; profile contents and external contact details are withheld.
- Successful profile and no-profile checks use a ten-minute, 5,000-entry in-memory LRU cache. Concurrent posts share one lookup; unavailable profiles fail open to message-only detection with redacted diagnostics and a one-minute retry backoff.
- Approving a queued message does not release its account-level hold. A moderator must release the account explicitly; a later match automatically holds it again only while recent-identity eligibility remains active, and cached bio results are ignored after both windows expire.

## Version 3.2.1 — breaking command cleanup

Deprecated compatibility routes and delimiter syntax have been removed instead of retained as runtime warning aliases. Upgrades from versions older than v3 are no longer supported.

The repository has no per-command telemetry, so real-world use of the removed aliases cannot be measured. This is an intentional breaking change, not evidence that nobody invoked them.

| Removed command or syntax                                                        | Replacement                                                                           |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `/Enable-AuditLog`, `/EnableAuditLog`                                            | `/AuditLog here` or `/AuditLog #channel`                                              |
| `/Disable-AuditLog`, `/DisableAuditLog`                                          | `/AuditLog off`                                                                       |
| `/Test-AuditLog`, `/TestAuditLog`                                                | `/AuditLog test`                                                                      |
| `/ExcludeChannel`                                                                | `/Exclude-Channel`                                                                    |
| `/GetInfo`                                                                       | `/Get-Info`                                                                           |
| `/postgate`                                                                      | `/Post-Gate`                                                                          |
| `/EnableFetchHoyo`, `/EnableFetchNTE`, `/EnableFetchWuWa`, `/EnableFetchNTEWuWa` | `/EnableFetch hoyo`, `/EnableFetch nte`, `/EnableFetch wuwa`, `/EnableFetch nte-wuwa` |
| `reason:`, `delete:`, `window:`, `purge:`, `duration:`, `mute:`, `timeout:`      | Plain reasons and bare values, for example `/Ban @member 1d repeated spam`            |

The undocumented internal `postgate` route, retired `moderation_level.json` subsystem, v2 evidence-cache infrastructure, and completed pre-v3 startup migrations were also removed. Defensive readers remain for legacy attachment shapes in the one-year archive and Post Gate queue entries without an author ID until live data proves they are gone.

## Version 3.2.0

### Prohibited-term hold filter

- Added a third Level 1–2 hold trigger: a message matching the prohibited-term list is held for review regardless of the author's tenure or whether the post carries a link, closing the gap where a single targeted slur produced none of the burst or flood behaviour automod scores on.
- Matching is word- and phrase-aware rather than substring-based. Every term is anchored between word boundaries and no stage of matching deletes separators from the message, so `Scunthorpe` is structurally incapable of matching. Evasion is handled by normalising the message toward the term — Unicode compatibility and case folding, invisible and control characters removed, diacritics stripped, Cyrillic and Greek homoglyphs folded, leetspeak folded only inside a word, separators between letters tolerated for longer terms, and stretched letters collapsed — while a term's own repeated letters are still required.
- An allowlist takes precedence over any term it overlaps, so an innocent phrase is rescued without exempting the same term used on its own elsewhere in the message.
- A match only ever holds. It never bans, times out, or records an automod strike by itself; the strike follows a moderator's denial exactly as it does for a link hold.
- Irminsul ships a small built-in list plus the classic false positives. Operators extend it with `prohibited_terms.json` in the data directory and reload it with `/Post-Gate terms` without restarting. A missing file is silent, a malformed one is logged once and ignored so the built-in list stays active, and the degraded state is reported in `/Post-Gate status`.
- Review cards and log lines name the rule id that fired, never the matched text, so reviewing a slur does not republish it into the review channel.

### Deny and hold a user

- Added a third review action, `Deny + Hold User` (🔒 or `/Post-Gate deny-hold QUEUE_ID`). It discards the post and advances the strike stage exactly as Deny does, then places the author in full Post Gate so every later message they send is held for review.
- A persistent control card in the review channel records who placed the hold and when, and carries a 🔓 release reaction. Holding is idempotent: denying the same author again reports the existing hold rather than stacking records or reposting the card.
- Hold state is persisted alongside the rest of Irminsul's moderation state, so it survives a bot restart — control cards included — and survives the member leaving and rejoining, because it is keyed on the server and the account rather than on membership. Moving the review channel reposts every control card into the new one.
- Releasing with 🔓 or `/Post-Gate release @member` restores normal posting immediately, but messages already in the review queue stay queued and are reviewed individually; the release notice states how many are outstanding. A release is a judgement about the author, not a way to publish a queue nobody read.
- A hold never expires or releases on its own. After 24 hours — configurable with `POST_GATE_HOLD_REMINDER_HOURS` — moderators get a reminder offering Release or Continue Holding, repeating once per window rather than once per maintenance sweep.
- `/Post-Gate holds` lists who is currently gated, who held them, since when, and how many of their messages are still queued.

### One decision per held post

- Fixed a race where two moderators acting on the same held post in the same instant could both pass the "still pending" check, because the permission refresh between that check and the write is asynchronous. Decisions are now serialised per queue entry and re-checked after authorization, so exactly one outcome is recorded, one review card deleted, and one accountability notice posted.
- The moderator who acted second is told the outcome the first one recorded instead of receiving a generic queue-status reply.

## Version 3.1.0

### VPS-only emergency lock

- Added host-side `emergency:lock`, `emergency:status`, and `emergency:unlock` commands that control the server default Send Messages permission over REST without waiting for Stoat gateway command delivery.
- Persisted ownership before mutation, preserved unrelated permission bits, retried transient failures, and prevented the recovery path from enabling sending when another lock owned the disabled state.

## Version 3.0.0

### Server moderation levels

- Replaced the short-lived threshold/kick-based `/Level 1|2|3` posture with persistent Post Gate-backed Levels 1–4. Levels 1–2 review qualifying new-member links/media, Level 3 locks default-role sending and deletes slips, and Level 4 also bans slipped-message authors after an invoker-only reaction confirmation.
- Hardened Levels 1–2 against common link obfuscation, including inserted whitespace and invisible characters, spaced or `hxxp` protocols, Unicode punctuation, bracketed dots, domains, and IPv4 addresses. Detection uses a normalized copy while review evidence keeps the original text.
- Persisted permission-lock ownership so downgrades restore only the Send Messages bit Irminsul removed; startup, server-update, and periodic reconciliation repair drift.
- Lockdown messages bypass review, automod, commands, attachment copies, and message archives to prevent queue floods.
- Renamed the separate per-member automod timeout ladder publicly to strike stages while preserving its existing persisted data.
- Consolidated the four strike stages into one canonical table and shortened the repeated post-gate explanation.

## Version 2.5.1

### Level 2/3 no longer hold plain text

- Levels 2 and 3 dropped `holdEveryMessage`: they now hold the same trigger as level 1 — links and attachments — instead of queuing every message a new account posts. Moderators reported that holding plain-text greetings both discouraged new members from sticking around and made the review queue unsustainable to keep up with.
- The wider "new account"/"new member" windows, the lower automod score threshold, and (at level 3) kick-on-join and tenure-gated posting are unchanged, so levels 2 and 3 are still meaningfully stricter than level 1. Text-only abuse from a new account is now covered by automod's behavioral scoring rather than by manual review of every message.

## Version 2.5.0

### Moderation levels

- Added `/Level 1|2|3`, a single dial for the whole server's moderation posture, using the same capability-based moderator policy as `/Automod` and `/Post-Gate` (owner, Manage Server, or a recognized moderation capability). Every server starts at level 1, which is the behavior that existed before this release, and `/Level 1` stands everything back down.
- **Level 2** holds every message from a new account instead of only links and attachments, widens "new account" from 7 days to 30 and "new member" from 24 hours to 7 days, lets automod act on a single behavioral signal, and trips raid mode at 3 joins in 60 seconds for 30 minutes.
- **Level 3** adds two enforcement actions: every new join is kicked on sight, and members who joined less than the tenure threshold ago (default 7 days, adjustable with `/Level tenure <1-30>`) have their messages deleted and their automod strike raised.
- A behavioral signal remains mandatory at every level. Being new, or joining during a raid, still only adds weight to observed behavior and can never trigger containment on its own.
- Level 3 is refused unless the command carries the literal word `confirm` and `/Automod` has a log channel configured, so no automatic kick can happen without a protected record. Bots and verified moderators are never kicked, and a joiner whose fresh permission check cannot complete is reported rather than removed.
- A restricted member has every message deleted but escalates at most one strike per 15 minutes, so a flood cannot walk an account to the top of the ladder in seconds or fill the log with hundreds of notices.
- Levels only retune thresholds `/Automod` and `/Post-Gate` already own; raising the level does not switch either feature on.

### Post-gate approval no longer reposts

- `/Post-Gate approve` and the ✅ reaction now clear the **author** rather than republishing the content: the review card is removed and the author's automod strike is reset to zero. The held message is not reposted, and the author is free to post it again themselves.
- Previously, approval re-uploaded every held attachment and republished the message as Irminsul attributed to the original author. Under a sustained wave that made the review queue a delivery mechanism, since clearing an account also relaunched whatever it had posted.
- A dead or unavailable archive copy no longer blocks approval. `repost_failed` and `attachments_unavailable` no longer exist as outcomes, because nothing is republished.

## Version 2.4.2

### Reliable member join and leave records

- Member joins and departures are now read from the raw gateway stream in addition to the Stoat library's own events. Previously a join was lost whenever the library's account lookup failed before it announced the event, and a departure was lost whenever its payload did not match the exact shape the library expected — in both cases silently, with nothing posted and nothing reported.
- Each arrival and departure is still recorded exactly once no matter which source delivered it.
- `/Test-AuditLog` and `/Server-Info` now report member joins and leaves separately, distinguishing what arrived on the wire from what was posted, with a running count of discarded events and the most recent reason.
- Member, identity, and nickname listeners now report their own failures instead of surfacing as an untraceable console error.
- An account Irminsul has never cached is reported with an **unknown** avatar rather than being flagged for review as a default-avatar account.

## Version 2.4.1

### Stoat-hosted attachment archive

- Replaced the persistent VPS attachment cache with immediate RAM-only copies into protected Stoat Logger cards. The local journal now keeps filenames, sizes, Stoat URLs, and protected record IDs but never attachment bytes.
- Delete and edit records reference the existing Logger card; bulk deletes reply to at most five cards and list the remaining record IDs without re-uploading media.
- Added a bounded two-worker, 50-message archive queue, precise transfer failure reasons, metadata-only tamper restoration, and automatic cleanup of direct regular files in the legacy `data/evidence/` directory.
- Moved first-post attachment storage to the Stoat review card. Approval requires every file and copies it through RAM; approval, rejection, and expiry intentionally remove the review card on completion.
- Retired `AUDITLOG_EVIDENCE_BUDGET_MB`; `AUDITLOG_EVIDENCE_MAX_MB=0` is now the metadata-only opt-out.

## Version 2.4.0

### First-post gate

- Added `/Post-Gate`, an Enka-approved review queue that holds a message instead of leaving it visible when it carries a link or an attachment **and** its author is a new account, a newly joined member, or has no other archived message in this server.
- A held message is deleted immediately and posted to a dedicated review channel with a bounded evidence excerpt; a single recognized moderator clears it with ✅/❌ or `/Post-Gate approve|reject QUEUE_ID`.
- Approving reposts the content as Irminsul, attributed to the original author. Rejecting discards it and increases the author's automod strike stage, so a repeat offender escalates faster without applying a timeout by itself.
- Turning the gate on, moving its review channel, and turning it off each require a fresh one-time code sent exclusively to Enka#4961, the same approval flow used by `/AuditLog` and `/Exclude-Channel`. Privacy-excluded channels are never gated, and recognized moderators are always exempt.
- Unreviewed holds expire and are discarded after 7 days with no strike.

### Consistent attachment logging

- Bulk message deletes now resolve and re-upload preserved attachment evidence like single deletes and edits already did, instead of showing only text; re-uploads are capped at 10 files per bulk event to bound worst-case load.
- Edited messages now note how many attachments the message carries, since edits cannot change them.
- Replaced the single generic "not preserved (too large or evidence capture was disabled)" line with the actual reason — evidence capture disabled, an untrusted URL, over the size cap, a failed download, or a local save error — consolidated into one shared module (`attachment-evidence.js`) so every caller reports it identically.

### Daily privacy digest fix

- Fixed the privacy exclusion digest never firing for a bot that restarts more often than once a day: it previously reset a fixed 24-hour timer on every boot with no memory of when it last posted. The digest now persists each server's last-posted time and polls hourly, so a restart no longer loses progress and a failed send retries within the hour instead of silently skipping a day.

## Version 2.3.0

### Account lookup beyond the server

- Expanded `/Get-Info` into a tiered lookup for current members, banned and departed accounts, accounts visible through another community, and accounts that have never joined this server.
- Account creation time is now derived from a valid Stoat ID even when no network identity is visible. Ban-list identity and reasons, platform flags, local moderation history, and archive evidence are combined without turning permission or network failures into false not-found errors.
- Reports state their lookup scope, whether ban-list access was unavailable, and up to three other cached mutual servers through which Irminsul can see the target.

### Reliability fixes

- Validated all user and member payload IDs before hydrating revolt.js collections, preventing error bodies or mismatched responses from poisoning the user cache.
- Stopped denied profile requests from producing a false “No bio set” signal and stopped unknown avatar state from being described as a default avatar.
- Fixed account collection so an identity supplied by the caller, including ban-list identity, is no longer discarded in favor of a cache reread.

## Version 2.2.0

### Year-long archive and retention

- Extended the message archive's retention from 30 days to 1 year, using calendar-correct month/year arithmetic so retention doesn't drift across leap years.
- Raised the archive's message cap from 100,000 to 1,000,000 (configurable via `HOYOFETCH_ARCHIVE_MAX_MESSAGES`) and moved the boot-time journal replay to a streaming reader to support the larger cap.
- Extended `/Ban`, `/Kick`, `/Mute` cleanup, and `/Purge-User` from a 1h–29d picker to 1h–1y (1h, 6h, 1d, 3d, 7d, 1mo, 3mo, 6mo, 1y), so the longest cleanup window now matches the archive's retention exactly instead of stopping a day short.
- Added an archived message count and its coverage start date to `/Get-Info`, and switched it to listing every account/membership field it collects instead of omitting empty ones. The join log's rendering is unchanged.

## Version 2.1.0

### Account intelligence

- Join records now include full account and membership detail — creation date, avatar status, platform badges and flags, roles, and prior automod or spam-report history — instead of just a username.
- Added a computed **⚠️ Signals** summary to join records and `/Get-Info`, naming the specific conditions that make an account worth a second look, such as a brand-new account or one created moments before it joined.
- Added `/Get-Info @member` to look up the same account and membership detail on demand, including for members who already left the server. Restricted to recognized moderators.
- The join log reads only locally cached data, so a join surge never triggers extra Stoat requests; `/Get-Info` additionally fetches the account's profile since it targets one account at a time.

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
