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

Mount persistent storage for `/app/data`; otherwise channel configuration, code history, audit state, and evidence disappear when the container is replaced.

## Deploy versus restart

Updating production generally has three separate steps:

1. move the intended source revision onto the host;
2. install the locked dependencies with `npm ci`; and
3. restart the actual supervisor, service, or container.

`/Restart` performs only the third step for the current process. It does not run `git pull` or otherwise deploy source.

## Backups

Back up the configured data directory if you need continuity for subscriptions, protected records, audit baselines, automod cases, and evidence. Protect backups with the same access controls as the live data.
