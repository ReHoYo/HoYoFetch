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
// A plain-text `@Username#1234` — Stoat's real mention macro is `<@ID>`
// (matched by MENTION_PATTERN above); typing a username/discriminator combo
// by hand, or pasting one from another client, produces neither a mention nor
// a bare account ID, so it would otherwise fall through to the generic
// "mention a member or give an ID" error with no explanation. See
// resolveUsernameDiscriminatorTokens below for how (and how far) this can
// actually be resolved.
const USERNAME_DISCRIMINATOR_PATTERN = /^@([^\s#@]{2,32})#(\d{4})$/;
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

/** Locate a bare `@Username#1234` token anywhere in the sentence. */
export function findUsernameDiscriminatorToken(tokens) {
  for (const [index, token] of tokens.entries()) {
    const match = token.match(USERNAME_DISCRIMINATOR_PATTERN);
    if (match) return { username: match[1], discriminator: match[2], index };
  }
  return null;
}

/**
 * Rewrite every `@Username#1234` token into a real `<@ID>` mention, but only
 * when that exact username/discriminator combo is already in Irminsul's
 * local account cache — populated from servers it shares with the account,
 * the same cache `/Get-Info` and review cards already read usernames from.
 *
 * Stoat's only username-resolution endpoint is "send friend request"
 * (`POST /users/friend`), and calling that to resolve a moderation target
 * would friend-request the account as a side effect — never appropriate for
 * a ban, kick, mute, spam report, or lookup. This deliberately never calls
 * it: an account Irminsul hasn't already seen simply cannot be resolved from
 * typed text alone, and the token is left untouched so the caller can
 * explain that rather than silently mistargeting or reporting a generic
 * "no target" error. A username match is case-sensitive on purpose — the
 * cost of a wrong guess here is a wrong moderation target, so an inexact
 * match is treated the same as no match at all.
 */
export function resolveUsernameDiscriminatorTokens(client, tokens) {
  return tokens.map((token) => {
    const match = token.match(USERNAME_DISCRIMINATOR_PATTERN);
    if (!match) return token;
    const [, username, discriminator] = match;
    const found = client?.users?.find?.(
      (user) =>
        user?.username === username && user?.discriminator === discriminator
    );
    return found && isSafeId(found.id) ? `<@${found.id}>` : token;
  });
}

/**
 * A more specific version of the generic "mention a member or give an
 * account ID" error, for the one case that deserves an explanation: a
 * plain-text `@Username#1234` that didn't resolve because Irminsul has never
 * seen that exact account. `tokens` should be the *already-resolved* array
 * from resolveUsernameDiscriminatorTokens — a still-present match there means
 * the lookup failed rather than never having run. Returns null when no such
 * token is present, so callers fall back to their own generic error
 * unchanged.
 */
export function describeUnresolvedUsernameToken(tokens) {
  const found = findUsernameDiscriminatorToken(tokens);
  if (!found) return null;
  return `\`@${found.username}#${found.discriminator}\` is not an account Irminsul has already seen in a shared server, so it can't be resolved from typed text alone. Use an actual @mention selected from the mention picker, or paste the account ID from \`/Get-Info\`.`;
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
