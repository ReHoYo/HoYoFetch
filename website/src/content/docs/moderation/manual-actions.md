---
title: Manual moderation
description: Ban, kick, mute, purge, release, confirmation, cleanup, and undo behavior.
---

All manual actions require an active Irminsul audit channel.

## Writing a command

Every manual action takes one target and a reason written in plain words. The target, the reason,
and any option may appear in any order. `/Ban` accepts either a member mention or a raw Stoat
account ID; the other member actions require a current member.

```text
/Ban @member for spamming and stuff
/Ban 01ABCDEFGHJKMNPQRSTVWXYZ12 for coordinating a raid
/Mute 1h @member because they argued with staff
/Ban @member delete:1d reason: raid cleanup
```

The last form is the older delimiter syntax; it is still accepted. A reason is always required.
Bare option words such as `1h` or `1y` are only read as options while they come before the reason —
once the reason starts, everything that follows is part of it, so `/Mute @member for arguing for 3d
straight` opens the duration picker and keeps the sentence intact.

## Confirm before acting

Because the reason is free text, a mistyped or auto-completed mention would otherwise be
indistinguishable from the intended account. `/Ban`, `/Kick`, and `/Mute` therefore post a
confirmation that names the action, the target, the reason, and any typed cleanup window:

```text
🔨 Confirm Ban
Action: ban
Target: @member
Reason: spamming and stuff
```

Nothing is sent to Stoat until the moderator who ran the command reacts ✅. Another moderator's
reaction is ignored, ❌ cancels without touching the target, and the prompt expires after two
minutes. Permissions and the target are verified at that point, not when the command was typed, so
the checks reflect the moment of the action.

## Ban

```text
/Ban @member for repeated spam
/Ban 01ABCDEFGHJKMNPQRSTVWXYZ12 for coordinating a raid
```

After ✅, `/Ban` freshly verifies Ban Members and the protected server context, then sends the
account ID to Stoat's native ban endpoint. The account may be a current member, a departed member,
or someone who has never joined the server. Irminsul does not keep a separate pending-ban list and
does not wait for a join event; Stoat owns and enforces the ban immediately. Invalid accounts and
hierarchy failures are rejected by Stoat without a success record.

Once the ban lands, Irminsul offers a cleanup
picker: 1️⃣ 1h · 2️⃣ 6h · 3️⃣ 1d · 4️⃣ 3d · 5️⃣ 7d · 6️⃣ 1mo · 7️⃣ 3mo · 8️⃣ 6mo · 9️⃣ 1y, or ❌ to keep the messages.
Only the moderator who ran the command can choose, and the picker expires after two minutes.
Cleanup requires Manage Messages in every affected channel and covers only messages Irminsul
previously observed, so a never-joined account normally has nothing to delete. A departed account's
archived messages remain eligible.

The protected record accepts a ↩️ reaction for ten minutes from a freshly authorized ban moderator.
Undo unbans the account but cannot restore membership or deleted messages.

## Kick

```text
/Kick @member for raiding
```

After ✅, `/Kick` verifies Kick Members and acts, then offers the same cleanup picker. A kick
cannot be undone by the bot; the member needs a new invite to return.

## Mute

```text
/Mute @member 1h cooldown
/Mute @member for arguing with staff
```

Supported durations are `10m`, `30m`, `1h`, `4h`, `24h`, `3d`, and `7d`. A typed duration goes
through the ✅/❌ confirmation. Omitting the duration opens a two-minute picker for the command
invoker instead — choosing from it is already a deliberate second act, so no separate confirmation
follows. Either way the cleanup picker comes after the timeout is applied. The protected record
offers a ten-minute ↩️ release window to freshly authorized timeout moderators.

## Purge observed messages

```text
/Purge-User @member because of spam
```

`/Purge-User` asks for a window with the same 1h–1y picker, then reports how many observed messages
match and waits for a ✅/❌ confirmation. Both steps are invoker-only and expire after two minutes.
Only one purge or cleanup runs per server at a time.

Only messages recorded by Irminsul can be selected. Protected audit entries, retained evidence,
quotations, reactions, and external copies are not erased.

## Release and reset automod history

```text
/Automod release @member false positive
```

This removes a native timeout, resets the member's automod strike history, and closes pending ban
reviews for the containment. It can also release a manually applied timeout. It is the one manual
action with no confirmation step, because it only restores access.

## Reading a cleanup result

A cleanup never claims more than it did. Alongside the deleted count, it names what happened to
everything it could not remove:

| Reported as                      | Meaning                                                                                    | What to do                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| already gone from Stoat          | The message was deleted before the cleanup reached it, usually while Irminsul was offline. | Nothing. Irminsul reconciles its archive so later cleanups stop selecting it. |
| lack Manage Messages there       | Irminsul cannot delete in that channel.                                                    | Grant Manage Messages in the affected channel, then re-run.                   |
| still rate limited after a retry | Stoat throttled the run and one slower retry did not clear it.                             | Re-run the cleanup; it resumes where this one stopped.                        |
| failed for another reason        | An unexpected error.                                                                       | Check the bot log; the status code is recorded there per message.             |
| left untouched by the safety cap | The run hit the 2,000-message ceiling.                                                     | Re-run to continue through the remainder.                                     |

Deletes are paced to stay inside Stoat's rate limit, so a cleanup covering many older messages takes
noticeably longer than one covering a recent burst. When a run is large enough to be slow, Irminsul
estimates the time up front.

:::caution[History cleanup is best-effort]
Cleanup reaches back up to 1 year, matching the message archive's own retention exactly — `1y`
selects everything the archive still holds. Stoat's ban route has no message-history option and
its bulk-delete route accepts only recent messages, so Irminsul bulk-deletes archived IDs from the
last seven days and removes anything older one message at a time; a `1mo`–`1y` cleanup will
typically route almost entirely through that paced individual-delete path. A single cleanup
deletes at most 2,000 messages, oldest first — on an active member, a long window will often
exhaust that cap before reaching the full year back.

Coverage is limited to messages Irminsul observed while archiving was active. Protected audit
entries, retained evidence, quotations, reactions, and external copies are never erased.
:::
