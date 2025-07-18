# HoYoFetch Bot

A simple Revolt bot that fetches the latest Hoyoverse gift codes using the Hoyocode API, with both manual “force-fetch” and passive “auto-fetch” modes, plus a bunch of comical fallbacks if the API isn’t fully populated.

---

### Credits

> ⚠ This bot uses the [Hoyocode API](https://github.com/seriaati/hoyo-codes) by `seriaati/hoyo-codes` to retrieve the latest codes.

---

### Commands

- `!forceGI` — Manually fetch **all** current Genshin Impact codes (new and still-active ones).
- `!forceHSR` — Manually fetch **all** current Honkai: Star Rail codes.
- `!forceZZZ` — Manually fetch **all** current Zenless Zone Zero codes.
- `!enablefetch` — Enable **auto-fetch** for this channel (every hour).
- `!disablefetch` — Disable auto-fetch for this channel.

---

### Features

💡 **Auto-Fetch Mode**  
Enable with `!enablefetch`. Every **1 hour**, the bot will:

1. Check each supported game’s API endpoint  
2. Compare against what it’s **already posted** (per-channel, per-game)  
3. Announce **only genuinely new** codes with a fun, game-specific header.

🔔 New codes are posted with headers like:

- **there are new primogems to be redeemed! Come get em!**  
- **there are new stellar jades to be redeemed! Come get em!**  
- **fresh polychrome from the bangboo on sixth street! Come get them!**

Turn it off anytime with `!disablefetch`.

😎 **Manual “Force-Fetch”**  
Run `!forceGI`, `!forceHSR`, or `!forceZZZ` to immediately list **all** codes (new + active) for that game, with this preamble:

> After manually checking the codes for *<Game Name>*, here are the codes. This includes new codes, and some codes which aren't new but may still be active.

---

### Funny Reward Fallbacks

If the API returns an empty `rewards` field, the bot will substitute a comical guess:

- **Genshin Impact:** “I asked Paimon and she guesses primogems.”  
- **Honkai Star Rail:** “I asked Pom-Pom and it's probably stellar jade.”  
- **Zenless Zone Zero:** “I asked the Bangboo in the back alley of Sixth Street and they told me it's probably polychromes.”

---

### Notes

1. **Supported Games:**  
   - Genshin Impact  
   - Honkai: Star Rail  
   - Zenless Zone Zero  
   *(Other Hoyoverse titles are not supported due to API limitations.)*

2. **Region Coverage:**  
   Works on global servers (Asia, America, EU, TW/HK/MO).  
   *Mainland China servers (Irminsul, Celestia) are not covered.*

3. **API Delay:**  
   Hoyocode can lag ~1 hour behind the official gift page.  
   Reward strings may be empty until they update.

4. **Persistence:**  
   Per-channel “last-seen” thresholds are stored in `enabledChannels.json` (auto-created).  
   **Make sure** to add this to your `.gitignore`.

5. **Resilience:**  
   - Automatic JSON backups on corruption  
   - Numeric ID coercion + sorting to guarantee ordering  
   - Safe `sendMessage` handling (removes channels if permissions change)

6. **Downtime / Support:**  
   If the bot goes offline, contact `suichanwaa` on Revolt.

---

### Deployment

1. **Install** Node.js v16+  
2. **Clone** this repo and `cd` in:  
   ```bash
   git clone <repo-url>
   cd hoyofetch

	3.	Secrets:
	•	Set REVOLT_BOT_TOKEN in your environment or a .env file.
	4.	Ignore the data file:

enabledChannels.json


	5.	Install dependencies:

npm install


	6.	Run the bot under your process manager:
	•	PM2: pm2 start index.js --name hoyofetch --watch
	•	systemd: set up a service with Restart=always
	•	Docker: build & run, mounting your token as an env var
