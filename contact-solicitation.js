// contact-solicitation.js — Bounded DM and off-platform contact detection
// ────────────────────────────────────────────────────────────────────────────
// This module is detection-only. A match is a reason for Post Gate to ask a
// moderator to review an account; it is never proof of abuse and never applies
// a strike, timeout, or ban by itself.

export const CONTACT_SOLICITATION_SCAN_LIMIT = 8_192;

const INVISIBLE_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- these characters carry no legitimate matching meaning
  /(?:\u00AD|\u034F|\u061C|\u180E|[\u200B-\u200F]|[\u202A-\u202E]|[\u2060-\u206F]|\uFEFF|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F])/gu;
const COMBINING_MARKS = /[\u0300-\u036F]/gu;
const DOT_LIKE = /[\u2024\u2027\u2219\u22C5\u3002\uFE52\uFF0E\uFF61]/gu;
const COLON_LIKE = /[\u02D0\u0589\u2236\uFE13\uFE55\uFF1A]/gu;
const SLASH_LIKE = /[\u2044\u2215\u29F8\uFF0F]/gu;

const LETTER_CONFUSABLES = Object.freeze({
  ı: "i",
  ſ: "s",
  а: "a",
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
  α: "a",
  ε: "e",
  ο: "o",
  ρ: "p",
  τ: "t",
  κ: "k",
  ι: "i",
  ν: "v",
});
const SYMBOL_CONFUSABLES = Object.freeze({
  0: "o",
  1: "i",
  3: "e",
  4: "a",
  5: "s",
  7: "t",
  8: "b",
  9: "g",
  $: "s",
  "!": "i",
  "|": "i",
});

function regexClass(values) {
  return Object.keys(values)
    .map((character) => character.replace(/[\\\]^-]/gu, "\\$&"))
    .join("");
}

const LETTER_CONFUSABLE_PATTERN = new RegExp(
  `[${regexClass(LETTER_CONFUSABLES)}]`,
  "gu"
);
const SYMBOL_CONFUSABLE_PATTERN = new RegExp(
  `(?<=[\\p{L}])([${regexClass(SYMBOL_CONFUSABLES)}]+)(?=[\\p{L}])`,
  "gu"
);

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

function normalise(value) {
  return foldConfusables(
    String(value ?? "")
      .slice(0, CONTACT_SOLICITATION_SCAN_LIMIT)
      .normalize("NFKC")
      .toLowerCase()
      .replace(INVISIBLE_CHARACTERS, "")
      .replace(DOT_LIKE, ".")
      .replace(COLON_LIKE, ":")
      .replace(SLASH_LIKE, "/")
      .replace(
        /(?:\[\s*(?:\.|dot)\s*\]|\(\s*(?:\.|dot)\s*\)|\{\s*(?:\.|dot)\s*\})/giu,
        "."
      )
      .normalize("NFD")
      .replace(COMBINING_MARKS, "")
      .normalize("NFC")
  )
    .replace(/([\p{L}\p{N}])\1{2,}/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\\-/]/gu, "\\$&");
}

const LETTER_GAP = "[\\s._\\-*'\u2022]{0,2}";
const WORD_GAP = "[^\\p{L}\\p{N}]{1,3}";

function word(value, { plural = false } = {}) {
  const body = [...normalise(value).replace(/[^\p{L}\p{N}]/gu, "")]
    .map(escapeRegExp)
    .join(LETTER_GAP);
  return `${body}${plural ? "(?:e?s)?" : ""}`;
}

function phrase(...values) {
  return values.map((value) => word(value)).join(WORD_GAP);
}

function bounded(body, flags = "iu") {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, flags);
}

const DM_NOUN = [
  `${word("dm")}(?:${LETTER_GAP}s)?`,
  phrase("direct", "message") + "s?",
  phrase("private", "message") + "s?",
  `${word("pm")}(?:${LETTER_GAP}s)?`,
  word("inbox"),
].join("|");
const AVAILABILITY = [
  word("open"),
  word("available"),
  word("welcome"),
  word("allowed"),
  word("accepting"),
  word("okay"),
  word("ok"),
].join("|");
const SHORT_BRIDGE = "[^\\n\\r]{0,24}?";

const DM_AVAILABILITY_PATTERN = bounded(
  `(?:${DM_NOUN})${SHORT_BRIDGE}(?:${AVAILABILITY})|(?:${AVAILABILITY})${SHORT_BRIDGE}(?:${DM_NOUN})`
);
const DM_INVITATION_PATTERN = bounded(
  `(?:${word("dm")}|${word("pm")}|${word("message")}|${word("contact")}|${word("add")}|${word("follow")}|${phrase("reach", "out", "to")})${WORD_GAP}(?:${word("me")}|${word("us")})`
);
const DM_AVAILABILITY_NEGATION_PATTERNS = [
  bounded(
    `(?:${DM_NOUN})${SHORT_BRIDGE}(?:${word("closed")}|${word("disabled")}|${word("off")}|${word("not")}${WORD_GAP}${word("open")})`
  ),
  bounded(
    `(?:${word("not")}${WORD_GAP}${word("accepting")})${SHORT_BRIDGE}(?:${DM_NOUN})`
  ),
  bounded(
    `(?:${phrase("do", "not")}|${word("dont")})${WORD_GAP}${word("accept")}${SHORT_BRIDGE}(?:${DM_NOUN})`
  ),
];
const DM_INVITATION_NEGATION_PATTERNS = [
  bounded(
    `(?:${phrase("do", "not")}|${word("dont")}|${word("cannot")}|${word("cant")})${WORD_GAP}(?:${word("dm")}|${word("pm")}|${word("message")}|${word("contact")})${WORD_GAP}(?:${word("me")}|${word("us")})`
  ),
];

