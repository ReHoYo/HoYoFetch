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

**Approve** clears the **author**, not the content. It deletes the review card and resets the author's automod strike to zero, so a member caught by the gate is not left carrying an escalation they did not earn. The held content is **not** reposted — the author is free to post it again themselves.

:::caution[Approving no longer reposts]
Earlier versions re-uploaded every held attachment and republished the message as Irminsul, attributed to the original author. During a troll wave that turned the review queue into a delivery mechanism: a moderator's "this account is fine" also relaunched whatever the account had posted. Approval now only clears the account. The archived copy stays on the review card as the evidence record until the card is deleted.
:::

**Reject** deletes the review card and its Stoat media, discards the held content, and increases the author's automod strike level by one (capped at 4) — the same ladder `/Automod` escalates on repeated triggers. Rejection does **not** apply a timeout by itself; it only means the _next_ automod trigger for that account escalates faster.

An unreviewed hold expires after **7 days**: the review card and its Stoat media are deleted, the queued content is discarded with no strike, and a notice is posted to the review channel.

:::note[One moderator is enough]
Neither outcome is permanent for the account: approval clears its strike, rejection only moves it one rung up a ladder that resets after 14 quiet days, and an ignored hold expires on its own. This is why review needs one moderator instead of the two-approval quorum `/Automod` requires for a permanent ban.
:::
