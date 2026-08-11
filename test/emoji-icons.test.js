import test from "node:test";
import assert from "node:assert/strict";
import { EMOJI_ICON_MANIFEST } from "../emoji-icons.js";
import { getEmojiMap } from "../config.js";

test("every manifest keyword exists in the Unicode emoji map", () => {
  const unicodeMap = getEmojiMap();
  for (const entry of EMOJI_ICON_MANIFEST) {
    assert.ok(
      entry.keyword in unicodeMap,
      `"${entry.keyword}" has no Unicode fallback in config.js`
    );
  }
});

test("manifest emoji names are unique, lowercase slugs", () => {
  const names = EMOJI_ICON_MANIFEST.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, "duplicate emoji names");
  for (const name of names) {
    assert.match(name, /^[a-z0-9_]{1,32}$/);
  }
});

test("every manifest url is https", () => {
  for (const entry of EMOJI_ICON_MANIFEST) {
    assert.match(entry.url, /^https:\/\//, entry.keyword);
  }
});

test("the manifest fits within the 100-emoji server cap", () => {
  assert.ok(EMOJI_ICON_MANIFEST.length <= 100, EMOJI_ICON_MANIFEST.length);
});

test("every entry has a valid tier for provisioning order", () => {
  for (const entry of EMOJI_ICON_MANIFEST) {
    assert.ok([1, 2, 3].includes(entry.tier), entry.keyword);
  }
});
