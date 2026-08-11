// raid-mode.js — one shared join-surge state for Post Gate and Automod
// ────────────────────────────────────────────────────────────────────────────
import { buildStatusEmbed } from "./embeds.js";
import {
  getAllPostGateConfigs,
  getAutomodConfig,
  getPostGateConfig,
  setPostGateRaidMode,
} from "./store.js";
import {
  RAID_MODE_POLICY,
  resolveModerationPolicy,
} from "./moderation-policy.js";
import { auditAlias, isSafeId, safeErrorSummary } from "./security.js";

const MAX_SERVERS = 1_000;
const MAX_JOINS_PER_SERVER = 100;

const DEFAULT_STORE = Object.freeze({
  getAllPostGateConfigs,
  getAutomodConfig,
  getPostGateConfig,
  setPostGateRaidMode,
});

export function createRaidModeCoordinator({
  sendProtected,
  store = DEFAULT_STORE,
  logger = console,
  now = Date.now,
  scheduleTimeout = setTimeout,
} = {}) {
  if (typeof sendProtected !== "function") {
    throw new TypeError("Raid Mode requires a protected sender.");
  }

  const joinStates = new Map();
  const expiryTimers = new Map();

  function logFailure(label, error) {
    logger.warn?.(`raid-mode: ${label} ${safeErrorSummary(error)}`);
  }

  function getPolicy(serverId) {
    return resolveModerationPolicy(store.getPostGateConfig(serverId), now());
  }

  function enabledLayers(serverId) {
    const postGate = store.getPostGateConfig(serverId);
    const automod = store.getAutomodConfig(serverId);
    return {
      postGate,
      automod,
      enabled: postGate.mode === "hold" || automod.mode !== "off",
    };
  }

  function noticeChannels(serverId) {
    const { postGate, automod } = enabledLayers(serverId);
    return [
      postGate.mode === "hold" ? postGate.reviewChannelId : null,
      automod.mode !== "off" ? automod.logChannelId : null,
    ].filter((channelId, index, values) => {
      return isSafeId(channelId) && values.indexOf(channelId) === index;
    });
  }

  async function notify(serverId, title, description, colour) {
    const embed = buildStatusEmbed(title, description, colour);
    await Promise.all(
      noticeChannels(serverId).map(async (channelId) => {
        try {
          await sendProtected(channelId, { embeds: [embed] });
        } catch (error) {
          logFailure("protected notice failed", error);
        }
      })
    );
  }

  function clearExpiryTimer(serverId) {
    const timer = expiryTimers.get(serverId);
    if (timer) clearTimeout(timer);
    expiryTimers.delete(serverId);
  }

  function scheduleExpiry(serverId, expiresAt) {
    clearExpiryTimer(serverId);
    const delay = Math.max(0, expiresAt - now());
    const timer = scheduleTimeout(() => {
      expiryTimers.delete(serverId);
      void expireServer(serverId);
    }, delay);
    timer?.unref?.();
    expiryTimers.set(serverId, timer);
  }

  async function expireServer(serverId) {
    const config = store.getPostGateConfig(serverId);
    const raidMode = config.raidMode;
    if (!raidMode) return { outcome: "inactive" };
    if (raidMode.expiresAt > now()) {
      scheduleExpiry(serverId, raidMode.expiresAt);
      return { outcome: "scheduled" };
    }

    store.setPostGateRaidMode(serverId, null);
    const policy = getPolicy(serverId);
    await notify(
      serverId,
      "✅ Shared Raid Mode Ended",
      `The automatic Level 2 floor expired. The effective server policy is now Level ${policy.effectiveLevel}${policy.configuredLevel ? ` (configured Level ${policy.configuredLevel})` : " for Automod only"}.`,
      "#2ECC71"
    );
    logger.log?.(`✅  raid-mode expired server=${auditAlias(serverId)}`);
    return { outcome: "expired", policy };
  }

  function stateFor(serverId) {
    let state = joinStates.get(serverId);
    if (!state) {
      state = { joins: [] };
      joinStates.set(serverId, state);
      while (joinStates.size > MAX_SERVERS) {
        joinStates.delete(joinStates.keys().next().value);
      }
    }
    return state;
  }

  async function handleMemberJoin(member) {
    const serverId = member?.id?.server;
    const userId = member?.id?.user;
    if (
      !isSafeId(serverId) ||
      !isSafeId(userId) ||
      member?.user?.bot ||
      !enabledLayers(serverId).enabled
    ) {
      return { outcome: "ignored" };
    }

    const current = now();
    const state = stateFor(serverId);
    state.joins = state.joins
      .filter(
        (entry) => current - entry.at < RAID_MODE_POLICY.joinSurgeWindowMs
      )
      .slice(-(MAX_JOINS_PER_SERVER - 1));
    if (state.joins.some((entry) => entry.userId === userId)) {
      return { outcome: "duplicate", joinCount: state.joins.length };
    }
    state.joins.push({ userId, at: current });

    if (state.joins.length < RAID_MODE_POLICY.joinSurgeCount) {
      return { outcome: "recorded", joinCount: state.joins.length };
    }

    const config = store.getPostGateConfig(serverId);
    const active = Number(config.raidMode?.expiresAt) > current;
    const lastRefreshAt = Number(config.raidMode?.lastRefreshAt) || 0;
    if (
      active &&
      current - lastRefreshAt < RAID_MODE_POLICY.refreshThrottleMs
    ) {
      return { outcome: "active", joinCount: state.joins.length };
    }

    const raidMode = {
      startedAt: active ? config.raidMode.startedAt : current,
      expiresAt: current + RAID_MODE_POLICY.durationMs,
      lastRefreshAt: current,
    };
    store.setPostGateRaidMode(serverId, raidMode);
    scheduleExpiry(serverId, raidMode.expiresAt);
    const policy = getPolicy(serverId);

    if (!active) {
      await notify(
        serverId,
        "🚨 Shared Raid Mode Activated",
        `${state.joins.length} members joined within 60 seconds. A temporary Level 2 floor is active until ${new Date(raidMode.expiresAt).toISOString()}. Post Gate uses targeted 14-day account and 3-day membership checks when enabled; Automod still requires message behavior and a score of 2. **No member was punished by the join surge alone.**`,
        "#E67E22"
      );
      logger.log?.(
        `🚨  raid-mode activated server=${auditAlias(serverId)} until=${raidMode.expiresAt}`
      );
      return {
        outcome: "activated",
        joinCount: state.joins.length,
        raidMode,
        policy,
      };
    }

    return {
      outcome: "refreshed",
      joinCount: state.joins.length,
      raidMode,
      policy,
    };
  }

  async function start() {
    for (const config of store.getAllPostGateConfigs()) {
      if (!config.raidMode) continue;
      if (config.raidMode.expiresAt > now()) {
        scheduleExpiry(config.serverId, config.raidMode.expiresAt);
      } else {
        await expireServer(config.serverId);
      }
    }
  }

  return {
    expireServer,
    getPolicy,
    handleMemberJoin,
    start,
  };
}
