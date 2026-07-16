import test from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_ACCESS_BY_ROUTE,
  COMMAND_CATALOG,
  COMMAND_SECTIONS,
  DOCS_URL,
  formatCommandSyntax,
  getHelpCommandTuples,
} from "../command-catalog.js";
import { COMMAND_GAME_MAP } from "../config.js";
import { getCommandAccess } from "../security.js";

test("documented commands have unique ids and valid public syntax", () => {
  const ids = COMMAND_CATALOG.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);

  for (const command of COMMAND_CATALOG) {
    assert.match(command.syntax, /^\/[A-Za-z]/);
    assert.ok(command.summary.endsWith("."));
    assert.equal(
      getCommandAccess(command.route, COMMAND_GAME_MAP),
      command.access,
      `${command.syntax} should use its documented access class`
    );
  }
});

test("all documented routes and compatibility aliases are authorized", () => {
  for (const [route, access] of Object.entries(COMMAND_ACCESS_BY_ROUTE)) {
    assert.equal(getCommandAccess(route, COMMAND_GAME_MAP), access);
  }
});

test("help tuples are generated from the shared catalog with a custom prefix", () => {
  const memberHelp = getHelpCommandTuples(COMMAND_SECTIONS.MEMBER, "!");
  assert.ok(memberHelp.some(([syntax]) => syntax === "!FetchGI"));
  assert.ok(memberHelp.some(([syntax]) => syntax === "!Docs"));
  assert.ok(
    memberHelp.some(([syntax]) => syntax === "!Report-Spam @member reason: ...")
  );
  assert.equal(
    formatCommandSyntax("/AuditLog status", "!"),
    "!AuditLog status"
  );
});

test("the canonical documentation URL is an HTTPS project page", () => {
  assert.equal(DOCS_URL, "https://rehoyo.github.io/HoYoFetch/");
});
