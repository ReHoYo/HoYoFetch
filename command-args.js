// command-args.js — natural-language argument parsing shared by commands that
// take one member and a reason written in plain words.
import { isSafeId } from "./security.js";

const MENTION_PATTERN = /^<@!?([A-Za-z0-9]+)>$/;
// Stoat IDs are ULIDs. isSafeId() alone accepts any alphanumeric word, so a
// bare ID is only recognized mid-sentence when it has the full ULID shape.
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// A bare leading token is only read as a user ID when it is long and carries a
// digit or capital, so `/Kick for raiding` asks for a member instead of trying
// to moderate someone called "for".
export const BARE_ID_PATTERN = /^(?=.{8,})(?=.*[0-9A-Z])[A-Za-z0-9]+$/;
// Leading filler between the member and the reason, so `/Ban @member for
// spamming` records "spamming" rather than "for spamming".
const REASON_PREFIX_PATTERN =
  /^(?:reason\s*:\s*|(?:because of|because|due to|for|about|over|-|–|—|:)(?:\s+|$))/i;

export function tokenizeArgs(args = []) {
  const values = Array.isArray(args) ? args : String(args ?? "").split(/\s+/);
  return values
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length > 0);
}

/**
 * Locate the member being acted on anywhere in the sentence. A mention wins
 * over a bare ULID so `/Ban 01ABC… @member for spam` targets the mention.
 */
export function findTargetToken(tokens) {
  for (const [index, token] of tokens.entries()) {
    const mention = token.match(MENTION_PATTERN);
    if (mention && isSafeId(mention[1])) {
      return { targetId: mention[1], index };
    }
  }
  for (const [index, token] of tokens.entries()) {
    if (ULID_PATTERN.test(token)) return { targetId: token, index };
  }
  return null;
}

export function stripReasonPrefix(text) {
  return String(text ?? "").replace(REASON_PREFIX_PATTERN, "");
}

/** Join the tokens no other rule claimed into a single reason string. */
export function buildReason(tokens, consumed = new Set()) {
  return stripReasonPrefix(
    tokens.filter((_, index) => !consumed.has(index)).join(" ")
  )
    .replace(/\s+/g, " ")
    .trim();
}
