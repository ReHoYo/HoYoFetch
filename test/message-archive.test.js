// Tests for the append-only message archive: record/lookup, edit history,
// journal replay across "restarts", retention pruning, compaction, count cap,
// and resilience to corrupt journal lines. Runs against a temp data dir.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let archive;
let dataDir;
let archivePath;
let reimportCounter = 0;

// Force a fresh module instance (fresh in-memory state) that replays the same
// journal file — simulates a bot restart.
async function reimportArchive() {
  reimportCounter++;
  return import(`../message-archive.js?replay=${reimportCounter}`);
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hoyofetch-archive-test-"));
  process.env.HOYOFETCH_DATA_DIR = dataDir;
  archivePath = join(dataDir, "message_archive.jsonl");
  // Import AFTER setting the env so the archive writes to the temp dir.
  archive = await import("../message-archive.js");
});

test("record → lookup round trip with attachment descriptors", () => {
  const descriptors = [
    {
      id: "att1",
      filename: "a.png",
      size: 100,
      contentType: "image/png",
      url: "https://x/a.png",
      evidencePath: null,
    },
    {
      id: "att2",
      filename: "b.png",
      size: 200,
      contentType: "image/png",
      url: "https://x/b.png",
      evidencePath: "/data/evidence/msg1_1.png",
    },
  ];
  archive.recordMessage({
    id: "msg1",
    channelId: "chanA",
    serverId: "srv1",
    authorId: "userA",
    content: "hello world",
    attachments: descriptors,
  });

  const entry = archive.getArchivedMessage("msg1");
  assert.equal(entry.content, "hello world");
  assert.equal(entry.channelId, "chanA");
  assert.equal(entry.serverId, "srv1");
  assert.equal(entry.authorId, "userA");
  assert.deepEqual(entry.attachments, descriptors);
  assert.equal(archive.getArchivedMessage("nope"), null);
});

test("recordMessage defaults attachments to an empty array", () => {
  archive.recordMessage({
    id: "msgNoAttachments",
    channelId: "chanA",
    serverId: "srv1",
    authorId: "userA",
    content: "no files here",
  });
  assert.deepEqual(
    archive.getArchivedMessage("msgNoAttachments").attachments,
    []
  );
});

test("metadata queries filter by server, author, and time without content", () => {
  const now = Date.now();
  archive.recordMessage({
    id: "queryRecent",
    channelId: "chanQuery",
    serverId: "srvQuery",
    authorId: "userQuery",
    content: "must not be returned",
    createdAt: now - 1_000,
  });
  archive.recordMessage({
    id: "queryOld",
    channelId: "chanQuery",
    serverId: "srvQuery",
    authorId: "userQuery",
    content: "old",
    createdAt: now - 100_000,
  });
  const matches = archive.findArchivedMessages({
    serverId: "srvQuery",
    authorId: "userQuery",
    since: now - 10_000,
    until: now,
  });
  assert.deepEqual(matches, [
    {
      id: "queryRecent",
      channelId: "chanQuery",
      serverId: "srvQuery",
      authorId: "userQuery",
      createdAt: now - 1_000,
    },
  ]);
  assert.equal(Object.hasOwn(matches[0], "content"), false);
  assert.equal(archive.getArchiveCoverage("srvQuery").count, 2);
  assert.equal(archive.markMessageDeleted("queryRecent", now), true);
  assert.equal(
    archive.findArchivedMessages({
      serverId: "srvQuery",
      authorId: "userQuery",
      since: now - 10_000,
      until: now,
    }).length,
    0
  );
  assert.equal(
    archive.getArchivedMessage("queryRecent").content,
    "must not be returned"
  );
});

