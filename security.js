import { createHash, randomBytes } from "crypto";
import { EASTER_EGG_COMMAND_NAMES } from "./easter-eggs.js";

export const COMMAND_ACCESS = Object.freeze({
  MEMBER: "member",
  FETCH_MANAGER: "fetch_manager",
  ADMIN: "admin",
});

const FETCH_MANAGEMENT_COMMANDS = new Set([
  "enablefetch",
  "enablefetchhoyo",
  "enablefetchnte",
  "disablefetch",
]);

const AUDIT_LOG_COMMANDS = new Set([
  "auditlog",
  "enable-auditlog",
  "enableauditlog",
  "disable-auditlog",
  "disableauditlog",
  "test-auditlog",
  "testauditlog",
]);

const PUBLIC_UTILITY_COMMANDS = new Set([
  "helphoyofetch",
  "harhar",
  ...EASTER_EGG_COMMAND_NAMES,
]);

const SERVER_MODERATOR_PERMISSIONS = Object.freeze([
  "KickMembers",
  "BanMembers",
  "TimeoutMembers",
]);

const PERMISSION_BITS = Object.freeze({
  ManageServer: 2n ** 1n,
  KickMembers: 2n ** 6n,
  BanMembers: 2n ** 7n,
  TimeoutMembers: 2n ** 8n,
  ManageMessages: 2n ** 23n,
});

const SAFE_ID_PATTERN = /^[A-Za-z0-9]+$/;
const AUDIT_SALT = randomBytes(16);

export function getCommandAccess(body, commandGameMap = {}) {
  if (Object.hasOwn(commandGameMap, body)) return COMMAND_ACCESS.MEMBER;
  if (FETCH_MANAGEMENT_COMMANDS.has(body)) {
    return COMMAND_ACCESS.FETCH_MANAGER;
  }
  if (AUDIT_LOG_COMMANDS.has(body)) return COMMAND_ACCESS.FETCH_MANAGER;
  if (body === "emojimode" || body.startsWith("emojimode ")) {
    return COMMAND_ACCESS.FETCH_MANAGER;
  }
  if (body === "restart") return COMMAND_ACCESS.FETCH_MANAGER;
  if (PUBLIC_UTILITY_COMMANDS.has(body)) return COMMAND_ACCESS.MEMBER;
  return null;
}

