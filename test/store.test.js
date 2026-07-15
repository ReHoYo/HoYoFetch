// Tests for JSON-file persistence: channel subscriptions/scopes, new-code
// detection, and atomic writes. Runs hermetically against a temp data dir.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store;
let dataDir;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hoyofetch-test-"));
  process.env.HOYOFETCH_DATA_DIR = dataDir;
  // Import AFTER setting the env so the store reads the temp dir.
  store = await import("../store.js");
});

test("channel enable/disable lifecycle with scopes", () => {
  assert.equal(store.isChannelEnabled("chan-1"), false);

  store.enableChannel("chan-1", "hoyo");
  assert.equal(store.isChannelEnabled("chan-1"), true);
  assert.equal(store.getChannelScope("chan-1"), "hoyo");
  assert.deepEqual(store.getEnabledChannels(), [{ id: "chan-1", scope: "hoyo" }]);

  // Re-enabling with a new scope reports the change.
  const result = store.enableChannel("chan-1", "nte");
  assert.equal(result.wasEnabled, true);
  assert.equal(result.previousScope, "hoyo");
  assert.equal(result.currentScope, "nte");
  assert.equal(result.changed, true);

  store.disableChannel("chan-1");
  assert.equal(store.isChannelEnabled("chan-1"), false);
  assert.deepEqual(store.getEnabledChannels(), []);
});

test("invalid scope normalises to 'all'", () => {
  store.enableChannel("chan-scope", "bogus");
  assert.equal(store.getChannelScope("chan-scope"), "all");
});

test("writes are atomic and produce valid JSON (no leftover .tmp)", () => {
  store.enableChannel("chan-2", "all");
  const path = join(dataDir, "channels.json");
  assert.ok(existsSync(path));
  // Must parse cleanly...
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  assert.equal(parsed["chan-2"].enabled, true);
  // ...and the temp file must have been renamed away.
  assert.equal(existsSync(`${path}.tmp`), false);
});

test("detectNewCodes returns only unseen codes and remembers them", () => {
  assert.deepEqual(store.detectNewCodes("genshin", ["A", "B"]).sort(), ["A", "B"]);
  assert.deepEqual(store.detectNewCodes("genshin", ["B", "C"]), ["C"]);
  assert.deepEqual(store.detectNewCodes("genshin", ["B", "C"]), []);
});

test("detectNewCodes ignores empty input so it can't wipe known codes", () => {
  store.detectNewCodes("hkrpg", ["X", "Y"]);
  assert.deepEqual(store.detectNewCodes("hkrpg", []), []);
  // X and Y are still known afterwards; only Z is new.
  assert.deepEqual(store.detectNewCodes("hkrpg", ["X", "Y", "Z"]), ["Z"]);
});

test("seedKnownCodes + hasSeenGame", () => {
  assert.equal(store.hasSeenGame("nap"), false);
  store.seedKnownCodes("nap", ["SEED1", "SEED2"]);
  assert.equal(store.hasSeenGame("nap"), true);
  assert.deepEqual(store.detectNewCodes("nap", ["SEED1", "SEED2"]), []);
});

test("source cache round-trips through atomic writes", () => {
  assert.equal(store.getSourceCache("nte"), null);
  store.setSourceCache("nte", { lastAttemptAt: 123, codes: [] });
  assert.deepEqual(store.getSourceCache("nte"), { lastAttemptAt: 123, codes: [] });
});

test("audit log channel configuration round-trips and disables", () => {
  const result = store.setAuditLogChannel("server-audit", "channel-audit");
  assert.equal(result.changed, true);
  assert.equal(store.getAuditLogChannel("server-audit"), "channel-audit");
  store.disableAuditLog("server-audit");
  assert.equal(store.getAuditLogChannel("server-audit"), null);
});
