# 🎮 HoyoFetch — HoYoverse Code Bot for Revolt / Stoat.chat

Automatically fetches and posts redemption codes for **Genshin Impact**, **Honkai: Star Rail**, **Zenless Zone Zero**, **Honkai Impact 3rd**, and **Neverness to Everness** in your Revolt server channels.

## ✨ Features

| Feature | Details |
|---------|---------|
| **5 games supported** | GI, HSR, ZZZ, HI3, and NTE |
| **Multiple code sources** | [hoyo-codes.seria.moe](https://hoyo-codes.seria.moe) (GI/HSR/ZZZ), [api.ennead.cc](https://api.ennead.cc/mihoyo) (HI3), and [Game8](https://game8.co/games/Neverness-to-Everness/archives/593718) (NTE) |
| **Rich embeds** | Game-coloured embeds with icons, reward details, and redemption links |
| **Auto-fetch** | Hourly scan — posts only when **new** codes appear (no spam) |
| **Audit log** | Stoat has no native audit log — `/Enable-AuditLog` relays server actions (deletes, edits, joins/leaves, bans, role/channel changes) to a channel of your choice |
| **Custom emoji** | Optional: use your own Revolt emoji hub server for game-themed icons |
| **Case-insensitive** | `/fetchgi`, `/FETCHGI`, `/FetchGI` all work |
| **Zero external deps** | Only `revolt.js` + `node-fetch`; no database needed |

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

| Command | Description |
|---------|-------------|
| `/FetchGI` | Fetch active Genshin Impact codes |
| `/FetchHSR` | Fetch active Honkai: Star Rail codes |
| `/FetchZZZ` | Fetch active Zenless Zone Zero codes |
| `/FetchHI3` | Fetch active Honkai Impact 3rd codes |
| `/FetchNTE` | Fetch active Neverness to Everness codes |
| `/EnableFetch` | Enable HoYoverse + NTE auto-fetch in the current channel (admins/mods only) |
| `/EnableFetchHoyo` | Enable HoYoverse-only auto-fetch in the current channel (admins/mods only) |
| `/EnableFetchNTE` | Enable NTE-only auto-fetch in the current channel (admins/mods only) |
| `/DisableFetch` | Disable auto-fetch in the current channel (admins/mods only) |
| `/EmojiMode [unicode\|custom]` | Show or switch reward-emoji rendering at runtime (owner/admin only) |
| `/Restart` | Restart the bot after deploying updates (owner/admin only) |
| `/Enable-AuditLog` | Post a live audit log of server actions to the current channel (admins/mods only) |
| `/Disable-AuditLog` | Turn off audit logging for the server (admins/mods only) |
| `/Test-AuditLog` | Send a test event through the audit pipeline to verify delivery (admins/mods only) |
| `/HelpHoyoFetch` | Show all commands |

> **Note:** Revolt does not support Discord-style slash commands. These are message-based prefix commands using `/` as the prefix. They are fully case-insensitive.

### Command security

- Commands are accepted only from human members in server channels. Direct messages, webhooks, and messages from other bots are ignored.
- Server owners and members with **Manage Server** permission are treated as administrators.
- A moderator can manage auto-fetch when they have **Kick Members**, **Ban Members**, **Timeout Members**, or **Manage Messages** in the current channel. Role names are not trusted; Stoat's effective permissions are used.
- `/Restart` is restricted to the server owner and members with **Manage Server** permission.
- Each member can trigger up to five recognised commands in 30 seconds. Concurrent requests for the same game's codes share one upstream fetch.

### Audit log

Stoat/Revolt has no built-in audit log, so `/Enable-AuditLog` turns the current channel into one: the bot relays message edits/deletes (with original content), bulk deletes, channel/role/server changes, member joins/leaves, bans, unbans, timeouts, nickname/role changes, and emoji changes.

To always show what was deleted or edited — Stoat only reports the *id* of a deleted message — the bot records every message in audit-enabled servers to a local archive (`data/message_archive.jsonl`, kept **30 days**, capped at 100k messages). This survives restarts.

The bot needs the **Ban Members** permission to detect bans (checked when a member leaves) and unbans (ban-list poll every ~5 minutes).

**Troubleshooting:** run `/Test-AuditLog` — it pushes a 🧪 test event through the real delivery pipeline and reports how many messages are archived. For verbose per-event console logging, set `AUDITLOG_DEBUG=1` in `.env`. Deletes of messages sent before audit logging was enabled are logged with "content unknown" (Stoat only transmits the message id on delete).

**Platform limitations that cannot be worked around:**

- The gateway never reports **who** deleted/edited a message or changed a channel/role — only the change itself is logged.
- A kick is indistinguishable from a voluntary leave.
- Messages sent before audit logging was enabled, or while the bot was offline, can't have their content recovered.
- Invites, webhooks, permission-override details, and voice actions produce no usable gateway events.

## 🔌 API Sources

| Game | API | Endpoint |
|------|-----|----------|
| Genshin Impact | hoyo-codes | `https://hoyo-codes.seria.moe/codes?game=genshin` |
| Honkai: Star Rail | hoyo-codes | `https://hoyo-codes.seria.moe/codes?game=hkrpg` |
| Zenless Zone Zero | hoyo-codes | `https://hoyo-codes.seria.moe/codes?game=nap` |
| Honkai Impact 3rd | ennead | `https://api.ennead.cc/mihoyo/honkai/codes` |
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
├── config.js           Game definitions, API config, custom emoji loader
├── api.js              Code source integration (hoyo-codes + ennead + Game8)
├── embeds.js           Revolt SendableEmbed builder
├── store.js            JSON persistence (channels, known codes)
├── custom_emojis.json  Optional: custom Revolt emoji IDs
├── .env.example        Configuration template
├── package.json
└── data/               Runtime data (auto-created, gitignored)
    ├── channels.json
    ├── known_codes.json
    └── source_cache.json
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

| Variable | Default | Description |
|----------|---------|-------------|
| `BOT_TOKEN` | _(required)_ | Revolt bot token |
| `PREFIX` | `/` | Command prefix |
| `FETCH_INTERVAL` | `60` | Auto-fetch interval in minutes |
| `FETCH_COOLDOWN` | `10` | Min seconds between manual `/Fetch*` commands per channel (`0` disables) |
| `EMOJI_MODE` | `unicode` | Initial emoji mode (`unicode` or `custom`); switchable at runtime via `/EmojiMode` |
| `HOYO_API_BASE` | `https://hoyo-codes.seria.moe/codes` | GI/HSR/ZZZ API |
| `HOYOFETCH_DATA_DIR` | `./data` | Where `channels.json` / `known_codes.json` / `source_cache.json` are stored |

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
