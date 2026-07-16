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
- Account younger than 7 days or membership younger than 24 hours: **1 point**
- Joined during heightened raid mode: **1 point**

Five joins within 60 seconds activate heightened weighting for ten minutes and create a warning. A join surge alone never changes a member. Bots, webhooks, the server owner, and verified moderation staff are excluded.

## Containment ladder

Successful enforcement advances a persistent ladder:

```text
10 minutes → 1 hour → 24 hours → 7 days
```

Further triggers remain capped at seven days. The ladder resets after 14 quiet days. Activity while the same timeout is active extends containment without creating another strike or approval prompt.

## Permanent bans require people

Permanent bans are never automatic. A contained case opens a separate ten-minute approval window. Production defaults to two distinct authorized staff approvals, using 🔨 or:

```text
/Automod approve CASE_ID
```

Use `/Automod quorum 1` only for a single-moderator sandbox and restore quorum two before production.

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
