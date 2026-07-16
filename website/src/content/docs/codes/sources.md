---
title: Code sources
description: The external sources Irminsul checks for each supported game.
---

| Game                  | Primary source                                                        | Behavior                                         |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| Genshin Impact        | [hoyo-codes](https://hoyo-codes.seria.moe)                            | JSON API                                         |
| Honkai: Star Rail     | [hoyo-codes](https://hoyo-codes.seria.moe)                            | JSON API                                         |
| Zenless Zone Zero     | [hoyo-codes](https://hoyo-codes.seria.moe)                            | JSON API                                         |
| Honkai Impact 3rd     | [ennead API](https://api.ennead.cc/mihoyo/honkai/codes)               | JSON API with a wiki fallback                    |
| Neverness to Everness | [Game8](https://game8.co/games/Neverness-to-Everness/archives/593718) | Active-code table parsed and cached for one hour |

Irminsul normalizes the different source formats into a shared code model before building embeds. Source attribution remains visible in every result.

## Availability

These are community-operated or third-party sources. A temporary source failure can delay fresh results. NTE can serve its last successful cached response when a refresh fails; an installation with no usable response or cache reports the failure instead of inventing codes.

## Redemption

- Genshin Impact, HSR, and ZZZ results include official web redemption links.
- HI3 and NTE codes must be redeemed from inside the game.
