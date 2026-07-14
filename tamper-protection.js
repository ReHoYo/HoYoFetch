// tamper-protection.js — persistent, always-on restoration for audit messages
// ────────────────────────────────────────────────────────────────────────────
// The revolt.js high-level messageDelete events are cache-dependent. This
// coordinator therefore listens to the raw gateway stream, while a bounded
// HTTP reconciliation sweep covers deletes that happen while the bot is
// offline. All state remains in store.js so existing protected_messages.json
// files continue to work without migration.
import { buildRestoredEmbed, buildTamperNotice } from "./embeds.js";
import {
  addProtectedMessage,
  computeBackoffMs,
  getAllProtectedMessages,
  getProtectedMessageByMessageId,
  markChannelMissing,
  removeProtectedMessage,
  selectDueRecords,
  updateProtectedMessage,
} from "./store.js";
import { auditAlias, isSafeId, safeErrorSummary } from "./security.js";

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_SWEEP_BUDGET = 40;
const DEFAULT_RESTORE_FLOOR_MS = 1_500;

const DEFAULT_STORE = Object.freeze({
  addProtectedMessage,
  computeBackoffMs,
  getAllProtectedMessages,
  getProtectedMessageByMessageId,
  markChannelMissing,
  removeProtectedMessage,
  selectDueRecords,
  updateProtectedMessage,
});

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function channelIdFrom(channel) {
  return typeof channel === "string" ? channel : channel?.id;
}

/**
 * Build and bind one tamper-protection runtime.
 *
 * @param {Object} client revolt.js client; only raw events are authoritative
 * @param {Object} options injected runtime dependencies
 * @return {{sendProtected: Function, handleRawEvent: Function,
 *          sweepNow: Function, start: Function,
 *          runIntentionalDelete: Function, untrack: Function}}
 */
