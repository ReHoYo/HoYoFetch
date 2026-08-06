---
title: First-post gate
description: Hold a new or first-time poster's first link or attachment for moderator review before it stays visible.
---

Automod's behavioral detection (rapid bursts, duplicate floods, mention floods) needs several messages to accumulate before it triggers — a single message from a fresh account passes straight through it. The post gate closes that gap by holding, rather than blocking, the specific case that matters most: a link or attachment as someone's first move in the server.

The post gate is **off by default for every server**.

## When a message is held

A message is deleted and queued for review only when **all** of the following are true:

- The server's post gate is in `hold` mode with a configured review channel.
- The channel is not privacy-excluded via `/Exclude-Channel` — excluded channels retain nothing, so the gate never touches them.
- The author is not a recognized moderator. This is checked with the same fresh permission verification `/Automod` uses, and fails closed: if the check itself is unavailable, nothing is held.
- The message contains a link **or** at least one attachment. At [moderation level](/moderation/levels/) 2 and above this condition is dropped — every message from a new account is held.
- The author is, by locally cached or archived evidence, **new**:
  - the account was created less than 7 days ago (30 days at level 2 and above), or
  - the author joined this server less than 24 hours ago (7 days at level 2 and above), or
  - the author has no other message Irminsul has archived in this server.

Obfuscated links (spaced-out domains, homoglyphs, URL shorteners disguised as plain text) are not detected — the pattern matches ordinary `https://`, `www.`, and bare common-TLD links only.

:::tip[Tell new members up front]
Irminsul does not notify an author when their message is held — a quiet hold is harder for a raid account to route around than an explicit warning, but it also means a genuine new member gets no explanation if their first link or image briefly disappears. Consider a line in your server rules or welcome message covering it generically, without describing the exact trigger, for example:

> Due to spam and abuse, new members' first links or media may be held for a quick moderator check before staying visible.

:::

## Configuration

```text
/Post-Gate status
/Post-Gate here
/Post-Gate #new-member-review
/Post-Gate off
/Post-Gate confirm 123456
/Post-Gate cancel
```

Turning the gate on, moving its review channel, and turning it off each require the same two-step approval as `/AuditLog` and `/Exclude-Channel`:

1. A recognized moderator requests the change.
2. Irminsul DMs a ten-minute, six-digit code exclusively to **Enka#4961**, who can reply with `approve CODE`, `deny CODE`, or the bare code, or relay it for `/Post-Gate confirm CODE` in the server.

Only one protected request can be pending per server at a time (shared with `/AuditLog` and `/Exclude-Channel`'s own approvals), and three incorrect attempts destroy it. `/Post-Gate status` and reviewing a held post are both immediate and never require Enka's approval.

## Reviewing a held post

Every held message posts a review card to the configured channel with the author, channel, content, and any successfully Stoat-hosted attachments, and seeds ✅/❌ reactions. Attachment bytes pass through RAM only; the VPS queue retains metadata. Any single recognized moderator with Manage Messages in the review channel can clear it — by reacting or with:

```text
/Post-Gate approve QUEUE_ID
/Post-Gate reject QUEUE_ID
```

The hold itself does **not** count as an automod strike. Its effect depends on how the review ends:

| Review outcome         | Original channel                                                      | Automod level                                                        | Queue and review card                                             |
| ---------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Approve                | Complete content is reposted by Irminsul and attributed to the author | No change                                                            | Marked approved; review card is deleted                           |
| Reject                 | Content stays discarded                                               | Advances one level, up to level 4; no timeout is applied immediately | Marked rejected; review card is deleted                           |
| No decision for 7 days | Content stays discarded                                               | No change                                                            | Marked expired; review card is deleted and an expiry notice posts |
| Approval cannot repost | Nothing is reposted; no partial or text-only fallback is sent         | No change                                                            | Remains pending for another approval attempt or rejection         |

### Approve

Approval downloads every held attachment from the Stoat review card into RAM, creates fresh
one-use Stoat uploads, and reposts the complete content as Irminsul, attributed to the original
author, in the original channel. If any attachment is unavailable, approval fails without a
partial or text-only repost and the queue remains pending. After success, the review card is
intentionally deleted and untracked.

### Reject and the automod ladder

Rejection deletes the review card and its Stoat media, discards the held content, and advances the
author's shared automod level:

| Stored level after rejection | Timeout on that rejection | Timeout projected for the next separate automod trigger |
| ---------------------------- | ------------------------- | ------------------------------------------------------- |
| Level 1                      | None                      | Level 2 — 1 hour                                        |
| Level 2                      | None                      | Level 3 — 24 hours                                      |
| Level 3                      | None                      | Level 4 — 7 days                                        |
| Level 4                      | None                      | Level 4 — 7 days                                        |

The first rejection after no recent history stores level 1. Another rejection within 14 days
stores level 2, and so on to the level-4 cap. Each rejection refreshes that 14-day quiet-reset
clock. Rejection never times the author out and never opens a permanent-ban vote by itself; a later
automod detection must independently reach its normal score threshold. If it does, it advances
from the stored level and applies the corresponding containment duration.

### Expiry

An unreviewed hold expires after **7 days**: the review card and its Stoat media are deleted, the queued content is discarded with no strike, and a notice is posted to the review channel.

:::note[Reversible by design]
A held post never remains visible while awaiting review. Its retained copy is either reposted,
discarded with a recorded strike, or discarded after 7 days without a decision. Review needs only
one moderator because approval restores content and rejection only changes future escalation; it
does not apply a timeout or permanent ban itself.
:::
