// Host-only emergency control for the server default SendMessage permission.
// This module deliberately uses REST rather than revolt.js: it must remain
// usable when the gateway cannot deliver an in-server /Level command.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  addPermission,
  hasPermission,
  permissionBitsToNumber,
  PERMISSION_BITS,
  removePermission,
  toPermissionBits,
} from "./permission-bits.js";

export const EMERGENCY_STATE_FILENAME = "emergency_send_lock.json";
export const EMERGENCY_PROCESS_LOCK_FILENAME = ".emergency_send_lock.lock";
const POST_GATE_FILENAME = "post_gate.json";
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429]);
const DEFAULT_MAX_RETRY_MS = 30_000;
const STATE_VERSION = 1;

export class EmergencyLockError extends Error {
  constructor(message, { code = "emergency_lock_failed", cause } = {}) {
    super(message, { cause });
    this.name = "EmergencyLockError";
    this.code = code;
  }
}

function isSafeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9]+$/.test(value);
}

function ensurePrivateDataDir(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}

function readJsonFile(path, { missing = null, label = "state" } = {}) {
  if (!existsSync(path)) return missing;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new EmergencyLockError(
      `The local ${label} file is unreadable or invalid JSON: ${path}`,
      { code: "invalid_local_state", cause }
    );
  }
}

function atomicWritePrivateJson(path, value) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, payload, "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } catch (cause) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created or may already be gone.
    }
    throw new EmergencyLockError(
      "Could not persist emergency recovery state.",
      {
        code: "state_write_failed",
        cause,
      }
    );
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Acquire a host-local exclusive lock. The returned function releases it. */
export function acquireEmergencyProcessLock(
  dataDir,
  { pid = process.pid } = {}
) {
  ensurePrivateDataDir(dataDir);
  const path = join(dataDir, EMERGENCY_PROCESS_LOCK_FILENAME);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync(path, "wx", 0o600);
      writeFileSync(
        descriptor,
        `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`,
        "utf8"
      );
      closeSync(descriptor);
      descriptor = undefined;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const owner = readJsonFile(path, { label: "process lock" });
          if (owner?.pid === pid) unlinkSync(path);
        } catch {
          // Never mask the command result during best-effort cleanup.
        }
      };
    } catch (cause) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (cause?.code !== "EEXIST") {
        throw new EmergencyLockError(
          "Could not acquire the emergency command lock.",
          { code: "process_lock_failed", cause }
        );
      }
      const owner = readJsonFile(path, { label: "process lock" });
      if (processIsAlive(owner?.pid)) {
        throw new EmergencyLockError(
          `Another emergency command is already running (PID ${owner.pid}).`,
          { code: "concurrent_command" }
        );
      }
      try {
        unlinkSync(path);
      } catch (error) {
        throw new EmergencyLockError(
          "A stale emergency command lock could not be removed.",
          { code: "process_lock_failed", cause: error }
        );
      }
    }
  }

  throw new EmergencyLockError(
    "Could not acquire the emergency command lock.",
    {
      code: "process_lock_failed",
    }
  );
}

function normalizeState(value, serverId) {
  if (value === null) return null;
  if (
    !value ||
    value.version !== STATE_VERSION ||
    !isSafeId(value.serverId) ||
    typeof value.active !== "boolean" ||
    typeof value.restoreOnUnlock !== "boolean"
  ) {
    throw new EmergencyLockError(
      "The emergency recovery state has an unsupported or malformed shape.",
      { code: "invalid_local_state" }
    );
  }
  if (value.serverId !== serverId) {
    throw new EmergencyLockError(
      `Emergency recovery state belongs to server ${value.serverId}, not ${serverId}.`,
      { code: "state_server_mismatch" }
    );
  }
  return value;
}

function activePostGateLevel(dataDir, serverId) {
  const path = join(dataDir, POST_GATE_FILENAME);
  const configs = readJsonFile(path, { missing: {}, label: "Post Gate" });
  if (!configs || typeof configs !== "object" || Array.isArray(configs)) {
    throw new EmergencyLockError(
      "The persisted Post Gate state is malformed.",
      {
        code: "invalid_post_gate_state",
      }
    );
  }
  const config = configs[serverId];
  if (!config || config.mode !== "hold") return 0;
  const level = Number(config.level);
  return Number.isInteger(level) && level >= 3 && level <= 4 ? level : 0;
}

