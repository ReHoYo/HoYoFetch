---
title: First-post gate
description: Hold a new or first-time poster's first link or attachment for moderator review before it stays visible.
---

Automod's behavioral detection (rapid bursts, duplicate floods, mention floods) needs several messages to accumulate before it triggers. The Post Gate supplies the protected review destination for server moderation Levels 1–2 and the transition notices for Levels 3–4.

The post gate is **off by default for every server**.

## When a message is held

A message is deleted and queued for review at Levels 1–2 only when **all** of the following are true:

- The server's post gate is in `hold` mode with a configured review channel.
- The channel is not privacy-excluded via `/Exclude-Channel` — excluded channels retain nothing, so the gate never touches them.
- The author is not a recognized moderator. This is checked with the same fresh permission verification `/Automod` uses, and fails closed: if the check itself is unavailable, nothing is held.
- The message contains a link **or** at least one attachment. Levels 1 and 2 intentionally use the same review trigger.
- The author is, by locally cached or archived evidence, **new**:
  - the account was created less than 7 days ago, or
  - the author joined this server less than 24 hours ago, or
  - the author has no other message Irminsul has archived in this server.

Before testing the message, Irminsul performs bounded Unicode normalization and removes invisible formatting characters. It recognizes ordinary and spaced `http`, `https`, `hxxp`, and `www` forms; spaces around URL punctuation; bracketed `(dot)`/`[.]` forms; common Unicode dot, colon, and slash variants; bare DNS and punycode domains; and IPv4 addresses. This normalized copy is used only for detection—the original content is retained unchanged on the review card.

No text-only detector can prove that arbitrary prose does not encode a destination. Novel Unicode letter homoglyph alphabets, base64 strings, QR content, and conversational directions can remain ambiguous; link-like first posts should still be reviewed rather than treated as a definitive abuse finding.

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

## Server moderation levels

After the review channel is configured, any recognized moderator may inspect or change the persistent server policy:

```text
/Level status
/Level 1
/Level 2
/Level 3
/Level 4 confirm
```

| Level | Review queue                                               | Default-role Send Messages | Slipped regular-member posts | Automatic ban                                              | Activation                                   |
| ----- | ---------------------------------------------------------- | -------------------------- | ---------------------------- | ---------------------------------------------------------- | -------------------------------------------- |
| 1     | Hold qualifying links/media from new or first-time members | Unchanged                  | Normal processing            | No                                                         | Immediate                                    |
| 2     | Same as Level 1; retained as a compatible policy setting   | Unchanged                  | Normal processing            | No                                                         | Immediate                                    |
| 3     | Bypassed to prevent queue floods                           | Removed                    | Silently deleted             | No                                                         | Immediate after permission checks            |
| 4     | Bypassed to prevent queue floods                           | Removed                    | Silently deleted             | Yes, when the message reaches Irminsul through an override | `/Level 4 confirm`, then ✅ within 2 minutes |

### Which level should moderators use?

Use the lowest level that fits the incident, then downgrade when the risk has passed:

| Level                      | Recommended situation                                                                             | What members experience                                                                                   | Important limitation                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **1 — Routine**            | Normal day-to-day operation                                                                       | Normal conversation continues; qualifying link/media posts from new or first-time members wait for review | Text-only posts are not held                                                                                |
| **2 — Elevated**           | A small suspected bot raid or credible warning                                                    | Currently the same enforcement as Level 1                                                                 | Level 2 records an intentionally elevated posture but does not yet tighten thresholds or block more content |
| **3 — Raid lockdown**      | A large or active raid where stopping message volume matters more than uninterrupted conversation | The default role cannot send; non-exempt messages that bypass the lock are silently deleted               | Authors are not automatically banned                                                                        |
| **4 — Emergency lockdown** | The most severe raid, when bypass attempts should be removed from the server                      | Level 3's lockdown remains active; non-exempt authors who post through an override are also banned        | Irminsul cannot ban an ordinary blocked sender because Stoat creates no message event identifying them      |

