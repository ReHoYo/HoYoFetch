# HoYoFetch Bot

A simple Revolt bot that fetches the latest Hoyoverse gift codes using the Hoyocode API.

---

### Credits

> ⚠ This bot uses the [Hoyocode API](https://github.com/seriaati/hoyo-codes) provided by `seriaati/hoyo-codes` to retrieve the latest codes.

---

### Commands

- `!fetchGI` — Get the latest Genshin Impact codes.
- `!fetchHSR` — Get the latest Honkai: Star Rail codes.
- `!fetchZZZ` — Get the latest Zenless Zone Zero codes.
- `!enableFetch` — Enable auto-fetching of new codes for this channel.
- `!disableFetch` — Disable auto-fetching for this channel.

---

### Features

💡 **Auto-Fetch Mode**  
You can enable a passive listener in your channel using `!enableFetch`.  
Every 2 hours, the bot will check for **new** codes and automatically announce them in the channel.

🔔 New codes will be posted with personalized headers like:

- `**Genshin Impact: there are new primogems to be redeemed! Come get em!**`
- `**Honkai Star Rail: there are new stellar jades to be redeemed! Come get em!**`
- `**Zenless Zone Zero: there are new polychromes to be redeemed! Come get em!**`

This ensures you never miss a drop, even without manually running commands.

📴 You can turn this off anytime using `!disableFetch`.

---

### Notes

1️⃣ **Game Coverage:**  
Currently supports Genshin Impact, Honkai: Star Rail, and Zenless Zone Zero.  
_Tears of Themis and Honkai Impact 3 are not supported due to API limitations._

2️⃣ **Server Compatibility:**  
The bot only works for Global servers (Asia, America, EU, and HW/TW/MO servers).  
⚠ Mainland China servers (Irminsul, Celestia) are not supported.

3️⃣ **Code Update Timing:**  
The bot uses the Hoyocode API, so there may be a short delay before new codes appear depending on when the API updates.

4️⃣ **Funny Reward Messages:**  
Sometimes you may see messages like:  
> “We asked Paimon and she replied that it's probably primogems.”  
This simply means the API found a code but didn't provide reward details. The code is still valid and redeemable.

5️⃣ **Downtime / Support:**  
If the bot goes offline, please contact `suichanwaa` (on revolt). The VPS running it probably crashed or went down.

---

### Deployment

1. Install Node.js (v16 or higher)
2. Install dependencies:  
```bash
npm install
