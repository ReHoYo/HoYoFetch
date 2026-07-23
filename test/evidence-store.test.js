// Tests for the local attachment-evidence store: save/read round trip,
// per-file cap rejection, total-budget eviction of the oldest files,
// retention pruning, boot-time rescan, path-safety, and the budget=0
// disable switch. Runs against a temp data dir.
//
// Note: evidence-store.js statically imports DATA_DIR from store.js, which
// is a plain (unversioned, singleton) module — it only ever initialises
// once per process. So HOYOFETCH_DATA_DIR is fixed ONCE for this whole file
// (matching store.test.js/message-archive.test.js); isolation between tests
// instead comes from wiping the evidence subdirectory before each test that
// needs a clean slate, then re-importing evidence-store.js under a fresh
// query string so its own top-level env-derived config (and in-memory
// index) resets and rescans the now-empty directory.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir;
let evidenceDir;
let reimportCounter = 0;

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hoyofetch-evidence-"));
  evidenceDir = join(dataDir, "evidence");
  process.env.HOYOFETCH_DATA_DIR = dataDir;
});

function resetEvidenceDir() {
  rmSync(evidenceDir, { recursive: true, force: true });
}

async function freshStore(envOverrides = {}) {
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  reimportCounter++;
  return import(`../evidence-store.js?variant=${reimportCounter}`);
}

test("save → read round trip", async () => {
  resetEvidenceDir();
  const store = await freshStore({
    AUDITLOG_EVIDENCE_MAX_MB: "20",
    AUDITLOG_EVIDENCE_BUDGET_MB: "1024",
  });

  assert.equal(store.isEvidenceEnabled(), true);

  const bytes = Buffer.from("fake image bytes");
  const path = store.saveEvidence("msg1", 0, bytes, "image/png");
  assert.ok(path, "expected a saved path");
  assert.ok(path.endsWith("msg1_0.png"));

  const readBack = store.readEvidence(path);
  assert.deepEqual(readBack, bytes);

  const stats = store.evidenceStats();
  assert.equal(stats.files, 1);
  assert.equal(stats.bytes, bytes.length);
});

test("readEvidence returns null for missing/evicted paths", async () => {
  resetEvidenceDir();
  const store = await freshStore({
    AUDITLOG_EVIDENCE_MAX_MB: "20",
    AUDITLOG_EVIDENCE_BUDGET_MB: "1024",
  });

  assert.equal(store.readEvidence(null), null);
  assert.equal(store.readEvidence(join(evidenceDir, "nope.png")), null);
});

test("deleteEvidence removes an indexed evidence file", async () => {
  resetEvidenceDir();
  const store = await freshStore({
    AUDITLOG_EVIDENCE_MAX_MB: "20",
    AUDITLOG_EVIDENCE_BUDGET_MB: "1024",
  });
  const path = store.saveEvidence(
    "deleteme",
    0,
    Buffer.from("private"),
    "image/png"
  );
  assert.equal(store.deleteEvidence(path), true);
  assert.equal(store.readEvidence(path), null);
  assert.equal(store.deleteEvidence(path), false);
});

test("per-file cap rejects oversized attachments", async () => {
  resetEvidenceDir();
  const store = await freshStore({
    AUDITLOG_EVIDENCE_MAX_MB: "1", // 1 MB cap
    AUDITLOG_EVIDENCE_BUDGET_MB: "1024",
  });

  const tooBig = Buffer.alloc(2 * 1024 * 1024); // 2 MB > 1 MB cap
  assert.equal(store.saveEvidence("bigmsg", 0, tooBig, "image/png"), null);
  assert.equal(store.evidenceStats().files, 0);

  const fine = Buffer.alloc(512 * 1024); // 512 KB < 1 MB cap
  assert.ok(store.saveEvidence("okmsg", 0, fine, "image/png"));
  assert.equal(store.evidenceStats().files, 1);
});

