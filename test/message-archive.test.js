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

test("record → lookup round trip with attachment count", () => {
  archive.recordMessage({
    id: "msg1",
    channelId: "chanA",
    serverId: "srv1",
    authorId: "userA",
    content: "hello world",
    attachments: 2,
  });

  const entry = archive.getArchivedMessage("msg1");
  assert.equal(entry.content, "hello world");
  assert.equal(entry.channelId, "chanA");
  assert.equal(entry.serverId, "srv1");
  assert.equal(entry.authorId, "userA");
  assert.equal(entry.attachments, 2);
  assert.equal(archive.getArchivedMessage("nope"), null);
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
  const ancient = now - fresh.RETENTION_MS - 1000;

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
  const lines = readFileSync(archivePath, "utf-8").split("\n").filter((l) => l.trim());
  assert.ok(
    lines.length === fresh.archiveSize(),
    `journal should be compacted to live entries (lines=${lines.length}, live=${fresh.archiveSize()})`
  );
  assert.ok(lines.every((l) => JSON.parse(l).op === "create"));
});

test("count cap evicts the oldest entries", async () => {
  const fresh = await reimportArchive();
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