export function isSafeId(value) {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

/**
 * Authorize a hydrated Stoat message for one of HoyoFetch's command classes.
 * All commands require a human server member and fail closed when hydration or
 * permission calculation is unavailable.
 */
export function authorizeCommand(message, access = COMMAND_ACCESS.MEMBER) {
  const context = getServerMessageContext(message);
  if (!context.allowed) return context;

  const cachedContext = { ...context, permissionSource: "cache" };
  const { authorId, channel, member, server } = cachedContext;
  const isOwner = server.ownerId === authorId;
  const isAdmin = isOwner || hasPermission(member, server, "ManageServer");

  if (access === COMMAND_ACCESS.MEMBER) {
    return { ...cachedContext, reason: "member" };
  }

  if (access === COMMAND_ACCESS.ADMIN) {
    return isAdmin
      ? { ...cachedContext, reason: isOwner ? "owner" : "admin" }
      : denied("insufficient_permission", cachedContext);
  }

  if (access === COMMAND_ACCESS.FETCH_MANAGER) {
    const isModerator =
      SERVER_MODERATOR_PERMISSIONS.some((permission) =>
        hasPermission(member, server, permission)
      ) || hasPermission(member, channel, "ManageMessages");

    if (isAdmin || isModerator) {
      return {
        ...cachedContext,
        reason: isOwner ? "owner" : isAdmin ? "admin" : "moderator",
      };
    }
    return denied("insufficient_permission", cachedContext);
  }

  return denied("unknown_access_policy", cachedContext);
}

/**
 * Re-evaluate a cached permission denial from fresh Stoat REST snapshots.
 * This never mutates revolt.js's caches and fails closed on any bad response.
 */
export async function refreshCommandAuthorization(
  client,
  cachedAuthorization,
  access,
  { logger = console } = {}
) {
  if (
    cachedAuthorization?.allowed ||
    cachedAuthorization?.reason !== "insufficient_permission" ||
    access === COMMAND_ACCESS.MEMBER
  ) {
    return cachedAuthorization;
  }

  const { authorId, channelId, server } = cachedAuthorization;
  const serverId = server?.id;
  if (
    !client?.api?.get ||
    !isSafeId(authorId) ||
    !isSafeId(channelId) ||
    !isSafeId(serverId)
  ) {
    return denied("insufficient_permission", {
      ...cachedAuthorization,
      permissionSource: "refresh_failed",
    });
  }

  try {
    const [serverSnapshot, memberResponse, channelSnapshot] = await Promise.all(
      [
        client.api.get(`/servers/${serverId}`),
        client.api.get(`/servers/${serverId}/members/${authorId}`, {
          roles: false,
        }),
        client.api.get(`/channels/${channelId}`),
      ]
    );
    const memberSnapshot = memberResponse?.member ?? memberResponse;
    const evaluated = evaluatePermissionSnapshot({
      authorId,
      server: serverSnapshot,
      member: memberSnapshot,
      channel: channelSnapshot,
    });

    if (!evaluated.valid) {
      return denied("insufficient_permission", {
        ...cachedAuthorization,
        permissionSource: "refresh_failed",
      });
    }

    const isAdmin =
      evaluated.isOwner ||
      hasPermissionBit(
        evaluated.serverPermissions,
        PERMISSION_BITS.ManageServer
      );
    const isModerator =
      SERVER_MODERATOR_PERMISSIONS.some((permission) =>
        hasPermissionBit(
          evaluated.serverPermissions,
          PERMISSION_BITS[permission]
        )
      ) ||
      hasPermissionBit(
        evaluated.channelPermissions,
        PERMISSION_BITS.ManageMessages
      );
    const allowed =
      access === COMMAND_ACCESS.ADMIN
        ? isAdmin
        : access === COMMAND_ACCESS.FETCH_MANAGER && (isAdmin || isModerator);

    if (!allowed) {
      return denied("insufficient_permission", {
        ...cachedAuthorization,
        permissionSource: "refreshed",
      });
    }

    return {
      ...cachedAuthorization,
      allowed: true,
      reason: evaluated.isOwner ? "owner" : isAdmin ? "admin" : "moderator",
      permissionSource: "refreshed",
    };
  } catch (error) {
    logger.warn?.(
      `permission refresh failed actor=${auditAlias(authorId)} ` +
        `server=${auditAlias(serverId)} channel=${auditAlias(channelId)} ` +
        safeErrorSummary(error)
    );
    return denied("insufficient_permission", {
      ...cachedAuthorization,
      permissionSource: "refresh_failed",
    });
  }
}

/**
 * Calculate effective server and channel permissions from raw API snapshots.
 * Permission values are int64 numbers, so BigInt avoids 32-bit truncation.
 */
export function evaluatePermissionSnapshot({
  authorId,
  server,
  member,
  channel,
  now = Date.now(),
} = {}) {
  const invalid = {
    valid: false,
    isOwner: false,
    serverPermissions: 0n,
    channelPermissions: 0n,
  };

  if (
    !isSafeId(authorId) ||
    !server ||
    !member ||
    !channel ||
    server._id !== member._id?.server ||
    server._id !== channel.server ||
    member._id?.user !== authorId ||
    channel.channel_type !== "TextChannel"
  ) {
    return invalid;
  }

  if (server.owner === authorId) {
    return {
      valid: true,
      isOwner: true,
      serverPermissions: PERMISSION_BITS.ManageServer,
      channelPermissions: PERMISSION_BITS.ManageMessages,
    };
  }

  const timeoutAt = member.timeout ? new Date(member.timeout).getTime() : null;
  if (timeoutAt !== null && (!Number.isFinite(timeoutAt) || timeoutAt > now)) {
    return {
      valid: Number.isFinite(timeoutAt),
      isOwner: false,
      serverPermissions: 0n,
      channelPermissions: 0n,
    };
  }

  const serverPermissions = toPermissionBits(server.default_permissions);
  const roleIds = member.roles ?? [];
  const roles = server.roles ?? {};
  if (
    serverPermissions === null ||
    !Array.isArray(roleIds) ||
    !isPlainObject(roles) ||
    !isPlainObject(channel.role_permissions ?? {})
  ) {
    return invalid;
  }

  const orderedRoles = [];
  for (const roleId of roleIds) {
    if (!isSafeId(roleId) || !isPlainObject(roles[roleId])) return invalid;
    if (
      roles[roleId].rank !== undefined &&
      !Number.isFinite(roles[roleId].rank)
    ) {
      return invalid;
    }
    orderedRoles.push({ id: roleId, ...roles[roleId] });
  }
  orderedRoles.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));

  let effectiveServer = serverPermissions;
  for (const role of orderedRoles) {
    effectiveServer = applyPermissionOverride(
      effectiveServer,
      role.permissions
    );
    if (effectiveServer === null) return invalid;
  }

  let effectiveChannel = effectiveServer;
  if (
    channel.default_permissions !== undefined &&
    channel.default_permissions !== null
  ) {
    effectiveChannel = applyPermissionOverride(
      effectiveChannel,
      channel.default_permissions
    );
    if (effectiveChannel === null) return invalid;
  }
  for (const role of orderedRoles) {
    const override = channel.role_permissions?.[role.id];
    if (!override) continue;
    effectiveChannel = applyPermissionOverride(effectiveChannel, override);
    if (effectiveChannel === null) return invalid;
  }

  return {
    valid: true,
    isOwner: false,
    serverPermissions: effectiveServer,
    channelPermissions: effectiveChannel,
  };
}

