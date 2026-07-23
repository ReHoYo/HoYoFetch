---
title: Moderation overview
description: The safety model behind Irminsul manual moderation, protected records, and anti-raid operation.
---

Irminsul moderation is designed around exact permission checks, explicit reasons, durable protected records, and clear limitations.

Member safety reports use the same protected-record destination but are not moderation actions. A report can raise a staff-review priority when several independent members report the same account, but it never changes the target's account or server state.

## Before the first action

Configure an audit destination and test it:

```text
/AuditLog here
/Test-AuditLog
```

Manual moderation refuses to mutate a member or messages without a configured audit channel. The protected record captures the actor, target, reason, requested action, and outcome.

## Shared command contract

- Supply exactly one member mention or raw user ID.
- Add a reason in your own words; it is mandatory. The older `reason:` delimiter still works.
- Keep the reason within 300 characters.
- The member, the reason, and any option may appear in any order.
- Use only the options documented for that command.

Irminsul refreshes the moderator, target, bot, server, and channel context before acting. Missing permissions, hierarchy problems, malformed arguments, and unsafe partial context fail closed.

## Reactions instead of buttons

Stoat does not provide command interaction buttons, so Irminsul uses reactions for:

- a ✅/❌ confirmation before every ban, kick, and typed-duration mute;
- a duration picker when `/Mute` omits its duration, which doubles as that command's confirmation;
- a 1h–29d message-cleanup picker after every ban, kick, and mute;
- a window picker and then a ✅/❌ confirmation for `/Purge-User`;
- ten-minute undo windows for bans and mutes; and
- staff approvals for automod ban cases.

Reaction handlers re-check the reacting moderator's current permission before applying the action, and only the moderator who ran the command can answer their own picker.

## Coverage is stated honestly

History cleanup covers only messages Irminsul observed while archiving was active — up to 29 days, one day short of the archive's own retention. Stoat's bulk-delete route is limited to recent messages, so older messages are removed individually, paced to stay inside the rate limit, and a single cleanup stops at 2,000 messages.

Results never claim complete erasure. Every message Irminsul could not delete is reported by cause — already gone from Stoat, blocked by a missing Manage Messages permission, still rate limited, or failed outright — so a partial result says what to do about it rather than only how many were lost. A message that Stoat no longer has is reconciled into the archive rather than counted as a failure, so repeat cleanups stop retrying it.

Continue to [Spam reports](/HoYoFetch/moderation/spam-reports/), [Manual actions](/HoYoFetch/moderation/manual-actions/), [Audit log](/HoYoFetch/moderation/audit-log/), or [Automod](/HoYoFetch/moderation/automod/).
