// command-args.js — natural-language argument parsing shared by commands that
// take one member and a reason written in plain words.
import { isSafeId } from "./security.js";

const MENTION_PATTERN = /^<@!?([A-Za-z0-9]+)>$/;
// Stoat IDs are ULIDs (26 characters). This is used for account-age
// derivation, not for target parsing — see ACCOUNT_ID_PATTERN below for that.
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// A bare leading token is only read as a user ID when it is long and carries a
// digit or capital, so `/Kick for raiding` asks for a member instead of trying
// to moderate someone called "for".
export const BARE_ID_PATTERN = /^(?=.{8,})(?=.*[0-9A-Z])[A-Za-z0-9]+$/;
// A bare token *anywhere else* in the sentence is only read as a user ID when
// it is at least as long as a real Stoat account ID (26 characters) and
// carries a digit or capital. Previously this required the strict Crockford
// ULID shape, so a moderator who wrapped a valid ID in `<@…>` could target it
// from anywhere in the sentence, but the same bare ID mid-sentence was
// rejected with an error that told them a user ID should have worked. A
// 20-character floor comfortably covers every real account ID while staying
// well above anything an ordinary reason word reaches.
export const ACCOUNT_ID_PATTERN = /^(?=.{20,})(?=.*[0-9A-Z])[A-Za-z0-9]+$/;
// Leading filler between the member and the reason, so `/Ban @member for
// spamming` records "spamming" rather than "for spamming".
const REASON_PREFIX_PATTERN =
  /^(?:(?:because of|because|due to|for|about|over|-|–|—|:)(?:\s+|$))/i;
const REMOVED_ARGUMENT_PREFIX_PATTERN =
  /^(reason|delete|window|purge|duration|mute|timeout)\s*:/i;

export function tokenizeArgs(args = []) {
  const values = Array.isArray(args) ? args : String(args ?? "").split(/\s+/);
  return values
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length > 0);
}

/**
 * Locate the member being acted on anywhere in the sentence. A mention wins
 * over a bare account ID so `/Ban 01ABC… @member for spam` targets the
 * mention.
 */
export function findTargetToken(tokens) {
  for (const [index, token] of tokens.entries()) {
    const mention = token.match(MENTION_PATTERN);
    if (mention && isSafeId(mention[1])) {
      return { targetId: mention[1], index };
    }
  }
  for (const [index, token] of tokens.entries()) {
    if (ACCOUNT_ID_PATTERN.test(token) && isSafeId(token)) {
      return { targetId: token, index };
    }
  }
  return null;
}

export function stripReasonPrefix(text) {
  return String(text ?? "").replace(REASON_PREFIX_PATTERN, "");
}

export function findRemovedArgumentPrefix(tokens = []) {
  for (const token of tokens) {
    const match = String(token ?? "").match(REMOVED_ARGUMENT_PREFIX_PATTERN);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

/** Join the tokens no other rule claimed into a single reason string. */
export function buildReason(tokens, consumed = new Set()) {
  return stripReasonPrefix(
    tokens.filter((_, index) => !consumed.has(index)).join(" ")
  )
    .replace(/\s+/g, " ")
    .trim();
}