function applyPermissionOverride(current, override) {
  if (!isPlainObject(override)) return null;
  const allow = toPermissionBits(override.a);
  const deny = toPermissionBits(override.d);
  if (allow === null || deny === null) return null;
  return (current | allow) & ~deny;
}

function toPermissionBits(value) {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function hasPermissionBit(value, permission) {
  return (value & permission) === permission;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getServerMessageContext(message) {
  try {
    if (!message || message.webhook) return denied("webhook");

    const author = message.author;
    if (!author) return denied("missing_author");
    if (author.bot) return denied("bot");

    const authorId = message.authorId;
    const channelId = message.channelId;
    const channel = message.channel;
    const server = message.server ?? channel?.server;
    const member = message.member;

    if (!isSafeId(authorId) || !isSafeId(channelId)) {
      return denied("invalid_identifier");
    }
    if (!channel || channel.id !== channelId) {
      return denied("missing_channel");
    }
    if (!server || !isSafeId(server.id)) {
      return denied("missing_server");
    }
    if (
      !member ||
      member.id?.user !== authorId ||
      member.id?.server !== server.id
    ) {
      return denied("missing_member");
    }

    return {
      allowed: true,
      authorId,
      channel,
      channelId,
      member,
      server,
    };
  } catch {
    return denied("context_error");
  }
}

function hasPermission(member, target, permission) {
  try {
    return Boolean(member?.hasPermission?.(target, permission));
  } catch {
    return false;
  }
}

function denied(reason, context = {}) {
  return { ...context, allowed: false, reason };
}

/**
 * Fixed-window, per-author command limiter.
 */
export class CommandRateLimiter {
  constructor({
    limit = 5,
    windowMs = 30_000,
    maxActors = 1_000,
    now = Date.now,
  } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxActors = maxActors;
    this.now = now;
    this.actors = new Map();
  }

  check(actorId) {
    const now = this.now();
    this.prune(now);

    let entry = this.actors.get(actorId);
    if (!entry || now >= entry.resetAt) {
      entry = {
        count: 0,
        noticeSent: false,
        resetAt: now + this.windowMs,
      };
      this.actors.delete(actorId);
      this.actors.set(actorId, entry);
      this.enforceCapacity();
    }

    if (entry.count < this.limit) {
      entry.count += 1;
      return {
        allowed: true,
        notify: false,
        retryAfterMs: 0,
      };
    }

    const notify = !entry.noticeSent;
    entry.noticeSent = true;
    return {
      allowed: false,
      notify,
      retryAfterMs: Math.max(0, entry.resetAt - now),
    };
  }

  prune(now = this.now()) {
    for (const [actorId, entry] of this.actors) {
      if (now >= entry.resetAt) this.actors.delete(actorId);
    }
  }

  enforceCapacity() {
    while (this.actors.size > this.maxActors) {
      this.actors.delete(this.actors.keys().next().value);
    }
  }
}

/**
 * Share an in-flight asynchronous operation by key and always clear failures.
 */
export class SingleFlight {
  constructor() {
    this.inFlight = new Map();
  }

  run(key, operation) {
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
        }
      });
    this.inFlight.set(key, promise);
    return promise;
  }
}

export function auditAlias(value) {
  if (!isSafeId(value)) return "unknown";
  return createHash("sha256")
    .update(AUDIT_SALT)
    .update(value)
    .digest("hex")
    .slice(0, 12);
}

export function safeErrorSummary(error) {
  const name =
    typeof error?.name === "string" && error.name.length <= 80
      ? error.name
      : "Error";
  const message =
    typeof error?.message === "string" ? error.message : "operation failed";
  const sanitised = message
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b[A-Za-z0-9]{16,}\b/g, "[identifier]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
  return `${name}: ${sanitised}`;
}
