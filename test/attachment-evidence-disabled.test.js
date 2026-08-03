import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOYOFETCH_DATA_DIR = mkdtempSync(
  join(tmpdir(), "hoyofetch-disabled-")
);
process.env.AUDITLOG_EVIDENCE_MAX_MB = "0";

const { prepareAttachmentCopies, SKIP_REASONS } =
  await import("../attachment-evidence.js");

test("a zero per-file cap disables Stoat attachment archiving", async () => {
  const result = await prepareAttachmentCopies(
    { configuration: { features: { autumn: { url: "https://autumn.test" } } } },
    [
      {
        id: "ATT1",
        filename: "proof.png",
        size: 5,
        contentType: "image/png",
        url: "https://autumn.test/attachments/ATT1",
      },
    ],
    { fetchImpl: async () => assert.fail("disabled capture must not fetch") }
  );
  assert.equal(
    result.descriptors[0].skipReason,
    SKIP_REASONS.EVIDENCE_DISABLED
  );
  assert.deepEqual(result.uploadIds, []);
});
