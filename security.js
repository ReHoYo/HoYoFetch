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

const SAFE_ID_PATTERN = /^[A-Za-z0-9]+$/;
const AUDIT_SALT = randomBytes(16);

export function getCommandAccess(body, commandGameMap = {}) {
  if (Object.hasOwn(commandGameMap, body)) return COMMAND_ACCESS.MEMBER;
  if (FETCH_MANAGEMENT_COMMANDS.has(body)) {
    return COMMAND_ACCESS.FETCH_MANAGER;
  }
  if (body === "emojimode" || body.startsWith("emojimode ")) {
    return COMMAND_ACCESS.ADMIN;
  }
  if (body === "restart") return COMMAND_ACCESS.ADMIN;
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

  const { authorId, channel, member, server } = context;
  const isOwner = server.ownerId === authorId;
  const isAdmin =
    isOwner || hasPermission(member, server, "ManageServer");

  if (access === COMMAND_ACCESS.MEMBER) {
    return { ...context, reason: "member" };
  }

  if (access === COMMAND_ACCESS.ADMIN) {
    return isAdmin
      ? { ...context, reason: isOwner ? "owner" : "admin" }
      : denied("insufficient_permission", context);
  }

  if (access === COMMAND_ACCESS.FETCH_MANAGER) {
    const isModerator =
      SERVER_MODERATOR_PERMISSIONS.some((permission) =>
        hasPermission(member, server, permission)
      ) || hasPermission(member, channel, "ManageMessages");

    if (isAdmin || isModerator) {
      return {
        ...context,
        reason: isOwner ? "owner" : isAdmin ? "admin" : "moderator",
      };
    }
    return denied("insufficient_permission", context);
  }

  return denied("unknown_access_policy", context);
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
