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
//
// `attachments` is an array of descriptors:
//   {id, filename, size, contentType, url, evidencePath}
// `evidencePath` points into evidence-store.js's local byte cache, or is
// null if the attachment didn't qualify (too large, capture failed, or
// evidence capture is disabled). Journals written before this field existed
// carry a plain number (attachment count) — callers must accept both shapes
// (`Array.isArray(entry.attachments)` vs a legacy count).
//
// Appends are cheap (no full-file rewrite); the journal is compacted when it
// grows well past the live set. Entries expire after RETENTION_MS.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { DATA_DIR } from "./store.js";

const ARCHIVE_PATH = join(DATA_DIR, "message_archive.jsonl");

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const MAX_MESSAGES = 100_000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const COMPACT_MIN_DEAD_RATIO = 2; // compact when journal lines > 2× live entries
const COMPACT_MIN_BYTES = 20 * 1024 * 1024; // …or the file exceeds 20 MB

// Map preserves insertion order → oldest entries are first, which makes both
// retention pruning and the count-cap eviction cheap.
const messages = new Map();
let journalLineCount = 0;

// ── Boot: replay the journal ───────────────────────
loadArchive();

function loadArchive() {
  if (!existsSync(ARCHIVE_PATH)) return;

  let raw;
  try {
    raw = readFileSync(ARCHIVE_PATH, "utf-8");
  } catch (err) {
    console.warn("message-archive: could not read journal:", err?.message || err);
    return;
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    journalLineCount++;
    let op;
    try {
      op = JSON.parse(line);
    } catch {
      continue; // skip corrupt lines (e.g. torn write on crash)
    }
    if (!op || typeof op !== "object") continue;

    if (op.op === "create" && typeof op.id === "string") {
      messages.set(op.id, {
        id: op.id,
        channelId: op.channelId,
        serverId: op.serverId,
        authorId: op.authorId,
        content: op.content,
        attachments: op.attachments ?? [], // legacy journals may carry a plain count
        createdAt: op.createdAt,
      });
    } else if (op.op === "edit" && typeof op.id === "string") {
      const entry = messages.get(op.id);
      if (entry) entry.content = op.content;
    }
  }

  pruneArchive();
}

// ── Public API ─────────────────────────────────────

/**
 * Record a newly created message.
 * @param {{id: string, channelId: string, serverId: string, authorId: string,
 *          content: string,
 *          attachments?: Array<{id: string, filename: string, size: number,
 *            contentType: string, url: string, evidencePath: string|null}>,
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
    attachments: entry.attachments ?? [],
    createdAt: entry.createdAt ?? Date.now(),
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

/**
 * Drop entries past retention and compact the journal when it has accumulated
 * substantially more lines than there are live entries.
 * @param {number} now
 */
export function pruneArchive(now = Date.now()) {
  const cutoff = now - RETENTION_MS;
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
  try {
    appendFileSync(ARCHIVE_PATH, JSON.stringify(op) + "\n", "utf-8");
    journalLineCount++;
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