export function createTamperProtection(
  client,
  {
    send,
    request,
    store = DEFAULT_STORE,
    logger = console,
    now = Date.now,
    sleep = defaultSleep,
    scheduleTimeout = setTimeout,
    scheduleInterval = setInterval,
    restoreFloorMs = DEFAULT_RESTORE_FLOOR_MS,
    sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
    sweepBudget = DEFAULT_SWEEP_BUDGET,
  } = {}
) {
  if (typeof send !== "function") {
    throw new TypeError("Tamper protection requires a send function.");
  }
  if (typeof request !== "function") {
    throw new TypeError("Tamper protection requires a request function.");
  }

  const repostQueue = [];
  const queuedRecordIds = new Set();
  const scheduledRecordIds = new Set();
  const intentionalDeletes = new Set();
  const lastRestoredAt = new Map();
  let repostQueueRunning = false;
  let drainPromise = Promise.resolve();
  let started = false;

  function recordById(recordId) {
    return store
      .getAllProtectedMessages()
      .find((record) => record.recordId === recordId);
  }

  function logLabel(record) {
    return (
      `record=${auditAlias(record?.recordId)} ` +
      `channel=${auditAlias(record?.channelId)}`
    );
  }

  /** Send a durable message and persist its pristine payload for restoration. */
  async function sendProtected(channel, payload) {
    const channelId = channelIdFrom(channel);
    if (!isSafeId(channelId)) {
      logger.warn("tamper-protection: refusing to track an invalid channel id");
      return undefined;
    }

    // Keep the actual wire payload as the pristine source of truth. In
    // particular, embed-only sends retain Revolt's required blank content.
    const outbound = structuredClone(payload);
    if (outbound.embeds?.length && !outbound.content) outbound.content = " ";
    const trackedPayload = structuredClone(outbound);
    const result = await send(channelId, outbound);

    if (!isSafeId(result?._id)) {
      logger.warn(
        `tamper-protection: send returned no trackable message id ` +
          `channel=${auditAlias(channelId)}`
      );
      return undefined;
    }

    const record = store.addProtectedMessage(
      channelId,
      result._id,
      trackedPayload
    );
    logger.log(`🔒  Tracking protected message ${logLabel(record)}`);
    return result;
  }

  function scheduleRepost(recordId, delayMs) {
    if (scheduledRecordIds.has(recordId)) return;
    scheduledRecordIds.add(recordId);
    const timer = scheduleTimeout(
      () => {
        scheduledRecordIds.delete(recordId);
        queueRepost(recordId);
      },
      Math.max(0, delayMs)
    );
    timer?.unref?.();
  }

  function queueRepost(recordId) {
    if (queuedRecordIds.has(recordId)) return drainPromise;
    queuedRecordIds.add(recordId);
    repostQueue.push(recordId);
    if (!repostQueueRunning) {
      drainPromise = runRepostQueue();
    }
    return drainPromise;
  }

  async function runRepostQueue() {
    repostQueueRunning = true;
    try {
      while (repostQueue.length > 0) {
        const recordId = repostQueue.shift();
        try {
          await repostRecord(recordId);
        } catch (error) {
          logger.error(
            `tamper-protection: unexpected repost error ${safeErrorSummary(error)}`
          );
        } finally {
          queuedRecordIds.delete(recordId);
        }
      }
    } finally {
      repostQueueRunning = false;
    }
  }

  async function repostRecord(recordId) {
    const record = recordById(recordId);
    if (!record || record.channelMissing || !isSafeId(record.channelId)) return;

    const currentTime = now();
    if (record.nextAttemptAt && currentTime < record.nextAttemptAt) {
      scheduleRepost(recordId, record.nextAttemptAt - currentTime);
      return;
    }

    const floorRemaining =
      restoreFloorMs - (currentTime - (lastRestoredAt.get(recordId) ?? 0));
    if (floorRemaining > 0) await sleep(floorRemaining);

    const restorationCount = record.restorations + 1;
    const payload = structuredClone(record.payload);
    if (payload.embeds?.length) {
      payload.embeds = [
        buildRestoredEmbed(record.payload.embeds[0], restorationCount),
        ...record.payload.embeds.slice(1),
      ];
      // Records created by the first tamper-protection release predate wire
      // payload canonicalisation and may not include this required field.
      if (!payload.content) payload.content = " ";
    } else if (payload.content) {
      payload.content =
        `${record.payload.content}\n\n` + buildTamperNotice(restorationCount);
    }

    const response = await request(
      "POST",
      `/channels/${record.channelId}/messages`,
      payload
    );

    if (response.ok && isSafeId(response.data?._id)) {
      const restoredAt = now();
      lastRestoredAt.set(recordId, restoredAt);
      const updated = store.updateProtectedMessage(recordId, {
        messageId: response.data._id,
        restorations: restorationCount,
        lastVerifiedAt: restoredAt,
        failures: 0,
        nextAttemptAt: 0,
      });
      logger.log(
        `🔒  Restored protected message ${logLabel(updated)} ` +
          `restoration=${restorationCount}`
      );
      return;
    }

    if (response.status === 404) {
      store.markChannelMissing(record.channelId);
      logger.warn(
        `🔒  Protected-message channel is unavailable ${logLabel(record)}`
      );
      return;
    }

    const failures = record.failures + 1;
    const delayMs = store.computeBackoffMs(failures);
    store.updateProtectedMessage(recordId, {
      failures,
      nextAttemptAt: now() + delayMs,
    });
    logger.warn(
      `🔒  Protected-message repost failed ${logLabel(record)} ` +
        `status=${response.status} retryMs=${delayMs}`
    );
    scheduleRepost(recordId, delayMs);
  }

  /** Process raw gateway deletes, including messages absent from SDK caches. */
  async function handleRawEvent(event) {
    if (!event || typeof event.type !== "string") return;

    if (event.type === "ChannelDelete") {
      if (isSafeId(event.id)) store.markChannelMissing(event.id);
      return;
    }

    const messageIds =
      event.type === "MessageDelete"
        ? [event.id]
        : event.type === "BulkMessageDelete"
          ? (event.ids ?? [])
          : [];
    if (messageIds.length === 0) return;

    let queued = false;
    for (const messageId of messageIds) {
      if (!isSafeId(messageId) || intentionalDeletes.has(messageId)) continue;
      const record = store.getProtectedMessageByMessageId(messageId);
      if (!record) continue;
      logger.log(`🔒  Detected protected-message deletion ${logLabel(record)}`);
      queueRepost(record.recordId);
      queued = true;
    }

    if (queued) await drainPromise;
  }

  /** Verify a bounded batch so offline deletions are eventually restored. */
  async function sweepNow() {
    const records = store.selectDueRecords(
      store.getAllProtectedMessages(),
      now(),
      sweepBudget
    );
    let queued = false;

    for (const record of records) {
      if (!isSafeId(record.channelId) || !isSafeId(record.messageId)) continue;
      const response = await request(
        "GET",
        `/channels/${record.channelId}/messages/${record.messageId}`
      );

      if (response.ok && response.data?._id) {
        store.updateProtectedMessage(record.recordId, {
          lastVerifiedAt: now(),
        });
      } else if (response.status === 404) {
        queueRepost(record.recordId);
        queued = true;
      }
      // Network errors, 429s, and 5xx responses are not proof of deletion.
    }

    if (queued) await drainPromise;
  }

  /** Start reconciliation once; raw listeners are bound immediately below. */
  async function start() {
    if (started) return;
    started = true;
    try {
      await sweepNow();
      const timer = scheduleInterval(() => {
        sweepNow().catch((error) =>
          logger.error(
            `tamper-protection: sweep error ${safeErrorSummary(error)}`
          )
        );
      }, sweepIntervalMs);
      timer?.unref?.();
    } catch (error) {
      started = false;
      throw error;
    }
  }

  function untrack(messageId) {
    const record = store.getProtectedMessageByMessageId(messageId);
    if (record) store.removeProtectedMessage(record.recordId);
  }

  /** Suppress the raw delete event while the bot intentionally removes one. */
  async function runIntentionalDelete(messageId, operation) {
    intentionalDeletes.add(messageId);
    try {
      const succeeded = await operation();
      if (succeeded) untrack(messageId);
      return succeeded;
    } finally {
      intentionalDeletes.delete(messageId);
    }
  }

  client.events.on("event", (event) => {
    handleRawEvent(event).catch((error) =>
      logger.error(
        `tamper-protection: raw event error ${safeErrorSummary(error)}`
      )
    );
  });

  return {
    sendProtected,
    handleRawEvent,
    sweepNow,
    start,
    runIntentionalDelete,
    untrack,
  };
}
