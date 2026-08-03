// message-archive.js — Persistent record of server messages for the audit log
// ─────────────────────────────────────────────────────────────────────────────
// Stoat's gateway only reports the *id* of a deleted message, and revolt.js
// only knows content for messages seen since the current process started.
// To always show what was deleted/edited — even across restarts — we journal
// every message (in audit-enabled servers) to an append-only JSONL file and
// keep an in-memory index for lookups.
//
// Journal ops, one JSON object per line:
//   {"op":"create", id, channelId, serverId, authorId, content, attachments, createdAt}
//   {"op":"edit",   id, content, editedAt}
//   {"op":"delete", id, deletedAt}
//
// `attachments` is an array of descriptors:
//   {id, filename, size, contentType, archiveAttachmentId, archiveUrl,
//    archiveRecordId, skipReason}
// Attachment bytes live only in the referenced Stoat Logger record. Legacy
// `evidencePath` descriptors normalize to `legacy_purged`; older journals may
// also carry a plain number (attachment count), which callers still accept.
//
// Appends are cheap (no full-file rewrite); the journal is compacted when it
// grows well past the live set. Entries expire after RETENTION_MONTHS
// (calendar months, not a fixed millisecond span, so retention doesn't drift
// across leap days).
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { StringDecoder } from "string_decoder";
import { join } from "path";
import { DATA_DIR } from "./store.js";
import { subtractMonths } from "./time-windows.js";
import { normaliseAttachmentDescriptors } from "./attachment-evidence.js";

const ARCHIVE_PATH = join(DATA_DIR, "message_archive.jsonl");

export const RETENTION_MONTHS = 12; // 1 year
export const MAX_MESSAGES = envInt("HOYOFETCH_ARCHIVE_MAX_MESSAGES", 1_000_000);
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const COMPACT_MIN_DEAD_RATIO = 2; // compact when journal lines > 2× live entries
const COMPACT_MIN_BYTES = 512 * 1024 * 1024; // …or the file exceeds 512 MB
const LOAD_CHUNK_BYTES = 1024 * 1024; // 1 MB read chunks when replaying the journal

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * The cutoff timestamp (epoch ms) before which archived entries have
 * expired, as of `now`.
 * @param {number} now
 * @return {number}
 */
export function retentionCutoff(now = Date.now()) {
  return subtractMonths(now, RETENTION_MONTHS);
}

// Map preserves insertion order → oldest entries are first, which makes both
// retention pruning and the count-cap eviction cheap.
const messages = new Map();
let journalLineCount = 0;

// ── Boot: replay the journal ───────────────────────
loadArchive();

function applyJournalLine(line) {
  if (!line.trim()) return;
  journalLineCount++;
  let op;
  try {
    op = JSON.parse(line);
  } catch {
    return; // skip corrupt lines (e.g. torn write on crash)
  }
  if (!op || typeof op !== "object") return;

  if (op.op === "create" && typeof op.id === "string") {
    messages.set(op.id, {
      id: op.id,
      channelId: op.channelId,
      serverId: op.serverId,
      authorId: op.authorId,
      content: op.content,
      attachments: Array.isArray(op.attachments)
        ? normaliseAttachmentDescriptors(op.attachments)
        : (op.attachments ?? []), // legacy journals may carry a plain count
      createdAt: op.createdAt,
      deletedAt: op.deletedAt ?? null,
    });
  } else if (op.op === "edit" && typeof op.id === "string") {
    const entry = messages.get(op.id);
    if (entry) entry.content = op.content;
  } else if (op.op === "delete" && typeof op.id === "string") {
    const entry = messages.get(op.id);
    if (op.purge === true) messages.delete(op.id);
    else if (entry) entry.deletedAt = op.deletedAt ?? Date.now();
  }
}

