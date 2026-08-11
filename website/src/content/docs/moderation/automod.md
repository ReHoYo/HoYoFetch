---
title: Anti-raid automod
description: Safely introduce monitor and enforcement modes, understand detection signals, containment, and staff-approved bans.
---

Automod is **off by default for every server**. Begin in monitor mode and review real cases before allowing containment.

## Modes

| Mode    | Behavior                                                                                |
| ------- | --------------------------------------------------------------------------------------- |
| Off     | No anti-raid evaluation                                                                 |
| Monitor | Runs the detector and writes protected cases without changing messages or members       |
| Enforce | May time out a member and clean triggering messages after fresh permission verification |

```text
/Automod status
/Automod monitor here
/Automod enforce here
/Automod off
```

## Detection score

A case opens at two points when at least one message-behavior signal is present:

- 5 messages within 5 seconds: **1 point**
- 4 normalized duplicates within 10 seconds: **2 points**
- 5 unique mentions within 10 seconds: **2 points**
- Recent identity under the effective server policy: **1 point**

At Level 1, recent identity means an account under 7 days or membership under 24 hours. At Level 2, it widens to an account under 14 days or membership under 3 days. The score threshold remains 2 at both levels, a behavioral signal remains mandatory, and the shared raid state itself adds no point.

Five unique non-bot joins within 60 seconds activate [Shared Raid Mode](/HoYoFetch/moderation/post-gate/#shared-raid-mode) for 30 minutes when either Automod or Post Gate is enabled. The effective Level 2 policy survives restarts and is also consumed by Automod when Post Gate is off. A join surge alone never opens a case or changes a member. Bots and webhooks are excluded from message evaluation; the server owner and freshly verified moderation staff are exempt from cases.

## Containment strike stages

Automod detections and rejected [held first posts](/HoYoFetch/moderation/post-gate/) advance the same persistent level. Their immediate effects differ:

| Stored stage after the event | Direct automod trigger                                            | Post-gate rejection                   | Next direct automod trigger |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------- | --------------------------- |
| Stage 1                      | 10-minute timeout in enforce mode; projected only in monitor mode | No timeout                            | Stage 2 (1 hour)            |
| Stage 2                      | 1-hour timeout in enforce mode; projected only in monitor mode    | No timeout                            | Stage 3 (24 hours)          |
| Stage 3                      | 24-hour timeout in enforce mode; projected only in monitor mode   | No timeout                            | Stage 4 (7 days)            |
| Stage 4                      | 7-day timeout in enforce mode; projected only in monitor mode     | No timeout; remains capped at stage 4 | Stage 4 (7 days)            |

The first stage-advancing event after a reset reaches stage 1 and refreshes the 14-day quiet-reset clock. Approval, expiry, and the act of holding a post do not change the stage. Activity while the same timeout is active extends containment without advancing the stage or opening another approval prompt.

## Permanent bans require people

Automod case bans are never automatic. A contained case opens a separate ten-minute approval window. Production defaults to two distinct authorized staff approvals, using 🔨 or:

```text
/Automod approve CASE_ID
```

Use `/Automod quorum 1` only for a single-moderator sandbox and restore quorum two before production.

This is separate from server-wide `/Level 4`, which is explicitly armed by a moderator and automatically bans non-exempt authors whose messages reach Irminsul through the lockdown permission barrier.

## Recommended rollout

1. Enable monitor mode in a sandbox logger.
2. Trigger a recent-join test case and confirm no moderation occurs.
3. Confirm an established account sending five unique messages does not get contained.
4. Enable enforcement and test duplicate or recent-join flooding.
5. Verify behavior when Timeout Members, Manage Messages, and Ban Members are missing.
6. Keep production in monitor mode for 48 hours, review false positives, confirm quorum two, then consider enforcement.

:::note[Permission refresh failure]
If fresh authorization cannot be verified, an enforcement trigger is downgraded to monitor-only.
:::
