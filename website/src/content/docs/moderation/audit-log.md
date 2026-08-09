---
title: Audit log
description: Configure protected server activity records, archive message content, mirror qualifying attachments to Stoat, and understand platform limits.
---

Stoat does not provide a native server audit log. Irminsul can relay activity into one protected channel per server.

## Configure the destination

```text
/AuditLog here
/AuditLog #moderation-log
/AuditLog status
/AuditLog test
/AuditLog off
/AuditLog confirm 123456
/AuditLog cancel
```

Run `/AuditLog test` after setup. It sends a test event through the real protected-delivery pipeline and reports message archive coverage, Stoat-hosted attachment mode and per-file cap, queue activity, capture failures since startup, settings baseline, and webhook coverage.

Enabling, moving, or disabling the audit log requires **two steps**:

1. A recognized moderator requests the change.
2. Irminsul sends a ten-minute, six-digit code exclusively to **Enka#4961**. Enka can reply with `approve CODE`, `deny CODE`, or the bare code, or release it for a recognized moderator to relay with `/AuditLog confirm CODE`.

The requester or Enka can use `/AuditLog cancel`. Three incorrect attempts destroy a request. If Enka cannot be reached by DM, audit logging fails closed in its existing state. Requests to keep the current destination or disable an already-disabled log return immediately without generating a code. `/AuditLog status` and `/AuditLog test` are read-only and never require approval.

Only one protected audit/privacy request can be pending per server. Moves and disables are recorded in the previous protected destination before it is replaced or disabled; successful enables and moves record completion in the new destination. The destination and Irminsul's Send Messages permission are checked again when approval arrives, and stale requests make no change.

## Exclude private channels

```text
/Exclude-Channel status
/Exclude-Channel #private-channel
/Exclude-Channel remove #private-channel
/Exclude-Channel confirm 123456
/Exclude-Channel cancel
```

Adding or removing an exclusion requires **two steps**:

1. A recognized moderator requests the change. This includes the server owner, Manage Server, Kick Members, Ban Members, Timeout Members, or effective Manage Messages in the current channel.
2. Irminsul DMs a ten-minute, six-digit code exclusively to **Enka#4961**, the fixed approver for this in-house deployment. Enka can reply with `approve CODE`, `deny CODE`, or the bare code, or relay it for `/Exclude-Channel confirm CODE` in the server.

Only one protected request can be pending per server, and three incorrect attempts destroy it. If Enka cannot be reached by DM, the request fails closed and logging continues unchanged. Both exclusion and removal require a fresh code.

An approved exclusion withholds only message content:

- new messages and attachments are not archived;
- edits, deletes, and bulk deletes are not relayed;
- existing archive entries and their Stoat-hosted attachment archive cards are permanently purged; and
- automod continues detecting raids, but its protected case log replaces excerpts from the channel with a privacy-withheld notice.

Channel, role, permission, moderation, membership, and other server events continue logging. The audit-log destination itself cannot be excluded. A protected daily digest lists every active exclusion so a privacy change cannot remain quiet.

:::caution[Purge coverage]
`/Purge-User` cannot clean messages in an excluded channel because Irminsul deliberately has no archived message IDs for that channel.
:::

Enka's approval prevents a moderator from silently changing message-content collection alone. It does not stop a server owner from removing the bot, or a host operator from editing `data/channel_exclusions.json` as a break-glass action.

## Events covered

The live pipeline and periodic reconciliation cover:

- message edits, deletes, and bulk deletes;
- joins, leaves, kicks, bans, unbans, and timeouts;
- username, nickname, and role changes;
- server identity, discovery, categories, and system-message routing;
- channels, roles, emoji, invites, webhooks, and permission overrides.

Server-setting reconciliation runs at startup and roughly every five minutes, allowing changes made while the bot was offline to be detected later.

## Join records now include account intelligence

A join record no longer stops at a username. It carries every account and membership detail Irminsul can read locally — account creation date, avatar status, platform badges and flags, roles, and any prior automod or spam-report history — plus a **⚠️ Signals** line naming the specific conditions that make an account worth a second look (a brand-new account, an account created moments before joining, a default avatar, and so on).

