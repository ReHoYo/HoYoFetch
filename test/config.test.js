// Tests for config: game registry integrity and the runtime emoji-mode toggle.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  GAMES,
  COMMAND_GAME_MAP,
  HOYO_GAME_KEYS,
  NTE_GAME_KEY,
  getEmojiMode,
  setEmojiMode,
  getEmojiMap,
} from "../config.js";

afterEach(() => setEmojiMode("unicode")); // restore default

test("every command maps to a real game with a source", () => {
  for (const gameKey of Object.values(COMMAND_GAME_MAP)) {
    const game = GAMES[gameKey];
    assert.ok(game, `missing game for ${gameKey}`);
    assert.ok(game.source, `game ${gameKey} has no source`);
  }
});

test("scope game-key lists reference real games", () => {
  for (const key of [...HOYO_GAME_KEYS, NTE_GAME_KEY]) {
    assert.ok(GAMES[key], `unknown game key ${key}`);
  }
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
