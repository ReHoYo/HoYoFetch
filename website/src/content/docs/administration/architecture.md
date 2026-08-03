---
title: Architecture
description: How Irminsul routes commands, fetches codes, persists state, and protects moderation evidence.
---

Irminsul is an event-driven Node.js bot built on `revolt.js`. It uses local files for bounded persistence and keeps external dependencies deliberately small.

The codebase retains **HoYoFetch** as its internal repository and package name for compatibility; user-facing documentation and help use **Irminsul**.

## Main modules

| Module                 | Responsibility                                                        |
| ---------------------- | --------------------------------------------------------------------- |
| `bot.js`               | Client startup, command routing, handlers, and auto-fetch scheduling  |
| `command-catalog.js`   | Shared public command metadata for in-chat and website documentation  |
| `config.js`            | Environment settings, game definitions, and emoji maps                |
| `api.js`               | Source requests, parsing, normalization, and reward formatting        |
| `store.js`             | Atomic local JSON persistence                                         |
| `security.js`          | Command authorization, permission refresh, rate limits, and redaction |
| `moderation.js`        | Ban, kick, timeout, purge, confirmation, and undo workflows           |
| `automod.js`           | Detection windows, containment ladder, and staff approvals            |
| `spam-report.js`       | Secure member-report intake, correlation, and abuse limits            |
| `auditlog.js`          | Message, member, and server event pipeline                            |
| `settings-monitor.js`  | Persisted REST baselines and offline-change reconciliation            |
| `message-archive.js`   | Bounded message journal for edit/delete context                       |
| `evidence-store.js`    | Bounded attachment preservation                                       |
| `tamper-protection.js` | Protected-message tracking, restore, backoff, and reconciliation      |

## Code announcement flow

```text
scheduled or manual request
        ↓
select game source
        ↓
fetch / parse / normalize
        ↓
compare known code identities
        ↓
build source-attributed embed
        ↓
send to the requesting or subscribed channel
```

Only scheduled announcements apply new-code filtering. Manual fetch commands return the current active list.

## Command safety flow

```text
server message → recognize command → rate-limit actor
       ↓
determine required capability
       ↓
authorize cached context
       ↓ when needed
refresh server, member, and channel permissions
       ↓
validate arguments and hierarchy
       ↓
perform action → write protected outcome
```

Failure at an authorization or validation boundary stops the mutation.

## Audit durability flow

Live events are combined with local message metadata and persistent server-setting baselines. A two-worker, 50-message attachment queue copies qualifying media through RAM into protected Stoat Logger cards before the local journal records their stable record IDs. Delete and edit events wait for an in-flight copy, then reference the Logger card without moving bytes again.

Protected sends store their wire payload. Attachment-bearing records also store a metadata-only restoration payload: raw deletion events and periodic verification can restore the record without replaying invalid one-use file IDs. Bounded retry backoff prevents hot failure loops.