// Replays the journal a chunk at a time rather than loading it whole: at the
// 1M-message cap the journal can run into the hundreds of MB, and
// readFileSync + split("\n") would momentarily hold both the raw text and
// every split line in memory. StringDecoder carries a multi-byte UTF-8
// character across a chunk boundary instead of corrupting it.
function loadArchive() {
  if (!existsSync(ARCHIVE_PATH)) return;

  let fd;
  try {
    fd = openSync(ARCHIVE_PATH, "r");
  } catch (err) {
    console.warn(
      "message-archive: could not open journal:",
      err?.message || err
    );
    return;
  }

  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.alloc(LOAD_CHUNK_BYTES);
    let carry = "";

    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;

      carry += decoder.write(buffer.subarray(0, bytesRead));
      const lines = carry.split("\n");
      carry = lines.pop() ?? ""; // last element may be a partial line
      for (const line of lines) applyJournalLine(line);
    }
    carry += decoder.end();
    if (carry) applyJournalLine(carry);
  } catch (err) {
    console.warn(
      "message-archive: could not read journal:",
      err?.message || err
    );
  } finally {
    closeSync(fd);
  }

  pruneArchive();
}

// ── Public API ─────────────────────────────────────

/**
 * Record a newly created message.
 * @param {{id: string, channelId: string, serverId: string, authorId: string,
 *          content: string,
 *          attachments?: Array<{id: string, filename: string, size: number,
 *            contentType: string, archiveAttachmentId: string|null,
 *            archiveUrl: string|null, archiveRecordId: string|null,
 *            skipReason: string|null}>,
 *          createdAt?: number}} entry
 */
export function recordMessage(entry) {
  if (!entry?.id) return;
  const record = {
    id: entry.id,
    channelId: entry.channelId,
    serverId: entry.serverId,
    authorId: entry.authorId,
    content: entry.content ?? "",
    attachments: Array.isArray(entry.attachments)
      ? normaliseAttachmentDescriptors(entry.attachments)
      : (entry.attachments ?? []),
    createdAt: entry.createdAt ?? Date.now(),
    deletedAt: null,
  };
  messages.set(entry.id, record);
  appendOp({ op: "create", ...record });

  // Count cap: evict oldest entries (Map iteration order = insertion order)
  if (messages.size > MAX_MESSAGES) {
    const excess = messages.size - MAX_MESSAGES;
    let removed = 0;
    for (const key of messages.keys()) {
      if (removed >= excess) break;
      messages.delete(key);
      removed++;
    }
  }
}

/**
 * Look up an archived message by id.
 * @param  {string} id
 * @return {Object|null}
 */
export function getArchivedMessage(id) {
  return messages.get(id) ?? null;
}

/**
 * Query message metadata without exposing archived content to moderation code.
 */
