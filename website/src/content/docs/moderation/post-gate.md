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

| Level | Behavior                                                                                  |
| ----- | ----------------------------------------------------------------------------------------- |
| 1     | Hold qualifying links and media from new, newly joined, or first-time members             |
| 2     | Same behavior as Level 1                                                                  |
| 3     | Remove default-role sending and silently delete regular-member messages that slip through |
| 4     | Apply Level 3 and automatically ban each slipped-message author                           |

Levels 3–4 include privacy-excluded channels because they retain no content: the denied message is not copied to the review queue or archive. Bots, webhooks, the server owner, and freshly verified moderation staff are exempt from reactive deletion and bans. The default-role restriction still affects any non-owner staff or bot role that does not explicitly grant Send Messages. If identity or permission verification is unavailable, Irminsul fails safe and does not delete or ban a possible moderator.

On Level 3 or 4 activation, Irminsul removes **Send Messages** from the server default role before changing the stored level. Reactive deletion remains enabled as a fallback for messages permitted through explicit role or channel overrides. Irminsul refuses a new lockdown if it cannot update permissions or if its bot role would lose explicit **View Channel** or **Send Messages** access in the protected review channel. It warns, but does not refuse activation, when **Manage Messages** cannot be verified for the deletion fallback. Staff and bot roles that inherit only the server default are silenced too; trusted roles need an explicit Send Messages grant.

Irminsul records whether Send Messages was enabled before lockdown. On a downgrade or approved `/Post-Gate off`, it restores only that bit when it was the actor that removed it, preserving every unrelated permission change. It checks the lock at startup, after server updates, and periodically; drift is repaired automatically. A migrated server already stored at Level 3 or 4 remains in deletion-only degraded mode if the permission lock cannot immediately be applied, warns at most once every ten minutes, and keeps retrying.

Entering Level 3 posts one protected notice: **Lockdown mode is currently enabled. Posts are automatically denied to avoid flooding the moderation queue.** Level 4 posts one corresponding automatic-ban warning. Individual attempts do not create held-post records, attachment copies, automod cases, command responses, or additional review cards. Runtime permission/delete/ban failures produce at most one degraded-mode notice every ten minutes.

Stoat rejects ordinary default-role sends before creating a message event, so Irminsul cannot identify or ban those users. Level 4's native ban applies exactly once to each non-exempt author whose message reaches the bot through an explicit role or channel override; the message is still deleted first.

Level 4 requires `/Level 4 confirm`, then the requesting moderator's ✅ reaction within two minutes; ❌ cancels it. The bot rechecks the requester, its own Ban Members and permission-management capabilities, and the unchanged Post Gate configuration before activation. A different moderator cannot answer the prompt. A downgrade completes only after the default permission has been safely restored. `/Post-Gate off` remains the Enka-approved way to disable the feature entirely.

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

Rejection deletes the review card and its Stoat media, discards the held content, and advances the
author's shared automod strike stage:

| Stored stage after rejection | Timeout on that rejection | Timeout projected for the next separate automod trigger |
| ---------------------------- | ------------------------- | ------------------------------------------------------- |
| Stage 1                      | None                      | Stage 2 — 1 hour                                        |
| Stage 2                      | None                      | Stage 3 — 24 hours                                      |
| Stage 3                      | None                      | Stage 4 — 7 days                                        |
| Stage 4                      | None                      | Stage 4 — 7 days                                        |

The first rejection after no recent history stores stage 1. Another rejection within 14 days
stores stage 2, and so on to the stage-4 cap. Each rejection refreshes that 14-day quiet-reset
clock. Rejection never times the author out and never opens a permanent-ban vote by itself; a later
automod detection must independently reach its normal score threshold. If it does, it advances
from the stored stage and applies the corresponding containment duration.

### Expiry

An unreviewed hold expires after **7 days**: the review card and its Stoat media are deleted, the queued content is discarded with no strike, and a notice is posted to the review channel.

:::note[Reversible by design]
A held post never remains visible while awaiting review. Its retained copy is discarded after an
approval, discarded with a recorded strike after a rejection, or discarded after 7 days without a
decision. Review needs only one moderator because approval clears the author and rejection only
changes future escalation; neither applies a timeout or permanent ban itself.
:::
