---
title: Server diagnostics
description: Read the local server, archive, feature-health, runtime, and safe VPS snapshot from Irminsul.
---

Recognized administrators and moderators can inspect the current installation without opening a shell:

```text
/Server-Info
```

The response separates values belonging to the current Stoat server from installation-wide VPS values. It includes cached server inventory, the bot's cached join date, retained archive coverage, auto-fetch and moderation-feature configuration, audit delivery and settings-monitor health, software versions, process and VPS uptime, memory, disk utilization, and normalized one-minute load.

## Local-only snapshot

`/Server-Info` uses only cached Stoat objects and local process state. It makes no live API requests, so running it does not consume a Stoat rate limit or actively test an external dependency. A missing cache entry or unsupported system probe is reported as unavailable rather than guessed.

The three time measurements have deliberately different meanings:

- **Bot joined** is the cached date when this bot account joined the current server.
- **Bot uptime** is the age of the current process and resets whenever the bot restarts.
- **VPS uptime** is the host operating-system uptime and resets whenever the VPS reboots.

Archive coverage begins at the earliest message currently retained for this server. It is not an installation date and advances as messages pass the retention window.

## Information boundary

Aggregate runtime statistics are installation-wide and are labelled accordingly. The command never displays the VPS hostname, IP addresses, filesystem paths, environment values, or secrets. Access uses the same recognized admin/moderator policy as other setup diagnostics.
