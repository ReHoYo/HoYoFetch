// account-lookup.js — network-backed account resolution for /Get-Info.
// Keep this outside user-info.js so the join-log path remains structurally
// cache-only during join floods.
import { ULID_PATTERN } from "./command-args.js";
import { auditAlias } from "./security.js";

export const LOOKUP_SCOPE = Object.freeze({
  MEMBER: "member",
  BANNED: "banned",
  FORMER: "former",
  OUTSIDE: "outside",
  PLATFORM: "platform",
  UNKNOWN: "unknown",
  MISSING: "missing",
});

const banCaches = new WeakMap();

function pathId(value) {
  return encodeURIComponent(String(value));
}

/** Build status-aware probes around bot.js's raw REST helper. */
export function buildLookupProbes(apiRequest) {
  if (typeof apiRequest !== "function") {
    throw new TypeError("Account lookup requires an API request function.");
  }
  return Object.freeze({
    member: (serverId, userId) =>
      apiRequest(
        "GET",
        `/servers/${pathId(serverId)}/members/${pathId(userId)}`
      ),
    user: (userId) => apiRequest("GET", `/users/${pathId(userId)}`),
    bans: (serverId) => apiRequest("GET", `/servers/${pathId(serverId)}/bans`),
    flags: (userId) => apiRequest("GET", `/users/${pathId(userId)}/flags`),
    profile: (userId) => apiRequest("GET", `/users/${pathId(userId)}/profile`),
  });
}

function statusOf(result, fallback = "skipped") {
  return Number.isFinite(result?.status) ? result.status : fallback;
}

function isUserPayload(result, userId) {
  return result?.ok === true && result.data?._id === userId;
}

function isMemberPayload(result, serverId, userId) {
  const id = result?.data?._id;
  return result?.ok === true && id?.server === serverId && id?.user === userId;
}

function isBanListPayload(result) {
  return (
    result?.ok === true &&
    Array.isArray(result.data?.bans) &&
    Array.isArray(result.data?.users)
  );
}

function identityFromUser(user) {
  if (!user) return null;
  return Object.freeze({
    username: user.username ?? null,
    discriminator: user.discriminator ?? null,
    displayName: user.displayName ?? null,
    hasCustomAvatar: Boolean(user.avatar),
  });
}

function identityFromBanUser(user) {
  if (!user) return null;
  return Object.freeze({
    username: user.username ?? null,
    discriminator: user.discriminator ?? null,
    displayName: user.display_name ?? user.displayName ?? null,
    hasCustomAvatar: Boolean(user.avatar),
  });
}

async function fetchBanList(probes, serverId, ttlMs, now) {
  let cache = banCaches.get(probes);
  if (!cache) {
    cache = new Map();
    banCaches.set(probes, cache);
  }
  const cached = cache.get(serverId);
  if (cached && now - cached.at < ttlMs) return cached.result;

  const pending = Promise.resolve(probes.bans(serverId)).catch(() => ({
    ok: false,
    status: 0,
    data: undefined,
  }));
  cache.set(serverId, { at: now, result: pending });
  return pending;
}

function cachedMutualServers(client, currentServerId, userId) {
  const seen = new Set();
  const mutualServers = [];
  for (const member of client.serverMembers.values()) {
    const serverId = member?.id?.server;
    if (
      member?.id?.user !== userId ||
      !serverId ||
      serverId === currentServerId ||
      seen.has(serverId) ||
      client.serverMembers.isPartialByKey?.(member.id)
    ) {
      continue;
    }
    seen.add(serverId);
    mutualServers.push(
      Object.freeze({
        id: serverId,
        name: client.servers.get(serverId)?.name ?? serverId,
      })
    );
  }
  return Object.freeze(mutualServers);
}

function freezeSummary(summary) {
  return Object.freeze({
    ...summary,
    mutualServers: Object.freeze([...(summary.mutualServers ?? [])]),
    probeStatuses: Object.freeze({ ...summary.probeStatuses }),
  });
}

/**
 * Resolve as much as Stoat will reveal without treating permission failures as
 * a missing account. Every network response is validated before hydration.
 */
