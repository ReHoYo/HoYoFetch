import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireEmergencyProcessLock,
  createEmergencySendLock,
  EmergencyLockError,
  EMERGENCY_STATE_FILENAME,
} from "../emergency-send-lock.js";
import { PERMISSION_BITS } from "../permission-bits.js";

const SERVER_ID = "SERVER123";
const TOKEN = "test-bot-token-never-log-this";

function tempDataDir() {
  return mkdtempSync(join(tmpdir(), "hoyofetch-emergency-test-"));
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeStoat({
  permissions = Number(PERMISSION_BITS.SendMessage),
  scripted = [],
} = {}) {
  const calls = [];
  let currentPermissions = permissions;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const next = scripted.shift();
    if (next instanceof Error) throw next;
    if (next instanceof Response) return next;
    const method = options.method ?? "GET";
    if (method === "GET") {
      return jsonResponse({
        _id: SERVER_ID,
        name: "Test Server",
        default_permissions: currentPermissions,
      });
    }
    const body = JSON.parse(options.body);
    currentPermissions = body.permissions;
    return jsonResponse({
      _id: SERVER_ID,
      name: "Test Server",
      default_permissions: currentPermissions,
    });
  };
  return {
    calls,
    fetchImpl,
    get permissions() {
      return currentPermissions;
    },
    set permissions(value) {
      currentPermissions = value;
    },
  };
}

function makeControl(dataDir, stoat, options = {}) {
  return createEmergencySendLock({
    token: TOKEN,
    serverId: SERVER_ID,
    apiBase: "https://stoat.invalid",
    dataDir,
    fetchImpl: stoat.fetchImpl,
    sleep: options.sleep ?? (async () => {}),
    now: options.now ?? (() => new Date("2026-08-07T00:00:00.000Z")),
    logger: options.logger ?? { warn() {} },
    maxAttempts: options.maxAttempts ?? 10,
  });
}

test("lock and unlock preserve unrelated low and high permission bits", async () => {
  const dataDir = tempDataDir();
  const unrelated = Number((2n ** 48n) | (2n ** 5n));
  const stoat = makeStoat({
    permissions: unrelated + Number(PERMISSION_BITS.SendMessage),
  });
  const control = makeControl(dataDir, stoat);

  const locked = await control.lock();
  assert.equal(locked.outcome, "emergency_locked");
  assert.equal(stoat.permissions, unrelated);
  assert.equal((await control.status()).outcome, "emergency_locked");

  const unlocked = await control.unlock();
  assert.equal(unlocked.outcome, "unlocked");
  assert.equal(
    stoat.permissions,
    unrelated + Number(PERMISSION_BITS.SendMessage)
  );
  assert.equal((await control.status()).outcome, "unlocked");

  const statePath = join(dataDir, EMERGENCY_STATE_FILENAME);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.active, false);
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
});

test("an interrupted lock retains ownership and resumes safely", async () => {
  const dataDir = tempDataDir();
  const failingStoat = makeStoat({
    scripted: [
      jsonResponse({
        _id: SERVER_ID,
        name: "Test Server",
        default_permissions: Number(PERMISSION_BITS.SendMessage),
      }),
      new Error("network down"),
    ],
  });
  const first = makeControl(dataDir, failingStoat, { maxAttempts: 1 });

  await assert.rejects(first.lock(), (error) => error.code === "retry_limit");
  const captured = JSON.parse(
    readFileSync(join(dataDir, EMERGENCY_STATE_FILENAME), "utf8")
  );
  assert.equal(captured.active, true);
  assert.equal(captured.lockedAt, null);
  assert.equal((await first.status()).outcome, "emergency_lock_pending");

  const recoveredStoat = makeStoat();
  const recovered = makeControl(dataDir, recoveredStoat);
  assert.equal((await recovered.lock()).outcome, "emergency_locked");
  assert.equal(recoveredStoat.permissions, 0);
});

test("an existing external lock is not claimed or restored", async () => {
  const dataDir = tempDataDir();
  const stoat = makeStoat({ permissions: 2 ** 16 });
  const control = makeControl(dataDir, stoat);

  assert.equal((await control.lock()).outcome, "externally_locked");
  assert.equal((await control.status()).outcome, "externally_locked");
  assert.equal((await control.unlock()).outcome, "not_owned");
  assert.equal(
    stoat.calls.filter((call) => call.options.method === "PUT").length,
    0
  );
});

test("transient network and rate-limit failures retry without logging secrets", async () => {
  const dataDir = tempDataDir();
  const warnings = [];
  const waits = [];
  const stoat = makeStoat({
    scripted: [
      new Error("temporary outage"),
      jsonResponse({ error: "rate limited" }, 429, { "retry-after": "2" }),
    ],
  });
  const control = makeControl(dataDir, stoat, {
    logger: { warn: (message) => warnings.push(message) },
    sleep: async (ms) => waits.push(ms),
  });

  assert.equal((await control.lock()).outcome, "emergency_locked");
  assert.deepEqual(waits, [500, 2_000]);
  assert.equal(warnings.join(" ").includes(TOKEN), false);
  assert.equal(
    stoat.calls.every((call) => call.options.headers["X-Bot-Token"] === TOKEN),
    true
  );
});

test("terminal permission failures stop immediately with actionable output", async () => {
  const dataDir = tempDataDir();
  const stoat = makeStoat({
    scripted: [
      jsonResponse({
        _id: SERVER_ID,
        default_permissions: Number(PERMISSION_BITS.SendMessage),
      }),
      jsonResponse({ error: "forbidden" }, 403),
    ],
  });
  const control = makeControl(dataDir, stoat);

  await assert.rejects(
    control.lock(),
    (error) =>
      error instanceof EmergencyLockError &&
      error.code === "http_403" &&
      /lacks permission/.test(error.message) &&
      !error.message.includes(TOKEN)
  );
  assert.equal(stoat.calls.length, 2);
});

test("unlock refuses to fight an active Level 3 or 4 lock", async () => {
  const dataDir = tempDataDir();
  const stoat = makeStoat();
  const control = makeControl(dataDir, stoat);
  await control.lock();
  writeFileSync(
    join(dataDir, "post_gate.json"),
    JSON.stringify({ [SERVER_ID]: { mode: "hold", level: 4 } }),
    { mode: 0o600 }
  );
  chmodSync(join(dataDir, "post_gate.json"), 0o600);

  await assert.rejects(
    control.unlock(),
    (error) =>
      error.code === "level_lock_active" && /Level 4/.test(error.message)
  );
  assert.equal(stoat.permissions, 0);
  assert.equal((await control.status()).outcome, "emergency_locked");
});

test("status distinguishes normal Level lockdown from an external lock", async () => {
  const dataDir = tempDataDir();
  const stoat = makeStoat({ permissions: 0 });
  const control = makeControl(dataDir, stoat);
  assert.equal((await control.status()).outcome, "externally_locked");

  writeFileSync(
    join(dataDir, "post_gate.json"),
    JSON.stringify({ [SERVER_ID]: { mode: "hold", level: 3 } })
  );
  assert.equal((await control.status()).outcome, "level_locked");
});

test("exclusive process lock rejects concurrent commands", () => {
  const dataDir = tempDataDir();
  const release = acquireEmergencyProcessLock(dataDir);
  try {
    assert.throws(
      () => acquireEmergencyProcessLock(dataDir),
      (error) => error.code === "concurrent_command"
    );
  } finally {
    release();
  }
  const releaseAgain = acquireEmergencyProcessLock(dataDir);
  releaseAgain();
});