test("total budget evicts the oldest evidence first", async () => {
  resetEvidenceDir();
  const store = await freshStore({
    AUDITLOG_EVIDENCE_MAX_MB: "20",
    AUDITLOG_EVIDENCE_BUDGET_MB: "1", // 1 MB total budget
  });

  const chunk = Buffer.alloc(400 * 1024); // 400 KB each
  const p1 = store.saveEvidence("m1", 0, chunk, "image/png");
  const p2 = store.saveEvidence("m2", 0, chunk, "image/png");
  const p3 = store.saveEvidence("m3", 0, chunk, "image/png"); // pushes total > 1MB

  assert.ok(p1 && p2 && p3);
  // m1 (oldest) should have been evicted to make room for m3.
  assert.equal(store.readEvidence(p1), null);
  assert.ok(store.readEvidence(p2));
  assert.ok(store.readEvidence(p3));
  assert.ok(store.evidenceStats().bytes <= store.budgetBytes());
});

test("pruneEvidence drops files past retention", async () => {
  resetEvidenceDir();
  const store = await freshStore({
    AUDITLOG_EVIDENCE_MAX_MB: "20",
    AUDITLOG_EVIDENCE_BUDGET_MB: "1024",
  });

  const bytes = Buffer.from("evidence");
  const path = store.saveEvidence("oldmsg", 0, bytes, "image/png");
  assert.ok(path);

  const farFuture = Date.now() + 31 * 24 * 60 * 60 * 1000; // 31 days later
  store.pruneEvidence(farFuture);

  assert.equal(store.readEvidence(path), null);
  assert.equal(store.evidenceStats().files, 0);
});

test("boot rescan picks up files left on disk from a prior process", async () => {
  resetEvidenceDir();
  const first = await freshStore({
    AUDITLOG_EVIDENCE_MAX_MB: "20",
    AUDITLOG_EVIDENCE_BUDGET_MB: "1024",
  });

  const bytes = Buffer.from("surviving bytes");
  first.saveEvidence("survivor", 0, bytes, "image/png");

  const rebooted = await freshStore({
    AUDITLOG_EVIDENCE_MAX_MB: "20",
    AUDITLOG_EVIDENCE_BUDGET_MB: "1024",
  });

  assert.equal(rebooted.evidenceStats().files, 1);
  assert.equal(rebooted.evidenceStats().bytes, bytes.length);
});

test("boot rescan enforces a shrunk budget by evicting oldest files", async () => {
  resetEvidenceDir();
  const first = await freshStore({
    AUDITLOG_EVIDENCE_MAX_MB: "20",
    AUDITLOG_EVIDENCE_BUDGET_MB: "1024",
  });

  const chunk = Buffer.alloc(600 * 1024);
  first.saveEvidence("a", 0, chunk, "image/png");
  first.saveEvidence("b", 0, chunk, "image/png");
  assert.equal(first.evidenceStats().files, 2);

  // Reboot with a much smaller budget — only one 600 KB file should survive.
  const rebooted = await freshStore({
    AUDITLOG_EVIDENCE_MAX_MB: "20",
    AUDITLOG_EVIDENCE_BUDGET_MB: "1", // ~1 MB, room for one chunk only
  });

  assert.equal(rebooted.evidenceStats().files, 1);
  assert.ok(rebooted.evidenceStats().bytes <= rebooted.budgetBytes());
});

test("rejects unsafe message ids and indices (no path traversal)", async () => {
  resetEvidenceDir();
  const store = await freshStore({
    AUDITLOG_EVIDENCE_MAX_MB: "20",
    AUDITLOG_EVIDENCE_BUDGET_MB: "1024",
  });

  const bytes = Buffer.from("x");
  assert.equal(
    store.saveEvidence("../../etc/passwd", 0, bytes, "image/png"),
    null
  );
  assert.equal(store.saveEvidence("valid_id", -1, bytes, "image/png"), null);
  assert.equal(store.saveEvidence("valid_id", 1.5, bytes, "image/png"), null);
  assert.equal(store.saveEvidence("", 0, bytes, "image/png"), null);

  // Confirm nothing escaped the evidence directory.
  if (existsSync(evidenceDir)) {
    for (const name of readdirSync(evidenceDir)) {
      assert.ok(statSync(join(evidenceDir, name)).isFile());
    }
  }
});

test("budget of 0 disables evidence capture entirely", async () => {
  resetEvidenceDir();
  const store = await freshStore({
    AUDITLOG_EVIDENCE_MAX_MB: "20",
    AUDITLOG_EVIDENCE_BUDGET_MB: "0",
  });

  assert.equal(store.isEvidenceEnabled(), false);
  assert.equal(
    store.saveEvidence("msg1", 0, Buffer.from("x"), "image/png"),
    null
  );
  assert.equal(store.evidenceStats().files, 0);
});