test("legacy numeric attachment counts survive journal replay unchanged", async () => {
  appendFileSync(
    archivePath,
    JSON.stringify({
      op: "create",
      id: "legacyMsg",
      channelId: "chanA",
      serverId: "srv1",
      authorId: "userA",
      content: "old format",
      attachments: 3,
      createdAt: Date.now(),
    }) + "\n",
    "utf-8"
  );

  const rebooted = await reimportArchive();
  assert.equal(rebooted.getArchivedMessage("legacyMsg").attachments, 3);
});

test("applyEdit returns previous content and updates the entry", () => {
  archive.recordMessage({
    id: "msg2",
    channelId: "chanA",
    serverId: "srv1",
    authorId: "userA",
    content: "first",
  });

  assert.equal(archive.applyEdit("msg2", "second"), "first");
  assert.equal(archive.applyEdit("msg2", "third"), "second");
  assert.equal(archive.getArchivedMessage("msg2").content, "third");

  // Editing an unknown message is a no-op that reports unknown before-state.
  assert.equal(archive.applyEdit("ghost", "x"), undefined);
});

test("purgeChannelFromArchive removes only one channel and returns evidence paths", async () => {
  archive.recordMessage({
    id: "privacyOne",
    channelId: "privacyChannel",
    serverId: "srv1",
    authorId: "userA",
    content: "private",
    attachments: [{ evidencePath: "/evidence/private.png" }],
  });
  archive.recordMessage({
    id: "publicOne",
    channelId: "publicChannel",
    serverId: "srv1",
    authorId: "userA",
    content: "public",
  });

  assert.deepEqual(archive.purgeChannelFromArchive("privacyChannel"), [
    "/evidence/private.png",
  ]);
  assert.equal(archive.getArchivedMessage("privacyOne"), null);
  assert.equal(archive.getArchivedMessage("publicOne").content, "public");

  const rebooted = await reimportArchive();
  assert.equal(rebooted.getArchivedMessage("privacyOne"), null);
  assert.equal(rebooted.getArchivedMessage("publicOne").content, "public");
});

test("journal replays across restarts, including edits", async () => {
  archive.recordMessage({
    id: "msg3",
    channelId: "chanB",
    serverId: "srv1",
    authorId: "userB",
    content: "original",
  });
  archive.applyEdit("msg3", "edited");

  const rebooted = await reimportArchive();
  const entry = rebooted.getArchivedMessage("msg3");
  assert.equal(entry.content, "edited");
  assert.equal(entry.authorId, "userB");
  // Earlier messages survive too.
  assert.equal(rebooted.getArchivedMessage("msg1").content, "hello world");
});

test("corrupt journal lines are skipped on replay", async () => {
  appendFileSync(archivePath, "{not valid json!!\n", "utf-8");
  appendFileSync(archivePath, '"just a string"\n', "utf-8");

  const rebooted = await reimportArchive();
  assert.equal(rebooted.getArchivedMessage("msg1").content, "hello world");
  assert.equal(rebooted.getArchivedMessage("msg3").content, "edited");
});

test("retention prune drops expired entries and compaction rewrites the journal", async () => {
  const fresh = await reimportArchive();
  const now = Date.now();
  const ancient = fresh.retentionCutoff(now) - 1000;

  // Old entries first (Map insertion order is what prune relies on).
  for (let i = 0; i < 1200; i++) {
    fresh.recordMessage({
      id: `old${i}`,
      channelId: "chanC",
      serverId: "srv1",
      authorId: "userC",
      content: `stale ${i}`,
      createdAt: ancient,
    });
  }
  fresh.recordMessage({
    id: "recent1",
    channelId: "chanC",
    serverId: "srv1",
    authorId: "userC",
    content: "still fresh",
    createdAt: now,
  });

  fresh.pruneArchive(now);

  assert.equal(fresh.getArchivedMessage("old0"), null);
  assert.equal(fresh.getArchivedMessage("old1199"), null);
  assert.equal(fresh.getArchivedMessage("recent1").content, "still fresh");

  // Dead entries vastly outnumbered live ones → journal must have compacted.
  const lines = readFileSync(archivePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim());
  assert.ok(
    lines.length === fresh.archiveSize(),
    `journal should be compacted to live entries (lines=${lines.length}, live=${fresh.archiveSize()})`
  );
  assert.ok(lines.every((l) => JSON.parse(l).op === "create"));
});

