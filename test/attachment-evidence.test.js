// Tests for the shared attachment descriptor + evidence-capture helpers used
// by both auditlog.js and post-gate.js: each distinct skip reason, the
// legacy plain-count archive shape, and the re-upload-cap accounting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOYOFETCH_DATA_DIR = mkdtempSync(
  join(tmpdir(), "hoyofetch-attachment-evidence-test-")
);

const {
  buildAttachmentDescriptors,
  humanReadableSize,
  resolveAttachmentEvidence,
  SKIP_REASONS,
} = await import("../attachment-evidence.js");

const client = {
  configuration: { features: { autumn: { url: "https://autumn.test" } } },
  authenticationHeader: ["X-Bot-Token", "secret"],
};

function okDownload() {
  return {
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode("bytes").buffer,
  };
}

test("humanReadableSize formats across unit boundaries", () => {
  assert.equal(humanReadableSize(0), "0 B");
  assert.equal(humanReadableSize(512), "512 B");
  assert.equal(humanReadableSize(2_048), "2.0 KB");
  assert.equal(humanReadableSize(50 * 1024 * 1024), "50 MB");
});

test("untrusted attachment URLs are recorded as untrusted_url", async () => {
  const [descriptor] = await buildAttachmentDescriptors(
    client,
    "MSGUNTRUSTED",
    [
      {
        id: "ATT1",
        filename: "proof.png",
        size: 500,
        contentType: "image/png",
        url: "https://evil.example/proof.png",
      },
    ],
    { fetchImpl: okDownload }
  );
  assert.equal(descriptor.skipReason, SKIP_REASONS.UNTRUSTED_URL);
  assert.equal(descriptor.evidencePath, null);
});

test("oversized or zero-byte attachments are recorded as too_large", async () => {
  const [tooBig] = await buildAttachmentDescriptors(
    client,
    "MSGBIG",
    [
      {
        id: "ATT2",
        filename: "huge.bin",
        size: 100 * 1024 * 1024, // over the default 20MB per-file cap
        contentType: "application/octet-stream",
        url: "https://autumn.test/attachments/ATT2",
      },
    ],
    { fetchImpl: okDownload }
  );
  assert.equal(tooBig.skipReason, SKIP_REASONS.TOO_LARGE);

  const [zeroSize] = await buildAttachmentDescriptors(
    client,
    "MSGZERO",
    [
      {
        id: "ATT3",
        filename: "empty.bin",
        size: 0,
        contentType: "application/octet-stream",
        url: "https://autumn.test/attachments/ATT3",
      },
    ],
    { fetchImpl: okDownload }
  );
  assert.equal(zeroSize.skipReason, SKIP_REASONS.TOO_LARGE);
});

test("a failed or oversized download is recorded as download_failed", async () => {
  const [notOk] = await buildAttachmentDescriptors(
    client,
    "MSGDOWNFAIL",
    [
      {
        id: "ATT4",
        filename: "proof.png",
        size: 500,
        contentType: "image/png",
        url: "https://autumn.test/attachments/ATT4",
      },
    ],
    { fetchImpl: async () => ({ ok: false }) }
  );
  assert.equal(notOk.skipReason, SKIP_REASONS.DOWNLOAD_FAILED);
});

test("a message id that fails the evidence store's safety pattern is recorded as capture_error", async () => {
  const [descriptor] = await buildAttachmentDescriptors(
    client,
    "not-a-safe-id", // hyphens fail evidence-store.js's SAFE_ID_PATTERN
    [
      {
        id: "ATT5",
        filename: "proof.png",
        size: 500,
        contentType: "image/png",
        url: "https://autumn.test/attachments/ATT5",
      },
    ],
    { fetchImpl: okDownload }
  );
  assert.equal(descriptor.skipReason, SKIP_REASONS.CAPTURE_ERROR);
  assert.equal(descriptor.evidencePath, null);
});

test("a qualifying attachment is captured and later re-uploaded on resolve", async () => {
  const [descriptor] = await buildAttachmentDescriptors(
    client,
    "MSGOK",
    [
      {
        id: "ATT6",
        filename: "proof.png",
        size: 500,
        contentType: "image/png",
        url: "https://autumn.test/attachments/ATT6",
      },
    ],
    { fetchImpl: okDownload }
  );
  assert.equal(descriptor.skipReason, null);
  assert.ok(descriptor.evidencePath);

  const { lines, ids } = await resolveAttachmentEvidence(
    client,
    { attachments: [descriptor] },
    {
      fetchImpl: async (url, options) => {
        if (options?.method === "POST") {
          return { ok: true, json: async () => ({ id: "REUPLOADED1" }) };
        }
        return okDownload();
      },
    }
  );
  assert.equal(ids.length, 1);
  assert.equal(ids[0], "REUPLOADED1");
  assert.match(lines[0], /✅ `proof\.png`.*preserved, attached above/);
});

test("resolveAttachmentEvidence honours a maxReuploads cap", async () => {
  const descriptors = [];
  for (let i = 0; i < 3; i++) {
    const [descriptor] = await buildAttachmentDescriptors(
      client,
      `MSGCAP${i}`,
      [
        {
          id: `ATTCAP${i}`,
          filename: `proof${i}.png`,
          size: 500,
          contentType: "image/png",
          url: `https://autumn.test/attachments/ATTCAP${i}`,
        },
      ],
      { fetchImpl: okDownload }
    );
    descriptors.push(descriptor);
  }

  let uploadCount = 0;
  const { lines, ids } = await resolveAttachmentEvidence(
    client,
    { attachments: descriptors },
    {
      fetchImpl: async (url, options) => {
        if (options?.method === "POST") {
          uploadCount += 1;
          return {
            ok: true,
            json: async () => ({ id: `REUPLOADED_${uploadCount}` }),
          };
        }
        return okDownload();
      },
      maxReuploads: 2,
    }
  );
  assert.equal(ids.length, 2);
  assert.match(lines[2], /re-upload limit was already reached/);
});

test("legacy plain-count archive entries render one summary line", async () => {
  const { lines, ids } = await resolveAttachmentEvidence(client, {
    attachments: 3,
  });
  assert.equal(ids.length, 0);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /3 attachments — recorded before evidence capture existed/
  );

  const singular = await resolveAttachmentEvidence(client, { attachments: 1 });
  assert.match(singular.lines[0], /1 attachment —/);

  const none = await resolveAttachmentEvidence(client, { attachments: 0 });
  assert.equal(none.lines.length, 0);
});

test("a missing entry or empty attachment list produces no lines", async () => {
  assert.deepEqual(await resolveAttachmentEvidence(client, null), {
    lines: [],
    ids: [],
  });
  assert.deepEqual(
    await resolveAttachmentEvidence(client, { attachments: [] }),
    {
      lines: [],
      ids: [],
    }
  );
});
