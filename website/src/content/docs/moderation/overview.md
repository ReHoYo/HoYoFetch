---
title: Moderation overview
description: The safety model behind Irminsul manual moderation, protected records, and anti-raid operation.
---

Irminsul moderation is designed around exact permission checks, explicit reasons, durable protected records, and clear limitations.

## Before the first action

Configure an audit destination and test it:

```text
/AuditLog here
/Test-AuditLog
```

Manual moderation refuses to mutate a member or messages without a configured audit channel. The protected record captures the actor, target, reason, requested action, and outcome.

## Shared command contract

- Supply exactly one member mention or raw user ID.
- Add a mandatory `reason:` delimiter.
- Keep the reason within 300 characters.
- Use only the options documented for that command.

Irminsul refreshes the moderator, target, bot, server, and channel context before acting. Missing permissions, hierarchy problems, malformed arguments, and unsafe partial context fail closed.

## Reactions instead of buttons

Stoat does not provide command interaction buttons, so Irminsul uses reactions for:

- a duration picker when `/Mute` omits its duration;
- confirmation before `/Purge-User` deletes messages;
- ten-minute undo windows for bans and mutes; and
- staff approvals for automod ban cases.

Reaction handlers re-check the reacting moderator's current permission before applying the action.

## Coverage is stated honestly

History cleanup covers only messages Irminsul observed while archiving was active, and Stoat's bulk-delete route is limited to recent messages. Results report selected, deleted, and failed counts instead of claiming complete erasure.

Continue to [Manual actions](/HoYoFetch/moderation/manual-actions/), [Audit log](/HoYoFetch/moderation/audit-log/), or [Automod](/HoYoFetch/moderation/automod/).
