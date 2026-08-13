---
title: Post Gate
description: Review risky first links or media, prohibited terms in messages and identities, DM and off-platform contact solicitations, and every message from a held member.
---

Post Gate Protection's behavioral detection (rapid bursts, duplicate floods, mention floods) needs several messages to accumulate before it triggers. The Post Gate queue holds individual messages a moderator should read first — a new member's opening link, attachment, or DM/off-platform contact solicitation; a prohibited term in a message, username, display name, or server nickname; or anything at all from a member already in Post Gate. It also supplies the protected review destination for server moderation Levels 1–2 and the transition notices for Levels 3–4.

The post gate is **off by default for every server**.

## When a message is held

At Levels 1–2, a message is deleted and queued for review only when **all** of these preconditions hold:

- The server's post gate is in `hold` mode with a configured review channel.
- The channel is not the review channel itself, and is not privacy-excluded via `/AuditLog privacy exclude` — excluded channels retain nothing, so the gate never touches them.
- The author is not a recognized moderator. This is checked with the same fresh permission verification Post Gate Protection uses, and fails closed: if the check itself is unavailable, nothing is held.

Given that, **any one** of five triggers queues the message:

| Trigger                  | What it catches                                                                                                 | Tenure matters? |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- | --------------- |
| **Author in Post Gate**  | Every message from a member already in [full Post Gate](#holding-a-whole-member)                                | No              |
| **Contact solicitation** | A matching message or the author's current [profile bio](#dm-and-off-platform-contact-solicitation)             | Recent identity |
| **Prohibited term**      | A message matching the [prohibited-term filter](#prohibited-terms)                                              | No              |
| **Prohibited identity**  | A [username, display name, or server nickname](#usernames-display-names-and-nicknames) matching the same filter | No              |
| **First link or media**  | A link **or** at least one attachment from a new or first-time poster                                           | Yes             |

A member a moderator has [approved or released](#post-gate-exemption) is permanently exempt from **Contact solicitation**, **Prohibited identity**, and **First link or media** — the three triggers above that exist to screen an unknown or new account. **Author in Post Gate** and **Prohibited term** (a slur or similar in the message itself) are unaffected: the exemption is not a blanket moderation bypass.

The last trigger, first link or media, additionally requires the author to be, by locally cached or archived evidence, **new**:

- the account was created less than 7 days ago, or
- the author joined this server less than 24 hours ago, or
- the author has no other message Irminsul has archived in this server.

Contact solicitation uses Post Gate Protection's narrower existing **recent identity** condition: the account must be less than 7 days old or the server membership less than 24 hours old. The first-time-poster condition does not qualify an otherwise established account for contact screening.

Levels 1 and 2 intentionally use the same triggers.

Before testing the message for links, Irminsul performs bounded Unicode normalization and removes invisible formatting characters. It recognizes ordinary and spaced `http`, `https`, `hxxp`, and `www` forms; spaces around URL punctuation; bracketed `(dot)`/`[.]` forms; common Unicode dot, colon, and slash variants; bare DNS and punycode domains; and IPv4 addresses. This normalized copy is used only for detection—the original content is retained unchanged on the review card.

No text-only detector can prove that arbitrary prose does not encode a destination. Novel Unicode letter homoglyph alphabets, base64 strings, QR content, and conversational directions can remain ambiguous; link-like first posts should still be reviewed rather than treated as a definitive abuse finding.

:::tip[Tell new members up front]
Irminsul does not notify an author when their message is held — a quiet hold is harder for a raid account to route around than an explicit warning, but it also means a genuine new member gets no explanation if their first link or image briefly disappears. Consider a line in your server rules or welcome message covering it generically, without describing the exact trigger, for example:

> Due to spam and abuse, new members' first links or media may be held for a quick moderator check before staying visible.

:::

## DM and off-platform contact solicitation

At Levels 1–2 Irminsul checks a non-moderator's message and current profile bio for contact invitations only while Post Gate Protection's existing recent-identity signal applies: the account is less than 7 days old or the server membership is less than 24 hours old. This identity signal defines eligibility only; no additional burst, flood, or score is required after the contact detector matches. Established accounts and established first-time posters are not checked. A match immediately creates a persistent [full-user hold](#holding-a-whole-member), deletes and queues the triggering message, and leaves every later message queued until a moderator releases the account. The automatic hold itself never applies a protection strike, timeout, or ban.

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

The prohibited-term filter closes the gap behavioral protection cannot: a single targeted slur produces none of the burst, duplicate-flood, or mention-flood behaviour that protection scores on, so without this trigger it passes through untouched no matter who posts it.

**It only ever holds.** A match never bans, times out, or applies a protection strike by itself. The strike follows a moderator pressing Deny, exactly as it does for a link hold. This is deliberate: no term list is accurate enough to punish on automatically.

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

### Usernames, display names, and nicknames

A slur does not have to appear in a message to need review — it can sit in an account's username, display name, or server nickname, visible on every post and in the member list without ever tripping a content filter. The same compiled term list and allowlist screen those three fields, checked in that order, with the same normalization and the same **hold, never punish** rule.

Screening runs at three points, so a name never has to wait for a message to be caught:

- **On join** — a raid or harassment account can carry the slur from the moment it appears in the member list.
- **On nickname change** — a nickname can be set to a slur at any point after joining. Username and display-name changes are not their own trigger; they are caught the next time the account posts, the same as any other message.
- **On every message** — a safety net for an account that joined or renamed before a restart picked up the current term list, so the check still applies even if the join or nickname-change listener missed it.

A match places the account in [full Post Gate](#holding-a-whole-member) immediately — the same automatic hold DM/off-platform contact solicitation creates — rather than waiting for a message. If the match was found while handling a message, that message is held too. **The name itself is never repeated anywhere Irminsul posts.** A review or control card names only the rule id and which field matched (`username`, `display name`, or `nickname`); the same discipline the message filter already applies by never showing the matched text.

The usual preconditions still apply: Post Gate must be in `hold` mode with a review channel, Levels 3–4 lockdown takes precedence, an account already held is left alone, and a recognized moderator is exempt — checked at the server level, independent of any single channel's permissions, and failing closed if that check itself is unavailable.

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

Denying a held post with 🔒 places its author in **full Post Gate**. A recent-identity DM/off-platform contact match, or a [prohibited term in a username, display name, or nickname](#usernames-display-names-and-nicknames), creates the same hold automatically without adding a strike. While any of these holds is active, _every_ message the member sends in the server is held for review — text, links, media, regardless of tenure, regardless of the term list.

The preconditions above still apply in full: the review channel and privacy-excluded channels are never gated, recognized moderators are always exempt (so holding a moderator has no effect while they retain their moderation permissions), and Levels 3–4 lockdown continues to take precedence over the queue.

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

Automatic cards show **Irminsul (automatic screening)** instead of a moderator, and a signal source and rule id — `message`, `profile bio (content withheld)`, `username (name withheld)`, `display name (name withheld)`, or `server nickname (name withheld)` — without ever copying the bio, contact detail, or offending name itself. For a name-triggered hold, the card's own opening line names only the account by mention, never the username or nickname that matched.

The hold is **idempotent**: denying or automatically matching the same author again reports the existing hold, leaves its original source and time untouched, and never posts a second card. Two simultaneous triggers produce one hold, not two.

State is stored on disk alongside the rest of Irminsul's moderation state, so a hold survives a bot restart — including its control card, which keeps working. A member leaving, being kicked, or being banned automatically deactivates the account-level hold and removes its control and reminder cards. Already queued messages remain pending for individual review. Turning the post gate off leaves hold records inert; re-enabling it honours them again. Moving the review channel reposts every control card into the new one.

`/Post-Gate holds` lists who is currently gated, who held them, since when, and how many of their messages are still queued.

### Reminders

A hold **never expires on a timer while the account remains a member**. After 24 hours — configurable with `POST_GATE_HOLD_REMINDER_HOURS` (1–168) — Irminsul posts a reminder to the review channel with 🔓 Release and ⏳ Continue Holding. Choosing ⏳ re-arms the clock for another window. Ignoring the reminder simply repeats it one window later, not once per sweep. Reminders ride the same hourly maintenance pass as queue expiry, so one lands within an hour of coming due, and the due time is stored absolutely — a restart does not reset it. A member departure ends the account-level hold automatically instead of leaving moderators with a stale reminder.

### Releasing

Release with 🔓 on the control or reminder card, or with `/Post-Gate release @member`. Both require freshly verified Manage Messages in the review channel, the same check the review actions use. If the account has an active account-level hold, normal posting resumes immediately and the control card is removed.

**Messages already in the review queue stay queued.** Release only stops _future_ messages from being held; anything already waiting keeps its own review card and is approved or denied individually, and the release notice states how many are outstanding. A release is a judgement about the author, not about content no moderator has looked at yet — and it must never become a way to publish a queue nobody read.

Post Gate has two independent layers — the account-level full hold, and per-message queuing (a first link/media post, a contact-solicitation or identity match) — and most accounts a moderator wants to release only ever hit the second layer, since a queued post alone never creates a full hold. So `/Post-Gate release @member` is not conditioned on a hold actually existing: once authorized, it always grants the [Post Gate exemption](#post-gate-exemption) below, and additionally releases the account-level hold when one happens to be active. Running it on an account with no active hold reports **"Member Exempted"** rather than an error, and still posts an accountability notice.

### Post Gate exemption

Approving a held post (✅), or running `/Post-Gate release @member` (🔓 also releases a control/reminder card the same way), marks the author **permanently exempt** from Post Gate's automatic "unknown/new account" screening: the contact-solicitation match, the prohibited-term identity match, and the first-link/media-from-a-new-account check. Both paths grant the exact same exemption, and neither requires the account to have an active full hold first — approving is how most members earn it day to day; releasing works whether or not a hold exists, so moderators don't need to check which layer caught an account before deciding to trust it. The exemption:

- **Never expires on its own** — it does not depend on account age, tenure, or the 7-day retention window that eventually prunes an old hold's audit record.
- Is keyed to the account, not to server membership, so it **survives the member leaving and rejoining**.
- Does **not** cover the message-content prohibited-term filter or Levels 3–4 lockdown, both of which still apply to every member regardless of approval or release history — the exemption is not a blanket moderation bypass.
- Is revoked the instant a moderator manually holds the member again, with `/Post-Gate hold @member <reason>` or 🔒 Deny + Hold User on a newly queued item. A member re-held this way needs another approval or release to regain the exemption.
- ❌ Deny and an unreviewed 7-day expiry never grant it — only a positive ✅/🔓 decision does.

### Manual hold

`/Post-Gate hold @member <reason>` places a member in full Post Gate immediately, the same as an automatic or deny-hold hold, and requires a plain-word reason and the same freshly verified Manage Messages as release. Use it to put a member who no longer has your trust back under review without waiting for them to trip an automatic trigger — for example, one who was approved or released earlier and has since caused a problem outside anything Post Gate itself detects. Because it revokes any standing exemption, the member is once again subject to normal automatic screening until a future approval or release.

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

Turning the gate on, moving its review channel, and turning it off each require the same two-step approval as `/AuditLog` destination and privacy changes:

1. A recognized moderator requests the change.
2. Irminsul DMs a ten-minute, six-digit code exclusively to **Enka#4961**, who can reply with `approve CODE`, `deny CODE`, or the bare code, or relay it for `/Post-Gate confirm CODE` in the server.

Only one protected request can be pending per server at a time (shared with `/AuditLog` destination and privacy approvals), and three incorrect attempts destroy it. `/Post-Gate status` and reviewing a held post are both immediate and never require Enka's approval.

## Post Gate Protection

Post Gate Protection is **off by default for every server**. It is independent of the review queue: `/Post-Gate off` disables queued review, while `/Post-Gate protection off` disables behavioral detection. Begin in monitor mode and review real cases before allowing containment.

### Modes

| Mode    | Behavior                                                                                |
| ------- | --------------------------------------------------------------------------------------- |
| Off     | No behavioral anti-raid evaluation                                                      |
| Monitor | Runs the detector and writes protected cases without changing messages or members       |
| Enforce | May time out a member and clean triggering messages after fresh permission verification |

```text
/Post-Gate protection monitor here
/Post-Gate protection enforce here
/Post-Gate protection off
/Post-Gate protection quorum 2
```

`/Post-Gate status` reports both queue and protection state for the server.

### Detection score

A case opens at two points when at least one message-behavior signal is present:

- 5 messages within 5 seconds: **1 point**
- 4 normalized duplicates within 10 seconds: **2 points**
- 5 unique mentions within 10 seconds: **2 points**
- Recent identity under the effective server policy: **1 point**

At Level 1, recent identity means an account under 7 days or membership under 24 hours. At Level 2, it widens to an account under 14 days or membership under 3 days. The score threshold remains 2 at both levels, a behavioral signal remains mandatory, and shared Raid Mode itself adds no point. Bots and webhooks are excluded; the server owner and freshly verified moderation staff are exempt.

### Containment strike stages

Protection detections and rejected held posts advance the same persistent stage. Their immediate effects differ:

| Stored stage after the event | Direct protection trigger                                         | Post Gate rejection                   | Next direct protection trigger |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------- | ------------------------------ |
| Stage 1                      | 10-minute timeout in enforce mode; projected only in monitor mode | No timeout                            | Stage 2 (1 hour)               |
| Stage 2                      | 1-hour timeout in enforce mode; projected only in monitor mode    | No timeout                            | Stage 3 (24 hours)             |
| Stage 3                      | 24-hour timeout in enforce mode; projected only in monitor mode   | No timeout                            | Stage 4 (7 days)               |
| Stage 4                      | 7-day timeout in enforce mode; projected only in monitor mode     | No timeout; remains capped at stage 4 | Stage 4 (7 days)               |

The first stage-advancing event after a reset reaches stage 1 and refreshes the 14-day quiet-reset clock. Approval, expiry, and the act of holding a post do not change the stage. Activity while the same timeout is active extends containment without advancing the stage or opening another approval prompt.

### Permanent bans require people

Protection case bans are never automatic. A contained case opens a separate ten-minute approval window. Production defaults to two distinct authorized staff approvals, using 🔨 or:

```text
/Post-Gate protection approve CASE_ID
```

Use `/Post-Gate protection quorum 1` only for a single-moderator sandbox and restore quorum two before production. Release a false positive with `/Post-Gate protection release @member reason`; that action requires Timeout Members.

This is separate from server-wide `/Level 4`, which is explicitly armed by a moderator and automatically bans non-exempt authors whose messages reach Irminsul through the lockdown permission barrier.

:::note[Permission refresh failure]
If fresh authorization cannot be verified, an enforcement trigger is downgraded to monitor-only.
:::

## Server moderation levels

After the review channel is configured, any recognized moderator may inspect or change the persistent server policy:

```text
/Level status
/Level 1
/Level 2
/Level 3
/Level 4 confirm
```

| Level | Review queue                                                               | Default-role Send Messages | Slipped regular-member posts | Automatic ban                                              | Activation                                   |
| ----- | -------------------------------------------------------------------------- | -------------------------- | ---------------------------- | ---------------------------------------------------------- | -------------------------------------------- |
| 1     | Qualifying links/media; account <7d, membership <24h, or first-time poster | Unchanged                  | Normal processing            | No                                                         | Immediate                                    |
| 2     | Qualifying links/media; account <14d, membership <3d, or first-time poster | Unchanged                  | Normal processing            | No                                                         | Immediate or automatic 30-minute raid floor  |
| 3     | Bypassed to prevent queue floods                                           | Removed                    | Silently deleted             | No                                                         | Immediate after permission checks            |
| 4     | Bypassed to prevent queue floods                                           | Removed                    | Silently deleted             | Yes, when the message reaches Irminsul through an override | `/Level 4 confirm`, then ✅ within 2 minutes |

### Which level should moderators use?

Use the lowest level that fits the incident, then downgrade when the risk has passed:

| Level                      | Recommended situation                                                                             | What members experience                                                                                   | Important limitation                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **1 — Routine**            | Normal day-to-day operation                                                                       | Normal conversation continues; qualifying link/media posts from new or first-time members wait for review | Text-only posts are not held                                                                           |
| **2 — Elevated**           | A small suspected bot raid or credible warning                                                    | Ordinary text flows; targeted link/media and protection identity windows widen to 14d/3d                  | Protection still requires behavior and score 2; contact/profile screening stays at 7d/24h              |
| **3 — Raid lockdown**      | A large or active raid where stopping message volume matters more than uninterrupted conversation | The default role cannot send; non-exempt messages that bypass the lock are silently deleted               | Authors are not automatically banned                                                                   |
| **4 — Emergency lockdown** | The most severe raid, when bypass attempts should be removed from the server                      | Level 3's lockdown remains active; non-exempt authors who post through an override are also banned        | Irminsul cannot ban an ordinary blocked sender because Stoat creates no message event identifying them |

Levels 1–2 are preventative review modes. They catch common link and media bot spam while keeping ordinary chat available, but they do not guarantee that every bot or text-only abuse attempt is blocked. Level 2 does not widen DM/off-platform contact screening: that profile-sensitive check remains limited to accounts under 7 days or memberships under 24 hours. Levels 3–4 are disruptive server-wide incident controls and should be reserved for an active raid. Level 4 is not a stronger permission barrier than Level 3; its additional action is the automatic ban applied when a message slips through an explicit permission override.

### Shared Raid Mode

Five unique non-bot joins in a rolling 60-second window activate a persisted 30-minute Level 2 floor when either the Post Gate queue or Post Gate Protection is enabled. Continuing qualifying bursts refresh the expiry at most once per minute without posting repeat warnings. The join window itself is in memory and restarts empty, while an already-active floor survives a restart.

The effective policy is the higher of the configured `/Level` and the automatic floor. Raid Mode therefore never lowers a manual level and never enters Level 3 or 4 automatically. `/Level 1` during the window changes the configured baseline but remains effectively Level 2 until expiry; `/Level 2` makes the heightened posture remain afterwards. Turning the Post Gate queue off still disables its queue and does not let Raid Mode turn it back on, although enabled Post Gate Protection continues to consume the shared Level 2 policy. When both layers are off, joins are not tracked.

`/Level status`, `/Post-Gate status`, and `/Server-Info` distinguish the configured and effective levels and show the automatic expiry. Activation and expiry produce one protected notice in each unique configured Post Gate review or protection log channel. A join surge alone never opens a protection case, locks the server, or changes a member.

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

The hold itself does **not** count as a protection strike. Its effect depends on how the review ends:

| Review outcome         | Original channel                                                           | Protection strike stage                                              | Queue and review card                                             | Post Gate exemption                      |
| ---------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| ✅ Approve             | Content stays discarded; the cleared author may submit it again themselves | Existing strike is reset                                             | Marked approved; review card is deleted                           | Author is granted the standing exemption |
| ❌ Deny                | Content stays discarded                                                    | Advances one stage, up to stage 4; no timeout is applied immediately | Marked rejected; review card is deleted                           | No change                                |
| 🔒 Deny + Hold User    | Content stays discarded                                                    | Advances one stage, exactly as Deny does                             | Marked rejected; review card deleted and a control card is posted | Any standing exemption is revoked        |
| No decision for 7 days | Content stays discarded                                                    | No change                                                            | Marked expired; review card is deleted and an expiry notice posts | No change                                |

Only one of those outcomes can ever be recorded. Decisions are serialised per queue entry, so two moderators acting in the same instant produce a single result; the second action reports the outcome the first recorded and changes nothing.

### Approve

Approval clears the author, resets any existing protection strike, and resolves the queue entry. It
does not repost the held content. The author may submit the post again themselves, which avoids
republishing hostile content during a raid and preserves the real author on the new message. The
review card and its Stoat-hosted evidence are intentionally deleted after approval.

Approving is also the everyday way a member earns the [Post Gate exemption](#post-gate-exemption): most held posts are a first link, first attachment, or a term match from an otherwise ordinary new member, and never place a full account-level hold — so there is nothing for `/Post-Gate release` to undo for them. Clicking ✅ (or running `/Post-Gate approve QUEUE_ID`) grants that member the same standing exemption a full release does, without requiring them to have been fully held first.

### Reject and the protection strike ladder

Rejection deletes the review card and its Stoat media, discards the held content, and advances the author's [protection strike stage](#containment-strike-stages). It never applies a timeout or opens a permanent-ban vote by itself. A later protection detection must independently reach the normal score threshold; it then advances the stage again and applies or projects the new duration.

### Deny and hold the user

🔒 does everything Deny does — discard, delete the card, advance the strike stage — and then places the author in [full Post Gate](#holding-a-whole-member), so every message they send afterwards is held for review until a moderator releases them. One combined notice records who denied the post, which queue entry caused it, and when the hold began.

Like Deny, it never times out or bans anyone. A hold is a decision to _read everything this person posts for a while_, which is why it is reversible in one reaction and why Irminsul reminds moderators rather than quietly leaving someone gated forever.

If the author was previously approved or released and therefore held a [Post Gate exemption](#post-gate-exemption), this revokes it — the same as `/Post-Gate hold`.

If the queue entry predates author-id capture, the post is still denied but no hold is placed — there is no account to hold, and Irminsul will not write a record under a phantom id.

### Expiry

An unreviewed hold expires after **7 days**: the review card and its Stoat media are deleted and the queued content is discarded with no strike. All entries expiring in the same hourly sweep are listed in one review-channel notice per server.

:::note[Reversible by design]
A held post never remains visible while awaiting review. Its retained copy is discarded after an
approval, discarded with a recorded strike after a rejection, or discarded after 7 days without a
decision. Review needs only one moderator because approval clears the author and rejection only
changes future escalation; neither applies a timeout or permanent ban itself.

A full-user hold is reversible on the same terms. It may be created by a moderator or automatic
screening, never expires on a timer while the account remains a member, and one 🔓 ends it. A
member departure ends the account-level hold automatically.
The prohibited-term filter likewise only ever holds a message for someone to read.
:::
