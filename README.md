# 🌿 Irminsul — HoYoverse Code Bot for Revolt / Stoat.chat

Automatically fetches and posts redemption codes for **Genshin Impact**, **Honkai: Star Rail**, **Zenless Zone Zero**, **Honkai Impact 3rd**, **Neverness to Everness**, and **Wuthering Waves** in your Revolt server channels.

📚 **Documentation:** [Irminsul Docs](https://rehoyo.github.io/HoYoFetch/) — searchable commands, setup, moderation, audit-log, automod, troubleshooting, and self-hosting guides.

## ✨ Features

| Feature                   | Details                                                                                                                                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **6 games supported**     | GI, HSR, ZZZ, HI3, NTE, and WuWa                                                                                                                                                                                                                                        |
| **Multiple code sources** | [hoyo-codes.seria.moe](https://hoyo-codes.seria.moe) (GI/HSR/ZZZ), [api.ennead.cc](https://api.ennead.cc/mihoyo) (HI3), and Game8 ([NTE](https://game8.co/games/Neverness-to-Everness/archives/593718), [WuWa](https://game8.co/games/Wuthering-Waves/archives/453149)) |
| **Rich embeds**           | Game-coloured embeds with icons, reward details, and redemption links                                                                                                                                                                                                   |
| **Auto-fetch**            | Hourly scan — posts only when **new** codes appear (no spam)                                                                                                                                                                                                            |
| **Audit log**             | Stoat has no native audit log — `/AuditLog` relays server actions (deletes, edits, joins/leaves, bans, role/channel changes) to a channel of your choice                                                                                                                |
| **Custom emoji**          | Optional: use your own Revolt emoji hub server for game-themed icons                                                                                                                                                                                                    |
| **Case-insensitive**      | `/fetchgi`, `/FETCHGI`, `/FetchGI` all work                                                                                                                                                                                                                             |
| **Zero external deps**    | Only `revolt.js` + `node-fetch`; no database needed                                                                                                                                                                                                                     |

## 🚀 Quick Start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Edit .env → paste your BOT_TOKEN

# 3. Run
npm start
```

### Getting a bot token

1. Open **Revolt** → Settings → **My Bots** → **Create Bot**
2. Copy the token → paste into `.env`
3. Click **Copy Invite Link** → add the bot to your server

### First-time behaviour

On first boot, the bot seeds all existing codes into memory so it won't announce old codes as "new". Only genuinely new codes trigger channel notifications.

### Development

```bash
npm test          # node:test unit suite (no network needed)
npm run lint      # ESLint (flat config)
npm run docs:build # Build the searchable documentation site
npm run format    # Prettier — format all files
```

CI (`.github/workflows/ci.yml`) runs lint + tests on Node 18 and 20 for every push and PR.

## 📋 Commands

| Command                                                         | Description                                                                                                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `/FetchGI`                                                      | Fetch active Genshin Impact codes                                                                                                 |
| `/FetchHSR`                                                     | Fetch active Honkai: Star Rail codes                                                                                              |
| `/FetchZZZ`                                                     | Fetch active Zenless Zone Zero codes                                                                                              |
| `/FetchHI3`                                                     | Fetch active Honkai Impact 3rd codes                                                                                              |
| `/FetchNTE`                                                     | Fetch active Neverness to Everness codes                                                                                          |
| `/FetchWuWa`                                                    | Fetch active Wuthering Waves codes                                                                                                |
| `/Report-Spam @member <what happened>`                          | Privately submit suspected friend-request or DM spam for review                                                                   |
| `/EnableFetch`                                                  | Enable HoYoverse + NTE + WuWa auto-fetch in the current channel (admins/mods only)                                                |
| `/EnableFetchHoyo`                                              | Enable HoYoverse-only auto-fetch in the current channel (admins/mods only)                                                        |
| `/EnableFetchNTE`                                               | Enable NTE-only auto-fetch in the current channel (admins/mods only)                                                              |
| `/EnableFetchWuWa`                                              | Enable WuWa-only auto-fetch in the current channel (admins/mods only)                                                             |
| `/EnableFetchNTEWuWa`                                           | Enable NTE + WuWa auto-fetch in the current channel (admins/mods only)                                                            |
| `/DisableFetch`                                                 | Disable auto-fetch in the current channel (admins/mods only)                                                                      |
| `/EmojiMode [unicode\|custom]`                                  | Show or switch reward-emoji rendering at runtime (admins/mods only)                                                               |
| `/Restart`                                                      | Restart the bot after deploying updates (admins/mods only)                                                                        |
| `/Server-Info`                                                  | Show cached server, archive, feature-health, and safe VPS diagnostics (admins/mods only)                                          |
| `/AuditLog [status\|here\|#channel\|off\|confirm CODE\|cancel]` | View or request an Enka-approved audit-log configuration change (admins/mods only)                                                |
| `/Test-AuditLog`                                                | Send a test event through the audit pipeline to verify delivery (admins/mods only; legacy diagnostic alias)                       |
| `/Exclude-Channel [status\|here\|#channel\|remove #channel]`    | Request Enka-approved message-content privacy exclusions (admins/mods only)                                                       |
| `/Level [status\|1\|2\|3 confirm\|tenure <days>]`               | Set the server-wide moderation posture from standard to lockdown (admins/mods only)                                               |
| `/Automod status`                                               | Show this server's automod mode, logger, and ban quorum (admins/mods only)                                                        |
| `/Automod monitor [here\|#channel]`                             | Detect and log cases without changing messages or members (admins/mods only)                                                      |
| `/Automod enforce [here\|#channel]`                             | Enable temporary containment and staff-approved ban cases (admins/mods only)                                                      |
| `/Automod off`                                                  | Disable anti-raid evaluation for this server (admins/mods only)                                                                   |
| `/Automod quorum 1\|2`                                          | Set the approval quorum for new cases; production defaults to two (admins/mods only)                                              |
| `/Automod approve CASE_ID`                                      | Approve a pending ban case (owner, Manage Server, or Ban Members only)                                                            |
| `/Automod release @member <reason>`                             | Remove a timeout and reset that member's automod escalation history (Timeout Members only)                                        |
| `/Ban <@member\|account ID> <reason>`                           | Natively ban a current or never-joined account after ✅ confirmation (Ban Members; cleanup also needs Manage Messages)            |
| `/Kick @member <reason>`                                        | Confirm with ✅, then pick a cleanup window by reaction; the kick cannot be undone (Kick Members)                                 |
| `/Mute @member [10m\|30m\|1h\|4h\|24h\|3d\|7d] <reason>`        | Type a duration and confirm with ✅, or omit it for a reaction picker (Timeout Members only)                                      |
| `/Purge-User @member <reason>`                                  | Pick a window by reaction, then confirm deletion of the member's observed messages (Manage Messages only)                         |
| `/Get-Info <@member\|account ID>`                               | Vet current, departed, banned, or never-joined accounts with tiered account, ban, archive, and bot-risk detail (admins/mods only) |
| `/HelpHoyoFetch`                                                | Show the two-page command reference; the opener navigates with ◀️/▶️                                                              |
| `/Docs`                                                         | Open the permanent searchable documentation site                                                                                  |

> **Note:** Revolt does not support Discord-style slash commands. These are message-based prefix commands using `/` as the prefix. Command names are case-insensitive; channel IDs are preserved exactly.

`/HelpHoyoFetch` opens on the code, member-safety, and setup reference. The person who opened it can use ◀️/▶️ for five minutes to switch between that page and the moderation reference; other members' navigation reactions are ignored. Run `/Docs` for the full searchable reference at any time.

### Command security

- Commands are accepted only from human members in server channels. Direct messages, webhooks, and messages from other bots are ignored.
- `/Report-Spam` is available to human members, but only in a channel where Irminsul can freshly verify its Manage Messages permission and remove the invocation before reading the target and description.
- Server owners and members with **Manage Server** permission are treated as administrators.
- `/AuditLog` configuration and `/Exclude-Channel` use the same recognized-moderator permissions, but no enable, move, disable, exclusion, or exclusion removal takes effect until **Enka#4961** approves a fresh one-time code. Read-only audit status and testing remain immediate.
- Fetch, emoji, restart, and audit-log management commands are available to administrators and capability-based moderators with **Kick Members**, **Ban Members**, **Timeout Members**, or **Manage Messages** in the current channel.
- Automod configuration uses the same capability-based moderator policy as other management commands: owner, **Manage Server**, **Kick Members**, **Ban Members**, **Timeout Members**, or **Manage Messages** in the current channel. Ban approvals remain stricter and require the owner, **Manage Server**, or **Ban Members**; **Manage Messages** alone cannot approve a ban.
- Manual moderation commands use exact effective permissions and refresh both the moderator and bot before acting: **Ban Members** for `/Ban`, **Kick Members** for `/Kick`, **Timeout Members** for `/Mute` and `/Automod release`, and **Manage Messages** for `/Purge-User`. An active `/AuditLog` channel is required so actor, target, reason, and outcome are durably protected.
- Role names are never trusted; access is based on Stoat's effective permissions. This shared policy covers auto-fetch management, emoji mode, restart, and audit-log configuration/testing.
- Each member can trigger up to five recognised commands in 30 seconds. Concurrent requests for the same game's codes share one upstream fetch.

### Member spam reports

`/Report-Spam @member sent me a scam DM` privately submits suspected friend-request, DM, commission, or scam spam for review. Describe what happened in plain words the way the moderation commands read; the reported account may be mentioned anywhere in the sentence, and the older `reason:` delimiter still works. The description must be 10–300 characters. Irminsul removes the command message before parsing it, verifies that the reporter and target are current members, strips active links and formatting from the reason, and posts only a generic report ID acknowledgement publicly.

The command has its own abuse controls: one attempt per reporter per minute, at most three accepted reports per reporter per server within 24 hours, and one accepted report against the same target per reporter within 24 hours. Three unique reporters against one target within 24 hours raise the review priority. Reports are allegations, not proof, and never create an automatic timeout, deletion, kick, ban, or automod strike.

Irminsul cannot observe private friend requests or DMs between ordinary members. Members must submit reports themselves, and staff must independently verify the available evidence.

### Manual moderation

Reasons are mandatory but are written in plain words — `/Ban @member for spamming and stuff` — and may contain up to 300 characters. The target, the reason, and any option may appear in any order, and the older `reason:`, `delete:`, and `window:` delimiters are still accepted. Commands accept one member mention or one raw user ID. Stoat has no interaction buttons, so Irminsul uses reactions for duration selection, cleanup windows, destructive confirmation, and undo. Every picker and confirmation is answerable only by the moderator who ran the command and expires after two minutes.

Because the reason is free text, a mistyped or auto-completed mention would otherwise be indistinguishable from the intended member. `/Ban`, `/Kick`, and `/Mute` therefore post a ✅/❌ confirmation naming the action, target, reason, and any typed cleanup window; nothing reaches Stoat until the invoking moderator reacts ✅. Permissions and the target are verified at that point rather than when the command was typed. `/Automod release` has no confirmation because it only restores access.

- `/Ban @member for repeated spam` or `/Ban ACCOUNT_ID for coordinating a raid` uses Stoat's native ban endpoint once confirmed. A current membership is not required, so moderators can ban current, departed, or never-joined accounts by raw ID. Irminsul then offers a cleanup picker: 1️⃣ 1h, 2️⃣ 6h, 3️⃣ 1d, 4️⃣ 3d, 5️⃣ 7d, 6️⃣ 1mo, 7️⃣ 3mo, 8️⃣ 6mo, 9️⃣ 1y, or ❌ to keep any messages Irminsul previously observed. Cleanup needs Manage Messages in every affected channel. The ↩️ reaction on the protected record is available for 10 minutes to any freshly authorized ban moderator; it unbans but cannot restore membership or deleted messages.
- `/Kick @member for raiding` kicks once confirmed and offers the same cleanup picker. Stoat cannot put a kicked member back, so no undo reaction is offered and the reason is retained in Irminsul's protected log.
- `/Mute @member 1h cooldown` confirms first, then applies that duration; omitting the duration opens the 10m–7d picker instead, and choosing from it is itself the confirmation. Either way the cleanup picker follows. The protected record has a 10-minute ↩️ undo reaction for authorized timeout moderators.
- `/Purge-User @member because of spam` asks for a window with the same 1h–1y picker, then shows a ✅/❌ confirmation with the number of matching messages. Only one purge or cleanup runs per server at a time.
- `/Automod release @member false positive` removes the native timeout, resets the member's automod strike history, and closes pending ban reviews for that containment. It can also remove a manually applied timeout.

**History cleanup limitations:** cleanup reaches back up to 1 year, matching the message archive's own retention exactly — `1y` selects everything the archive still holds. Stoat's ban API has no message-history option and its bulk-delete endpoint accepts only recent messages, so Irminsul bulk-deletes IDs recorded in the last seven days and removes anything older one message at a time; a `1mo`–`1y` cleanup will typically route almost entirely through the paced individual-delete path and take noticeably longer than a short one. Irminsul estimates the time up front when a run is large enough to be slow. A single cleanup deletes at most 2,000 messages, oldest first — never read the result as guaranteed-complete, and a long window on an active member will often exhaust the cap well before reaching the full year. Protected audit entries, Stoat-hosted attachment archive cards, quotations, reactions, and external copies are never erased by a purge.

Every message a cleanup could not delete is reported by cause rather than as one anonymous failure count: **already gone from Stoat** (deleted before the cleanup reached it, usually while the bot was offline — reconciled into the archive so later runs stop selecting it), **missing Manage Messages** in that channel (fix the permission and re-run), **still rate limited** after a retry (re-run to finish), or a genuine **error** (the per-message status code is in the bot log).

### Audit log

Stoat/Revolt has no built-in audit log, so `/AuditLog here` requests the current channel as the destination and `/AuditLog #channel` requests another text channel. `/AuditLog off` requests disabling it. Every enable, move, or disable—including the older `/Enable-AuditLog` and `/Disable-AuditLog` compatibility forms—requires a fresh ten-minute code sent exclusively to **Enka#4961**. Enka may approve or deny in DM or release the code for `/AuditLog confirm CODE`; the requester or Enka can use `/AuditLog cancel`. `/AuditLog status` and `/Test-AuditLog` are read-only and do not require approval, and a request that would make no change does not generate a code.

Only one protected audit/privacy request can wait per server. If Enka cannot be reached, the request fails closed and the existing audit destination remains unchanged. Approved moves and disables leave lifecycle notices in the previous protected destination; an approved enable or move records completion in the new destination. The bot relays message edits/deletes (with original content), bulk deletes, channel/role/server changes, member joins/leaves, bans, unbans, timeouts, username changes, nickname/role changes, and emoji changes. Username coverage is live-only while Irminsul is online.

Server-setting monitoring combines live raw gateway events with a persisted REST baseline in `data/server_settings_snapshots.json`. It records detailed before/after changes for server identity and discovery settings, categories and system-message routing, channels, role and channel permission overrides, roles, emoji, invites, and webhooks. A reconciliation runs at startup and about every five minutes, so changes made while the bot was offline are detected after it returns. Webhooks require one request per channel and are scanned in bounded rotating batches; `/Test-AuditLog` reports the current baseline and webhook coverage.

Audit configuration and testing commands use the same capability-based moderator policy as other management commands: the owner, **Manage Server**, **Kick Members**, **Ban Members**, **Timeout Members**, or effective **Manage Messages** in the current channel.

To always show what was deleted or edited — Stoat only reports the _id_ of a deleted message — the bot records every message in audit-enabled servers to a local archive (`data/message_archive.jsonl`, kept **1 year**, capped at 1,000,000 messages by default, configurable via `HOYOFETCH_ARCHIVE_MAX_MESSAGES`). This survives restarts.

Use `/Exclude-Channel #private-channel` when a text channel's message content must never be archived or relayed. Irminsul sends a six-digit approval code exclusively to **Enka#4961** by DM. Enka may approve there or relay it to the requesting moderator for `/Exclude-Channel confirm CODE`. Removing an exclusion requires a new code. Approval retroactively removes that channel's archive entries and its Stoat-hosted attachment archive cards; new message creates, edits, deletes, and bulk deletes are ignored. Channel, role, permission, moderation, membership, and other server events still log, and a protected daily digest lists active exclusions. Automod detection remains active, but evidence excerpts from excluded channels are withheld. Because no messages are recorded there, `/Purge-User` cannot clean messages in an excluded channel.

The approval protects against a moderator silently changing message privacy. It does not prevent a server owner from removing the bot or someone with host filesystem access from editing `data/channel_exclusions.json` as an operator break-glass action.

**Attachment evidence.** Stoat removes an attachment with its owning message, and an uploaded file ID cannot be reused by another message. Irminsul therefore copies each qualifying attachment (any type, up to `AUDITLOG_EVIDENCE_MAX_MB` — default 20 MB) immediately into a protected **📎 Attachment Archived** card in the configured Logger. The transfer is RAM-only: the VPS journal keeps the filename, size, Stoat URL, and protected record ID, but never the attachment bytes. Later edit and delete records reply to that Logger card instead of uploading the file again. Set `AUDITLOG_EVIDENCE_MAX_MB=0` for metadata-only notices. The archive worker is bounded to two active transfers plus at most 50 queued source messages.

On the first startup after upgrading, Irminsul deletes direct regular files left in the exact legacy `data/evidence/` directory and marks old descriptors as purged. It does not follow symlinks or traverse subdirectories. VPS snapshots and backups are outside the bot's control and must be cleaned separately if they contain the former evidence cache.

The bot needs the **Ban Members** permission to detect bans (checked when a member leaves) and unbans (ban-list poll every ~5 minutes).

**Troubleshooting:** run `/Test-AuditLog` — it pushes a 🧪 test event through the real delivery pipeline and reports message coverage, the Stoat-hosted attachment mode, the per-file cap, archive-queue activity, and capture failures since startup. For verbose per-event console logging, set `AUDITLOG_DEBUG=1` in `.env`. Deletes of messages sent before audit logging was enabled are logged with "content unknown" (Stoat only transmits the message id on delete).

**Platform limitations that cannot be worked around:**

- Stoat has no username-to-ID search for bots, so `/Get-Info` needs a mention or a 26-character account ID; non-members cannot be found by username alone.
- Stoat's server, channel, role, member, and user-profile update events do not identify who acted. These entries explicitly say **Actor unavailable from Stoat** rather than guessing. Emoji and invite creators are shown as verified actors when their resource data supplies a creator.
- The gateway never reports **who** deleted a message. Delete entries list the author and members with effective **Manage Messages** permission as **possible deleters**, clearly labeled as a heuristic; this is not proof of who acted.
- Newer backends can label a member departure as `Leave`, `Kick`, or `Ban`. When the backend omits that reason, the bot can only report that the member left or was removed.
- Messages sent before audit logging was enabled, or while the bot was offline, can't have their content recovered.
- Invites and webhooks produce no usable gateway events, so they are detected later by REST reconciliation and only when the bot has permission to list them. Webhook tokens and usable invite codes are never persisted or logged.
- Reconciliation can prove that a setting changed while the bot was offline, but not the exact time or actor. Voice participation is not treated as a server-setting change.

### Account intelligence

Stoat's own UI hides basic account facts like join date, which makes a bot or raid account harder to spot by eye. Irminsul surfaces what Stoat exposes on every join and on demand.

Join records now carry full account and membership detail — creation date, avatar status, platform badges/flags, roles, and any prior automod or spam-report history — instead of just a username, plus a computed **⚠️ Signals** line naming the specific conditions worth a second look (a brand-new account, an account created moments before it joined, a default avatar, and so on). A join titled **📥 Member Joined — review** has at least one signal; a plain **📥 Member Joined** does not. The join log reads only locally cached data, so a join surge never triggers extra Stoat requests.

`/Get-Info @member` or `/Get-Info <account ID>` now degrades gracefully across current, departed, banned, and never-joined accounts. It labels the lookup scope, derives the creation date directly from any valid Stoat ULID, reads ban-list identity and reasons when permitted, checks platform flags when full identity is unavailable, and includes local archive/moderation evidence. When another cached mutual server makes the account visible, the report names up to three such servers. Unlike the join log, it may fetch the account's profile because it targets one account at a time. Access remains restricted to recognized moderators — the same policy as `/Automod` and `/AuditLog`.

Stoat has no username-to-ID search, so a non-member must be looked up by their 26-character account ID (or by a mention when one is available).

Signals are heuristics for a moderator to weigh, not proof that an account is a bot.

### Moderation levels

`/Level` is a single dial for the whole server's posture, and every server starts at **level 1** — the behavior that existed before this command. It uses the same capability-based moderator policy as `/Automod` and `/Post-Gate` (owner, Manage Server, or a recognized moderation capability), and only retunes thresholds those two features already own; raising the level never switches either one on.

|                                    | 1 — Standard                | 2 — Heightened              | 3 — Lockdown                |
| ---------------------------------- | --------------------------- | --------------------------- | --------------------------- |
| Post gate holds                    | links and attachments       | every message               | every message               |
| "New account" / "new member"       | 7d / 24h                    | 30d / 7d                    | 30d / 7d                    |
| Automod trips at                   | behavior signal + score ≥ 2 | behavior signal + score ≥ 1 | behavior signal + score ≥ 1 |
| Raid mode                          | 5 joins/60s for 10m         | 3 joins/60s for 30m         | 3 joins/60s for 30m         |
| New joins                          | observed                    | observed                    | kicked on sight             |
| Members below the tenure threshold | —                           | —                           | cannot post                 |

A behavior signal stays mandatory at every level: being new, or joining during a raid, only ever adds weight to observed behavior and can never trigger containment on its own.

Level 3 is the only setting that removes members automatically, so it has two preconditions. `/Level 3` alone refuses and explains what it would do — only `/Level 3 confirm` applies it — and it is refused outright unless `/Automod` has a log channel, since every kick, withheld kick, and restricted message is written there as a protected record. Bots and freshly verified moderators are never kicked, and a joiner whose permission check cannot complete is reported rather than removed. Restricted members have every message deleted but escalate at most one strike per 15 minutes, so a flood cannot walk an account up the ladder in seconds. `/Level 1` stands everything down immediately; kicked accounts are not banned and can rejoin.

### Anti-raid automod

Automod is **off by default for every server**. Start with `/Automod monitor here` in a sandbox or logger channel. Monitor mode runs the complete detector and writes protected case records, but never deletes messages, times out members, or creates ban votes. `/Automod enforce here` must be selected explicitly before containment is allowed.

The detector keeps bounded, in-memory message and join windows. It opens a case at two points when at least one message-behavior signal is present:

- 5 messages within 5 seconds: 1 point
- 4 normalized duplicates within 10 seconds: 2 points
- 5 unique mentions within 10 seconds: 2 points
- Account younger than 7 days or server membership younger than 24 hours: 1 point
- Joined during heightened raid mode: 1 point

Five joins within 60 seconds activate heightened weighting for 10 minutes and write a warning to the automod logger. A join surge by itself never changes a member. Bots, webhooks, the server owner, and verified moderation staff are excluded. If fresh permission verification is unavailable, an enforcement trigger is downgraded to monitor-only.

In enforcement mode, successful containment advances a persistent, bounded timeout ladder: **10 minutes → 1 hour → 24 hours → 7 days**. Further triggers remain capped at seven days, and the ladder resets after 14 quiet days. Monitor mode displays the projected strike without changing it. The bot then best-effort deletes the triggering messages and writes a protected evidence record. A successfully contained case gets a separate 10-minute ban prompt. Permanent bans are **never automatic**: two distinct authorized staff approvals are required by default, using the 🔨 reaction or `/Automod approve CASE_ID`. `/Automod quorum 1` exists for a one-moderator sandbox; restore it to `2` before production use.

Queued triggers while the same timeout is still active extend that containment without creating vote spam or another strike. Once the timeout expires, another trigger advances the ladder and opens a fresh approval window even if the older case is less than 15 minutes old. Pending case IDs, approval state, strike history, reversible manual actions, and per-server configuration survive restarts in `data/automod_cases.json`, `data/automod_strikes.json`, `data/moderation_actions.json`, and `data/automod.json`; message-rate windows and uncommitted reaction pickers intentionally reset on restart.

For the sandbox acceptance pass:

1. Enable monitor mode and send five messages within five seconds from a recent-join test account; confirm one case and no moderation action.
2. Confirm five unique rapid messages from an established account do not cause containment.
3. Enable enforcement and repeat a recent-join or four-message duplicate flood; confirm timeout plus cleanup.
4. Use quorum one or two staff accounts to approve, verify the case ID in the ban reason, then unban the test account.
5. Test missing Timeout Members, Manage Messages, and Ban Members permissions; each failure must be logged without escalating to another action.

After sandbox acceptance, keep production in monitor mode for 48 hours, review false positives, verify quorum is two, and only then enable enforcement.

## 🔌 API Sources

| Game                  | API          | Endpoint                                                       |
| --------------------- | ------------ | -------------------------------------------------------------- |
| Genshin Impact        | hoyo-codes   | `https://hoyo-codes.seria.moe/codes?game=genshin`              |
| Honkai: Star Rail     | hoyo-codes   | `https://hoyo-codes.seria.moe/codes?game=hkrpg`                |
| Zenless Zone Zero     | hoyo-codes   | `https://hoyo-codes.seria.moe/codes?game=nap`                  |
| Honkai Impact 3rd     | ennead       | `https://api.ennead.cc/mihoyo/honkai/codes`                    |
| Neverness to Everness | Game8 scrape | `https://game8.co/games/Neverness-to-Everness/archives/593718` |
| Wuthering Waves       | Game8 scrape | `https://game8.co/games/Wuthering-Waves/archives/453149`       |

The hoyo-codes API returns an array of `{code, rewards, date, source}`. The ennead API returns `{active: [{code, reward: [...]}], inactive: [...]}` with reward arrays. NTE and WuWa are scraped from their Game8 active-code sections and use independent one-hour caches. WuWa parsing combines limited-time promotional tables with the permanent active-code table while excluding expired sections.

## 🎨 Custom Emoji Hub

You can use custom Revolt server emoji instead of Unicode emoji for reward icons (💎→ actual Primogem icon, etc.).

### How it works

1. **Create a dedicated server** on Revolt (e.g. "Irminsul Emoji Hub")
2. **Upload emoji** — game icons for Primogems, Mora, Stellar Jade, etc.
3. **Get each emoji's ID** — in the emoji picker, hover/select an emoji before sending; the format is `:EMOJI_ID:` where EMOJI_ID is a long alphanumeric string like `01H7K9RTHKEPJM8DM19TX35M8N`
4. **Invite the bot** to the emoji hub server
5. **Edit `custom_emojis.json`** — fill in the IDs

### Why a hub server?

In Revolt, custom emoji are globally referenced by their unique ID. A bot can use emoji from **any server it has joined** in messages sent to **any other server**. This means you only need one hub server with all your emoji — the bot renders them everywhere.

### Example `custom_emojis.json`

```json
{
  "genshin": {
    "primogem": "01H7ABCDEF123456",
    "mora": "01H7ABCDEF789012"
  },
  "hkrpg": {
    "stellar jade": "01H7XYZXYZXYZ123"
  },
  "_global": {
    "crystal": "01H7GLOBALEMOJI01"
  }
}
```

- **Game-specific** entries override `_global` entries
- Leave a value as `""` or remove it to fall back to Unicode emoji
- `_comment` keys are ignored by the code

## 🏗️ Architecture

```
hoyofetch/
├── bot.js              Main entry, command router, auto-fetch scheduler
├── command-catalog.js  Shared command metadata for the bot help and docs site
├── automod.js          Anti-raid detection, containment, and ban approvals
├── config.js           Game definitions, API config, custom emoji loader
├── api.js              Code source integration (hoyo-codes + ennead + Game8)
├── embeds.js           Revolt SendableEmbed builder
├── store.js            JSON persistence (channels, codes, audit, automod)
├── auditlog.js         Message/member audit event pipeline
├── settings-monitor.js Persistent server-setting diff and reconciliation
├── tamper-protection.js Always-on protected audit-message restoration
├── custom_emojis.json  Optional: custom Revolt emoji IDs
├── .env.example        Configuration template
├── package.json
├── website/            Astro Starlight documentation site
└── data/               Runtime data (auto-created, gitignored)
    ├── channels.json
    ├── known_codes.json
    ├── source_cache.json
    ├── auditlog.json
    ├── server_settings_snapshots.json
    ├── protected_messages.json
    ├── automod.json
    └── automod_cases.json
```

### Data flow

```
API poll (hourly)
  │
  ├─ GI/HSR/ZZZ ──→ hoyo-codes.seria.moe ──→ normalise
  │                                              │
  ├─ HI3 ─────────→ api.ennead.cc ─────────→ normalise
  │                                              │
  ├─ NTE ─────────→ Game8 scrape/cache ────→ normalise
  │                                              │
  └─ WuWa ───────→ Game8 scrape/cache ────→ normalise
                                                 │
                                    ┌────────────┘
                                    ▼
                           detectNewCodes()
                                    │
                        ┌───── new? ─────┐
                        │ yes            │ no
                        ▼                ▼
                   buildEmbed()      (silent)
                        │
                        ▼
                 Send to subscribed channels
```

## ⚙️ Configuration

All settings are in `.env`:

| Variable             | Default                              | Description                                                                        |
| -------------------- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| `BOT_TOKEN`          | _(required)_                         | Revolt bot token                                                                   |
| `PREFIX`             | `/`                                  | Command prefix                                                                     |
| `FETCH_INTERVAL`     | `60`                                 | Auto-fetch interval in minutes                                                     |
| `FETCH_COOLDOWN`     | `10`                                 | Min seconds between manual `/Fetch*` commands per channel (`0` disables)           |
| `EMOJI_MODE`         | `unicode`                            | Initial emoji mode (`unicode` or `custom`); switchable at runtime via `/EmojiMode` |
| `HOYO_API_BASE`      | `https://hoyo-codes.seria.moe/codes` | GI/HSR/ZZZ API                                                                     |
| `HOYOFETCH_DATA_DIR` | `./data`                             | Where `channels.json` / `known_codes.json` / `source_cache.json` are stored        |

## 🚀 Production Deployment

### PM2

```bash
npm install -g pm2
pm2 start bot.js --name hoyofetch
pm2 save
pm2 startup
```

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
CMD ["node", "bot.js"]
```

```bash
docker build -t hoyofetch .
docker run -d --name hoyofetch --restart unless-stopped \
  -e BOT_TOKEN=your_token_here \
  hoyofetch
```

## 📝 Changelog

### v2.5.1

- Level 2 and 3 no longer hold every message from a new account — all three levels now hold the same trigger, links and attachments, and rely on the wider new-account window and lower automod threshold to cover text-only abuse instead of queuing every plain-text message for manual review

### v2.5.0

- Added `/Level 1|2|3`, a server-wide moderation posture that retunes the post gate, automod's trigger threshold, and raid-mode sensitivity in one command _(same capability-based moderator policy as `/Automod` and `/Post-Gate`)_
- Level 2 widens the new-account window to 30 days and lets automod act on a single behavioural signal; a behavioural signal remains mandatory at every level, so being new still cannot trigger containment on its own
- Level 3 is lockdown: every new join is kicked on sight, and members who joined less than the tenure threshold ago (default 7 days, `/Level tenure <1-30>`) have their messages deleted and their automod strike raised, at most one strike per 15 minutes
- Level 3 requires the literal word `confirm` and a configured automod log channel, and never kicks bots, verified moderators, or a joiner whose permission check could not complete
- `/Post-Gate approve` no longer reposts the held content; it clears the author and resets their automod strike instead, so approving an account during a wave cannot republish what it posted

### v2.4.2

- Fixed member joins and leaves silently never reaching the audit channel; both are now read from the raw gateway stream as well as the Stoat library's own events, which drop a join whose account lookup fails and a departure whose payload does not match the expected shape
- Each join and departure is still recorded exactly once regardless of which source delivered it
- `/Test-AuditLog` and `/Server-Info` now report joins and leaves separately, distinguishing what arrived on the wire from what was posted, plus a running count of discarded events and the most recent reason
- Member, identity, and nickname listeners now report their own failures instead of surfacing as an untraceable console error
- An account Irminsul has never cached is reported with an unknown avatar instead of being flagged for review as a default-avatar account

### v2.4.1

- Extended `/Ban` to use Stoat's native raw-account-ID support for current, departed, and never-joined accounts; no pending-ban list or join-event workaround is required
- Replaced the persistent VPS attachment cache with immediate RAM-only copies into protected Stoat Logger cards; the local journal keeps filenames, sizes, Stoat URLs, and protected record IDs but never attachment bytes
- Delete/edit records reference the existing Logger card, bulk deletes reply to at most five cards without re-uploading media, and a bounded two-worker 50-message archive queue reports precise transfer failure reasons
- Moved first-post attachment storage to the Stoat review card; approval, rejection, and expiry remove the review card on completion, and metadata-only tamper restoration plus legacy `data/evidence/` cleanup were added
- Retired `AUDITLOG_EVIDENCE_BUDGET_MB`; `AUDITLOG_EVIDENCE_MAX_MB=0` is now the metadata-only opt-out

### v2.4.0

- Added `/Post-Gate`, an Enka-approved first-post review queue that holds a link or attachment from a new account, a newly joined member, or a first-time poster, instead of leaving it visible unreviewed
- A held message is deleted and posted to a review channel for a single moderator's ✅/❌ decision; approving reposts it attributed to the author, rejecting discards it and raises the author's automod strike level, and unreviewed holds expire after 7 days
- Fixed bulk message deletes never showing preserved attachment evidence, added an attachment count to edited-message records, and replaced the single generic "not preserved" reason with the actual cause (disabled, untrusted URL, over the size cap, failed download, or a local save error)
- Fixed the daily privacy exclusion digest never firing for a bot that restarts more often than once a day; it now persists each server's last-posted time and polls hourly instead of resetting a fixed 24-hour timer on every boot

### v2.3.0

- Expanded `/Get-Info` into a tiered lookup for current, departed, banned, never-joined, invisible, and deleted accounts, with ID-derived creation dates, ban reasons, platform flags, and named cached mutual servers
- Prevented invalid user responses from poisoning the revolt.js cache, stopped denied profiles from producing false “No bio” signals, and honored identities supplied by the ban list

### v2.2.0

- Extended the message archive's retention from 30 days to 1 year (calendar-correct across leap years), raised the message cap from 100k to 1,000,000 (configurable via `HOYOFETCH_ARCHIVE_MAX_MESSAGES`), and moved the boot-time journal replay to a streaming reader
- Extended `/Ban`, `/Kick`, `/Mute` cleanup, and `/Purge-User` from a 1h–29d picker to 1h–1y (1h, 6h, 1d, 3d, 7d, 1mo, 3mo, 6mo, 1y), matching the archive's new retention exactly
- Added an archived message count to `/Get-Info`, and switched it to listing every account/membership field it collects instead of omitting empty ones; the join log is unchanged

### v2.1.0

- Added account and membership detail to join records — creation date, avatar status, platform badges/flags, roles, and prior automod/spam-report history — with a computed bot-risk signals summary
- Added `/Get-Info @member` for the same account detail on demand, including for members who already left, restricted to recognized moderators

### v2.0.0

- Added protected server audit logging with raw edit/delete coverage, a 30-day message archive, attachment evidence, settings reconciliation, `/Test-AuditLog`, and tamper-resistant audit records
- Added Enka-approved `/Exclude-Channel` privacy controls that purge and withhold message content while preserving accountable lifecycle notices and daily digests
- Added persistent anti-raid automod monitor/enforce modes, scored detection, progressive timeouts, triggering-message cleanup, staff-approved bans, and `/Automod release`
- Added natural-language `/Ban`, `/Kick`, `/Mute`, `/Purge-User`, and `/Report-Spam` parsing with moderator-only reaction pickers and destructive-action confirmations
- Extended cleanup to 29 days with bulk and paced individual deletion, a 2,000-message cap, archive reconciliation, rate-limit-aware retries, and specific outcome reporting
- Added protected member spam reports with secure invocation deletion, anti-abuse limits, 24-hour unique-reporter correlation, and no automatic punishment
- Added Wuthering Waves via cached multi-table Game8 parsing, WuWa-only and NTE + WuWa auto-fetch scopes, and WuWa in all-games subscriptions
- Added the searchable Irminsul documentation site, `/Docs`, FAQ, paginated in-chat help, a shared command catalog, and documentation consistency checks
- Hardened command authorization with fresh effective-permission checks and deduplicated concurrent code fetches and announcements

### v1.1.0

- Neverness to Everness support via cached Game8 scraping
- Auto-fetch scopes: all games, HoYoverse-only, or NTE-only
- Remote `/Restart` command for reloading deployed updates
- **Honkai Impact 3rd support** via [ennead community API](https://github.com/torikushiii/hoyoverse-api) — no longer deprecated!
- **Custom emoji hub** — use your own Revolt server emoji for reward icons
- Dual API source architecture (hoyo-codes + ennead)
- Ennead API returns structured reward arrays with better detail
- HI3 now included in auto-fetch rotation
- Source attribution in embeds (shows which API powered the result)

### v1.0.0

- Initial release with GI, HSR, ZZZ support
- Rich embeds with reward emoji decoration
- Hourly auto-fetch with new code detection
- Channel enable/disable persistence

## 🙏 Credits

- [hoyo-codes](https://github.com/seriaati/hoyo-codes) by seriaati — GI/HSR/ZZZ codes API
- [hoyoverse-api](https://github.com/torikushiii/hoyoverse-api) by torikushiii — HI3 codes via ennead API
- [Game8](https://game8.co/games/Neverness-to-Everness/archives/593718) — NTE redeem-code source
- [Game8](https://game8.co/games/Wuthering-Waves/archives/453149) — WuWa redeem-code source
- [revolt.js](https://github.com/revoltchat/revolt.js) — Revolt bot framework
