---
title: Moderation levels
description: Dial the whole server's protection between standard, heightened, and lockdown with a single command.
---

Every other moderation feature in Irminsul is tuned for ordinary conditions. When a server is under a sustained wave, those defaults are the wrong shape — but retuning them one command at a time, mid-incident, is exactly when mistakes happen.

`/Level` is one dial for the whole posture. It is **level 1 for every server** unless changed, and `/Level 1` always stands everything back down.

```text
/Level status
/Level 1
/Level 2
/Level 3 confirm
/Level tenure 14
```

`/Level` uses the same capability-based moderator policy as `/Automod` and `/Post-Gate`: the server owner, **Manage Server**, or a recognized moderation capability (**Kick Members**, **Ban Members**, **Timeout Members**, or effective **Manage Messages** in the current channel). Level changes are recorded in the automod log channel.

## What each level does

|                                    | **1 — Standard**                      | **2 — Heightened**                        | **3 — Lockdown**                  |
| ---------------------------------- | ------------------------------------- | ----------------------------------------- | --------------------------------- |
| Post gate holds                    | links and attachments                 | **every message**                         | every message                     |
| "New account" means                | created < 7d ago                      | **< 30d ago**                             | < 30d ago                         |
| "New member" means                 | joined < 24h ago                      | **< 7d ago**                              | < 7d ago                          |
| Automod trips at                   | a behavioral signal **and** score ≥ 2 | a behavioral signal **and** score ≥ **1** | a behavioral signal and score ≥ 1 |
| Raid mode                          | 5 joins/60s, lasts 10m                | **3 joins/60s, lasts 30m**                | 3 joins/60s, lasts 30m            |
| New joins                          | observed                              | observed                                  | **kicked on sight**               |
| Members below the tenure threshold | —                                     | —                                         | **cannot post**                   |

Levels only change thresholds that `/Automod` and `/Post-Gate` already own. A level does **not** switch those features on: if the post gate is off, raising the level does not start holding anything, and if automod is off, nothing is scored.

### Level 2 — Heightened

The two changes that matter most under a wave:

- **The post gate stops caring about links.** At level 1 a new account's plain "hey everyone" passes through; only a link or attachment is held. At level 2 the first message is held whatever it contains.
- **Automod needs less corroboration.** Level 1 requires a behavioral signal plus a second point of evidence. Level 2 acts on a single signal.

What does _not_ change: the behavioral signal itself is still mandatory. Being new, or joining during a raid, cannot trigger containment at any level — it only ever adds weight to behavior Irminsul actually observed.

### Level 3 — Lockdown

Level 3 is everything in level 2 plus two enforcement actions of its own.

**Every new join is kicked.** No review, no queue, no scoring. Exempt: bots (adding one requires Manage Server) and accounts a fresh permission check confirms as moderators. If that check cannot complete, the join is **reported and not kicked** — an unverifiable account is a reason to look, not a reason to act.

**Members below the tenure threshold cannot post.** Any member who joined less than the threshold ago (default **7 days**, set with `/Level tenure <1-30>`) has their messages deleted and their automod strike raised. Privacy-excluded channels are never touched, moderators are exempt, and a member whose join date Irminsul cannot read is left alone.

A member posting repeatedly has every message deleted, but escalates **at most one strike per 15 minutes** — otherwise four messages in a row would walk them to the top of the ladder in seconds. The audit notice follows the same cooldown, so a flood produces one record rather than hundreds.

:::caution[Level 3 is disruptive by design]
Lockdown does not distinguish a raid account from someone who found your server today, and it silences legitimate members who joined last week. It is a way to stop the bleeding while you deal with a wave, not a posture to leave a server in. `/Level 1` restores everything immediately; kicked accounts are not banned and can rejoin.
:::

## The two guards on lockdown

Level 3 is the only setting in Irminsul that removes members automatically, so it has two preconditions that levels 1 and 2 do not:

1. **A typed confirmation.** `/Level 3` alone refuses and explains what it would do; only `/Level 3 confirm` applies it. Unlike `/Post-Gate` and `/AuditLog`, this does not route through Enka — a lockdown is an emergency response, and a round-trip for a one-time code is the wrong thing to need mid-raid.
2. **An automod log channel.** `/Level 3 confirm` is refused outright unless `/Automod` has one configured, because an automatic kick nobody can see afterwards is indistinguishable from the bot malfunctioning. Every kick, every withheld kick, and every restricted message is recorded there as a protected entry.

## Related

- [Anti-raid automod](/moderation/automod/) — what the score and the behavioral signals actually are
- [First-post gate](/moderation/post-gate/) — what "held" means and how review works
- [Account checks](/moderation/account-checks/) — the advisory signals on the member-join card
