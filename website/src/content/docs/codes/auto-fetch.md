---
title: Auto-fetch
description: Configure automatic code announcements without replaying old or duplicate codes.
---

Irminsul checks its sources on a fixed interval and posts only codes that are new to the installation. The default interval is 60 minutes.

## Choose a feed

Run one of these commands in the destination channel:

| Command            | Feed                              |
| ------------------ | --------------------------------- |
| `/EnableFetch`     | HoYoverse games and NTE           |
| `/EnableFetchHoyo` | Genshin Impact, HSR, ZZZ, and HI3 |
| `/EnableFetchNTE`  | NTE only                          |

Running a different enable command updates the channel's existing scope. Run `/DisableFetch` in that channel to remove it.

## What gets posted

Each announcement includes:

- the code;
- parsed reward details when the source provides them;
- a direct redemption link for Genshin Impact, HSR, and ZZZ;
- in-game redemption guidance for HI3 and NTE; and
- source attribution.

## Duplicate protection

Known codes are persisted locally. When the bot first starts, it records currently visible codes without announcing them. Later scans compare normalized code identities and stay silent when nothing is new.

NTE identities are compared case-insensitively because the Game8 source can vary capitalization.

## Manual requests

`/FetchGI`, `/FetchHSR`, `/FetchZZZ`, `/FetchHI3`, and `/FetchNTE` return the active list on demand. A per-channel cooldown limits repeated manual requests, and concurrent requests for the same game share one upstream operation.

Operators can tune the scan interval and manual cooldown in [Configuration](/HoYoFetch/administration/configuration/).
