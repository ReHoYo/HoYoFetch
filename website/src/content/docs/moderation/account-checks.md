---
title: Account checks
description: Look up every account and membership detail Irminsul can read for one member, and understand the bot-risk signals it computes.
---

Stoat's own UI hides basic account facts like join date, which makes it harder to spot a bot or raid account by eye. Irminsul reads what Stoat exposes and surfaces it directly, on every join and on demand.

## Look up a member

```text
/Get-Info @member
/Get-Info 01ABCDEFGHJKMNPQRSTVWXYZ12
```

The mention or ID may refer to a current member or someone who already left — a departed account is looked up by its last-known Stoat identity.

`/Get-Info` fetches the account's profile (bio and banner) as part of the lookup, since it targets one account at a time. The [join log](/HoYoFetch/moderation/audit-log/) does not do this — it works from cached data only, so a join surge never turns into a burst of extra requests.

## What is shown

- **Identity:** username, nickname, avatar status, and platform badges.
- **Timestamps:** account creation date and, for current members, when they joined this server — both shown as an absolute UTC time and a relative age.
- **Platform flags:** any Suspended, Banned, or Deleted flag Stoat has set on the account.
- **Moderation history:** an existing automod strike, an open automod case, or prior spam reports naming this account in this server.
- **⚠️ Signals:** the specific conditions above that read as suspicious, listed at the top. An account with nothing unusual shows no signals block at all.

## Signals are heuristics, not verdicts

A signal — a new account, a default avatar, an account created minutes before it joined — is a prompt to look closer, not grounds to act on its own. Plenty of real members have a default avatar or joined the same day their account was made. Treat `/Get-Info` as a faster way to gather the facts a manual moderation decision already needs, not as an automatic classifier.

For live protection while you are away, see [Automod](/HoYoFetch/moderation/automod/), which acts on message and join patterns in real time.
