// Tests for the post gate's prohibited-term matcher: the shared normalization
// pipeline, word/phrase-aware boundaries (the Scunthorpe guarantee), evasion
// resistance, allowlist precedence, and the compile-time caps that keep the
// scan bounded. Pure functions — no data dir, no store, no client.
import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILT_IN_PROHIBITED_TERMS,
  BUILT_IN_TERM_ALLOWLIST,
  MAX_ALLOWLIST_ENTRIES,
  MAX_PROHIBITED_TERMS,
  MAX_TERM_LENGTH,
  compileProhibitedTerms,
  describeProhibitedTermList,
  matchProhibitedTerm,
  normaliseTermText,
} from "../prohibited-terms.js";

// A stand-in with the same shape as a real rule, so the tests never need to
// spell a slur out to prove the matcher works.
const SAMPLE = "flurbex";
const SAMPLE_PHRASE = "grebble wort";

function compile(terms, allowlist = []) {
  return compileProhibitedTerms({ terms, allowlist });
}

// Distinct filler terms with no two adjacent characters equal, so none of them
// collapse into each other under the matcher's prefilter key.
const FILLER_ALPHABET = "abcdefghijkl";
function fillerTerm(index) {
  const at = (place) =>
    FILLER_ALPHABET[Math.floor(index / place) % FILLER_ALPHABET.length];
  return `q${at(1)}x${at(12)}y${at(144)}z`;
}

const builtIns = compile(
  [...BUILT_IN_PROHIBITED_TERMS],
  [...BUILT_IN_TERM_ALLOWLIST]
);

test("normalises fullwidth, zero-width, diacritic, and homoglyph spellings to one canonical form", () => {
  const canonical = normaliseTermText("flurbex");
  assert.equal(normaliseTermText("FLURBEX"), canonical);
  assert.equal(normaliseTermText("ｆｌｕｒｂｅｘ"), canonical);
  assert.equal(normaliseTermText("flu​rbex"), canonical);
  assert.equal(normaliseTermText("flu­rbex"), canonical);
  assert.equal(normaliseTermText("flürbéx"), canonical);
  assert.equal(normaliseTermText("flurbеx"), canonical); // Cyrillic е
  assert.equal(normaliseTermText("flurb3x"), canonical);
  assert.equal(normaliseTermText("  flurbex \n "), canonical);
});

test("matches a seeded term as a standalone word", () => {
  const compiled = compile([SAMPLE]);
  assert.ok(matchProhibitedTerm(`what a ${SAMPLE} thing to say`, compiled));
  assert.ok(matchProhibitedTerm(`${SAMPLE}!`, compiled));
  assert.ok(matchProhibitedTerm(`${SAMPLE}s are everywhere`, compiled));
  assert.equal(matchProhibitedTerm("nothing to see here", compiled), null);
});

test("does not match a seeded term inside a longer word", () => {
  const compiled = compile(["cunt"]);
  assert.equal(matchProhibitedTerm("I live in Scunthorpe", compiled), null);
  assert.equal(matchProhibitedTerm("the viscount arrived", compiled), null);
  // The same term standing alone still matches, so this is a boundary rule
  // rather than the term being quietly dropped.
  assert.ok(matchProhibitedTerm("you cunt", compiled));
});

test("matches a term written with separators between its letters", () => {
  const compiled = compile([SAMPLE]);
  for (const evasion of [
    "f l u r b e x",
    "f-l-u-r-b-e-x",
    "f.l.u.r.b.e.x",
    "f_l_u_r_b_e_x",
    "f*l*u*r*b*e*x",
  ]) {
    assert.ok(
      matchProhibitedTerm(`say ${evasion} again`, compiled),
      `expected a hold for ${evasion}`
    );
  }
});

test("matches a term with stretched repeated letters", () => {
  const compiled = compile([SAMPLE]);
  assert.ok(matchProhibitedTerm("fllllurbeeeex", compiled));
  assert.ok(matchProhibitedTerm("ffflurbex", compiled));
});

test("a term's own repeated letters are still required", () => {
  // "gg" must appear at least twice, so a shorter innocent spelling that only
  // differs by a collapsed run cannot be caught by the stretch tolerance.
  const compiled = compile(["diggle"]);
  assert.ok(matchProhibitedTerm("diggle", compiled));
  assert.ok(matchProhibitedTerm("digggggle", compiled));
  assert.equal(matchProhibitedTerm("a digle of water", compiled), null);
});

test("matches a multi-word phrase across up to three separator characters", () => {
  const compiled = compile([SAMPLE_PHRASE]);
  assert.ok(matchProhibitedTerm("a grebble wort here", compiled));
  assert.ok(matchProhibitedTerm("a grebble - wort here", compiled));
  assert.ok(matchProhibitedTerm("a grebble...wort here", compiled));
  assert.equal(
    matchProhibitedTerm("grebble is a long way from wort", compiled),
    null
  );
});

test("an allowlist entry overlapping the match suppresses the hold", () => {
  const compiled = compile(["flurb"], ["flurb sauce"]);
  assert.equal(matchProhibitedTerm("pass the flurb sauce", compiled), null);
});