export function findArchivedMessages({
  serverId,
  authorId,
  since = 0,
  until = Number.POSITIVE_INFINITY,
} = {}) {
  const matches = [];
  for (const entry of messages.values()) {
    const createdAt = Number(entry.createdAt) || 0;
    if (
      entry.serverId === serverId &&
      entry.authorId === authorId &&
      !entry.deletedAt &&
      createdAt >= since &&
      createdAt <= until
    ) {
      matches.push({
        id: entry.id,
        channelId: entry.channelId,
        serverId: entry.serverId,
        authorId: entry.authorId,
        createdAt,
      });
    }
  }
  return matches.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Count messages by one author without allocating a match array —
 * findArchivedMessages's array shape is wasteful for a count-only query at
 * archive scale.
 */
export function countArchivedMessages({ serverId, authorId, since = 0 } = {}) {
  let count = 0;
  for (const entry of messages.values()) {
    const createdAt = Number(entry.createdAt) || 0;
    if (
      entry.serverId === serverId &&
      entry.authorId === authorId &&
      !entry.deletedAt &&
      createdAt >= since
    ) {
      count++;
    }
  }
  return count;
}

export function getArchiveCoverage(serverId) {
  let count = 0;
  let earliestAt = null;
  let latestAt = null;
  for (const entry of messages.values()) {
    if (entry.serverId !== serverId) continue;
    const createdAt = Number(entry.createdAt) || 0;
    count += 1;
    earliestAt =
      earliestAt === null ? createdAt : Math.min(earliestAt, createdAt);
    latestAt = latestAt === null ? createdAt : Math.max(latestAt, createdAt);
  }
  return { count, earliestAt, latestAt };
}

/**
 * Apply an edit to an archived message.
 * @param  {string} id
 * @param  {string} newContent
 * @return {string|undefined} the content before this edit (undefined if unknown)
 */
export function applyEdit(id, newContent) {
  const entry = messages.get(id);
  const previous = entry?.content;
  if (entry) {
    entry.content = newContent;
    appendOp({ op: "edit", id, content: newContent, editedAt: Date.now() });
  }
  return previous;
}

/** Mark a deletion while retaining its archive metadata for audit history. */
export function markMessageDeleted(id, deletedAt = Date.now()) {
  return markMessagesDeleted([id], deletedAt) === 1;
}

export function markMessagesDeleted(ids, deletedAt = Date.now()) {
  const ops = [];
  for (const id of new Set(ids)) {
    const entry = messages.get(id);
    if (!entry || entry.deletedAt) continue;
    entry.deletedAt = deletedAt;
    ops.push({ op: "delete", id, deletedAt });
  }
  appendOps(ops);
  return ops.length;
}

/**
 * Permanently remove all archived content for one privacy-excluded channel.
 * @param {string} channelId
 * @return {{evidencePaths: string[], archiveRecordIds: string[]}}
 *   legacy paths and Stoat Logger records formerly referenced by removed entries
 */
export function purgeChannelFromArchive(channelId) {
  const evidencePaths = [];
  const archiveRecordIds = [];
  const ops = [];
  const deletedAt = Date.now();
  for (const [id, entry] of messages) {
    if (entry.channelId !== channelId) continue;
    if (Array.isArray(entry.attachments)) {
      for (const attachment of entry.attachments) {
        if (typeof attachment?.evidencePath === "string") {
          evidencePaths.push(attachment.evidencePath);
        }
        if (
          typeof attachment?.archiveRecordId === "string" &&
          !archiveRecordIds.includes(attachment.archiveRecordId)
        ) {
          archiveRecordIds.push(attachment.archiveRecordId);
        }
      }
    }
    messages.delete(id);
    ops.push({ op: "delete", id, deletedAt, purge: true });
  }
  appendOps(ops);
  return { evidencePaths, archiveRecordIds };
}

/**
 * Drop entries past retention and compact the journal when it has accumulated
 * substantially more lines than there are live entries.
 * @param {number} now
 */
export function pruneArchive(now = Date.now()) {
  const cutoff = retentionCutoff(now);
  for (const [id, entry] of messages) {
    if ((entry.createdAt ?? 0) < cutoff) messages.delete(id);
  }

  const fileBytes = existsSync(ARCHIVE_PATH) ? statSync(ARCHIVE_PATH).size : 0;
  const deadHeavy = journalLineCount > messages.size * COMPACT_MIN_DEAD_RATIO;
  if ((deadHeavy && journalLineCount > 1000) || fileBytes > COMPACT_MIN_BYTES) {
    compact();
  }
}

/**
 * Start the daily retention/compaction timer.
 */
export function startArchiveMaintenance() {
  setInterval(() => pruneArchive(), PRUNE_INTERVAL_MS).unref?.();
}

/** Number of live archived messages (for logging/tests). */
export function archiveSize() {
  return messages.size;
}

// ── Internals ──────────────────────────────────────

function appendOp(op) {
  appendOps([op]);
}

function appendOps(ops) {
  if (!ops.length) return;
  try {
    appendFileSync(
      ARCHIVE_PATH,
      ops.map((op) => JSON.stringify(op)).join("\n") + "\n",
      "utf-8"
    );
    journalLineCount += ops.length;
  } catch (err) {
    console.warn("message-archive: append failed:", err?.message || err);
  }
}

// Rewrite the journal from the live Map (atomic: temp file + rename).
function compact() {
  try {
    const tmp = `${ARCHIVE_PATH}.tmp`;
    const lines = [];
    for (const entry of messages.values()) {
      lines.push(JSON.stringify({ op: "create", ...entry }));
    }
    writeFileSync(tmp, lines.length ? lines.join("\n") + "\n" : "", "utf-8");
    renameSync(tmp, ARCHIVE_PATH);
    journalLineCount = messages.size;
  } catch (err) {
    console.warn("message-archive: compaction failed:", err?.message || err);
  }
}
