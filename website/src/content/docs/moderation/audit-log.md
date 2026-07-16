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
