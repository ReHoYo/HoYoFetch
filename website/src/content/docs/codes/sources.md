---
title: Code sources
description: The external sources Irminsul checks for each supported game.
---

| Game                  | Primary source                                                        | Behavior                                                         |
| --------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Genshin Impact        | [hoyo-codes](https://hoyo-codes.seria.moe)                            | JSON API                                                         |
| Honkai: Star Rail     | [hoyo-codes](https://hoyo-codes.seria.moe)                            | JSON API                                                         |
| Zenless Zone Zero     | [hoyo-codes](https://hoyo-codes.seria.moe)                            | JSON API                                                         |
| Honkai Impact 3rd     | [ennead API](https://api.ennead.cc/mihoyo/honkai/codes)               | JSON API with a wiki fallback                                    |
| Neverness to Everness | [Game8](https://game8.co/games/Neverness-to-Everness/archives/593718) | Active-code table parsed and independently cached for one hour   |
| Wuthering Waves       | [Game8](https://game8.co/games/Wuthering-Waves/archives/453149)       | All active promotional and permanent tables parsed; one-hour cache |

Irminsul normalizes the different source formats into a shared code model before building embeds. Source attribution remains visible in every result.

## Availability

These are community-operated or third-party sources. A temporary source failure can delay fresh results. NTE and WuWa maintain separate caches and can each serve their last successful response when a refresh fails. An installation with no usable response or cache reports the failure instead of inventing codes.

WuWa's Game8 page can place limited-time collaborations or livestream codes in separate tables above the permanent “All Active Codes” table. Irminsul combines every table in the active section, deduplicates code identities case-insensitively, and stops before the redemption and expired-code sections.

## Redemption

- Genshin Impact, HSR, and ZZZ results include official web redemption links.
- HI3, NTE, and WuWa codes must be redeemed from inside the game.
- For WuWa, open **Settings → Other Settings → Redemption Code**.
