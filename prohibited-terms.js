// prohibited-terms.js — Word-aware prohibited-term matching for the post gate
// ────────────────────────────────────────────────────────────────────────────
// A slur posted once by an established member never trips automod: behavioural
// scoring needs a burst, a duplicate flood, or a mention flood to accumulate,
// and a single targeted word produces none of those. This module supplies the
// missing signal as a *detection only* primitive — post-gate.js turns a match
// into a hold for one moderator to look at, and nothing here ever bans, times
// out, or strikes anyone.
//
// The hard requirement is that matching is word- and phrase-aware rather than
// substring-based. Every generated pattern is anchored between
// (?<![\p{L}\p{N}]) and (?![\p{L}\p{N}]), and neither text projection ever
// removes separators, so `cunt` structurally cannot match inside `Scunthorpe`.
// Evasion is handled by normalising the *text* toward the term (NFKC, case
// folding, invisible-character stripping, diacritic folding, homoglyph and
// leetspeak folding, repeated-letter collapsing) and by optional bounded
// tolerance for separators inserted between a term's letters — never by
// deleting separators and searching the result, which is exactly what makes
// naive filters flag innocent words.
//
// The module is deliberately I/O-free and imports nothing but crypto, so it is
// testable on its own and store.js stays the only place that touches disk.
import { createHash } from "crypto";

// Stoat messages are far shorter than this, but keep the scan bounded so an
// unexpected payload cannot turn term matching into expensive work.
export const PROHIBITED_TERM_SCAN_LIMIT = 8_192;
export const MAX_PROHIBITED_TERMS = 200;
export const MAX_ALLOWLIST_ENTRIES = 200;
export const MAX_TERM_LENGTH = 64;

// The invisible-character class post-gate.js already uses for link detection
// (soft hyphen, combining grapheme joiner, Arabic letter mark, Mongolian vowel
// separator, the bidi and zero-width blocks, BOM), plus the C0/C1 control
// characters a message body should never carry meaning in.
const INVISIBLE_TERM_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  /(?:\u00AD|\u034F|\u061C|\u180E|[\u200B-\u200F]|[\u202A-\u202E]|[\u2060-\u206F]|\uFEFF|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F])/gu;
// Combining Diacritical Marks only. Stripping every \p{M} would mangle Arabic,
// Indic, and Hebrew text where marks are letters, manufacturing false
// positives in languages the list was never written for.
const COMBINING_MARKS = /[\u0300-\u036F]/gu;

// Letters from other scripts that are visually identical to Latin ones. These
// are folded unconditionally: they are already letters, so replacing them can
// never change where a word starts or ends.
const LETTER_CONFUSABLES = Object.freeze({
  ı: "i", // ı dotless i
  ĸ: "k", // ĸ kra
  ſ: "s", // ſ long s
  а: "a", // Cyrillic а
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  у: "y",
  ѕ: "s",
  і: "i",
  ј: "j",
  к: "k",
  м: "m",
  н: "h",
  т: "t",
  в: "b",
  α: "a", // Greek α
  ε: "e",
  ο: "o",
  ρ: "p",
  τ: "t",
  κ: "k",
  ι: "i",
  ν: "v",
});

// Leetspeak digits and symbols. These are folded **only inside a word**, where
// a run of them sits between two real letters — `n1gg3r` and `sh!t` fold, while
// `great!`, `$5`, `c++`, and the year `2000` keep their punctuation and so keep
// their word boundaries intact. Folding these unconditionally is what turns a
// trailing exclamation mark into a letter and silently breaks the boundary the
// whole matcher depends on.
const SYMBOL_CONFUSABLES = Object.freeze({
  0: "o",
  1: "i",
  3: "e",
  4: "a",
  5: "s",
  7: "t",
  8: "b",
  9: "g",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "i",
  "+": "t",
});

function confusableClass(table) {
  return Object.keys(table)
    .map((character) => character.replace(/[\\\]^-]/gu, "\\$&"))
    .join("");
}

const LETTER_CONFUSABLE_PATTERN = new RegExp(
  `[${confusableClass(LETTER_CONFUSABLES)}]`,
  "gu"
);
const SYMBOL_CONFUSABLE_PATTERN = new RegExp(
  `(?<=[\\p{L}])([${confusableClass(SYMBOL_CONFUSABLES)}]+)(?=[\\p{L}])`,
  "gu"
);

