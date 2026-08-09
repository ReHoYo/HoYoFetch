---
title: Post Gate
description: Review risky first links or media, prohibited terms, DM and off-platform contact solicitations, and every message from a held member.
---

Automod's behavioral detection (rapid bursts, duplicate floods, mention floods) needs several messages to accumulate before it triggers. The Post Gate holds individual messages a moderator should read first — a new member's opening link, attachment, or DM/off-platform contact solicitation; a prohibited term; or anything at all from a member already in Post Gate. It also supplies the protected review destination for server moderation Levels 1–2 and the transition notices for Levels 3–4.

The post gate is **off by default for every server**.

## When a message is held

At Levels 1–2, a message is deleted and queued for review only when **all** of these preconditions hold:

- The server's post gate is in `hold` mode with a configured review channel.
- The channel is not the review channel itself, and is not privacy-excluded via `/Exclude-Channel` — excluded channels retain nothing, so the gate never touches them.
- The author is not a recognized moderator. This is checked with the same fresh permission verification `/Automod` uses, and fails closed: if the check itself is unavailable, nothing is held.

Given that, **any one** of four triggers queues the message:

| Trigger                  | What it catches                                                                                     | Tenure matters? |
| ------------------------ | --------------------------------------------------------------------------------------------------- | --------------- |
| **Author in Post Gate**  | Every message from a member already in [full Post Gate](#holding-a-whole-member)                    | No              |
| **Contact solicitation** | A matching message or the author's current [profile bio](#dm-and-off-platform-contact-solicitation) | Recent identity |
| **Prohibited term**      | A message matching the [prohibited-term filter](#prohibited-terms)                                  | No              |
| **First link or media**  | A link **or** at least one attachment from a new or first-time poster                               | Yes             |

The fourth trigger additionally requires the author to be, by locally cached or archived evidence, **new**:

- the account was created less than 7 days ago, or
- the author joined this server less than 24 hours ago, or
- the author has no other message Irminsul has archived in this server.

Contact solicitation uses Automod's narrower existing **recent identity** condition: the account must be less than 7 days old or the server membership less than 24 hours old. The first-time-poster condition does not qualify an otherwise established account for contact screening.

Levels 1 and 2 intentionally use the same triggers.

Before testing the message for links, Irminsul performs bounded Unicode normalization and removes invisible formatting characters. It recognizes ordinary and spaced `http`, `https`, `hxxp`, and `www` forms; spaces around URL punctuation; bracketed `(dot)`/`[.]` forms; common Unicode dot, colon, and slash variants; bare DNS and punycode domains; and IPv4 addresses. This normalized copy is used only for detection—the original content is retained unchanged on the review card.

No text-only detector can prove that arbitrary prose does not encode a destination. Novel Unicode letter homoglyph alphabets, base64 strings, QR content, and conversational directions can remain ambiguous; link-like first posts should still be reviewed rather than treated as a definitive abuse finding.

:::tip[Tell new members up front]
Irminsul does not notify an author when their message is held — a quiet hold is harder for a raid account to route around than an explicit warning, but it also means a genuine new member gets no explanation if their first link or image briefly disappears. Consider a line in your server rules or welcome message covering it generically, without describing the exact trigger, for example:

> Due to spam and abuse, new members' first links or media may be held for a quick moderator check before staying visible.

:::

## DM and off-platform contact solicitation

At Levels 1–2 Irminsul checks a non-moderator's message and current profile bio for contact invitations only while Automod's existing recent-identity signal applies: the account is less than 7 days old or the server membership is less than 24 hours old. This identity signal defines eligibility only; no additional burst, flood, or score is required after the contact detector matches. Established accounts and established first-time posters are not checked. A match immediately creates a persistent [full-user hold](#holding-a-whole-member), deletes and queues the triggering message, and leaves every later message queued until a moderator releases the account. The automatic hold itself never applies an automod strike, timeout, or ban.

The built-in detector covers:

- open or available DMs, private messages, PMs, and inboxes, including reversed wording such as `open DMs`
- direct invitations such as `DM me`, `message me`, `contact us`, `add me`, and `follow me`
- labeled handles and profile/invite URLs for common messaging, social, and gaming platforms
- explicit email/contact invitations, while leaving ordinary unlabeled Stoat `@mentions` alone

Matching is bounded to 8 KB and normalizes case, Unicode compatibility forms, invisible/control characters, combining diacritics, common Latin-looking homoglyphs, in-word leetspeak, inserted spacing/punctuation, and stretched letters. Clear opt-outs such as `DMs closed`, `DMs are not open`, `not accepting DMs`, and `do not DM me` are not matches. Ambiguous contact wording remains reviewable.

The review and control cards name only a stable rule id and whether the signal came from the message or profile bio. Profile text, external handles, and unsafe URLs are never copied into the automatic-hold control card. The triggering message remains on its normal protected review card as message evidence; a bio-triggered card says **profile bio (content withheld)**.

Only recent-identity accounts receive a profile lookup. Successful profile and no-profile results are cached in memory for ten minutes, up to 5,000 recently used accounts, and concurrent messages from one account share a single lookup. A failed profile request uses a still-fresh successful cache result if one exists. With no usable result, Irminsul continues message-only detection, allows that post, logs only redacted diagnostics, and waits one minute before trying the profile again. The cache intentionally resets when Irminsul restarts, and a cached match is ignored once the account has aged beyond both eligibility windows.

No finite text detector can catch arbitrary coded prose, base64, contact details inside images, or QR codes. A match is a screening signal for a moderator, not a misconduct finding.

## Prohibited terms

The prohibited-term filter closes the gap automod cannot: a single targeted slur produces none of the burst, duplicate-flood, or mention-flood behaviour automod scores on, so without this trigger it passes through untouched no matter who posts it.

**It only ever holds.** A match never bans, times out, or applies an automod strike by itself. The strike follows a moderator pressing Deny, exactly as it does for a link hold. This is deliberate: no term list is accurate enough to punish on automatically.

### How matching works

Matching is **word- and phrase-aware**, not substring-based. Every term is anchored between word boundaries, and no stage of matching ever deletes separators from the message, so `Scunthorpe` and `viscount` are structurally incapable of matching a term inside them.

Evasion is handled by normalizing the _message_ toward the term:

- Unicode compatibility folding (`ｎｉｇｇｅｒ`) and case folding
- invisible and control characters removed (zero-width spaces, soft hyphens, bidi marks, BOM)
- combining diacritics stripped (`nïgger`)
- homoglyph folding — Cyrillic and Greek letters that imitate Latin ones (`nіgger`)
- leetspeak folding **inside a word only**, so `n1gg3r` and `sh!t` fold while `great!`, `$5`, `c++`, and the year `2000` keep their punctuation
- separators inserted between a term's letters (`n i g g e r`, `n-i-g-g-e-r`) for terms of five characters or more
- stretched letters (`niiiiigger`), while a term's own repeated letters are still required
- an optional trailing plural, so a list needs one entry per term rather than two

Phrases may be separated by up to three non-alphanumeric characters. Work is bounded: the scan is capped at 8 KB of content, 200 terms, and 200 allowlist entries, and a cheap prefilter means no pattern actually runs on ordinary prose.

### The allowlist

An allowlist entry **wins over any term it overlaps**. That is precedence, not filtering: `spic and span` is allowlisted, so `pass me the spic and span` is not held, while `you spic` in the same message still is.

### Configuring the list

Irminsul ships a small built-in list limited to terms whose only ordinary reading is the slur, plus the classic false positives (`scunthorpe`, `penistone`, `niggling`, `flame retardant`, `chink in the armour`, `spic and span`, …).

Operators extend it — never replace it — with `prohibited_terms.json` in the data directory:

```json
{
  "version": 1,
  "terms": [
    "a plain term",
    { "id": "local:example", "term": "a two word phrase", "tolerant": false }
  ],
  "allowlist": ["a legitimate phrase", "a surname"]
}
```

`id` is optional and appears on the review card instead of the term itself. `tolerant` overrides the separator-tolerance default (on for terms of five characters or more). A malformed entry is skipped rather than throwing.

Because the operator file extends the built-ins, an allowlist entry is the only way to soften a built-in rule.

Run `/Post-Gate terms` to see the active counts and reload the file **without restarting the bot**. If the file is absent, only the built-in list is active. If it cannot be parsed, Irminsul logs one warning, ignores it, keeps the built-in list running, and reports the degraded state in `/Post-Gate status` and `/Post-Gate terms`.

:::caution[A term list is not a solution]
No word list catches novel spellings, coded language, or abuse that uses no listed term at all, and every list produces false positives eventually. Treat a prohibited-term hold as a prompt for a moderator to read the message, not as a finding. The list is operator-owned data in the gitignored data directory; it is never committed.
:::

## Holding a whole member

Denying a held post with 🔒 places its author in **full Post Gate**. A recent-identity DM/off-platform contact match creates the same hold automatically without adding a strike. While either hold is active, _every_ message the member sends in the server is held for review — text, links, media, regardless of tenure, regardless of the term list.

The preconditions above still apply in full: the review channel and privacy-excluded channels are never gated, recognized moderators are always exempt (so holding a moderator has no effect while they retain Manage Messages), and Levels 3–4 lockdown continues to take precedence over the queue.

When a hold begins, Irminsul posts one persistent control card to the review channel:

> **🔒 Post Gate — User Held**
>
> @User is currently in Post Gate.
> All new messages from this user in this server are held for moderator approval.
>
> **Held by:** @Moderator
> **Held since:** Sat, 09 Aug 2026 14:02:11 GMT
> **Origin:** denied queue entry `PGABCDEF01234567`
>
> React 🔓 to release them, or use `/Post-Gate release @user`.

Automatic cards show **Irminsul (automatic contact screening)** instead of a moderator and include the signal surface and rule id without copying the bio or contact detail.

The hold is **idempotent**: denying or automatically matching the same author again reports the existing hold, leaves its original source and time untouched, and never posts a second card. Two simultaneous triggers produce one hold, not two.

State is stored on disk alongside the rest of Irminsul's moderation state, so a hold survives a bot restart — including its control card, which keeps working — and survives the member leaving and rejoining, because it is keyed on the server and the account rather than on membership. Turning the post gate off leaves hold records inert; re-enabling it honours them again. Moving the review channel reposts every control card into the new one.

`/Post-Gate holds` lists who is currently gated, who held them, since when, and how many of their messages are still queued.

### Reminders

A hold **never expires and is never released automatically**. After 24 hours — configurable with `POST_GATE_HOLD_REMINDER_HOURS` (1–168) — Irminsul posts a reminder to the review channel with 🔓 Release and ⏳ Continue Holding. Choosing ⏳ re-arms the clock for another window. Ignoring the reminder simply repeats it one window later, not once per sweep. Reminders ride the same hourly maintenance pass as queue expiry, so one lands within an hour of coming due, and the due time is stored absolutely — a restart does not reset it.

### Releasing

Release with 🔓 on the control or reminder card, or with `/Post-Gate release @member`. Both require freshly verified Manage Messages in the review channel, the same check the review actions use. Normal posting resumes immediately and the control card is removed.

**Messages already in the review queue stay queued.** Release only stops _future_ messages from being held; anything already waiting keeps its own review card and is approved or denied individually, and the release notice states how many are outstanding. A release is a judgement about the author, not about content no moderator has looked at yet — and it must never become a way to publish a queue nobody read.

Approving a queued item also resolves only that item; it does not release the account-level hold. If a released account still has a recent identity and its next message or still-cached/refreshed bio continues to match the contact detector, Irminsul automatically holds it again. Once both eligibility windows expire, the cached bio is ignored and automatic re-holding stops.

## Configuration

```text
/Post-Gate status
/Post-Gate here
/Post-Gate #new-member-review
/Post-Gate off
/Post-Gate confirm 123456
/Post-Gate cancel
/Post-Gate holds
/Post-Gate terms
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

Every held message posts a review card to the configured channel with the author, channel, the reason it was held, the content, and any successfully Stoat-hosted attachments, and seeds ✅/❌/🔒 reactions. When a prohibited term caused the hold, the card names the **rule id** that fired, never the matched text — a review channel is still a channel, and repeating the term there would republish what the hold removed. Attachment bytes pass through RAM only; the VPS queue retains metadata.

Stoat has no interactive buttons, so every control is a reaction Irminsul seeds on a card it posted, with an equivalent command for anyone who prefers typing. Any single recognized moderator with Manage Messages in the review channel can clear a card — by reacting or with:

```text
/Post-Gate approve QUEUE_ID
/Post-Gate reject QUEUE_ID
/Post-Gate deny-hold QUEUE_ID
```

The hold itself does **not** count as an automod strike. Its effect depends on how the review ends:

| Review outcome         | Original channel                                                           | Automod strike stage                                                 | Queue and review card                                             |
| ---------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| ✅ Approve             | Content stays discarded; the cleared author may submit it again themselves | Existing strike is reset                                             | Marked approved; review card is deleted                           |
| ❌ Deny                | Content stays discarded                                                    | Advances one stage, up to stage 4; no timeout is applied immediately | Marked rejected; review card is deleted                           |
| 🔒 Deny + Hold User    | Content stays discarded                                                    | Advances one stage, exactly as Deny does                             | Marked rejected; review card deleted and a control card is posted |
| No decision for 7 days | Content stays discarded                                                    | No change                                                            | Marked expired; review card is deleted and an expiry notice posts |

Only one of those outcomes can ever be recorded. Decisions are serialised per queue entry, so two moderators acting in the same instant produce a single result; the second action reports the outcome the first recorded and changes nothing.

### Approve

Approval clears the author, resets any existing automod strike, and resolves the queue entry. It
does not repost the held content. The author may submit the post again themselves, which avoids
republishing hostile content during a raid and preserves the real author on the new message. The
review card and its Stoat-hosted evidence are intentionally deleted after approval.

### Reject and the automod strike ladder

Rejection deletes the review card and its Stoat media, discards the held content, and advances the author's [automod strike stage](/HoYoFetch/moderation/automod/#containment-strike-stages). It never applies a timeout or opens a permanent-ban vote by itself. A later automod detection must independently reach the normal score threshold; it then advances the stage again and applies or projects the new duration.

### Deny and hold the user

🔒 does everything Deny does — discard, delete the card, advance the strike stage — and then places the author in [full Post Gate](#holding-a-whole-member), so every message they send afterwards is held for review until a moderator releases them. One combined notice records who denied the post, which queue entry caused it, and when the hold began.

Like Deny, it never times out or bans anyone. A hold is a decision to _read everything this person posts for a while_, which is why it is reversible in one reaction and why Irminsul reminds moderators rather than quietly leaving someone gated forever.

If the queue entry predates author-id capture, the post is still denied but no hold is placed — there is no account to hold, and Irminsul will not write a record under a phantom id.

### Expiry

An unreviewed hold expires after **7 days**: the review card and its Stoat media are deleted, the queued content is discarded with no strike, and a notice is posted to the review channel.

:::note[Reversible by design]
A held post never remains visible while awaiting review. Its retained copy is discarded after an
approval, discarded with a recorded strike after a rejection, or discarded after 7 days without a
decision. Review needs only one moderator because approval clears the author and rejection only
changes future escalation; neither applies a timeout or permanent ban itself.

A full-user hold is reversible on the same terms. It is never applied automatically — only a
moderator pressing 🔒 creates one — it never expires or releases on its own, and one 🔓 ends it.
The prohibited-term filter likewise only ever holds a message for someone to read.
:::
