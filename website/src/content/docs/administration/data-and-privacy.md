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
- automod modes, cases, approvals, strikes, and reversible actions;
- bounded spam-report correlation metadata without member-supplied reasons; and
- protected-message records needed to restore deleted audit entries.

## Message archive

When audit logging is active, server messages are journaled so later edit and delete events can show what Irminsul previously observed. The default retention is 30 days with a cap of 100,000 messages.

The archive is operational evidence. Restrict host access, include it in your community's retention policy, and avoid copying it into public bug reports.

## Attachments

Qualifying attachments can be downloaded at post time because the original file may disappear with a deleted message. The per-file and total-size limits are operator-configurable. Oldest evidence is evicted first when the total budget is reached.

Set `AUDITLOG_EVIDENCE_BUDGET_MB=0` when your community prefers metadata-only delete records.

## Secret handling

Irminsul does not intentionally persist or print:

- bot tokens;
- webhook tokens;
- usable invite codes discovered during monitoring; or
- raw identifiers in security diagnostics when a redacted alias is sufficient.

## Protected audit records

Protected audit messages are intentionally difficult to erase silently: when deletion is detected, Irminsul reposts the stored record and tracks its replacement. A purge never removes protected audit records or locally retained evidence.

Spam-report reasons exist only inside these protected records. The separate `spam_reports.json` file stores identifiers, timestamps, channel references, and the protected message reference for 30-day correlation; it does not duplicate the supplied reason.

:::note[Community policy still matters]
The software provides retention controls, but the server operator remains responsible for informing members, choosing lawful retention, controlling host access, and responding to deletion or access requests that apply to the installation.
:::
