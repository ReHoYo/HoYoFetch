---
title: Data and privacy
description: What Irminsul stores, why it stores it, how long evidence remains, and what it refuses to log.
---

Irminsul uses local JSON and JSONL files rather than an external database. Self-hosters control the machine and directory where this data is retained.

## Operational state

The bot persists data needed to avoid duplicate announcements and resume configured behavior, including:

- subscribed channels and their feed scopes;
- known redemption codes and source cache entries;
- audit destinations and server-setting baselines;
- Enka-approved channel exclusions in `channel_exclusions.json`;
- automod modes, cases, approvals, strikes, and reversible actions;
- the post gate's mode, review channel, and pending/resolved held-post queue;
- bounded spam-report correlation metadata without member-supplied reasons; and
- protected-message records needed to restore deleted audit entries.

## Message archive

When audit logging is active, server messages are journaled so later edit and delete events can show what Irminsul previously observed. The default retention is 1 year (calendar-correct across leap years) with a cap of 1,000,000 messages, configurable via `HOYOFETCH_ARCHIVE_MAX_MESSAGES`.

The archive is operational evidence. Restrict host access, include it in your community's retention policy, and avoid copying it into public bug reports.

An approved `/Exclude-Channel` request purges that channel's existing archive entries and prevents new message content from entering the archive. Removing an exclusion affects only future messages; purged content is not restored.

## First-post gate queue

A message held by `/Post-Gate` (see [First-post gate](/HoYoFetch/moderation/post-gate/)) is removed from its original channel and its content and any captured attachment evidence are retained in the held-post queue pending a moderator decision. Approving reposts the content publicly; rejecting or letting the hold expire after 7 days discards the content and its evidence. Privacy-excluded channels are never gated, since the gate would otherwise capture content that exclusion is meant to withhold.

## Attachments

Qualifying attachments can be downloaded at post time because the original file may disappear with a deleted message. The per-file and total-size limits are operator-configurable. Oldest evidence is evicted first when the total budget is reached.

Set `AUDITLOG_EVIDENCE_BUDGET_MB=0` when your community prefers metadata-only delete records.

## Account checks

The enriched join log and `/Get-Info` (see [Account checks](/HoYoFetch/moderation/account-checks/)) read live Stoat account and membership data plus Irminsul's existing local records. `/Get-Info` may read the full server ban list to confirm a ban and recover its reason and limited identity, probe the target's platform flags as an existence check, fetch a visible profile, and count the target's messages in the local archive.

These reads introduce no new persisted storage. A lookup is not written to disk, the archive scan is read-only, and `/Get-Info` deliberately does **not** update `knownBans`; that snapshot belongs to unban polling, where replacing it from an ad hoc lookup could suppress a real unban audit entry.

When the target is cached as a member elsewhere, `/Get-Info` names up to three other servers Irminsul shares with that account. Only members authorized under the `FETCH_MANAGER` policy (server owner, Manage Server, or a recognized moderation capability) can run the command. Even with that restriction, this means one server's membership can be disclosed to moderators of another server using the same bot instance. Server operators should account for that in their member-facing privacy policy.

## Secret handling

Irminsul does not intentionally persist or print:

- bot tokens;
- webhook tokens;
- usable invite codes discovered during monitoring; or
- raw identifiers in security diagnostics when a redacted alias is sufficient.

## Protected audit records

Protected audit messages are intentionally difficult to erase silently: when deletion is detected, Irminsul reposts the stored record and tracks its replacement. A member purge never removes protected audit records or locally retained evidence. An Enka-approved channel exclusion is the exception: it deliberately deletes archived content and evidence for that channel.

Spam-report reasons exist only inside these protected records. The separate `spam_reports.json` file stores identifiers, timestamps, channel references, and the protected message reference for 30-day correlation; it does not duplicate the supplied reason.

:::note[Community policy still matters]
The software provides retention controls, but the server operator remains responsible for informing members, choosing lawful retention, controlling host access, and responding to deletion or access requests that apply to the installation.
:::