Levels 1–2 are preventative review modes. They catch common link and media bot spam while keeping ordinary chat available, but they do not guarantee that every bot or text-only abuse attempt is blocked. Levels 3–4 are disruptive server-wide incident controls and should be reserved for an active raid. Level 4 is not a stronger permission barrier than Level 3; its additional action is the automatic ban applied when a message slips through an explicit permission override.

### Levels 3–4 lockdown

- Irminsul removes **Send Messages** from the server default role. Trusted staff and bot roles need an explicit Send Messages grant to remain active.
- Irminsul must retain **View Channel** and **Send Messages** in the protected review channel. Missing permission-management access or a self-lockout risk prevents activation; missing **Manage Messages** produces a deletion-fallback warning.
- Messages allowed through an explicit role or channel override are deleted without entering the review queue, automod, command router, attachment archive, or message archive. Privacy-excluded channels remain covered because no content is retained.
- Bots, webhooks, the server owner, and freshly verified moderation staff are exempt from reactive deletion and bans. An unavailable identity or permission check fails safe.
- Downgrading restores only the Send Messages bit Irminsul removed. Startup, server updates, and periodic reconciliation repair drift; degraded failures are reported at most once every ten minutes.

### Level 4 automatic bans

- Only the requesting moderator can confirm activation with ✅ within two minutes. Irminsul rechecks the moderator, its own Ban Members and permission-management capabilities, and the unchanged Post Gate configuration.
- Stoat blocks ordinary default-role sends before a message exists, so Irminsul cannot identify those authors. Level 4 bans a non-exempt author only when their message reaches the bot through an explicit permission override; the message is deleted first.
- A downgrade completes only after the default permission is safely restored. `/Post-Gate off` remains the Enka-approved way to disable the feature entirely.

## Reviewing a held post

Every held message posts a review card to the configured channel with the author, channel, content, and any successfully Stoat-hosted attachments, and seeds ✅/❌ reactions. Attachment bytes pass through RAM only; the VPS queue retains metadata. Any single recognized moderator with Manage Messages in the review channel can clear it — by reacting or with:

```text
/Post-Gate approve QUEUE_ID
/Post-Gate reject QUEUE_ID
```

The hold itself does **not** count as an automod strike. Its effect depends on how the review ends:

| Review outcome         | Original channel                                                           | Automod strike stage                                                 | Queue and review card                                             |
| ---------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Approve                | Content stays discarded; the cleared author may submit it again themselves | Existing strike is reset                                             | Marked approved; review card is deleted                           |
| Reject                 | Content stays discarded                                                    | Advances one stage, up to stage 4; no timeout is applied immediately | Marked rejected; review card is deleted                           |
| No decision for 7 days | Content stays discarded                                                    | No change                                                            | Marked expired; review card is deleted and an expiry notice posts |

### Approve

Approval clears the author, resets any existing automod strike, and resolves the queue entry. It
does not repost the held content. The author may submit the post again themselves, which avoids
republishing hostile content during a raid and preserves the real author on the new message. The
review card and its Stoat-hosted evidence are intentionally deleted after approval.

### Reject and the automod strike ladder

Rejection deletes the review card and its Stoat media, discards the held content, and advances the author's [automod strike stage](/HoYoFetch/moderation/automod/#containment-strike-stages). It never applies a timeout or opens a permanent-ban vote by itself. A later automod detection must independently reach the normal score threshold; it then advances the stage again and applies or projects the new duration.

### Expiry

An unreviewed hold expires after **7 days**: the review card and its Stoat media are deleted, the queued content is discarded with no strike, and a notice is posted to the review channel.

:::note[Reversible by design]
A held post never remains visible while awaiting review. Its retained copy is discarded after an
approval, discarded with a recorded strike after a rejection, or discarded after 7 days without a
decision. Review needs only one moderator because approval clears the author and rejection only
changes future escalation; neither applies a timeout or permanent ban itself.
:::
