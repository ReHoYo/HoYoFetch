import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTACT_SOLICITATION_SCAN_LIMIT,
  matchContactSolicitation,
} from "../contact-solicitation.js";

test("matches DM availability and direct contact invitations", () => {
  const samples = [
    "dms open",
    "OPEN DMs",
    "direct messages welcome",
    "private messages are available",
    "inbox available",
    "DM me",
    "message me",
    "contact us",
    "add me",
    "follow me",
    "DMs closed, but message me",
  ];
  for (const sample of samples) {
    assert.ok(matchContactSolicitation(sample), sample);
  }
});

test("matches labeled external handles, profile links, and email invitations", () => {
  const samples = [
    "Discord: enka#4961",
    "Telegram @enka",
    "my Instagram is enka",
    "PSN user: enka",
    "X handle: enka",
    "https://discord.gg/example",
    "telegram [.] me/enka",
    "email: enka@example.com",
    "email me at enka@example.com",
  ];
  for (const sample of samples) {
    assert.ok(matchContactSolicitation(sample), sample);
  }
});

test("normalizes common contact-filter bypass attempts", () => {
  const samples = [
    "ｄｍｓ　ｏｐｅｎ",
    "d​ms o​pen",
    "d.m.s o.p.e.n",
    "dмs оpen",
    "dms op3n",
    "dmmmms opennnn",
    "d-m m-e",
  ];
  for (const sample of samples) {
    assert.ok(matchContactSolicitation(sample), sample);
  }
});

test("clear contact opt-outs and ordinary Stoat mentions are not matches", () => {
  const samples = [
    "DMs closed",
    "my DMs are not open",
    "not accepting direct messages",
    "do not DM me",
    "don't message me",
    "hello @enka",
    "we talked about Discord yesterday",
    "discord.com is currently unavailable",
    "send the report to support@example.com",
  ];
  for (const sample of samples) {
    assert.equal(matchContactSolicitation(sample), null, sample);
  }
});

test("returns stable non-sensitive metadata and bounds scanning work", () => {
  assert.deepEqual(matchContactSolicitation("DMs open"), {
    ruleId: "contact:dm-available",
    category: "dm_availability",
  });
  assert.equal(
    matchContactSolicitation(
      `${"x".repeat(CONTACT_SOLICITATION_SCAN_LIMIT)} dms open`
    ),
    null
  );
});