test("an allowlisted phrase does not rescue the same term used standalone in the same message", () => {
  const compiled = compile(["flurb"], ["flurb sauce"]);
  const hit = matchProhibitedTerm("pass the flurb sauce, you flurb", compiled);
  assert.ok(hit, "the standalone use should still be held");
  // The surviving match is the second, unprotected occurrence.
  assert.ok(hit.index > "pass the flurb sauce".length - 6);
});

test("short terms do not get intra-letter separator tolerance", () => {
  const short = compile(["frob"]);
  assert.ok(matchProhibitedTerm("frob", short));
  assert.equal(matchProhibitedTerm("f r o b", short), null);

  const long = compile([SAMPLE]);
  assert.ok(matchProhibitedTerm("f l u r b e x", long));

  // An explicit flag overrides the length default in both directions.
  const forced = compile([{ term: "frob", tolerant: true }]);
  assert.ok(matchProhibitedTerm("f r o b", forced));
  const suppressed = compile([{ term: SAMPLE, tolerant: false }]);
  assert.equal(matchProhibitedTerm("f l u r b e x", suppressed), null);
});

test("compilation caps the term list, the allowlist, and term length and reports what it skipped", () => {
  const tooMany = Array.from(
    { length: MAX_PROHIBITED_TERMS + 25 },
    (_, index) => fillerTerm(index)
  );
  const compiled = compile(
    tooMany,
    tooMany.slice(0, MAX_ALLOWLIST_ENTRIES + 5)
  );
  assert.equal(compiled.termCount, MAX_PROHIBITED_TERMS);
  assert.equal(compiled.allowCount, MAX_ALLOWLIST_ENTRIES);
  assert.equal(compiled.skipped, 30);

  const malformed = compile(
    [
      "ok",
      "",
      "   ",
      null,
      42,
      { nope: true },
      "x".repeat(MAX_TERM_LENGTH + 1),
    ],
    []
  );
  assert.equal(malformed.termCount, 1);
  assert.equal(malformed.skipped, 6);
});

test("duplicate spellings collapse to one rule", () => {
  const compiled = compile([SAMPLE, "FLURBEX", "f l u r b e x", "flürbex"]);
  assert.equal(compiled.termCount, 1);
});

test("an 8 KB message with a full term list and no match returns null without pathological work", () => {
  const filler = Array.from({ length: MAX_PROHIBITED_TERMS }, (_, index) =>
    fillerTerm(index)
  );
  const compiled = compile(filler, [...BUILT_IN_TERM_ALLOWLIST]);
  const message = "lorem ipsum dolor sit amet consectetur ".repeat(250);
  assert.ok(message.length > 8_000);

  const startedAt = process.hrtime.bigint();
  assert.equal(matchProhibitedTerm(message, compiled), null);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(elapsedMs < 250, `scan took ${elapsedMs}ms`);
});

test("derived rule ids are stable across list reordering", () => {
  const forward = compile([SAMPLE, "grebble", "wobbat"]);
  const reversed = compile(["wobbat", "grebble", SAMPLE]);
  const byTerm = (compiled) =>
    Object.fromEntries(compiled.rules.map((rule) => [rule.term, rule.id]));
  assert.deepEqual(byTerm(forward), byTerm(reversed));
  for (const rule of forward.rules) assert.match(rule.id, /^t-[0-9a-f]{8}$/);
});

test("a supplied rule id is preserved so a hold can name the rule, not the term", () => {
  const compiled = compile([{ id: "local:example", term: SAMPLE }]);
  const hit = matchProhibitedTerm(`a ${SAMPLE} appears`, compiled);
  assert.equal(hit.ruleId, "local:example");
});

test("an empty or absent term list never matches", () => {
  assert.equal(matchProhibitedTerm("anything at all", compile([])), null);
  assert.equal(matchProhibitedTerm("anything at all", null), null);
  assert.equal(matchProhibitedTerm(null, builtIns), null);
  assert.equal(matchProhibitedTerm("", builtIns), null);
});

test("the built-in list holds a slur but not its documented false positives", () => {
  assert.ok(builtIns.termCount > 0);
  for (const innocent of [
    "I live in Scunthorpe",
    "a chink in the armour",
    "flame retardant material",
    "spic and span",
    "that is niggling me",
    "the wet back of the truck",
    "Niger is a country in Africa",
    "the bookkeeper cooperated",
  ]) {
    assert.equal(
      matchProhibitedTerm(innocent, builtIns),
      null,
      `expected no hold for ${JSON.stringify(innocent)}`
    );
  }
});

test("the summary line reports built-in, custom, and allowlist counts with the file status", () => {
  const compiled = compile(
    [...BUILT_IN_PROHIBITED_TERMS, "flurbex"],
    [...BUILT_IN_TERM_ALLOWLIST]
  );
  const summary = describeProhibitedTermList(compiled, { status: "ok" });
  assert.match(
    summary,
    new RegExp(`${BUILT_IN_PROHIBITED_TERMS.length} built-in`)
  );
  assert.match(summary, /1 custom/);
  assert.match(
    describeProhibitedTermList(compiled, { status: "malformed" }),
    /could not be parsed/
  );
  assert.match(
    describeProhibitedTermList(compiled, { status: "missing" }),
    /no operator list configured/
  );
});