const PLATFORM_ALIASES = Object.freeze([
  "discord",
  "telegram",
  "whatsapp",
  "signal",
  "instagram",
  "insta",
  "snapchat",
  "snap",
  "tiktok",
  "twitter",
  "facebook",
  "messenger",
  "reddit",
  "steam",
  "playstation",
  "psn",
  "xbox",
  "line",
  "wechat",
  "kakaotalk",
]);
const PLATFORM = PLATFORM_ALIASES.map((entry) => word(entry)).join("|");
const HANDLE_LABEL = [
  word("username"),
  word("user"),
  word("handle"),
  word("id"),
  word("tag"),
].join("|");
const HANDLE_VALUE = "[@]?[a-z0-9][a-z0-9._#-]{1,63}";
const PLATFORM_HANDLE_PATTERNS = [
  bounded(`(?:${PLATFORM})\\s*(?::|=|@)\\s*${HANDLE_VALUE}`),
  bounded(
    `(?:${PLATFORM})${WORD_GAP}(?:${HANDLE_LABEL})\\s*(?::|=|is)?\\s*${HANDLE_VALUE}`
  ),
  bounded(
    `(?:${phrase("my")})${WORD_GAP}(?:${PLATFORM})${WORD_GAP}(?:${word("is")})${WORD_GAP}${HANDLE_VALUE}`
  ),
  bounded(
    `(?:${word("x")})${WORD_GAP}(?:${HANDLE_LABEL})\\s*(?::|=|is)?\\s*${HANDLE_VALUE}`
  ),
];

const PLATFORM_DOMAINS = Object.freeze([
  "discord.gg",
  "discord.com",
  "t.me",
  "telegram.me",
  "wa.me",
  "chat.whatsapp.com",
  "whatsapp.com",
  "signal.me",
  "instagram.com",
  "snapchat.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "m.me",
  "reddit.com",
  "steamcommunity.com",
  "steam.tv",
  "playstation.com",
  "xbox.com",
  "line.me",
  "wechat.com",
  "kakao.com",
  "open.kakao.com",
]);
const PLATFORM_URL_PATTERN = new RegExp(
  `(?:https?\\s*:\\s*\\/\\s*\\/)?(?:www\\s*\\.\\s*)?(?:${PLATFORM_DOMAINS.map(
    (domain) => domain.split(".").map(escapeRegExp).join("\\s*\\.\\s*")
  ).join("|")})\\s*\\/\\s*[^\\s/]{1,256}`,
  "iu"
);

const EMAIL_ADDRESS =
  "[a-z0-9._%+-]+\\s*@\\s*[a-z0-9.-]+\\s*\\.\\s*[a-z]{2,63}";
const EMAIL_INVITATION_PATTERNS = [
  bounded(`(?:${word("email")})\\s*(?::|=)\\s*${EMAIL_ADDRESS}`),
  bounded(
    `(?:${word("email")}|${word("contact")})${WORD_GAP}(?:${word("me")}|${word("us")})(?:${WORD_GAP}${word("at")})?${WORD_GAP}${EMAIL_ADDRESS}`
  ),
];

function firstMatch(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Return a stable, non-sensitive rule id for a contact solicitation, or null.
 * The matched content is deliberately never returned to callers.
 */
export function matchContactSolicitation(value) {
  const text = normalise(value);
  if (!text) return null;

  if (PLATFORM_URL_PATTERN.test(text)) {
    return { ruleId: "contact:platform-url", category: "platform_url" };
  }
  if (firstMatch(PLATFORM_HANDLE_PATTERNS, text)) {
    return { ruleId: "contact:platform-handle", category: "platform_handle" };
  }
  if (firstMatch(EMAIL_INVITATION_PATTERNS, text)) {
    return { ruleId: "contact:email-invite", category: "email_invite" };
  }

  const clauses = text.split(
    /(?:[\n\r,;]|(?<![\p{L}\p{N}])(?:but|however|though|yet)(?![\p{L}\p{N}]))/giu
  );
  for (const clause of clauses) {
    if (
      DM_AVAILABILITY_PATTERN.test(clause) &&
      !firstMatch(DM_AVAILABILITY_NEGATION_PATTERNS, clause)
    ) {
      return { ruleId: "contact:dm-available", category: "dm_availability" };
    }
    if (
      DM_INVITATION_PATTERN.test(clause) &&
      !firstMatch(DM_INVITATION_NEGATION_PATTERNS, clause)
    ) {
      return { ruleId: "contact:direct-invite", category: "direct_invite" };
    }
  }
  return null;
}
