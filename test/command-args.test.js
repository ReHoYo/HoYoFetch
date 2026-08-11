// Tests for command-args.js's shared target-parsing helpers, focused on the
// pieces not already exercised indirectly through moderation.test.js,
// spam-report.test.js, and user-info.test.js: the plain-text
// @Username#Discriminator detector and its cache-backed resolver.
import test from "node:test";
import assert from "node:assert/strict";
import {
  describeUnresolvedUsernameToken,
  findTargetToken,
  findUsernameDiscriminatorToken,
  resolveUsernameDiscriminatorTokens,
} from "../command-args.js";

const TARGET_ID = "01HZY3M6Q8V7N2K4J5T9W0XAAA";

function makeClient(users = []) {
  return {
    users: {
      find(predicate) {
        return users.find((user) => predicate(user));
      },
    },
  };
}

test("findUsernameDiscriminatorToken locates a bare @Username#1234 anywhere in the tokens", () => {
  assert.deepEqual(
    findUsernameDiscriminatorToken(["ban", "@EdgarAI#7456", "for", "raiding"]),
    { username: "EdgarAI", discriminator: "7456", index: 1 }
  );
  assert.equal(findUsernameDiscriminatorToken(["ban", "for", "raiding"]), null);
  // Not a real mention shape, not a bare ID, and not this shape either.
  assert.equal(findUsernameDiscriminatorToken(["@everyone"]), null);
  // Discriminator must be exactly 4 digits.
  assert.equal(findUsernameDiscriminatorToken(["@EdgarAI#74"]), null);
  assert.equal(findUsernameDiscriminatorToken(["@EdgarAI#74567"]), null);
  // No trailing text glued onto the token.
  assert.equal(findUsernameDiscriminatorToken(["@EdgarAI#7456x"]), null);
});

test("resolveUsernameDiscriminatorTokens rewrites a cached account into a real mention", () => {
  const client = makeClient([
    { id: TARGET_ID, username: "EdgarAI", discriminator: "7456" },
  ]);
  const resolved = resolveUsernameDiscriminatorTokens(client, [
    "ban",
    "@EdgarAI#7456",
    "for",
    "raiding",
  ]);
  assert.deepEqual(resolved, ["ban", `<@${TARGET_ID}>`, "for", "raiding"]);

  // The rewritten token is picked up by the normal mention parser for free.
  const found = findTargetToken(resolved);
  assert.equal(found.targetId, TARGET_ID);
});

test("resolveUsernameDiscriminatorTokens leaves an uncached account untouched", () => {
  const client = makeClient([
    { id: TARGET_ID, username: "EdgarAI", discriminator: "7456" },
  ]);
  const resolved = resolveUsernameDiscriminatorTokens(client, [
    "@SomeoneElse#1234",
  ]);
  assert.deepEqual(resolved, ["@SomeoneElse#1234"]);
});

test("resolveUsernameDiscriminatorTokens matches username and discriminator exactly, never loosely", () => {
  const client = makeClient([
    { id: TARGET_ID, username: "EdgarAI", discriminator: "7456" },
  ]);
  // Wrong discriminator for a real username: never resolved, even though a
  // wrong guess here means banning the wrong account.
  assert.deepEqual(
    resolveUsernameDiscriminatorTokens(client, ["@EdgarAI#0000"]),
    ["@EdgarAI#0000"]
  );
  // Case must match exactly.
  assert.deepEqual(
    resolveUsernameDiscriminatorTokens(client, ["@edgarai#7456"]),
    ["@edgarai#7456"]
  );
});

test("resolveUsernameDiscriminatorTokens tolerates a missing or empty user cache", () => {
  assert.deepEqual(
    resolveUsernameDiscriminatorTokens(undefined, ["@EdgarAI#7456"]),
    ["@EdgarAI#7456"]
  );
  assert.deepEqual(resolveUsernameDiscriminatorTokens({}, ["@EdgarAI#7456"]), [
    "@EdgarAI#7456",
  ]);
  assert.deepEqual(
    resolveUsernameDiscriminatorTokens(makeClient([]), ["@EdgarAI#7456"]),
    ["@EdgarAI#7456"]
  );
});

test("describeUnresolvedUsernameToken explains the one case worth explaining", () => {
  assert.equal(describeUnresolvedUsernameToken(["for", "raiding"]), null);
  const hint = describeUnresolvedUsernameToken([
    "@EdgarAI#7456",
    "for",
    "raiding",
  ]);
  assert.match(hint, /EdgarAI#7456/);
  assert.match(hint, /Get-Info/);
});