// Up to two separator characters may sit between the letters of a tolerant
// term, so `n i g g e r` and `n-i-g-g-e-r` match while the bound keeps the
// pattern from spanning a whole sentence.
const SEPARATOR_CLASS = "[\\s._\\-*'•]{0,2}";
// Words of a phrase may be separated by up to three non-alphanumerics.
const TOKEN_JOIN = "[^\\p{L}\\p{N}]{1,3}";
// A trailing plural is matched without needing a separate list entry. The stem
// still has to satisfy the leading boundary, so this cannot reach into a
// longer unrelated word.
const PLURAL_SUFFIX = "(?:e?s)?";
// Terms shorter than this get no intra-letter separator tolerance: spreading a
// three- or four-letter term across separators is where false positives come
// from, and short terms are already easy to spell out in full.
const TOLERANT_MIN_LENGTH = 5;

/**
 * The seed list. Deliberately small and limited to terms whose only ordinary
 * reading is the slur — everything situational belongs in the operator's own
 * data/prohibited_terms.json, which extends (never replaces) this list.
 *
 * Ids never spell the term out, so a log line or a review card can name the
 * rule that fired without repeating the word.
 */
export const BUILT_IN_PROHIBITED_TERMS = Object.freeze([
  { id: "builtin:racial-n-er", term: "nigger" },
  { id: "builtin:racial-n-a", term: "nigga" },
  { id: "builtin:racial-k", term: "kike" },
  { id: "builtin:racial-sp", term: "spic" },
  { id: "builtin:racial-ch", term: "chink" },
  { id: "builtin:racial-gk", term: "gook" },
  // "wet back" is an ordinary English phrase, so this one never gets
  // intra-letter separator tolerance.
  { id: "builtin:racial-wb", term: "wetback", tolerant: false },
  { id: "builtin:racial-bn", term: "beaner" },
  { id: "builtin:homophobic-f", term: "faggot" },
  { id: "builtin:transphobic-t", term: "tranny" },
  { id: "builtin:transphobic-sm", term: "shemale" },
  { id: "builtin:ableist-r", term: "retard" },
  { id: "builtin:ableist-r-ed", term: "retarded" },
]);

/**
 * Known-innocent words and phrases. An allowlist entry wins over any rule it
 * overlaps, so this both documents the classic false positives and gives
 * operators a worked example of the format.
 */
export const BUILT_IN_TERM_ALLOWLIST = Object.freeze([
  "scunthorpe",
  "penistone",
  "cockburn",
  "lightwater",
  "shiitake",
  "niggle",
  "niggling",
  "spic and span",
  "chink in the armour",
  "chink in the armor",
  "chink of light",
  "flame retardant",
  "fire retardant",
  "retardant",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\\-/]/gu, "\\$&");
}

function foldConfusables(text) {
  return text
    .replace(
      LETTER_CONFUSABLE_PATTERN,
      (character) => LETTER_CONFUSABLES[character] ?? character
    )
    .replace(SYMBOL_CONFUSABLE_PATTERN, (run) =>
      [...run].map((character) => SYMBOL_CONFUSABLES[character]).join("")
    );
}

/**
 * The shared normalization pipeline. Message content, rule terms, and
 * allowlist entries all pass through this identical function, so the two sides
 * of a comparison can never disagree about what a character means.
 */
