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
import {
  COMMAND_DISPATCH_BY_ROUTE,
  getCommandDispatch,
  parseAutoFetchScope,
  REMOVED_COMMAND_ROUTES,
} from "../command-routing.js";
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

test("all documented routes are authorized", () => {
  for (const [route, access] of Object.entries(COMMAND_ACCESS_BY_ROUTE)) {
    assert.equal(getCommandAccess(route, COMMAND_GAME_MAP), access);
  }
});

test("help tuples are generated from the shared catalog with a custom prefix", () => {
  const memberHelp = getHelpCommandTuples(COMMAND_SECTIONS.MEMBER, "!");
  assert.ok(memberHelp.some(([syntax]) => syntax === "!FetchGI"));
  assert.ok(memberHelp.some(([syntax]) => syntax === "!FetchWuWa"));
  assert.ok(memberHelp.some(([syntax]) => syntax === "!Docs"));
  assert.ok(
    memberHelp.some(
      ([syntax]) => syntax === "!Report-Spam @member <what happened>"
    )
  );
  assert.equal(
    formatCommandSyntax("/AuditLog status", "!"),
    "!AuditLog status"
  );

  const setupHelp = getHelpCommandTuples(COMMAND_SECTIONS.SETUP, "!");
  assert.ok(
    setupHelp.some(
      ([syntax]) => syntax === "!EnableFetch [all|hoyo|nte|wuwa|nte-wuwa]"
    )
  );
});

test("catalog routes and the enumerable handler registry agree exactly", () => {
  const catalogBases = new Set(
    COMMAND_CATALOG.flatMap((command) => [
      command.route.split(/\s+/, 1)[0],
      ...(command.routeAliases ?? []).map((route) => route.split(/\s+/, 1)[0]),
    ])
  );
  assert.deepEqual(
    [...catalogBases].sort(),
    Object.keys(COMMAND_DISPATCH_BY_ROUTE).sort()
  );
  for (const route of catalogBases) assert.ok(getCommandDispatch(route));
});

test("removed command routes have neither handlers nor authorization", () => {
  for (const route of REMOVED_COMMAND_ROUTES) {
    assert.equal(getCommandDispatch(route), null, `${route} has no handler`);
    assert.equal(
      getCommandAccess(route, COMMAND_GAME_MAP),
      null,
      `${route} has no authorization`
    );
    assert.equal(
      getCommandAccess(`${route} anything`, COMMAND_GAME_MAP),
      null,
      `${route} arguments cannot restore authorization`
    );
  }
});

test("EnableFetch accepts each canonical scope and rejects invalid or extra arguments", () => {
  assert.deepEqual(parseAutoFetchScope([]), { ok: true, scope: "all" });
  for (const [input, scope] of [
    ["all", "all"],
    ["hoyo", "hoyo"],
    ["nte", "nte"],
    ["wuwa", "wuwa"],
    ["nte-wuwa", "nte_wuwa"],
  ]) {
    assert.deepEqual(parseAutoFetchScope([input]), { ok: true, scope });
  }
  assert.equal(parseAutoFetchScope(["bogus"]).ok, false);
  assert.equal(parseAutoFetchScope(["hoyo", "extra"]).ok, false);
});

test("the canonical documentation URL is an HTTPS project page", () => {
  assert.equal(DOCS_URL, "https://rehoyo.github.io/HoYoFetch/");
});
