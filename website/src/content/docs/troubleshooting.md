---
title: Troubleshooting
description: Diagnose code fetching, permissions, audit logging, evidence, automod, and restart behavior.
---

## A command gets no response

Confirm that:

- the message is in a server text channel, not a direct message;
- a human member sent it;
- the command begins with the configured prefix;
- the command name is recognized; and
- the member has not exceeded five recognized commands in 30 seconds.

Irminsul intentionally ignores other bots, webhooks, direct messages, overlong messages, and unknown commands.

## `/Report-Spam` was not accepted

Confirm that:

- secure reporting is available for the server;
- the command was used in a text channel where Irminsul has Manage Messages;
- the invocation was successfully removed;
- reporter and target are current members of the same server;
- the reason contains 10–300 characters; and
- the reporter has not hit the one-minute, duplicate-target, or three-per-day limit.

If Irminsul cannot delete the invocation or securely record the report, it retains no report.

## A moderator command is denied

Irminsul checks effective permissions, not role names. Confirm the permission that matches the action:

- Ban Members for `/Ban`;
- Kick Members for `/Kick`;
- Timeout Members for `/Mute` and `/Automod release`;
- Manage Messages for `/Purge-User` and ban cleanup.

Also confirm the bot itself has the needed permission and sits high enough in the hierarchy. If fresh state cannot be verified, the command fails closed.

## Manual moderation says the audit log is missing

Configure and test it before trying again:

```text
/AuditLog here
/Test-AuditLog
```

The bot must be able to send messages and embeds in the selected channel.

## A deleted message shows “content unknown”

The message was sent before audit logging was enabled, while Irminsul was offline, or after its archived copy aged out. Stoat only sends the ID during deletion, so content not observed earlier cannot be reconstructed.

## An attachment was not archived in Logger

Check the `/Test-AuditLog` attachment-mode and queue report:

- archiving may be disabled with `AUDITLOG_EVIDENCE_MAX_MB=0`;
- the attachment may exceed the per-file cap;
- its URL may not be a recognized Stoat CDN URL;
- the download, Stoat upload, or Logger send may have failed; or
- a burst may have filled the bounded 50-message archive queue.

Irminsul does not retain failed media on disk for retry. If an archive card itself was deleted, its restored metadata states that Stoat removed the media.

## A server setting change appears later

Invites, webhooks, and changes made while the bot was offline are detected by periodic reconciliation. These records can show what changed but may not know the exact time or actor.

## Automod did not contain a member

Check that the server is in enforcement mode, the score reached two with a message-behavior signal, and the bot has Timeout Members. Fresh permission verification failures intentionally downgrade the case to monitor-only.

## `/Restart` did not deploy new code

`/Restart` only restarts the currently running process. It does not fetch source changes. The operator must deploy first—usually by pulling the intended revision, installing locked dependencies, and restarting the actual supervisor.

## Code sources are unavailable

Third-party sources can fail temporarily. Manual fetches report failures instead of inventing results. NTE and WuWa maintain independent one-hour Game8 caches and may each serve their last successful response when a refresh fails.

For operator-level diagnostics, see [Configuration](/HoYoFetch/administration/configuration/) and [Self-hosting](/HoYoFetch/administration/self-hosting/).
