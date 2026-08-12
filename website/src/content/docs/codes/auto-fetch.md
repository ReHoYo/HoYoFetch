---
title: Auto-fetch
description: Configure automatic code announcements without replaying old or duplicate codes.
---

Irminsul checks its sources on a fixed interval and posts only codes that are new to the installation. The default interval is 60 minutes.

## Choose a feed

Run `/Auto-Fetch enable` with the desired scope in the destination channel:

| Command                              | Feed                              |
| ------------------------------------ | --------------------------------- |
| `/Auto-Fetch enable` or `enable all` | HoYoverse games, NTE, and WuWa    |
| `/Auto-Fetch enable hoyo`            | Genshin Impact, HSR, ZZZ, and HI3 |
| `/Auto-Fetch enable nte`             | NTE only                          |
| `/Auto-Fetch enable wuwa`            | WuWa only                         |
| `/Auto-Fetch enable nte-wuwa`        | NTE and WuWa                      |

Running the command with a different scope updates the channel's existing subscription. `/Auto-Fetch status` reports the current channel, and `/Auto-Fetch off` removes its subscription. Invalid or extra arguments are rejected.

## What gets posted

Each announcement includes:

- the code;
- parsed reward details when the source provides them;
- a direct redemption link for Genshin Impact, HSR, and ZZZ;
- in-game redemption guidance for HI3, NTE, and WuWa; and
- source attribution.

## Duplicate protection

Known codes are persisted locally. When the bot first starts, it records currently visible codes without announcing them. Later scans compare normalized code identities and stay silent when nothing is new.

NTE and WuWa identities are compared case-insensitively because Game8 can vary capitalization.

Existing `all`, `hoyo`, and `nte` subscriptions remain valid. The all-games feed now includes WuWa, but startup seeding records currently visible WuWa codes before scheduled announcements so deployment does not replay them as new.

## Manual requests

`/FetchGI`, `/FetchHSR`, `/FetchZZZ`, `/FetchHI3`, `/FetchNTE`, and `/FetchWuWa` return the active list on demand. A per-channel cooldown limits repeated manual requests, and concurrent requests for the same game share one upstream operation.

Operators can tune the scan interval and manual cooldown in [Configuration](/HoYoFetch/administration/configuration/).
