---
title: Frequently asked questions
description: Answers to common questions about Irminsul's behavior, performance, and design.
---

## Why is Irminsul so fast, and why do audit logs appear almost instantly?

Irminsul is event-driven. For ordinary live activity, it listens directly to
Stoat's WebSocket gateway instead of repeatedly asking the API whether
something changed. When an event arrives, the bot can usually look up its
context, build the audit embed, and queue it for delivery immediately.

Several design choices keep that path short:

- **Fast local lookups.** Frequently used state is held in bounded in-memory
  `Map` indexes, including message context and other short-lived caches. This
  avoids a database or network round trip for each event.
- **Cheap durable history.** Message context is written to an append-only
  journal. Recording a message adds one small entry instead of rewriting the
  complete archive, while the in-memory index keeps later edit and delete
  lookups fast.
- **Ordered, bounded delivery.** Audit entries pass through a serialized send
  queue. It preserves event order and prevents bursts from hammering the API.
  The queue is capped so an unhealthy connection cannot create an unlimited
  backlog.
- **Cached context and baselines.** Irminsul reuses bounded local context and
  persisted server-setting snapshots where appropriate, avoiding unnecessary
  API requests while still reconciling state periodically.
- **Fetch once, fan out.** Automatic code checks only cover games with active
  subscriptions. Each game source is fetched once per run, then any new codes
  are sent to all subscribed channels instead of refetching the same source for
  every server.
- **Bounded background work.** Scraped sources can use a short cache, while
  archive compaction, retention, evidence cleanup, and settings reconciliation
  run on bounded schedules rather than expanding the live-event path.

The result is a typical audit flow of:

```text
gateway event → local context lookup → build embed → ordered send queue
```

:::note[Near-instant, not zero-latency]
Delivery still depends on the network and Stoat's API. Events that need
attachment recovery, fresh permission or member verification, or extra API
context may take longer. Changes made while Irminsul is offline—as well as
invites and webhooks that lack usable live gateway events—are found by periodic
reconciliation rather than posted instantly.
:::

For the wider design, see [Architecture](/HoYoFetch/administration/architecture/).
For audit coverage, retention, evidence behavior, and platform limitations, see
[Audit log](/HoYoFetch/moderation/audit-log/).
