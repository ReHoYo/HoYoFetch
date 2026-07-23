---
title: Audit log
description: Configure protected server activity records, archive message content, preserve qualifying attachments, and understand platform limits.
---

Stoat does not provide a native server audit log. Irminsul can relay activity into one protected channel per server.

## Configure the destination

```text
/AuditLog here
/AuditLog #moderation-log
/AuditLog status
/AuditLog off
```

The older `/Enable-AuditLog` and `/Disable-AuditLog` forms remain accepted for compatibility.

Run `/Test-AuditLog` after setup. It sends a test event through the real protected-delivery pipeline and reports message archive, evidence usage, settings baseline, and webhook coverage.

## Exclude private channels

```text
/Exclude-Channel status
/Exclude-Channel #private-channel
/Exclude-Channel remove #private-channel
/Exclude-Channel confirm 123456
/Exclude-Channel cancel
```

Adding or removing an exclusion requires **two steps**:

1. The server owner or a member with **Manage Server** requests the change.
2. Irminsul DMs a ten-minute, six-digit code to the bot owner. The owner can reply with `approve CODE`, `deny CODE`, or the bare code, or can relay it for `/Exclude-Channel confirm CODE` in the server.

Only one request can be pending per server, and three incorrect attempts destroy it. If the owner cannot be resolved or reached by DM, the request fails closed and logging continues unchanged. Both exclusion and removal require a fresh code.

An approved exclusion withholds only message content:

- new messages and attachments are not archived;
- edits, deletes, and bulk deletes are not relayed;
- existing archive entries and locally captured evidence for the channel are permanently purged; and
- automod continues detecting raids, but its protected case log replaces excerpts from the channel with a privacy-withheld notice.

Channel, role, permission, moderation, membership, and other server events continue logging. The audit-log destination itself cannot be excluded. A protected daily digest lists every active exclusion so a privacy change cannot remain quiet.

:::caution[Purge coverage]
`/Purge-User` cannot clean messages in an excluded channel because Irminsul deliberately has no archived message IDs for that channel.
:::

The bot-owner check prevents an administrator from silently changing message-content collection alone. It does not stop a server owner from removing the bot, or a host operator from editing `data/channel_exclusions.json` as a break-glass action.

## Events covered

The live pipeline and periodic reconciliation cover:

- message edits, deletes, and bulk deletes;
- joins, leaves, kicks, bans, unbans, and timeouts;
- username, nickname, and role changes;
- server identity, discovery, categories, and system-message routing;
- channels, roles, emoji, invites, webhooks, and permission overrides.

Server-setting reconciliation runs at startup and roughly every five minutes, allowing changes made while the bot was offline to be detected later.

## Recovering message content

Delete events contain only a message ID. While audit logging is active, Irminsul records server messages to a local 30-day journal capped at 100,000 messages. This lets later edit and delete records include the content that the bot observed.

Messages sent before logging began or while the bot was offline cannot be recovered.

## Attachment evidence

Attachment URLs may stop working as soon as their message is deleted. Irminsul can download qualifying attachments when they are posted, then re-upload the local copy with a later delete record.

The default per-file limit is 20 MB and the default total evidence budget is 1 GB. Oldest evidence is evicted first when the budget is full. Set `AUDITLOG_EVIDENCE_BUDGET_MB=0` to disable capture and keep metadata-only notices.

## Protected messages

Audit records sent through the protected pipeline are persisted. Raw delete events and reconciliation detect removal and repost the stored payload. Reposted records remain protected across restarts.

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