export async function resolveAccountLookup(
  client,
  { serverId, userId, probes, banCacheTtlMs = 30_000, now = Date.now() }
) {
  if (!probes) throw new TypeError("Account lookup probes are required.");

  const idWellFormed = ULID_PATTERN.test(userId);
  const memberKey = { server: serverId, user: userId };
  let member = client.serverMembers.getByKey(memberKey) ?? null;
  if (member && client.serverMembers.isPartialByKey?.(memberKey)) member = null;
  let user = client.users.get(userId) ?? null;
  if (user && client.users.isPartial?.(userId)) user = null;
  let profile = null;
  let identitySource = user ? "cache" : "none";
  let banned = false;
  let banReason = null;
  let banListChecked = false;
  let platformFlags = null;
  let accountExists = member || user ? true : null;
  const probeStatuses = {
    member: member ? "cache" : "skipped",
    user: user ? "cache" : "skipped",
    bans: "skipped",
    flags: "skipped",
    profile: "skipped",
  };

  if (!member) {
    const result = await Promise.resolve(probes.member(serverId, userId)).catch(
      () => ({ ok: false, status: 0 })
    );
    probeStatuses.member = statusOf(result, 0);
    if (isMemberPayload(result, serverId, userId)) {
      member = client.serverMembers.getOrCreate(result.data._id, result.data);
      accountExists = true;
    }
  }

  if (member && !user) {
    const result = await Promise.resolve(probes.user(userId)).catch(() => ({
      ok: false,
      status: 0,
    }));
    probeStatuses.user = statusOf(result, 0);
    if (isUserPayload(result, userId)) {
      user = client.users.getOrCreate(userId, result.data);
      identitySource = "fetch";
      accountExists = true;
    }
  }

  let banIdentity = null;
  if (!member) {
    const userPromise = user
      ? Promise.resolve(null)
      : Promise.resolve(probes.user(userId)).catch(() => ({
          ok: false,
          status: 0,
        }));
    const bansPromise = fetchBanList(probes, serverId, banCacheTtlMs, now);
    const [userResult, bansResult] = await Promise.all([
      userPromise,
      bansPromise,
    ]);

    if (userResult) {
      probeStatuses.user = statusOf(userResult, 0);
      if (isUserPayload(userResult, userId)) {
        user = client.users.getOrCreate(userId, userResult.data);
        identitySource = "fetch";
        accountExists = true;
      }
    }

    probeStatuses.bans = statusOf(bansResult, 0);
    if (isBanListPayload(bansResult)) {
      banListChecked = true;
      const ban = bansResult.data.bans.find(
        (entry) =>
          entry?._id?.server === serverId && entry?._id?.user === userId
      );
      if (ban) {
        banned = true;
        banReason = typeof ban.reason === "string" ? ban.reason : null;
        banIdentity = bansResult.data.users.find(
          (entry) => entry?._id === userId
        );
        accountExists = true;
        if (!user && banIdentity) identitySource = "ban-list";
      }
      // Do not call setKnownBans here. Unban polling owns that snapshot; writing
      // this read-only lookup into it could suppress a real unban audit event.
    }
  }

  const mutualServers = cachedMutualServers(client, serverId, userId);

  if (!user && !member) {
    const result = await Promise.resolve(probes.flags(userId)).catch(() => ({
      ok: false,
      status: 0,
    }));
    probeStatuses.flags = statusOf(result, 0);
    if (result?.ok && Number.isInteger(result.data?.flags)) {
      platformFlags = result.data.flags;
      accountExists = true;
    } else if (
      result?.status === 404 &&
      idWellFormed &&
      accountExists !== true
    ) {
      accountExists = false;
    }
  }

  if (user) {
    const result = await Promise.resolve(probes.profile(userId)).catch(() => ({
      ok: false,
      status: 0,
    }));
    probeStatuses.profile = statusOf(result, 0);
    if (result?.ok && result.data && typeof result.data === "object") {
      profile = result.data;
    }
  }

  let scope;
  if (member) scope = LOOKUP_SCOPE.MEMBER;
  else if (banned) scope = LOOKUP_SCOPE.BANNED;
  else if (user || mutualServers.length) scope = LOOKUP_SCOPE.OUTSIDE;
  else if (accountExists === true) scope = LOOKUP_SCOPE.PLATFORM;
  else if (accountExists === false) scope = LOOKUP_SCOPE.MISSING;
  else scope = LOOKUP_SCOPE.UNKNOWN;

  const summary = freezeSummary({
    scope,
    identitySource,
    identity: user ? identityFromUser(user) : identityFromBanUser(banIdentity),
    accountExists,
    platformFlags,
    banned,
    banReason,
    banListChecked,
    mutualElsewhere: mutualServers.length > 0,
    mutualServers,
    idWellFormed,
    probeStatuses,
  });

  if (process.env.HOYOFETCH_GETINFO_DEBUG === "1") {
    console.warn(
      `get-info: target=${auditAlias(userId)} probes=${JSON.stringify(summary.probeStatuses)}`
    );
  }

  return { user, member, profile, summary };
}
