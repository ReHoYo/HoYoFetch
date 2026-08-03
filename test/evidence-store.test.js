import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "hoyofetch-legacy-evidence-"));
process.env.HOYOFETCH_DATA_DIR = dataDir;

const { evidenceModeStats, isEvidenceEnabled, purgeLegacyEvidence } =
  await import("../evidence-store.js");

test("runtime reports Stoat mode and zero VPS bytes", () => {
  assert.equal(isEvidenceEnabled(), true);
  assert.deepEqual(evidenceModeStats(), {
    mode: "stoat",
    diskBytes: 0,
    perFileCapBytes: 20 * 1024 * 1024,
  });
});

test("legacy purge does not follow an evidence-directory symlink", () => {
  const evidenceDir = join(dataDir, "evidence");
  const outsideDir = join(dataDir, "outside-directory");
  const outsideFile = join(outsideDir, "keep.bin");
  mkdirSync(outsideDir);
  writeFileSync(outsideFile, Buffer.from("outside"));
  symlinkSync(outsideDir, evidenceDir);

  const result = purgeLegacyEvidence();
  assert.deepEqual(result, { files: 0, bytes: 0, errors: 0 });
  assert.equal(existsSync(outsideFile), true);
  unlinkSync(evidenceDir);
});

test("legacy purge deletes only direct regular files in the exact evidence directory", () => {
  const evidenceDir = join(dataDir, "evidence");
  const nested = join(evidenceDir, "nested");
  const outside = join(dataDir, "outside.bin");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(evidenceDir, "legacy.png"), Buffer.from("legacy"));
  writeFileSync(join(nested, "keep.png"), Buffer.from("nested"));
  writeFileSync(outside, Buffer.from("outside"));
  symlinkSync(outside, join(evidenceDir, "outside-link"));

  const result = purgeLegacyEvidence();
  assert.equal(result.files, 1);
  assert.equal(result.bytes, 6);
  assert.equal(existsSync(join(evidenceDir, "legacy.png")), false);
  assert.equal(existsSync(join(nested, "keep.png")), true);
  assert.equal(existsSync(outside), true);
  assert.equal(existsSync(join(evidenceDir, "outside-link")), true);
});