A join titled **📥 Member Joined — review** has at least one signal; a plain **📥 Member Joined** does not. Signals are heuristics for a moderator to weigh, not proof that an account is a bot. The join record never fetches the account's bio or banner — it works entirely from data Irminsul already has cached, so a join surge cannot turn into a burst of extra API calls. See [Account checks](/HoYoFetch/moderation/account-checks/) for the same detail on demand via `/Get-Info`.

When the account is not in Irminsul's cache, its avatar is reported as **unknown** rather than counted as a default avatar, so an uncached join is not flagged for review on that basis alone.

## Confirming member events are arriving

Joins and departures are the only audit records that can fail with nothing posted and nothing to show for it — the Stoat library discards a join whose account lookup fails, and an unrecognized departure payload used to be discarded outright. Irminsul now reads both from the raw gateway stream as well, so a record is posted even when the library drops its own event, and each arrival is logged exactly once regardless of which source delivered it.

Both `/AuditLog test` and `/Server-Info` report what was seen on the wire separately from what was posted:

- **seen but never posted** — the events are reaching Irminsul and something is discarding them. The accompanying drop reason names the cause.
- **never seen** — Stoat is not delivering member events to this bot at all, which is a permission or server-side issue rather than a configuration one.
- **dropped** — a running count, with the most recent reason.

## Recovering message content

Delete events contain only a message ID. While audit logging is active, Irminsul records server messages to a local journal retained for 1 year and capped at 1,000,000 messages by default. This lets later edit and delete records include the content that the bot observed.

Messages sent before logging began or while the bot was offline cannot be recovered.

## Stoat-hosted attachment archive

Attachment URLs may stop working as soon as their message is deleted, and Stoat upload IDs belong to one message. Irminsul therefore copies qualifying attachments immediately into one protected **📎 Attachment Archived** Logger card per source message. The card identifies the source author, channel, message ID, filenames, sizes, and any failures without duplicating the source text.

Bytes exist only in RAM during the source download and Stoat upload. The local journal retains metadata and the protected Logger record ID, never the file. The default per-file limit is 20 MB; set `AUDITLOG_EVIDENCE_MAX_MB=0` to disable media copies and keep metadata-only notices. The worker allows two concurrent transfers plus at most 50 queued source messages.

When an attachment was not archived, the record states the reason:

- attachment archiving is disabled with a zero per-file cap;
- the attachment URL was not a recognized Stoat CDN link;
- the file exceeded the per-file size cap;
- the source download failed or came back oversized;
- the Stoat upload failed;
- the Logger archive card could not be sent; or
- the bounded archive queue was full.

Delete and edit records reply to the existing Logger card and perform no new media transfer. Bulk deletes reply to at most five archive cards—the Stoat reply limit—and list the stable record IDs for all remaining attachments in the embed.

If someone deletes an attachment archive card, Stoat deletes the associated media. Tamper protection restores the metadata without stale file IDs, marks the media as lost, and does not retry forever. `/Exclude-Channel` intentionally deletes related archive cards when purging a channel.

## Protected messages

Audit records sent through the protected pipeline are persisted. Raw delete events and reconciliation detect removal and repost the stored payload. Attachment-bearing records use a metadata-only restoration payload because their one-use Stoat file IDs cannot be replayed.

## Limits the platform does not expose

:::caution[Actor attribution]
Stoat update events often do not identify who acted. Irminsul labels these records **Actor unavailable from Stoat** instead of guessing.
:::

- Delete events never identify the deleter. Members with effective Manage Messages may be listed as **possible deleters**, which is a heuristic and not proof.
- Some departure events distinguish Leave, Kick, or Ban; when the backend omits the reason, the record can only say the member left or was removed.
- Offline reconciliation can prove that a value changed, not the exact time or actor.
- Invite and webhook changes are detected by bounded REST scans because no usable live event exists.
- Webhook tokens and usable invite codes are never persisted or logged.
- Username coverage is live-only while Irminsul is online.