function retryDelayMs(response, attempt, maxRetryMs) {
  const rawResetAfter = response?.headers?.get?.("x-ratelimit-reset-after");
  const rawRetryAfter = response?.headers?.get?.("retry-after");
  const resetAfter = rawResetAfter === null ? null : Number(rawResetAfter);
  const retryAfter = rawRetryAfter === null ? null : Number(rawRetryAfter);
  const specified =
    resetAfter !== null && Number.isFinite(resetAfter) && resetAfter >= 0
      ? resetAfter
      : retryAfter !== null && Number.isFinite(retryAfter) && retryAfter >= 0
        ? retryAfter * 1_000
        : null;
  const exponential = Math.min(maxRetryMs, 500 * 2 ** Math.min(attempt, 6));
  return Math.min(maxRetryMs, specified ?? exponential);
}

function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(status) || status >= 500;
}

function statusError(method, path, status) {
  const detail =
    status === 401
      ? "BOT_TOKEN was rejected."
      : status === 403
        ? method === "PUT"
          ? "The bot lacks permission to change the server default permissions."
          : "The bot cannot read the target server."
        : status === 404
          ? "The configured server was not found or is not visible to the bot."
          : `Stoat rejected ${method} ${path} with HTTP ${status}.`;
  return new EmergencyLockError(detail, {
    code: status === 401 ? "invalid_token" : `http_${status}`,
  });
}

function validateOptions({ token, serverId, apiBase, dataDir, fetchImpl }) {
  if (!token || token === "your_bot_token_here") {
    throw new EmergencyLockError("BOT_TOKEN is not configured.", {
      code: "missing_token",
    });
  }
  if (!isSafeId(serverId)) {
    throw new EmergencyLockError(
      "EMERGENCY_SERVER_ID must be a valid Stoat server ID.",
      { code: "invalid_server_id" }
    );
  }
  let parsedBase;
  try {
    parsedBase = new URL(apiBase);
  } catch {
    throw new EmergencyLockError("STOAT_API_BASE must be a valid URL.", {
      code: "invalid_api_base",
    });
  }
  if (
    !["http:", "https:"].includes(parsedBase.protocol) ||
    parsedBase.username ||
    parsedBase.password
  ) {
    throw new EmergencyLockError(
      "STOAT_API_BASE must be an HTTP(S) URL without embedded credentials.",
      { code: "invalid_api_base" }
    );
  }
  if (!dataDir || typeof dataDir !== "string") {
    throw new EmergencyLockError("The runtime data directory is invalid.", {
      code: "invalid_data_dir",
    });
  }
  if (typeof fetchImpl !== "function") {
    throw new EmergencyLockError("No Fetch implementation is available.", {
      code: "missing_fetch",
    });
  }
}

