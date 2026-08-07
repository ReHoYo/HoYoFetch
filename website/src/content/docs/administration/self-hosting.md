---
title: Self-hosting
description: Install, run, test, and deploy an Irminsul instance under a process supervisor.
---

Irminsul requires Node.js 18 or newer and a Revolt bot token.

The public bot name is **Irminsul**. The repository, npm package, process examples, and `HOYOFETCH_*` compatibility keys retain the internal HoYoFetch name.

## Install

```bash
git clone https://github.com/ReHoYo/HoYoFetch.git
cd HoYoFetch
npm ci
cp .env.example .env
```

Edit `.env`, provide `BOT_TOKEN`, then start the bot:

```bash
npm start
```

On its first successful connection, the bot seeds existing codes so they are not announced as new.

## Validate an update

```bash
npm ci
npm run lint
npm test
```

Tests do not require live network access. The repository's continuous integration runs lint and the test suite across supported Node versions.

## Run with PM2

```bash
npm install -g pm2
pm2 start bot.js --name hoyofetch
pm2 save
pm2 startup
```

Use the exact command printed by `pm2 startup` to register the service for the current host.

## Run with Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "bot.js"]
```

```bash
docker build -t hoyofetch .
docker run -d --name hoyofetch --restart unless-stopped \
  --env-file .env \
  -v hoyofetch-data:/app/data \
  hoyofetch
```

Mount persistent storage for `/app/data`; otherwise channel configuration, code history, message metadata, protected-record references, and audit state disappear when the container is replaced. Attachment bytes live on Stoat, not in this volume.

## VPS-only emergency lock

When Stoat is too unstable to deliver an in-server `/Level` command, an operator
with access to the trusted host can directly disable the server default role's
Send Messages permission:

```bash
npm run emergency:status
npm run emergency:lock
npm run emergency:unlock
```

For the Docker example above, run the same scripts inside the bot container,
for example `docker exec hoyofetch npm run emergency:lock`, so the command sees
the container's environment and persistent `/app/data` volume.

Set `EMERGENCY_SERVER_ID` in `.env` first. The command reuses `BOT_TOKEN` for
direct REST calls and does not open a gateway connection, HTTP server, or other
remote control surface. Transient outages and rate limits retry until the live
server state verifies the requested change; invalid credentials, a wrong server
ID, and missing permission-management access fail immediately.

The recovery record is written before the permission changes and remains in the
persistent data directory. `unlock` restores Send Messages only if this tool
originally removed it, preserves every unrelated permission bit, and refuses to
run while `/Level 3` or `/Level 4` remains active. If Send Messages was already
disabled, `lock` reports that fact without claiming restoration ownership.

:::caution[Default role only]
This is the same default-role permission barrier used by Irminsul's normal
lockdown. The server owner and accounts or webhooks with explicit role/channel
allows can still send. The emergency CLI itself is protected by host access and
filesystem permissions, so keep the repository, `.env`, and data volume limited
to the VPS owner or bot service account.
:::

## Deploy versus restart

Updating production generally has three separate steps:

1. move the intended source revision onto the host;
2. install the locked dependencies with `npm ci`; and
3. restart the actual supervisor, service, or container.

`/Restart` performs only the third step for the current process. It does not run `git pull` or otherwise deploy source.

## Backups

Back up the configured data directory if you need continuity for subscriptions, protected records, audit baselines, automod cases, spam-report correlation, message content, and attachment metadata. Protect backups with the same access controls as the live data.

The first upgraded startup removes direct regular files from the former `data/evidence/` cache. It cannot remove copies already present in VPS snapshots, backup archives, or separately copied data directories; operators must clean those locations according to their retention policy.
