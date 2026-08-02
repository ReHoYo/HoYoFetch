---
title: Account checks
description: Vet current, departed, banned, or never-joined accounts and understand how much Stoat allowed Irminsul to see.
---

During a raid, you do not need to wait for an account to join before checking it. `/Get-Info` combines whatever Stoat will reveal with Irminsul's existing local moderation and message records, then labels the result so moderators know how complete it is.

## Look up an account

```text
/Get-Info @member
/Get-Info 01ABCDEFGHJKMNPQRSTVWXYZ12
```

Use a mention for a visible member or paste a 26-character Stoat account ID for anyone else. Stoat provides no username search for bots, so a non-member cannot be found from a username alone.

The account may be current, departed, banned, visible to Irminsul through another community, or entirely unrelated to this server. A permission failure or rate limit produces a partial report rather than a misleading “not found” error. A genuine “Stoat has no account with that ID” result is shown only when the platform explicitly confirms it.

## What Irminsul can and cannot see

| Lookup scope   | What it means                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| Current member | The account and membership are present in this server.                                                               |
| Banned         | The account is absent from membership and appears in this server's ban list. Identity may come from that list.       |
| Former         | Local archive, automod, or spam-report evidence proves the account was previously seen here.                         |
| Outside        | The account is visible through another community Irminsul is in. The report names up to three cached mutual servers. |
| Platform only  | Stoat confirms the account exists, but full identity is hidden because it shares no visible community with Irminsul. |
| Unknown        | Stoat did not confirm whether the account exists, usually because a probe was denied, rate-limited, or unavailable.  |

A valid Stoat ID always carries its own mint timestamp, so **Account created** remains available without a network request and is marked “derived from the account ID” when identity is otherwise hidden.

Reading the server's ban list requires Irminsul to have **Ban Members**. Without it, the scope line says that a ban in this server could not be ruled out. A ban reason appears only when the account is actually found in the list.

:::caution[Cross-server membership disclosure]
When Irminsul has cached the target as a member of another server, `/Get-Info` names up to three of those servers to the authorized moderator running the command. This means a server's membership may be visible to moderators of another server that uses the same bot instance.
:::

## What is shown

- **Identity:** username, display name, nickname, user ID, avatar status, and platform badges when visible.
- **Timestamps:** account creation date and, for current members, when they joined this server.
- **Platform flags:** any Suspended, Banned, or Deleted flag Stoat exposes, plus online status, bot owner, and timeout when full identity is visible.
- **Moderation history:** ban status and reason, automod strikes and open cases, and prior spam reports naming this account in this server.
- **Messages sent:** how many messages remain in Irminsul's local archive and when coverage begins. This is not a lifetime total; deleted and purged messages are excluded.
- **⚠️ Signals:** the specific conditions worth a closer look, listed at the top.

`/Get-Info` fetches a profile only after full user identity is available. The [join log](/HoYoFetch/moderation/audit-log/) never performs these network probes: it remains cache-only so a join surge cannot become a burst of per-member requests. The join log can still derive creation time from the ID synchronously.

## Signals are heuristics, not verdicts

A signal — a new account, a default avatar, a server ban, or an account created minutes before it joined — is a prompt to look closer, not grounds to act on its own. Treat `/Get-Info` as a faster way to collect evidence for a manual moderation decision, not as an automatic classifier.

For live protection while you are away, see [Automod](/HoYoFetch/moderation/automod/), which acts on message and join patterns in real time.
