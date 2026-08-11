// Tests for config: game registry integrity and the runtime emoji-mode toggle.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  GAMES,
  COMMAND_GAME_MAP,
  GAME8_GAME_KEYS,
  HOYO_GAME_KEYS,
  NTE_GAME_KEY,
  WUWA_GAME_KEY,
  getEmojiMode,
  setEmojiMode,
  getEmojiMap,
  getCustomEmojiRegistry,
  setCustomEmojiRegistry,
} from "../config.js";

const SEED_REGISTRY = getCustomEmojiRegistry();

afterEach(() => {
  setEmojiMode("unicode"); // restore default
  setCustomEmojiRegistry(SEED_REGISTRY); // restore the hardcoded seed
});

test("every command maps to a real game with a source", () => {
  for (const gameKey of Object.values(COMMAND_GAME_MAP)) {
    const game = GAMES[gameKey];
    assert.ok(game, `missing game for ${gameKey}`);
    assert.ok(game.source, `game ${gameKey} has no source`);
  }
});

test("scope game-key lists reference real games", () => {
  for (const key of [
    ...HOYO_GAME_KEYS,
    ...GAME8_GAME_KEYS,
    NTE_GAME_KEY,
    WUWA_GAME_KEY,
  ]) {
    assert.ok(GAMES[key], `unknown game key ${key}`);
  }
  assert.deepEqual(GAME8_GAME_KEYS, ["nte", "wuwa"]);
});

test("default emoji mode is unicode with real emoji characters", () => {
  assert.equal(getEmojiMode(), "unicode");
  assert.equal(getEmojiMap().primogem, "💎");
});

test("setEmojiMode switches to custom; getEmojiMap merges overrides", () => {
  assert.equal(setEmojiMode("custom"), true);
  assert.equal(getEmojiMode(), "custom");
  // primogem has a custom :id: override...
  assert.match(getEmojiMap().primogem, /^:.*:$/);
  // ...and keys without a custom override fall back to the unicode value.
  assert.equal(getEmojiMap().resin, "🌙");
});

test("setEmojiMode rejects invalid values and leaves mode unchanged", () => {
  assert.equal(setEmojiMode("custom"), true);
  assert.equal(setEmojiMode("rainbow"), false);
  assert.equal(getEmojiMode(), "custom");
});

test("setCustomEmojiRegistry applies provisioned ids while un-provisioned keywords keep Unicode", () => {
  setEmojiMode("custom");
  const applied = setCustomEmojiRegistry({
    "mystic enhancement ore": ":01ABCDEFGHJKMNPQRSTVWXYZ0:",
  });

  assert.equal(applied, 1);
  assert.equal(
    getEmojiMap()["mystic enhancement ore"],
    ":01ABCDEFGHJKMNPQRSTVWXYZ0:"
  );
  // A keyword the registry never touched keeps its Unicode fallback.
  assert.equal(getEmojiMap().resin, "🌙");
});

test("setCustomEmojiRegistry drops malformed entries and keeps the seed", () => {
  setEmojiMode("custom");
  const before = getEmojiMap().primogem;

  const applied = setCustomEmojiRegistry({
    primogem: "nope",
    mora: ":bad id:",
    resin: 123,
    "fine enhancement ore": null,
  });

  assert.equal(applied, 0);
  assert.equal(getEmojiMap().primogem, before);
});

test("unicode mode ignores the custom registry entirely", () => {
  setCustomEmojiRegistry({ primogem: ":01ABCDEFGHJKMNPQRSTVWXYZ0:" });
  assert.equal(getEmojiMode(), "unicode");
  assert.equal(getEmojiMap().primogem, "💎");
});

test("an empty registry leaves the seeded ids intact", () => {
  setEmojiMode("custom");
  setCustomEmojiRegistry({});
  assert.match(getEmojiMap().primogem, /^:.*:$/);
  assert.equal(getEmojiMap().primogem, SEED_REGISTRY.primogem);
});
