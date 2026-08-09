import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "hoyofetch-attachment-stoat-"));
process.env.HOYOFETCH_DATA_DIR = dataDir;

const {
  createAttachmentArchiveQueue,
  finaliseArchiveDescriptors,
  humanReadableSize,
  prepareAttachmentCopies,
  resolveAttachmentArchive,
  SKIP_REASONS,
} = await import("../attachment-evidence.js");

const client = {
  configuration: { features: { autumn: { url: "https://autumn.test" } } },
  authenticationHeader: ["X-Bot-Token", "secret"],
};

function source(overrides = {}) {
  return {
    id: "ATT1",
    filename: "proof.png",
    size: 5,
    contentType: "image/png",
    url: "https://autumn.test/attachments/ATT1",
    ...overrides,
  };
}

function transferFetch({ uploadFails = false, downloadFails = false } = {}) {
  let uploads = 0;
  return async (_url, options) => {
    if (options?.method === "POST") {
      uploads += 1;
      return uploadFails
        ? { ok: false, status: 503 }
        : { ok: true, json: async () => ({ id: `COPY${uploads}` }) };
    }
    return downloadFails
      ? { ok: false, status: 404 }
      : {
          ok: true,
          arrayBuffer: async () => new TextEncoder().encode("bytes").buffer,
        };
  };
}

test("humanReadableSize formats across unit boundaries", () => {
  assert.equal(humanReadableSize(0), "0 B");
  assert.equal(humanReadableSize(512), "512 B");
  assert.equal(humanReadableSize(2_048), "2.0 KB");
});

test("qualifying attachments are copied to Stoat without creating evidence files", async () => {
  const result = await prepareAttachmentCopies(client, [source()], {
    fetchImpl: transferFetch(),
  });
  assert.deepEqual(result.uploadIds, ["COPY1"]);
  assert.equal(result.descriptors[0].archiveAttachmentId, "COPY1");
  assert.match(result.descriptors[0].archiveUrl, /COPY1/);
  assert.equal(existsSync(join(dataDir, "evidence")), false);
});

test("untrusted, oversized, download, and upload failures stay metadata-only", async () => {
  const untrusted = await prepareAttachmentCopies(
    client,
    [source({ url: "https://evil.example/file" })],
    { fetchImpl: transferFetch() }
  );
  assert.equal(untrusted.descriptors[0].skipReason, SKIP_REASONS.UNTRUSTED_URL);

  const oversized = await prepareAttachmentCopies(
    client,
    [source({ size: 100 * 1024 * 1024 })],
    { fetchImpl: transferFetch() }
  );
  assert.equal(oversized.descriptors[0].skipReason, SKIP_REASONS.TOO_LARGE);

  const download = await prepareAttachmentCopies(client, [source()], {
    fetchImpl: transferFetch({ downloadFails: true }),
  });
  assert.equal(
    download.descriptors[0].skipReason,
    SKIP_REASONS.DOWNLOAD_FAILED
  );

  const upload = await prepareAttachmentCopies(client, [source()], {
    fetchImpl: transferFetch({ uploadFails: true }),
  });
  assert.equal(upload.descriptors[0].skipReason, SKIP_REASONS.UPLOAD_FAILED);
});

test("a source message can archive qualifying media while visibly retaining failed metadata", async () => {
  const result = await prepareAttachmentCopies(
    client,
    [
      source(),
      source({ id: "ATT2", filename: "large.mov", size: 100 * 1024 * 1024 }),
    ],
    { fetchImpl: transferFetch() }
  );
  assert.deepEqual(result.uploadIds, ["COPY1"]);
  assert.equal(result.descriptors[0].archiveAttachmentId, "COPY1");
  assert.equal(result.descriptors[1].archiveAttachmentId, null);
  assert.equal(result.descriptors[1].skipReason, SKIP_REASONS.TOO_LARGE);
});

test("Logger send success binds a stable protected record and failure drops upload ids", async () => {
  const prepared = await prepareAttachmentCopies(client, [source()], {
    fetchImpl: transferFetch(),
  });
  const archived = finaliseArchiveDescriptors(prepared.descriptors, {
    _id: "LOGGER1",
  });
  assert.equal(archived[0].archiveRecordId, "LOGGER1");

  const failed = finaliseArchiveDescriptors(prepared.descriptors, undefined);
  assert.equal(failed[0].archiveAttachmentId, null);
  assert.equal(failed[0].skipReason, SKIP_REASONS.LOGGER_SEND_FAILED);
});

test("delete descriptions resolve the current Logger message and media-loss state", () => {
  const attachment = {
    ...source(),
    archiveAttachmentId: "COPY1",
    archiveUrl: "https://autumn.test/attachments/COPY1/proof.png",
    archiveRecordId: "LOGGER1",
    skipReason: null,
  };
  const live = resolveAttachmentArchive(
    { attachments: [attachment] },
    { getProtectedRecord: () => ({ messageId: "LOGGER2", mediaLost: false }) }
  );
  assert.deepEqual(live.replyMessageIds, ["LOGGER2"]);
  assert.match(live.lines[0], /archived in Logger record/);

  const lost = resolveAttachmentArchive(
    { attachments: [attachment] },
    { getProtectedRecord: () => ({ messageId: "LOGGER3", mediaLost: true }) }
  );
  assert.match(lost.lines[0], /removed the media/);
});

test("numeric legacy attachment journals remain readable", () => {
  const numeric = resolveAttachmentArchive({ attachments: 3 });
  assert.match(numeric.lines[0], /3 attachments/);
});

test("archive queue enforces concurrency and pending capacity", async () => {
  const queue = createAttachmentArchiveQueue({ concurrency: 1, maxPending: 2 });
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const first = queue.run(() => blocked);
  const second = queue.run(async () => "second");
  const third = queue.run(async () => "third");
  const fourth = await queue.run(async () => "fourth");
  assert.equal(fourth.accepted, false);
  release("first");
  assert.equal((await first).value, "first");
  assert.equal((await second).value, "second");
  assert.equal((await third).value, "third");
  assert.equal(queue.stats().rejected, 1);
});
