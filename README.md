# 🎮 HoyoFetch — HoYoverse Code Bot for Revolt / Stoat.chat

Automatically fetches and posts redemption codes for **Genshin Impact**, **Honkai: Star Rail**, **Zenless Zone Zero**, **Honkai Impact 3rd**, and **Neverness to Everness** in your Revolt server channels.

## ✨ Features

| Feature | Details |
|---------|---------|
| **5 games supported** | GI, HSR, ZZZ, HI3, and NTE |
| **Multiple sources** | [hoyo-codes.seria.moe](https://hoyo-codes.seria.moe) (GI/HSR/ZZZ), [api.ennead.cc](https://api.ennead.cc/mihoyo) (HI3), and [neverness.gg](https://neverness.gg/codes/) (NTE) |
| **Rich embeds** | Game-coloured embeds with icons, reward details, and redemption links |
| **Auto-fetch** | Hourly scan — posts only when **new** codes appear (no spam) |
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

## 📋 Commands

| Command | Description |
|---------|-------------|
| `/FetchGI` | Fetch active Genshin Impact codes |
| `/FetchHSR` | Fetch active Honkai: Star Rail codes |
| `/FetchZZZ` | Fetch active Zenless Zone Zero codes |
| `/FetchHI3` | Fetch active Honkai Impact 3rd codes |
| `/FetchNTE` | Fetch active Neverness to Everness codes |
| `/EnableFetch` | Enable auto-fetch in the current channel |
| `/DisableFetch` | Disable auto-fetch in the current channel |
| `/HelpHoyoFetch` | Show all commands |

> **Note:** Revolt does not support Discord-style slash commands. These are message-based prefix commands using `/` as the prefix. They are fully case-insensitive.

## 🔌 API Sources

| Game | API | Endpoint |
|------|-----|----------|
| Genshin Impact | hoyo-codes | `https://hoyo-codes.seria.moe/codes?game=genshin` |
| Honkai: Star Rail | hoyo-codes | `https://hoyo-codes.seria.moe/codes?game=hkrpg` |
| Zenless Zone Zero | hoyo-codes | `https://hoyo-codes.seria.moe/codes?game=nap` |
| Honkai Impact 3rd | ennead | `https://api.ennead.cc/mihoyo/honkai/codes` |
| Neverness to Everness | neverness.gg | `https://neverness.gg/codes/` |

The hoyo-codes API returns an array of `{code, rewards, date, source}`. The ennead API returns `{active: [{code, reward: [...]}], inactive: [...]}` with reward arrays. NTE is scraped from the active-code list and cached so the site is checked at most once per hour. The bot normalises these formats transparently.

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
├── api.js              Dual-source API integration (hoyo-codes + ennead)
├── embeds.js           Revolt SendableEmbed builder
├── store.js            JSON persistence (channels, known codes)
├── custom_emojis.json  Optional: custom Revolt emoji IDs
├── .env.example        Configuration template
├── package.json
└── data/               Runtime data (auto-created, gitignored)
    ├── channels.json
    └── known_codes.json
```

### Data flow

```
API poll (hourly)
  │
  ├─ GI/HSR/ZZZ ──→ hoyo-codes.seria.moe ──→ normalise
  │                                              │
  ├─ HI3 ─────────→ api.ennead.cc ─────────→ normalise
  │                                              │
  └─ NTE ─────────→ neverness.gg hourly cache → normalise
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
                 Send to all enabled channels
```

## ⚙️ Configuration

All settings are in `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `BOT_TOKEN` | _(required)_ | Revolt bot token |
| `PREFIX` | `/` | Command prefix |
| `FETCH_INTERVAL` | `60` | Auto-fetch interval in minutes |
| `HOYO_API_BASE` | `https://hoyo-codes.seria.moe/codes` | GI/HSR/ZZZ API |

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
FROM node:22-alpine
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
- [revolt.js](https://github.com/revoltchat/revolt.js) — Revolt bot framework