export function createEmergencySendLock({
  token,
  serverId,
  apiBase = "https://api.stoat.chat",
  dataDir,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date(),
  logger = console,
  timeoutMs = 10_000,
  maxAttempts = Number.POSITIVE_INFINITY,
  maxRetryMs = DEFAULT_MAX_RETRY_MS,
}) {
  validateOptions({ token, serverId, apiBase, dataDir, fetchImpl });
  ensurePrivateDataDir(dataDir);
  const normalizedApiBase = apiBase.replace(/\/+$/, "");
  const statePath = join(dataDir, EMERGENCY_STATE_FILENAME);

  function readState() {
    return normalizeState(
      readJsonFile(statePath, { missing: null, label: "emergency state" }),
      serverId
    );
  }

  function writeState(state) {
    atomicWritePrivateJson(statePath, state);
  }

  async function request(method, path, body) {
    let attempt = 0;
    while (attempt < maxAttempts) {
      let response;
      try {
        response = await fetchImpl(`${normalizedApiBase}${path}`, {
          method,
          headers: {
            "X-Bot-Token": token,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        attempt += 1;
        if (attempt >= maxAttempts) {
          throw new EmergencyLockError(
            "Stoat remained unreachable after the configured retry limit.",
            { code: "retry_limit", cause }
          );
        }
        const waitMs = Math.min(
          maxRetryMs,
          500 * 2 ** Math.min(attempt - 1, 6)
        );
        logger.warn?.(`Stoat is unreachable; retrying in ${waitMs}ms.`);
        await sleep(waitMs);
        continue;
      }

      if (!response || typeof response.ok !== "boolean") {
        throw new EmergencyLockError(
          "Stoat returned an invalid HTTP response object.",
          { code: "invalid_response" }
        );
      }
      if (response.ok) {
        const text = await response.text();
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch (cause) {
          throw new EmergencyLockError(
            "Stoat returned a successful response with invalid JSON.",
            { code: "invalid_response", cause }
          );
        }
      }

      if (!isRetryableStatus(response.status)) {
        throw statusError(method, path, response.status);
      }
      attempt += 1;
      if (attempt >= maxAttempts) {
        throw new EmergencyLockError(
          `Stoat kept returning HTTP ${response.status} through the configured retry limit.`,
          { code: "retry_limit" }
        );
      }
      const waitMs = retryDelayMs(response, attempt - 1, maxRetryMs);
      logger.warn?.(
        `Stoat returned HTTP ${response.status}; retrying in ${waitMs}ms.`
      );
      await sleep(waitMs);
    }
    throw new EmergencyLockError("The configured retry limit was exhausted.", {
      code: "retry_limit",
    });
  }

  async function fetchServer() {
    const server = await request("GET", `/servers/${serverId}`);
    const permissions = toPermissionBits(server?.default_permissions);
    if (server?._id !== serverId || permissions === null) {
      throw new EmergencyLockError(
        "Stoat returned a malformed or mismatched server snapshot.",
        { code: "invalid_response" }
      );
    }
    return { server, permissions };
  }

  async function setDefaultPermissions(permissions) {
    const value = permissionBitsToNumber(permissions);
    if (value === null) {
      throw new EmergencyLockError(
        "The server default permissions are outside JavaScript's safe integer range.",
        { code: "invalid_permissions" }
      );
    }
    await request("PUT", `/servers/${serverId}/permissions/default`, {
      permissions: value,
    });
  }

  async function lock() {
    let state = readState();
    while (true) {
      const { server, permissions } = await fetchServer();
      if (!hasPermission(permissions, PERMISSION_BITS.SendMessage)) {
        if (!state?.active) {
          return {
            outcome: "externally_locked",
            serverName: server.name ?? serverId,
          };
        }
        state = {
          ...state,
          lockedAt: state.lockedAt ?? now().toISOString(),
        };
        writeState(state);
        return {
          outcome: "emergency_locked",
          serverName: server.name ?? serverId,
        };
      }

      if (!state?.active) {
        state = {
          version: STATE_VERSION,
          serverId,
          serverName: server.name ?? null,
          active: true,
          restoreOnUnlock: true,
          capturedAt: now().toISOString(),
          lockedAt: null,
          restoredAt: null,
        };
        // Ownership is durable before the permission mutation occurs.
        writeState(state);
      }
      await setDefaultPermissions(
        removePermission(permissions, PERMISSION_BITS.SendMessage)
      );
    }
  }

  async function unlock() {
    let state = readState();
    if (!state?.active || !state.restoreOnUnlock) {
      return { outcome: "not_owned" };
    }

    while (true) {
      const level = activePostGateLevel(dataDir, serverId);
      if (level >= 3) {
        throw new EmergencyLockError(
          `Server moderation Level ${level} is active; lower it before releasing the VPS emergency lock.`,
          { code: "level_lock_active" }
        );
      }
      const { server, permissions } = await fetchServer();
      if (hasPermission(permissions, PERMISSION_BITS.SendMessage)) {
        state = {
          ...state,
          active: false,
          restoredAt: now().toISOString(),
        };
        writeState(state);
        return { outcome: "unlocked", serverName: server.name ?? serverId };
      }
      // Recheck after the network read so an in-server lockdown activated
      // during an outage cannot race this restoration write.
      const currentLevel = activePostGateLevel(dataDir, serverId);
      if (currentLevel >= 3) continue;
      await setDefaultPermissions(
        addPermission(permissions, PERMISSION_BITS.SendMessage)
      );
    }
  }

  async function status() {
    const state = readState();
    const level = activePostGateLevel(dataDir, serverId);
    const { server, permissions } = await fetchServer();
    const sendEnabled = hasPermission(permissions, PERMISSION_BITS.SendMessage);
    const outcome = state?.active
      ? sendEnabled
        ? "emergency_lock_pending"
        : "emergency_locked"
      : level >= 3 && !sendEnabled
        ? "level_locked"
        : sendEnabled
          ? "unlocked"
          : "externally_locked";
    return {
      outcome,
      serverName: server.name ?? serverId,
      serverId,
      sendEnabled,
      emergencyOwned: Boolean(state?.active),
      level,
      capturedAt: state?.capturedAt ?? null,
      lockedAt: state?.lockedAt ?? null,
      restoredAt: state?.restoredAt ?? null,
    };
  }

  return { lock, status, unlock, readState, statePath };
}
