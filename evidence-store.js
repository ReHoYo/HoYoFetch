// evidence-store.js — compatibility settings and one-time legacy cleanup
// ────────────────────────────────────────────────────────────────────────
// Irminsul no longer stores attachment bytes on disk. This module retains
// the established per-file limit and safely removes files left by releases
// that used data/evidence as a persistent byte cache.
import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "./store.js";

const EVIDENCE_DIR = join(DATA_DIR, "evidence");
const DEFAULT_MAX_FILE_MB = 20;

function envMB(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const MAX_FILE_MB = envMB("AUDITLOG_EVIDENCE_MAX_MB", DEFAULT_MAX_FILE_MB);

export function perFileCapBytes() {
  return MAX_FILE_MB * 1024 * 1024;
}

/** A zero per-file cap is now the metadata-only opt-out. */
export function isEvidenceEnabled() {
  return perFileCapBytes() > 0;
}

/**
 * Remove only direct regular files from the exact legacy evidence directory.
 * Symlinks and subdirectories are deliberately left untouched.
 */
export function purgeLegacyEvidence() {
  const result = { files: 0, bytes: 0, errors: 0 };
  if (!existsSync(EVIDENCE_DIR)) return result;

  try {
    // lstat deliberately rejects an evidence path that is itself a symlink;
    // readdirSync would otherwise follow it outside the configured data dir.
    if (!lstatSync(EVIDENCE_DIR).isDirectory()) return result;
  } catch {
    result.errors += 1;
    return result;
  }

  let names;
  try {
    names = readdirSync(EVIDENCE_DIR);
  } catch {
    result.errors += 1;
    return result;
  }

  for (const name of names) {
    const path = join(EVIDENCE_DIR, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) continue;
      unlinkSync(path);
      result.files += 1;
      result.bytes += stat.size;
    } catch {
      result.errors += 1;
    }
  }

  try {
    rmdirSync(EVIDENCE_DIR);
  } catch {
    // It may contain a subdirectory/symlink or have raced with another actor.
  }
  return result;
}

export function evidenceModeStats() {
  return {
    mode: "stoat",
    diskBytes: 0,
    perFileCapBytes: perFileCapBytes(),
  };
}
