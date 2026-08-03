// Separate process/file (node:test isolates by file) so the
// AUDITLOG_EVIDENCE_BUDGET_MB=0 env var is fixed before evidence-store.js's
// module-level budget const is computed at import time — see
// test/evidence-store.test.js for the same constraint on that module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOYOFETCH_DATA_DIR = mkdtempSync(
  join(tmpdir(), "hoyofetch-attachment-evidence-disabled-test-")
);
process.env.AUDITLOG_EVIDENCE_BUDGET_MB = "0";

const { buildAttachmentDescriptors, SKIP_REASONS } =
  await import("../attachment-evidence.js");

test("evidence capture disabled (budget=0) is reported as evidence_disabled", async () => {
  const client = {
    configuration: { features: { autumn: { url: "https://autumn.test" } } },
  };
  const [descriptor] = await buildAttachmentDescriptors(
    client,
    "MSGDISABLED",
    [
      {
        id: "ATT1",
        filename: "proof.png",
        size: 500,
        contentType: "image/png",
        url: "https://autumn.test/attachments/ATT1",
      },
    ],
    {
      fetchImpl: async () => ({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("bytes").buffer,
      }),
    }
  );
  assert.equal(descriptor.skipReason, SKIP_REASONS.EVIDENCE_DISABLED);
  assert.equal(descriptor.evidencePath, null);
});
