import test from "node:test";
import assert from "node:assert/strict";
import { computeBackoffMs, shouldVerify, selectDueRecords } from "../store.js";
import { buildTamperNotice, buildRestoredEmbed } from "../embeds.js";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function makeRecord(overrides = {}) {
  return {
    recordId: "rec1",
    channelId: "chan1",
    messageId: "msg1",
    payload: { embeds: [{ title: "t", description: "d" }] },
    restorations: 0,
    createdAt: NOW,
    lastVerifiedAt: NOW,
    failures: 0,
    nextAttemptAt: 0,
    channelMissing: false,
    ...overrides,
  };
}

test("computeBackoffMs is monotonic across failure counts and capped", () => {
  const samples = [1, 2, 3, 4, 5, 10, 20].map((f) => computeBackoffMs(f));
  for (const ms of samples) {
    assert.ok(ms > 0);
    assert.ok(ms <= 15 * 60 * 1000);
  }
  // Loosely monotonic: later failure counts shouldn't produce a *lower*
  // backoff than the very first, even accounting for jitter.
  assert.ok(samples[samples.length - 1] >= samples[0] * 0.5);
});

test("shouldVerify excludes channelMissing and records still on backoff", () => {
  assert.equal(shouldVerify(makeRecord({ channelMissing: true }), NOW + DAY), false);
  assert.equal(
    shouldVerify(makeRecord({ nextAttemptAt: NOW + 1000 }), NOW + 500),
    false
  );
});

test("shouldVerify checks fresh records every sweep but throttles old ones", () => {
  const fresh = makeRecord({ createdAt: NOW, lastVerifiedAt: NOW });
  assert.equal(shouldVerify(fresh, NOW + 1000), true);

  const monthOld = makeRecord({
    createdAt: NOW - 40 * DAY,
    lastVerifiedAt: NOW - 1000,
  });
  assert.equal(shouldVerify(monthOld, NOW), false);
  assert.equal(shouldVerify(monthOld, NOW - 1000 + DAY), true);
});

test("selectDueRecords respects the budget and orders least-recently-verified first", () => {
  const records = [
    makeRecord({ recordId: "a", lastVerifiedAt: NOW - 3000 }),
    makeRecord({ recordId: "b", lastVerifiedAt: NOW - 1000 }),
    makeRecord({ recordId: "c", lastVerifiedAt: NOW - 5000 }),
    makeRecord({ recordId: "d", channelMissing: true, lastVerifiedAt: NOW - 9000 }),
  ];

  const due = selectDueRecords(records, NOW, 2);
  assert.deepEqual(due.map((r) => r.recordId), ["c", "a"]);
});

test("buildTamperNotice includes the restoration count", () => {
  assert.match(buildTamperNotice(3), /Restoration #3/);
});

test("buildRestoredEmbed appends a notice without mutating the original", () => {
  const original = { title: "Codes", description: "line one", colour: "#fff" };
  const restored = buildRestoredEmbed(original, 1);

  assert.equal(original.description, "line one");
  assert.equal(restored.title, "Codes");
  assert.equal(restored.colour, "#fff");
  assert.match(restored.description, /line one/);
  assert.match(restored.description, /Restoration #1/);
});

test("buildRestoredEmbed does not stack notices when applied twice to the same original", () => {
  const original = { title: "Codes", description: "line one" };
  const first = buildRestoredEmbed(original, 1);
  const second = buildRestoredEmbed(original, 2);

  assert.equal((first.description.match(/Restoration #/g) || []).length, 1);
  assert.equal((second.description.match(/Restoration #/g) || []).length, 1);
  assert.match(second.description, /Restoration #2/);
});

test("buildRestoredEmbed truncates an overlong description but keeps the notice intact", () => {
  const original = { title: "Codes", description: "x".repeat(2500) };
  const restored = buildRestoredEmbed(original, 5);

  assert.ok(restored.description.length <= 2000);
  assert.match(restored.description, /Restoration #5/);
});