test("count cap evicts the oldest entries", async () => {
  // The production default is 1,000,000 — override it for this reimport so
  // the test doesn't have to write a million messages to exercise eviction.
  process.env.HOYOFETCH_ARCHIVE_MAX_MESSAGES = "50";
  const fresh = await reimportArchive();
  delete process.env.HOYOFETCH_ARCHIVE_MAX_MESSAGES;

  assert.equal(fresh.MAX_MESSAGES, 50);
  const base = fresh.archiveSize();
  const toAdd = fresh.MAX_MESSAGES - base + 5;

  for (let i = 0; i < toAdd; i++) {
    fresh.recordMessage({
      id: `cap${i}`,
      channelId: "chanD",
      serverId: "srv1",
      authorId: "userD",
      content: `filler ${i}`,
    });
  }

  assert.equal(fresh.archiveSize(), fresh.MAX_MESSAGES);
  // The newest entry is present; the oldest pre-existing entries were evicted.
  assert.ok(fresh.getArchivedMessage(`cap${toAdd - 1}`));
});

test("countArchivedMessages counts by author, excludes soft-deleted, and respects since", () => {
  const now = Date.now();
  archive.recordMessage({
    id: "countA1",
    channelId: "chanCount",
    serverId: "srvCount",
    authorId: "userCount",
    content: "one",
    createdAt: now - 3_000,
  });
  archive.recordMessage({
    id: "countA2",
    channelId: "chanCount",
    serverId: "srvCount",
    authorId: "userCount",
    content: "two",
    createdAt: now - 2_000,
  });
  archive.recordMessage({
    id: "countA3ToDelete",
    channelId: "chanCount",
    serverId: "srvCount",
    authorId: "userCount",
    content: "three (will be deleted)",
    createdAt: now - 1_000,
  });
  archive.recordMessage({
    id: "countOtherAuthor",
    channelId: "chanCount",
    serverId: "srvCount",
    authorId: "someoneElse",
    content: "not counted",
    createdAt: now,
  });

  assert.equal(
    archive.countArchivedMessages({
      serverId: "srvCount",
      authorId: "userCount",
    }),
    3
  );

  archive.markMessageDeleted("countA3ToDelete", now);
  assert.equal(
    archive.countArchivedMessages({
      serverId: "srvCount",
      authorId: "userCount",
    }),
    2
  );

  assert.equal(
    archive.countArchivedMessages({
      serverId: "srvCount",
      authorId: "userCount",
      since: now - 2_500,
    }),
    1
  );
});

test("boot replay streams a journal larger than one read chunk, preserving multi-byte content", async () => {
  const emoji = "🎉"; // 4-byte UTF-8 character, deliberately likely to straddle a chunk boundary somewhere across many entries
  const padding = "x".repeat(2_000);
  const messageCount = 700; // ~2KB/entry × 700 ≈ 1.4MB, past the 1MB read-chunk size

  for (let i = 0; i < messageCount; i++) {
    archive.recordMessage({
      id: `stream${i}`,
      channelId: "chanStream",
      serverId: "srvStream",
      authorId: "userStream",
      content: `${padding} celebration ${emoji} #${i}`,
      createdAt: Date.now(),
    });
  }

  const rebooted = await reimportArchive();
  assert.equal(
    rebooted.countArchivedMessages({
      serverId: "srvStream",
      authorId: "userStream",
    }),
    messageCount
  );
  for (const i of [0, 1, 349, 350, 699]) {
    assert.equal(
      rebooted.getArchivedMessage(`stream${i}`).content,
      `${padding} celebration ${emoji} #${i}`
    );
  }
});
