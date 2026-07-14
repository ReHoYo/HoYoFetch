// evidence-store.js — Local storage for deleted-message attachment evidence
// ─────────────────────────────────────────────────────────────────────────
// Stoat's File schema has a `deleted` flag, so the original CDN copy of an
// attachment is very likely purged the moment its message is deleted — a
// saved link alone would 404 exactly when it's needed as evidence. This
// module keeps a local byte copy from the moment a qualifying attachment is
// posted, bounded by a hard total-size budget (oldest evicted first) plus
// the shared retention window, so disk use can never exceed what the
// operator configures.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { DATA_DIR } from "./store.js";
import { RETENTION_MS } from "./message-archive.js";

const EVIDENCE_DIR = join(DATA_DIR, "evidence");
const SAFE_ID_PATTERN = /^[A-Za-z0-9]+$/;

const DEFAULT_MAX_FILE_MB = 20;
const DEFAULT_BUDGET_MB = 1024;

function envMB(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const MAX_FILE_MB = envMB("AUDITLOG_EVIDENCE_MAX_MB", DEFAULT_MAX_FILE_MB);
const BUDGET_MB = envMB("AUDITLOG_EVIDENCE_BUDGET_MB", DEFAULT_BUDGET_MB);

const EXTENSION_BY_CONTENT_TYPE = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

// Insertion-ordered → oldest evidence is always first, matching the
// eviction/retention strategy in message-archive.js.
const files = new Map();

loadExisting();

function loadExisting() {
  if (!existsSync(EVIDENCE_DIR)) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    return;
  }

  let entries;
  try {
    entries = readdirSync(EVIDENCE_DIR);
  } catch (err) {
    console.warn("evidence-store: could not list directory:", err?.message || err);
    return;
  }

  const found = [];
  for (const name of entries) {
    const path = join(EVIDENCE_DIR, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      found.push({ name, path, size: stat.size, createdAt: stat.mtimeMs });
    } catch {
      continue; // vanished between readdir and stat
    }
  }

  found.sort((a, b) => a.createdAt - b.createdAt);
  for (const f of found) {
    files.set(f.name, { path: f.path, size: f.size, createdAt: f.createdAt });
  }

  pruneEvidence();
  evictUntilFits(0); // enforce budget in case it shrank since last boot
}

// ── Config accessors ───────────────────────────────

export function perFileCapBytes() {
  return MAX_FILE_MB * 1024 * 1024;
}

export function budgetBytes() {
  return BUDGET_MB * 1024 * 1024;
}

/** Evidence capture is entirely disabled when the budget is 0. */
export function isEvidenceEnabled() {
  return budgetBytes() > 0;
}

// ── Public API ─────────────────────────────────────

/**
 * Save an attachment's bytes as evidence, evicting the oldest evidence
 * files as needed to stay within the total byte budget.
 * @param  {string} messageId  the message this attachment belongs to
 * @param  {number} index      attachment index within the message (0-based)
 * @param  {Buffer} bytes
 * @param  {string} contentType
 * @return {string|null} the saved file path, or null if not saved
 */
export function saveEvidence(messageId, index, bytes, contentType) {
  if (!isEvidenceEnabled()) return null;
  if (!SAFE_ID_PATTERN.test(messageId ?? "")) return null;
  if (!Number.isInteger(index) || index < 0) return null;
  if (!bytes || !bytes.length) return null;
  if (bytes.length > perFileCapBytes()) return null;
  if (bytes.length > budgetBytes()) return null; // could never fit even alone

  const ext = EXTENSION_BY_CONTENT_TYPE[contentType] || "bin";
  const filename = `${messageId}_${index}.${ext}`;
  const filePath = join(EVIDENCE_DIR, filename);

  evictUntilFits(bytes.length);

  try {
    writeFileSync(filePath, bytes);
  } catch (err) {
    console.warn("evidence-store: write failed:", err?.message || err);
    return null;
  }

  files.set(filename, { path: filePath, size: bytes.length, createdAt: Date.now() });
  return filePath;
}

/**
 * Read back previously saved evidence.
 * @param  {string} path
 * @return {Buffer|null} null if missing (evicted, pruned, or never saved)
 */
export function readEvidence(path) {
  if (!path) return null;
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path);
  } catch (err) {
    console.warn("evidence-store: read failed:", err?.message || err);
    return null;
  }
}

/**
 * Drop evidence files past the retention window.
 * @param {number} now
 */
export function pruneEvidence(now = Date.now()) {
  const cutoff = now - RETENTION_MS;
  for (const [filename, meta] of files) {
    if (meta.createdAt < cutoff) {
      files.delete(filename);
      try {
        unlinkSync(meta.path);
      } catch {
        // already gone — fine
      }
    }
  }
}

/**
 * Start the daily retention-pruning timer.
 */
export function startEvidenceMaintenance() {
  setInterval(() => pruneEvidence(), 24 * 60 * 60 * 1000).unref?.();
}

/** Current evidence storage usage (for /Test-AuditLog and logging). */
export function evidenceStats() {
  return {
    files: files.size,
    bytes: totalBytes(),
    budgetBytes: budgetBytes(),
    perFileCapBytes: perFileCapBytes(),
  };
}

// ── Internals ──────────────────────────────────────

function totalBytes() {
  let sum = 0;
  for (const entry of files.values()) sum += entry.size;
  return sum;
}

function evictUntilFits(incomingBytes) {
  while (files.size > 0 && totalBytes() + incomingBytes > budgetBytes()) {
    const oldestKey = files.keys().next().value;
    const oldest = files.get(oldestKey);
    files.delete(oldestKey);
    try {
      unlinkSync(oldest.path);
    } catch {
      // already gone — fine
    }
  }
}
