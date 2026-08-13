// Stable, non-pinging account labels for bot-generated cards and replies.
// Stoat renders a bare <@id> as "Unknown User" when the account is no longer
// hydrated or has left the server. Keep the stable ID visible instead, and use
// a bounded username snapshot only as a human-readable aid.

const SAFE_ACCOUNT_ID = /^[A-Za-z0-9]+$/u;
const MAX_USERNAME_LENGTH = 64;
const UNSAFE_DIRECTIONAL_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/gu;
const OTHER_CONTROL_CHARACTERS = /\p{Cc}/gu;

export function normalizeUsernameSnapshot(value) {
  if (typeof value !== "string") return null;
  const compact = value
    .normalize("NFKC")
    .replace(UNSAFE_DIRECTIONAL_CONTROLS, "")
    .replace(OTHER_CONTROL_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!compact) return null;

  const bounded =
    compact.length > MAX_USERNAME_LENGTH
      ? `${compact.slice(0, MAX_USERNAME_LENGTH - 1)}…`
      : compact;
  return bounded;
}

export function safeUsernameSnapshot(value) {
  const bounded = normalizeUsernameSnapshot(value);
  if (!bounded) return null;
  return bounded
    .replaceAll("\\", "\\\\")
    .replace(/([`*_~|()[\]])/gu, "\\$1")
    .replace(/<([@#])/gu, "<$1\u200B")
    .replace(/@(everyone|here)/giu, "@\u200B$1");
}

export function usernameSnapshot(client, userId, suppliedUsername = null) {
  return (
    normalizeUsernameSnapshot(suppliedUsername) ??
    normalizeUsernameSnapshot(client?.users?.get?.(userId)?.username)
  );
}

export function formatAccountLabel(
  client,
  userId,
  { username = null, redacted = false } = {}
) {
  if (typeof userId !== "string" || !SAFE_ACCOUNT_ID.test(userId)) {
    return "Account unavailable";
  }
  const idLabel = `Account \`${userId}\``;
  if (redacted) return idLabel;
  const shownUsername = safeUsernameSnapshot(
    usernameSnapshot(client, userId, username)
  );
  return shownUsername ? `@\u200B${shownUsername} (\`${userId}\`)` : idLabel;
}
