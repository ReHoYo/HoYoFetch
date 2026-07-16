---
title: Configuration
description: Environment variables for code fetching, emoji, audit diagnostics, and attachment evidence.
---

Copy `.env.example` to `.env` and provide the bot token. Never commit `.env`.

| Variable                      | Default             | Purpose                                                          |
| ----------------------------- | ------------------- | ---------------------------------------------------------------- |
| `BOT_TOKEN`                   | Required            | Revolt bot token                                                 |
| `PREFIX`                      | `/`                 | Message-command prefix                                           |
| `FETCH_INTERVAL`              | `60`                | Auto-fetch interval in minutes, clamped to a safe range          |
| `FETCH_COOLDOWN`              | `10`                | Minimum seconds between manual fetches per channel; `0` disables |
| `EMOJI_MODE`                  | `unicode`           | Initial `unicode` or `custom` reward-emoji mode                  |
| `AUDITLOG_DEBUG`              | Off                 | Set to `1` for verbose, redacted audit pipeline diagnostics      |
| `AUDITLOG_EVIDENCE_MAX_MB`    | `20`                | Maximum preserved size for one attachment                        |
| `AUDITLOG_EVIDENCE_BUDGET_MB` | `1024`              | Total evidence budget; `0` disables capture                      |
| `HOYOFETCH_DATA_DIR`          | `./data`            | Runtime persistence directory                                    |
| `HOYO_API_BASE`               | hoyo-codes endpoint | Override for the GI, HSR, and ZZZ API base                       |

```dotenv title=".env"
BOT_TOKEN=replace_with_your_token
PREFIX=/
FETCH_INTERVAL=60
FETCH_COOLDOWN=10
EMOJI_MODE=unicode
AUDITLOG_DEBUG=
AUDITLOG_EVIDENCE_MAX_MB=20
AUDITLOG_EVIDENCE_BUDGET_MB=1024
```

:::danger[Protect the token]
The bot token grants control of the bot account. Keep it in secret storage on the host, redact it from logs, and rotate it if it is exposed.
:::

## Runtime changes

`/EmojiMode unicode` and `/EmojiMode custom` change the current process without editing `.env`. Channel subscriptions, audit configuration, automod configuration, cases, strikes, spam-report correlation metadata, protected records, and known codes are persisted locally.

## Debug logging

`AUDITLOG_DEBUG=1` adds per-event console detail while retaining redacted aliases rather than raw IDs or secrets. Disable it during routine operation unless you are diagnosing a delivery problem.
