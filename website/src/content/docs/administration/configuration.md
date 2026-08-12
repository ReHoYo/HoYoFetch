---
title: Configuration
description: Environment variables for code fetching, emergency controls, emoji, audit diagnostics, and Stoat-hosted attachment archiving.
---

Copy `.env.example` to `.env` and provide the bot token. Never commit `.env`.

| Variable                        | Default                 | Purpose                                                                        |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `BOT_TOKEN`                     | Required                | Revolt bot token                                                               |
| `EMERGENCY_SERVER_ID`           | Emergency CLI only      | Server controlled by the VPS-only default Send Messages lock                   |
| `STOAT_API_BASE`                | Stoat production API    | REST endpoint used by the VPS-only emergency command                           |
| `PREFIX`                        | `/`                     | Message-command prefix                                                         |
| `FETCH_INTERVAL`                | `60`                    | Auto-fetch interval in minutes, clamped to a safe range                        |
| `FETCH_COOLDOWN`                | `10`                    | Minimum seconds between manual fetches per channel; `0` disables               |
| `EMOJI_MODE`                    | `unicode`               | Initial `unicode` or `custom` reward-emoji mode                                |
| `EMOJI_HUB_SERVER_ID`           | Irminsul's in-house hub | Server Irminsul auto-provisions reward icons onto (needs Manage Customisation) |
| `AUDITLOG_DEBUG`                | Off                     | Set to `1` for verbose, redacted audit pipeline diagnostics                    |
| `AUDITLOG_EVIDENCE_MAX_MB`      | `20`                    | Maximum Stoat-mirrored size; `0` disables attachment archiving                 |
| `POST_GATE_HOLD_REMINDER_HOURS` | `24`                    | Hours before moderators are reminded a Post Gate hold still stands (1–168)     |
| `HOYOFETCH_DATA_DIR`            | `./data`                | Runtime persistence directory                                                  |
| `HOYO_API_BASE`                 | hoyo-codes endpoint     | Override for the GI, HSR, and ZZZ API base                                     |

```dotenv title=".env"
BOT_TOKEN=replace_with_your_token
EMERGENCY_SERVER_ID=replace_with_server_id
STOAT_API_BASE=https://api.stoat.chat
PREFIX=/
FETCH_INTERVAL=60
FETCH_COOLDOWN=10
EMOJI_MODE=unicode
EMOJI_HUB_SERVER_ID=
AUDITLOG_DEBUG=
AUDITLOG_EVIDENCE_MAX_MB=20
POST_GATE_HOLD_REMINDER_HOURS=24
```

`AUDITLOG_EVIDENCE_BUDGET_MB` has been removed. Delete it from existing `.env` files; only the current per-file cap is supported.

:::danger[Protect the token]
The bot token grants control of the bot account. Keep it in secret storage on the host, redact it from logs, and rotate it if it is exposed.
:::

## Runtime changes

`/Emoji mode unicode` and `/Emoji mode custom` change the current process without editing `.env`. `/Emoji provision`, run in the configured `EMOJI_HUB_SERVER_ID` server, auto-provisions the custom emoji `/Emoji mode custom` then renders — see [Custom emoji](/HoYoFetch/codes/custom-emoji/). Channel subscriptions, audit configuration, Post Gate Protection configuration, cases, strikes, spam-report correlation metadata, protected records, known codes, and the provisioned emoji registry are persisted locally.

## Debug logging

`AUDITLOG_DEBUG=1` adds per-event console detail while retaining redacted aliases rather than raw IDs or secrets. Disable it during routine operation unless you are diagnosing a delivery problem.

## Sensitive-action approver

This in-house deployment sends `/AuditLog` destination and privacy approval codes exclusively to **Enka#4961**. The approver is pinned in the application and has no environment-variable override. If Irminsul cannot open or send the DM, the request fails closed: audit configuration and privacy exclusions remain unchanged.