export function normaliseTermText(value) {
  return foldConfusables(
    String(value ?? "")
      .slice(0, PROHIBITED_TERM_SCAN_LIMIT)
      .normalize("NFKC")
      .toLowerCase()
      .replace(INVISIBLE_TERM_CHARACTERS, "")
      .normalize("NFD")
      .replace(COMBINING_MARKS, "")
      .normalize("NFC")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

/**
 * Remove every separator, then collapse runs of the same character to one.
 * Used **only** as a prefilter key — never as a source to match against,
 * because searching a separator-free string is precisely the naive approach
 * that flags Scunthorpe.
 */
function squashKey(text) {
  return text
    .replace(/[^\p{L}\p{N}]/gu, "")
    .replace(/([\p{L}\p{N}])\1+/gu, "$1");
}

/**
 * Every character of a term compiles to `X+`, so a stretched `niiiiigger`
 * matches without a second text projection — and a term's own repeated letters
 * still have to appear at least that many times, so a term whose letters
 * collapse into a shorter innocent word cannot match that word.
 */
function buildPattern(term, tolerant) {
  const body = term
    .split(/\s+/u)
    .filter(Boolean)
    .map((token) =>
      [...token]
        .map((character) => `${escapeRegExp(character)}+`)
        .join(tolerant ? SEPARATOR_CLASS : "")
    )
    .join(TOKEN_JOIN);
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${body}${PLURAL_SUFFIX}(?![\\p{L}\\p{N}])`,
    "gu"
  );
}

function derivedRuleId(core) {
  return `t-${createHash("sha256").update(core).digest("hex").slice(0, 8)}`;
}

function compileEntry(entry, { tolerantAllowed }) {
  const source = typeof entry === "string" ? { term: entry } : entry;
  if (!source || typeof source.term !== "string") return null;
  const term = normaliseTermText(source.term);
  if (!term || term.length > MAX_TERM_LENGTH) return null;
  const core = squashKey(term);
  if (!core) return null;

  const tolerant =
    tolerantAllowed &&
    (typeof source.tolerant === "boolean"
      ? source.tolerant
      : term.replace(/[^\p{L}\p{N}]/gu, "").length >= TOLERANT_MIN_LENGTH);

  return {
    id:
      typeof source.id === "string" && source.id.trim()
        ? source.id.trim()
        : derivedRuleId(core),
    term,
    core,
    tolerant,
    pattern: buildPattern(term, tolerant),
  };
}

function compileList(entries, { limit, tolerantAllowed }) {
  const compiled = [];
  const seen = new Set();
  let skipped = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (compiled.length >= limit) {
      skipped += 1;
      continue;
    }
    const rule = compileEntry(entry, { tolerantAllowed });
    if (!rule) {
      skipped += 1;
      continue;
    }
    if (seen.has(rule.core)) continue;
    seen.add(rule.core);
    compiled.push(rule);
  }
  return { compiled, skipped };
}

/**
 * Compile a term list and its allowlist into the matcher's runtime shape.
 * Malformed entries are counted into `skipped` rather than thrown, so one bad
 * line in an operator's file can never take the filter offline.
 */
export function compileProhibitedTerms({ terms, allowlist } = {}) {
  const rules = compileList(terms, {
    limit: MAX_PROHIBITED_TERMS,
    tolerantAllowed: true,
  });
  const allow = compileList(allowlist, {
    limit: MAX_ALLOWLIST_ENTRIES,
    tolerantAllowed: false,
  });
  return {
    rules: rules.compiled,
    allow: allow.compiled,
    termCount: rules.compiled.length,
    allowCount: allow.compiled.length,
    skipped: rules.skipped + allow.skipped,
  };
}

function collectMatches(text, pattern, onMatch) {
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (end === start) {
      // A zero-width match cannot advance on its own; step past it manually so
      // the loop always terminates.
      pattern.lastIndex = start + 1;
      continue;
    }
    if (onMatch(start, end)) return { index: start };
    pattern.lastIndex = end;
  }
  return null;
}

function allowSpansFor(text, key, compiled) {
  const spans = [];
  for (const rule of compiled.allow) {
    if (!key.includes(rule.core)) continue;
    collectMatches(text, rule.pattern, (start, end) => {
      spans.push([start, end]);
      return false;
    });
  }
  return spans;
}

function overlapsAny(start, end, spans) {
  return spans.some(([from, to]) => start < to && from < end);
}

/**
 * Return the first prohibited-term hit an allowlist entry does not cover, or
 * null. The caller is expected to treat a hit as a reason to hold the message
 * for review — never as a finding to act on automatically.
 */
export function matchProhibitedTerm(content, compiled) {
  if (!compiled?.rules?.length) return null;
  const text = normaliseTermText(content);
  if (!text) return null;

  // Sound prefilter: a pattern only ever repeats a term's own characters and
  // inserts separators between them, so the term's squashed key must appear
  // contiguously in the message's squashed key for a match to be possible.
  // In practice this means no regex runs at all on ordinary prose.
  const key = squashKey(text);
  if (!compiled.rules.some((rule) => key.includes(rule.core))) return null;

  const spans = allowSpansFor(text, key, compiled);
  for (const rule of compiled.rules) {
    if (!key.includes(rule.core)) continue;
    const found = collectMatches(
      text,
      rule.pattern,
      (start, end) => !overlapsAny(start, end, spans)
    );
    if (found) {
      return { ruleId: rule.id, term: rule.term, index: found.index };
    }
  }
  return null;
}

/** One-line summary for /Post-Gate status and /Post-Gate terms. */
export function describeProhibitedTermList(compiled, list = {}) {
  const custom = Math.max(
    0,
    (compiled?.termCount ?? 0) - BUILT_IN_PROHIBITED_TERMS.length
  );
  const status =
    list.status === "malformed"
      ? " — ⚠️ the operator list could not be parsed and was ignored"
      : list.status === "missing"
        ? " — no operator list configured"
        : "";
  return `${compiled?.termCount ?? 0} term(s) (${BUILT_IN_PROHIBITED_TERMS.length} built-in, ${custom} custom), ${compiled?.allowCount ?? 0} allowlist entr(y/ies)${status}`;
}
