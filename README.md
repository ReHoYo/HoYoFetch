# 🎮 HoyoFetch — HoYoverse Code Bot for Revolt / Stoat.chat

Automatically fetches and posts redemption codes for **Genshin Impact**, **Honkai: Star Rail**, **Zenless Zone Zero**, **Honkai Impact 3rd**, and **Neverness to Everness** in your Revolt server channels.

## ✨ Features

| Feature                   | Details                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **5 games supported**     | GI, HSR, ZZZ, HI3, and NTE                                                                                                                                                                              |
| **Multiple code sources** | [hoyo-codes.seria.moe](https://hoyo-codes.seria.moe) (GI/HSR/ZZZ), [api.ennead.cc](https://api.ennead.cc/mihoyo) (HI3), and [Game8](https://game8.co/games/Neverness-to-Everness/archives/593718) (NTE) |
| **Rich embeds**           | Game-coloured embeds with icons, reward details, and redemption links                                                                                                                                   |
| **Auto-fetch**            | Hourly scan — posts only when **new** codes appear (no spam)                                                                                                                                            |
| **Audit log**             | Stoat has no native audit log — `/AuditLog` relays server actions (deletes, edits, joins/leaves, bans, role/channel changes) to a channel of your choice                                                |
| **Custom emoji**          | Optional: use your own Revolt emoji hub server for game-themed icons                                                                                                                                    |
| **Case-insensitive**      | `/fetchgi`, `/FETCHGI`, `/FetchGI` all work                                                                                                                                                             |
| **Zero external deps**    | Only `revolt.js` + `node-fetch`; no database needed                                                                                                                                                     |

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
npm run format    # Prettier — format all files
```

CI (`.github/workflows/ci.yml`) runs lint + tests on Node 18 and 20 for every push and PR.

## 📋 Commands

| Command                                                     | Description                                                                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/FetchGI`                                                  | Fetch active Genshin Impact codes                                                                           |
| `/FetchHSR`                                                 | Fetch active Honkai: Star Rail codes                                                                        |
| `/FetchZZZ`                                                 | Fetch active Zenless Zone Zero codes                                                                        |
| `/FetchHI3`                                                 | Fetch active Honkai Impact 3rd codes                                                                        |
| `/FetchNTE`                                                 | Fetch active Neverness to Everness codes                                                                    |
| `/EnableFetch`                                              | Enable HoYoverse + NTE auto-fetch in the current channel (admins/mods only)                                 |
| `/EnableFetchHoyo`                                          | Enable HoYoverse-only auto-fetch in the current channel (admins/mods only)                                  |
| `/EnableFetchNTE`                                           | Enable NTE-only auto-fetch in the current channel (admins/mods only)                                        |
| `/DisableFetch`                                             | Disable auto-fetch in the current channel (admins/mods only)                                                |
| `/EmojiMode [unicode\|custom]`                              | Show or switch reward-emoji rendering at runtime (admins/mods only)                                         |
| `/Restart`                                                  | Restart the bot after deploying updates (admins/mods only)                                                  |
| `/AuditLog [status\|here\|#channel\|off]`                   | View or configure audit logging for the server (admins/mods only)                                           |
| `/Test-AuditLog`                                            | Send a test event through the audit pipeline to verify delivery (admins/mods only; legacy diagnostic alias) |
| `/Automod status`                                           | Show this server's automod mode, logger, and ban quorum (admins/mods only)                                  |
| `/Automod monitor [here\|#channel]`                         | Detect and log cases without changing messages or members (admins/mods only)                                |
| `/Automod enforce [here\|#channel]`                         | Enable temporary containment and staff-approved ban cases (admins/mods only)                                |
| `/Automod off`                                              | Disable anti-raid evaluation for this server (admins/mods only)                                             |
| `/Automod quorum 1\|2`                                      | Set the approval quorum for new cases; production defaults to two (admins/mods only)                        |
| `/Automod approve CASE_ID`                                  | Approve a pending ban case (owner, Manage Server, or Ban Members only)                                      |
| `/Automod release @member reason: ...`                      | Remove a timeout and reset that member's automod escalation history (Timeout Members only)                  |
| `/Ban @member [delete:1h\|6h\|1d\|3d\|7d] reason: ...`      | Ban with optional best-effort observed-message cleanup (Ban Members; cleanup also needs Manage Messages)    |
| `/Kick @member reason: ...`                                 | Immediately kick a member; this cannot be undone (Kick Members only)                                        |
| `/Mute @member [10m\|30m\|1h\|4h\|24h\|3d\|7d] reason: ...` | Apply a native timeout, or omit duration for a reaction picker (Timeout Members only)                       |
| `/Purge-User @member window:1h\|6h\|1d\|3d\|7d reason: ...` | Confirm and delete the member's observed messages in the selected window (Manage Messages only)             |
| `/HelpHoyoFetch`                                            | Show all commands                                                                                           |

> **Note:** Revolt does not support Discord-style slash commands. These are message-based prefix commands using `/` as the prefix. Command names are case-insensitive; channel IDs are preserved exactly.

### Command security

- Commands are accepted only from human members in server channels. Direct messages, webhooks, and messages from other bots are ignored.
- Server owners and members with **Manage Server** permission are treated as administrators.
- Fetch, emoji, restart, and audit-log management commands are available to administrators and capability-based moderators with **Kick Members**, **Ban Members**, **Timeout Members**, or **Manage Messages** in the current channel.
- Automod configuration uses the same capability-based moderator policy as other management commands: owner, **Manage Server**, **Kick Members**, **Ban Members**, **Timeout Members**, or **Manage Messages** in the current channel. Ban approvals remain stricter and require the owner, **Manage Server**, or **Ban Members**; **Manage Messages** alone cannot approve a ban.
- Manual moderation commands use exact effective permissions and refresh both the moderator and bot before acting: **Ban Members** for `/Ban`, **Kick Members** for `/Kick`, **Timeout Members** for `/Mute` and `/Automod release`, and **Manage Messages** for `/Purge-User`. An active `/AuditLog` channel is required so actor, target, reason, and outcome are durably protected.
- Role names are never trusted; access is based on Stoat's effective permissions. This shared policy covers auto-fetch management, emoji mode, restart, and audit-log configuration/testing.
- Each member can trigger up to five recognised commands in 30 seconds. Concurrent requests for the same game's codes share one upstream fetch.

### Manual moderation

Reasons are mandatory, use the literal `reason:` delimiter, and may contain up to 300 characters. Commands accept one member mention or one raw user ID. Stoat has no interaction buttons, so HoYoFetch uses reactions for duration selection, destructive confirmation, and undo.

- `/Ban @member reason: repeated spam` bans immediately. Add `delete:1h`, `delete:6h`, `delete:1d`, `delete:3d`, or `delete:7d` before `reason:` to request message cleanup. The ↩️ reaction on the protected record is available for 10 minutes to any freshly authorized ban moderator; it unbans but cannot restore membership or deleted messages.
- `/Kick @member reason: raid account` kicks immediately. Stoat cannot put a kicked member back, so no undo reaction is offered and the reason is retained in HoYoFetch's protected log.
- `/Mute @member 1h reason: cooldown` applies that duration immediately. Omitting the duration opens a two-minute invoker-only picker: 10m, 30m, 1h, 4h, 24h, 3d, or 7d. The protected record has a 10-minute ↩️ undo reaction for authorized timeout moderators.
- `/Purge-User @member window:1d reason: cleanup` shows a two-minute ✅/❌ confirmation. Only one purge runs per server at a time.
- `/Automod release @member reason: false positive` removes the native timeout, resets the member's automod strike history, and closes pending ban reviews for that containment. It can also remove a manually applied timeout.

**History cleanup limitations:** Stoat's ban API has no message-history option and its bulk-delete endpoint accepts only messages from the last seven days. HoYoFetch therefore groups message IDs recorded while audit logging was active and deletes them separately in bounded batches. Results always report selected, deleted, and failed counts and must not be read as guaranteed-complete. Protected audit entries, locally retained evidence, quotations, reactions, and external copies are never erased by a purge.

### Audit log

Stoat/Revolt has no built-in audit log, so `/AuditLog here` turns the current channel into one. `/AuditLog #channel` targets another text channel, `/AuditLog status` reports the current setting, and `/AuditLog off` disables it. The bot relays message edits/deletes (with original content), bulk deletes, channel/role/server changes, member joins/leaves, bans, unbans, timeouts, nickname/role changes, and emoji changes. The older `/Enable-AuditLog` and `/Disable-AuditLog` forms remain accepted for compatibility.

Server-setting monitoring combines live raw gateway events with a persisted REST baseline in `data/server_settings_snapshots.json`. It records detailed before/after changes for server identity and discovery settings, categories and system-message routing, channels, role and channel permission overrides, roles, emoji, invites, and webhooks. A reconciliation runs at startup and about every five minutes, so changes made while the bot was offline are detected after it returns. Webhooks require one request per channel and are scanned in bounded rotating batches; `/Test-AuditLog` reports the current baseline and webhook coverage.

Audit configuration and testing commands use the same capability-based moderator policy as other management commands: the owner, **Manage Server**, **Kick Members**, **Ban Members**, **Timeout Members**, or effective **Manage Messages** in the current channel.

To always show what was deleted or edited — Stoat only reports the _id_ of a deleted message — the bot records every message in audit-enabled servers to a local archive (`data/message_archive.jsonl`, kept **30 days**, capped at 100k messages). This survives restarts.

**Attachment evidence.** Stoat's file storage almost certainly purges an attachment the moment its message is deleted, so a saved link would 404 exactly when it's needed. Instead, the bot downloads qualifying attachments (any type, up to `AUDITLOG_EVIDENCE_MAX_MB` — default 20 MB, Stoat's own upload limit) the moment they're posted and keeps a local copy under `data/evidence/`, bounded by a hard total-size budget (`AUDITLOG_EVIDENCE_BUDGET_MB`, default 1 GB) — the oldest evidence is evicted first once the budget is full, so disk use can never exceed what you configure. When a message with saved evidence is deleted, the bot re-uploads the file and attaches it to the log entry. This means every qualifying attachment is downloaded once at post-time (a bandwidth cost), not just on deletion. Set `AUDITLOG_EVIDENCE_BUDGET_MB=0` to disable evidence capture entirely and fall back to metadata-only ("not preserved") notices.

The bot needs the **Ban Members** permission to detect bans (checked when a member leaves) and unbans (ban-list poll every ~5 minutes).

**Troubleshooting:** run `/Test-AuditLog` — it pushes a 🧪 test event through the real delivery pipeline and reports how many messages are archived plus current evidence storage usage. For verbose per-event console logging, set `AUDITLOG_DEBUG=1` in `.env`. Deletes of messages sent before audit logging was enabled are logged with "content unknown" (Stoat only transmits the message id on delete).

**Platform limitations that cannot be worked around:**

- Stoat's server, channel, role, and member update events do not include the administrator who acted. These entries explicitly say **Actor unavailable from Stoat** rather than guessing. Emoji and invite creators are shown as verified actors when their resource data supplies a creator.
- The gateway never reports **who** deleted a message. Delete entries list the author and members with effective **Manage Messages** permission as **possible deleters**, clearly labeled as a heuristic; this is not proof of who acted.
- Newer backends can label a member departure as `Leave`, `Kick`, or `Ban`. When the backend omits that reason, the bot can only report that the member left or was removed.
- Messages sent before audit logging was enabled, or while the bot was offline, can't have their content recovered.
- Invites and webhooks produce no usable gateway events, so they are detected later by REST reconciliation and only when the bot has permission to list them. Webhook tokens and usable invite codes are never persisted or logged.
- Reconciliation can prove that a setting changed while the bot was offline, but not the exact time or actor. Voice participation is not treated as a server-setting change.

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

The hoyo-codes API returns an array of `{code, rewards, date, source}`. The ennead API returns `{active: [{code, reward: [...]}], inactive: [...]}` with reward arrays. NTE is scraped from Game8's active redeem-code table and cached for one hour between outbound requests.

## 🎨 Custom Emoji Hub

You can use custom Revolt server emoji instead of Unicode emoji for reward icons (💎→ actual Primogem icon, etc.).

### How it works

1. **Create a dedicated server** on Revolt (e.g. "HoyoFetch Emoji Hub")
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
  └─ NTE ─────────→ Game8 scrape/cache ────→ normalise
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
- [revolt.js](https://github.com/revoltchat/revolt.js) — Revolt bot framework
