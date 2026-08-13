import test from "node:test";
import assert from "node:assert/strict";

import {
  formatAccountLabel,
  safeUsernameSnapshot,
  usernameSnapshot,
} from "../identity-label.js";

const USER_ID = "01IDENTITYLABELTEST000000001";

function clientWith(username) {
  return { users: new Map([[USER_ID, { username }]]) };
}

test("formats a supplied username with a stable account id and no mention macro", () => {
  const label = formatAccountLabel(null, USER_ID, { username: "Kiana" });
  assert.equal(label, `@\u200BKiana (\`${USER_ID}\`)`);
  assert.doesNotMatch(label, /<@|Unknown User/iu);
});

test("uses a cached username when no snapshot was supplied", () => {
  assert.equal(
    formatAccountLabel(clientWith("March7th"), USER_ID),
    `@\u200BMarch7th (\`${USER_ID}\`)`
  );
  assert.equal(usernameSnapshot(clientWith("March7th"), USER_ID), "March7th");
});

test("falls back to the stable account id when no username is available", () => {
  assert.equal(
    formatAccountLabel({ users: new Map() }, USER_ID),
    `Account \`${USER_ID}\``
  );
});

test("invalid account ids never become mention macros", () => {
  assert.equal(
    formatAccountLabel(null, "bad id", { username: "Kiana" }),
    "Account unavailable"
  );
  assert.equal(formatAccountLabel(null, null), "Account unavailable");
});

test("sanitizes markdown, mentions, controls, and bounds usernames", () => {
  const unsafe = "**@everyone** <@USER>\n" + "x".repeat(100);
  const snapshot = safeUsernameSnapshot(unsafe);
  assert.match(snapshot, /\\\*\\\*@\u200Beveryone\\\*\\\*/u);
  assert.match(snapshot, /<@\u200BUSER>/u);
  assert.doesNotMatch(snapshot, /\n/u);
  assert.ok(snapshot.length < 100);
});

test("redacted labels omit even a supplied username", () => {
  assert.equal(
    formatAccountLabel(clientWith("unsafe-name"), USER_ID, {
      username: "snapshot-name",
      redacted: true,
    }),
    `Account \`${USER_ID}\``
  );
});
