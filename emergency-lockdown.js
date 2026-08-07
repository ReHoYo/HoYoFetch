#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";
import {
  acquireEmergencyProcessLock,
  createEmergencySendLock,
  EmergencyLockError,
} from "./emergency-send-lock.js";

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));

function terminalLabel(value) {
  return [...String(value ?? "unknown")]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)
        ? " "
        : character;
    })
    .join("")
    .trim()
    .slice(0, 100);
}

function printResult(action, result) {
  const target = terminalLabel(result.serverName ?? CONFIG.emergencyServerId);
  if (action === "lock") {
    if (result.outcome === "externally_locked") {
      console.log(
        `🔒 ${target}: default Send Messages was already disabled; no emergency restoration ownership was claimed.`
      );
    } else {
      console.log(
        `🔒 ${target}: VPS emergency lock verified. Default Send Messages is disabled.`
      );
    }
    return;
  }
  if (action === "unlock") {
    if (result.outcome === "not_owned") {
      console.log(
        `ℹ️ ${target}: this VPS tool does not own an active Send Messages lock; nothing was changed.`
      );
    } else {
      console.log(
        `🔓 ${target}: emergency restoration verified. Default Send Messages is enabled.`
      );
    }
    return;
  }
  console.log(`Server: ${target} (${result.serverId})`);
  console.log(`State: ${result.outcome}`);
  console.log(
    `Default Send Messages: ${result.sendEnabled ? "enabled" : "disabled"}`
  );
  console.log(
    `Emergency ownership: ${result.emergencyOwned ? "active" : "none"}`
  );
  console.log(`Moderation level interlock: ${result.level || "none"}`);
  if (result.capturedAt) console.log(`Captured: ${result.capturedAt}`);
  if (result.lockedAt) console.log(`Locked: ${result.lockedAt}`);
  if (result.restoredAt) console.log(`Restored: ${result.restoredAt}`);
}

async function main() {
  const action = String(process.argv[2] ?? "").toLowerCase();
  if (!new Set(["lock", "status", "unlock"]).has(action)) {
    throw new EmergencyLockError(
      "Usage: node emergency-lockdown.js <lock|status|unlock>",
      { code: "invalid_action" }
    );
  }
  const dataDir = process.env.HOYOFETCH_DATA_DIR || join(ROOT_DIR, "data");
  const release = acquireEmergencyProcessLock(dataDir);
  try {
    const control = createEmergencySendLock({
      token: CONFIG.token,
      serverId: CONFIG.emergencyServerId,
      apiBase: CONFIG.stoatApiBase,
      dataDir,
    });
    const result = await control[action]();
    printResult(action, result);
  } finally {
    release();
  }
}

main().catch((error) => {
  const message =
    error instanceof EmergencyLockError
      ? error.message
      : "The emergency command failed unexpectedly.";
  console.error(`❌ ${message}`);
  process.exitCode = 1;
});
