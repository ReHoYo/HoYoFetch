# HoYoFetch Bot

A simple Revolt bot that fetches the latest Hoyoverse gift codes using the Hoyocode API, with both manual “force-fetch” and passive “auto-fetch” modes, plus comical fallbacks if reward details are missing.

---

### Credits

> ⚠ This bot uses the [Hoyocode API](https://github.com/seriaati/hoyo-codes) by `seriaati/hoyo-codes` to retrieve the latest codes.

---

### Commands

- `!forceGI` — Manually fetch **all** current Genshin Impact codes (new and still-active ones).
- `!forceHSR` — Manually fetch **all** current Honkai: Star Rail codes.
- `!forceZZZ` — Manually fetch **all** current Zenless Zone Zero codes.
- `!forceHI3` — Manually fetch **all** current Honkai Impact 3rd exchange rewards (from Fandom).
- `!enablefetch` — Enable **auto-fetch** for this channel (every hour).
- `!disablefetch` — Disable auto-fetch for this channel.

---

### Features

💡 **Auto-Fetch Mode**  
Enable with `!enablefetch`. Every **1 hour**, the bot will:

1. Check each supported game source (Hoyocode API + HI3 Fandom page).
2. Compare against what it’s already posted (per-channel, per-game).
3. Announce only genuinely new codes with game-specific headers.

🔔 Example headers:

- **there are new primogems to be redeemed! Come get em!**
- **there are new stellar jades to be redeemed! Come get em!**
- **fresh polychrome from the bangboo on sixth street! Come get them!**
- **captain! new HI3 exchange rewards were found!**

😎 **Manual Force-Fetch**  
Run `!forceGI`, `!forceHSR`, `!forceZZZ`, or `!forceHI3` to immediately list current codes/rewards for that game.

---

### Funny Reward Fallbacks

If the API returns an empty `rewards` field, the bot substitutes a comical guess:

- **Genshin Impact:** “I asked Paimon and she guesses primogems.”
- **Honkai Star Rail:** “I asked Pom-Pom and it's probably stellar jade.”
- **Zenless Zone Zero:** “I asked the Bangboo in the back alley of Sixth Street and they told me it's probably polychromes.”

---

### Notes

1. **Supported Games:**
   - Genshin Impact
   - Honkai: Star Rail
   - Zenless Zone Zero
   - Honkai Impact 3rd (exchange reward table from the Fandom wiki)

2. **Region Coverage:**
   Works on global servers (Asia, America, EU, TW/HK/MO). Mainland China servers (Irminsul, Celestia) are not covered.

3. **API / Source Delay:**
   Hoyocode can lag around 1 hour behind official pages. HI3 codes are scraped from the Fandom exchange rewards page and depend on how quickly that page is updated.

4. **Persistence:**
   Per-channel thresholds are stored in `enabledChannels.json` and pending reward-detail retries in `pendingDetails.json`.

5. **Resilience:**
   - Automatic JSON backups on corruption
   - Numeric ID coercion + sorting to guarantee ordering
   - Safe `sendMessage` handling (removes channels if permissions change)

6. **Downtime / Support:**
   If the bot goes offline, contact `suichanwaa` on Revolt.

---

### Deployment

1. Install Node.js v16+
2. Clone this repo and `cd` in:
   ```bash
   git clone <repo-url>
   cd hoyofetch
   ```
3. Set `REVOLT_BOT_TOKEN` in your environment or in a `.env` file.
4. Add `enabledChannels.json` and `pendingDetails.json` to `.gitignore`.
5. Install dependencies:
   ```bash
   npm install
   ```

   This project uses `cheerio` to parse the HI3 exchange rewards table.

6. Run the bot with your process manager:
   - PM2: `pm2 start index.js --name hoyofetch --watch`
   - systemd: service with `Restart=always`
   - Docker: run with your token passed as an environment variable
