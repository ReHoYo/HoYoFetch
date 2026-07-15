// settings-monitor.js — deep, actor-honest server-settings audit monitoring
// Stoat gateway settings events do not include the administrator who acted.
// This monitor therefore records exact actors only for resources whose models
// carry a creator, and labels every other actor as unavailable.

import { createHash } from "crypto";
import { buildAuditEmbed } from "./embeds.js";
import {
  getAuditLogServers,
  getServerSettingsSnapshot,
  isAuditLogEnabled,
  removeServerSettingsSnapshot,
  setServerSettingsSnapshot,
} from "./store.js";
import { auditAlias, isSafeId, safeErrorSummary } from "./security.js";

const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_WEBHOOK_BATCH_SIZE = 10;
const SNAPSHOT_VERSION = 1;
const MAX_EMITS_PER_RECONCILE = 25;

const PERMISSION_BITS = Object.freeze({
  ManageChannel: 0,
  ManageServer: 1,
  ManagePermissions: 2,
  ManageRole: 3,
  ManageCustomisation: 4,
  KickMembers: 6,
  BanMembers: 7,
  TimeoutMembers: 8,
  AssignRoles: 9,
  ChangeNickname: 10,
  ManageNicknames: 11,
  ChangeAvatar: 12,
  RemoveAvatars: 13,
  ViewChannel: 20,
  ReadMessageHistory: 21,
  SendMessage: 22,
  ManageMessages: 23,
  ManageWebhooks: 24,
  InviteOthers: 25,
  SendEmbeds: 26,
  UploadFiles: 27,
  Masquerade: 28,
  React: 29,
  Connect: 30,
  Speak: 31,
  Video: 32,
  MuteMembers: 33,
  DeafenMembers: 34,
  MoveMembers: 35,
  MentionEveryone: 37,
  MentionRoles: 38,
});

const SERVER_FIELDS = Object.freeze([
  ["owner", "Owner"],
  ["name", "Name"],
  ["description", "Description"],
  ["nsfw", "NSFW"],
  ["analytics", "Analytics"],
  ["discoverable", "Discoverable"],
  ["flags", "Flags"],
]);

const CHANNEL_FIELDS = Object.freeze([
  ["name", "Name"],
  ["description", "Description"],
  ["nsfw", "NSFW"],
  ["archived", "Archived"],
  ["slowmode", "Slowmode"],
]);

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function sortedObject(entries) {
  return Object.fromEntries(
    entries
      .filter(([key]) => typeof key === "string" && key.length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

function fileId(value) {
  if (typeof value === "string") return value;
  return value?._id ?? value?.id ?? null;
}

function normaliseOverride(value) {
  if (!plainObject(value)) return null;
  return { a: value.a ?? 0, d: value.d ?? 0 };
}

function normaliseRole(role = {}) {
  return {
    name: role.name ?? "Unknown role",
    colour: role.colour ?? null,
    hoist: Boolean(role.hoist),
    rank: role.rank ?? 0,
    permissions: normaliseOverride(role.permissions),
  };
}

function normaliseChannel(channel = {}) {
  const rolePermissions =
    channel.role_permissions ?? channel.rolePermissions ?? {};
  return {
    id: channel._id ?? channel.id,
    type: channel.channel_type ?? channel.type ?? "Unknown",
    name: channel.name ?? "Unknown channel",
    description: channel.description ?? null,
    icon: fileId(channel.icon),
    nsfw: Boolean(channel.nsfw),
    archived: Boolean(channel.archived),
    slowmode: channel.slowmode ?? channel.slow_mode ?? null,
    defaultPermissions: normaliseOverride(
      channel.default_permissions ?? channel.defaultPermissions
    ),
    rolePermissions: sortedObject(
      Object.entries(rolePermissions).map(([roleId, override]) => [
        roleId,
        normaliseOverride(override),
      ])
    ),
  };
}

function normaliseCategories(categories) {
  return (Array.isArray(categories) ? categories : []).map((category) => ({
    id: category.id,
    title: category.title ?? "Untitled",
    channels: Array.isArray(category.channels) ? [...category.channels] : [],
  }));
}

function normaliseSystemMessages(value) {
  const source = plainObject(value) ? value : {};
  return {
    user_joined: source.user_joined ?? null,
    user_left: source.user_left ?? null,
    user_kicked: source.user_kicked ?? null,
    user_banned: source.user_banned ?? null,
  };
}

function normaliseServerResponse(data) {
  const server = data?.server ?? data;
  if (!plainObject(server) || !isSafeId(server._id ?? server.id)) return null;
  const channelValues = Array.isArray(data?.channels)
    ? data.channels
    : Array.isArray(server.channels)
      ? server.channels
      : [];
  // `include_channels=true` must return complete channel objects. Treat an
  // ID-only or mixed response as unusable instead of falsely reporting every
  // previously known channel as deleted.
  if (channelValues.some((channel) => !plainObject(channel))) return null;
  const channels = sortedObject(
    channelValues.map((channel) => [
      channel._id ?? channel.id,
      normaliseChannel(channel),
    ])
  );
  const roles = sortedObject(
    Object.entries(server.roles ?? {}).map(([roleId, role]) => [
      roleId,
      normaliseRole(role),
    ])
  );

  return {
    server: {
      id: server._id ?? server.id,
      owner: server.owner ?? server.ownerId ?? null,
      name: server.name ?? "Unknown server",
      description: server.description ?? null,
      icon: fileId(server.icon),
      banner: fileId(server.banner),
      categories: normaliseCategories(server.categories),
      systemMessages: normaliseSystemMessages(
        server.system_messages ?? server.systemMessages
      ),
      defaultPermissions:
        server.default_permissions ?? server.defaultPermissions ?? 0,
      flags: server.flags ?? 0,
      nsfw: Boolean(server.nsfw),
      analytics: Boolean(server.analytics),
      discoverable: Boolean(server.discoverable),
    },
    channels,
    roles,
  };
}

function opaqueIdentity(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function normaliseInvites(values) {
  if (!Array.isArray(values)) return null;
  return sortedObject(
    values
      .filter((invite) => plainObject(invite) && invite._id)
      .map((invite) => [
        opaqueIdentity(invite._id),
        {
          channelId: invite.channel ?? null,
          creatorId: invite.creator ?? null,
        },
      ])
  );
}

function normaliseEmojis(values) {
  if (!Array.isArray(values)) return null;
  return sortedObject(
    values
      .filter((emoji) => plainObject(emoji) && (emoji._id ?? emoji.id))
      .map((emoji) => [
        emoji._id ?? emoji.id,
        {
          name: emoji.name ?? "Unknown emoji",
          creatorId: emoji.creator_id ?? emoji.creator?.id ?? null,
          animated: Boolean(emoji.animated),
          nsfw: Boolean(emoji.nsfw),
        },
      ])
  );
}

function normaliseWebhooks(values, channelId) {
  if (!Array.isArray(values)) return null;
  return sortedObject(
    values
      .filter((webhook) => plainObject(webhook) && (webhook.id ?? webhook._id))
      .map((webhook) => [
        webhook.id ?? webhook._id,
        {
          name: webhook.name ?? "Unknown webhook",
          avatar: fileId(webhook.avatar),
          channelId: webhook.channel_id ?? channelId,
          permissions: webhook.permissions ?? 0,
          creatorId: webhook.creator_id ?? null,
        },
      ])
  );
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function display(value) {
  if (value === null || value === undefined || value === "") return "*(none)*";
  if (typeof value === "boolean") return value ? "enabled" : "disabled";
  if (plainObject(value) || Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

function toBits(value) {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isFinite(value)) {
      return BigInt(Math.trunc(value));
    }
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  } catch {
    // Invalid or unsafe permission payloads are displayed opaquely below.
  }
  return null;
}

function permissionNames(value) {
  const bits = toBits(value);
  if (bits === null) return [];
  return Object.entries(PERMISSION_BITS)
    .filter(([, bit]) => (bits & (1n << BigInt(bit))) !== 0n)
    .map(([name]) => name);
}

function permissionDelta(before, after) {
  const previous = new Set(permissionNames(before));
  const current = new Set(permissionNames(after));
  return {
    granted: [...current].filter((name) => !previous.has(name)),
    revoked: [...previous].filter((name) => !current.has(name)),
  };
}

function permissionLines(label, before, after) {
  if (same(before, after)) return [];
  const delta = permissionDelta(before, after);
  const lines = [];
  if (delta.granted.length)
    lines.push(`**${label} granted:** ${delta.granted.join(", ")}`);
  if (delta.revoked.length)
    lines.push(`**${label} revoked:** ${delta.revoked.join(", ")}`);
  if (!lines.length) lines.push(`**${label}:** changed`);
  return lines;
}

function overrideLines(label, before, after) {
  if (same(before, after)) return [];
  return [
    ...permissionLines(`${label} allow`, before?.a ?? 0, after?.a ?? 0),
    ...permissionLines(`${label} deny`, before?.d ?? 0, after?.d ?? 0),
  ];
}

function formatUser(client, userId) {
  if (!userId) return "Unknown user";
  const user = client.users?.get?.(userId);
  return user?.username ? `@${user.username} (${userId})` : `User ${userId}`;
}

function attributionLines(client, change, source) {
  const lines = [];
  if (change.actorId) {
    lines.push(`**Verified actor:** ${formatUser(client, change.actorId)}`);
    lines.push(`**Attribution source:** ${change.actorSource}`);
  } else {
    lines.push(
      "**Actor:** Unavailable — Stoat did not include an actor for this change."
    );
  }
  if (source === "reconciliation") {
    lines.push(
      "**Detection:** Found during reconciliation; the exact change time is unavailable."
    );
  }
  return lines;
}

function changedFields(before, after, fields) {
  return fields.flatMap(([key, label]) =>
    same(before?.[key], after?.[key])
      ? []
      : [`**${label}:** ${display(before?.[key])} → ${display(after?.[key])}`]
  );
}

function diffMap(before = {}, after = {}) {
  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(after));
  return {
    added: [...afterKeys].filter((key) => !beforeKeys.has(key)),
    removed: [...beforeKeys].filter((key) => !afterKeys.has(key)),
    shared: [...afterKeys].filter((key) => beforeKeys.has(key)),
  };
}

function channelList(ids) {
  const values = Array.isArray(ids) ? ids : [];
  const shown = values.slice(0, 8).map((id) => `<#${id}>`);
  if (values.length > shown.length)
    shown.push(`… (+${values.length - shown.length})`);
  return shown.length ? shown.join(", ") : "*(none)*";
}

function categoryLines(beforeCategories, afterCategories) {
  const before = sortedObject(
    (beforeCategories ?? []).map((category) => [category.id, category])
  );
  const after = sortedObject(
    (afterCategories ?? []).map((category) => [category.id, category])
  );
  const diff = diffMap(before, after);
  const lines = [];
  for (const id of diff.added) {
    lines.push(`**Category added:** ${after[id].title}`);
  }
  for (const id of diff.removed) {
    lines.push(`**Category removed:** ${before[id].title}`);
  }
  for (const id of diff.shared) {
    if (before[id].title !== after[id].title) {
      lines.push(
        `**Category renamed:** ${before[id].title} → ${after[id].title}`
      );
    }
    if (!same(before[id].channels, after[id].channels)) {
      lines.push(
        `**${after[id].title} channels/order:** ${channelList(before[id].channels)} → ${channelList(after[id].channels)}`
      );
    }
  }
  return lines;
}

export function diffSettingsSnapshots(before, after) {
  const changes = [];
  const serverLines = changedFields(before.server, after.server, SERVER_FIELDS);
  if (!same(before.server?.icon, after.server?.icon))
    serverLines.push("**Icon:** changed");
  if (!same(before.server?.banner, after.server?.banner))
    serverLines.push("**Banner:** changed");
  serverLines.push(
    ...permissionLines(
      "Default permissions",
      before.server?.defaultPermissions,
      after.server?.defaultPermissions
    )
  );
  if (!same(before.server?.categories, after.server?.categories)) {
    serverLines.push(
      ...categoryLines(before.server?.categories, after.server?.categories)
    );
  }
  for (const [key, label] of [
    ["user_joined", "Join messages"],
    ["user_left", "Leave messages"],
    ["user_kicked", "Kick messages"],
    ["user_banned", "Ban messages"],
  ]) {
    if (
      !same(
        before.server?.systemMessages?.[key],
        after.server?.systemMessages?.[key]
      )
    ) {
      serverLines.push(
        `**${label}:** ${display(before.server?.systemMessages?.[key])} → ${display(after.server?.systemMessages?.[key])}`
      );
    }
  }
  if (serverLines.length) {
    changes.push({
      title: "⚙️ Server Settings Updated",
      lines: serverLines,
      colour: "#9B59B6",
    });
  }

  const channelDiff = diffMap(before.channels, after.channels);
  for (const id of channelDiff.added) {
    const channel = after.channels[id];
    changes.push({
      title: "📁 Channel Created",
      lines: [
        `**Channel:** <#${id}>`,
        `**Name:** ${channel.name}`,
        `**Type:** ${channel.type}`,
      ],
      colour: "#2ECC71",
    });
  }
  for (const id of channelDiff.removed) {
    const channel = before.channels[id];
    changes.push({
      title: "📁 Channel Deleted",
      lines: [
        `**Channel:** ${channel.name} (${id})`,
        `**Type:** ${channel.type}`,
      ],
      colour: "#E74C3C",
    });
  }
  for (const id of channelDiff.shared) {
    const previous = before.channels[id];
    const current = after.channels[id];
    const lines = changedFields(previous, current, CHANNEL_FIELDS);
    if (!same(previous.icon, current.icon)) lines.push("**Icon:** changed");
    lines.push(
      ...overrideLines(
        "Default permissions",
        previous.defaultPermissions,
        current.defaultPermissions
      )
    );
    const overrideDiff = diffMap(
      previous.rolePermissions,
      current.rolePermissions
    );
    for (const roleId of [
      ...overrideDiff.added,
      ...overrideDiff.removed,
      ...overrideDiff.shared,
    ]) {
      lines.push(
        ...overrideLines(
          `Role ${after.roles?.[roleId]?.name ?? before.roles?.[roleId]?.name ?? roleId}`,
          previous.rolePermissions?.[roleId],
          current.rolePermissions?.[roleId]
        )
      );
    }
    if (lines.length) {
      changes.push({
        title: "📁 Channel Settings Updated",
        lines: [`**Channel:** <#${id}>`, ...lines],
        colour: "#F1C40F",
      });
    }
  }

  const roleDiff = diffMap(before.roles, after.roles);
  for (const id of roleDiff.added) {
    changes.push({
      title: "🎭 Role Created",
      lines: [
        `**Role:** ${after.roles[id].name}`,
        ...overrideLines("Permissions", null, after.roles[id].permissions),
      ],
      colour: "#2ECC71",
    });
  }
  for (const id of roleDiff.removed) {
    changes.push({
      title: "🎭 Role Deleted",
      lines: [`**Role:** ${before.roles[id].name}`],
      colour: "#E74C3C",
    });
  }
  for (const id of roleDiff.shared) {
    const previous = before.roles[id];
    const current = after.roles[id];
    const lines = changedFields(previous, current, [
      ["name", "Name"],
      ["colour", "Colour"],
      ["hoist", "Hoist"],
      ["rank", "Rank"],
    ]);
    lines.push(
      ...overrideLines("Permissions", previous.permissions, current.permissions)
    );
    if (lines.length) {
      changes.push({
        title: "🎭 Role Updated",
        lines: [`**Role:** ${current.name}`, ...lines],
        colour: "#F1C40F",
      });
    }
  }

  const emojiDiff = diffMap(before.emojis, after.emojis);
  for (const id of emojiDiff.added) {
    const emoji = after.emojis[id];
    changes.push({
      title: "😀 Emoji Created",
      lines: [`**Name:** :${emoji.name}:`],
      colour: "#2ECC71",
      actorId: emoji.creatorId,
      actorSource: "Stoat emoji creator",
    });
  }
  for (const id of emojiDiff.removed) {
    changes.push({
      title: "😀 Emoji Deleted",
      lines: [`**Name:** :${before.emojis[id].name}:`],
      colour: "#E74C3C",
    });
  }

  const inviteDiff = diffMap(before.invites, after.invites);
  for (const id of inviteDiff.added) {
    const invite = after.invites[id];
    changes.push({
      title: "✉️ Server Invite Created",
      lines: [
        `**Channel:** <#${invite.channelId}>`,
        "**Invite code:** redacted",
      ],
      colour: "#2ECC71",
      actorId: invite.creatorId,
      actorSource: "Stoat invite creator",
    });
  }
  for (const id of inviteDiff.removed) {
    changes.push({
      title: "✉️ Server Invite Removed",
      lines: [
        `**Channel:** <#${before.invites[id].channelId}>`,
        "**Invite code:** redacted",
      ],
      colour: "#E74C3C",
    });
  }

  const previouslyScanned = new Set(before.webhookScannedChannels ?? []);
  const webhookDiff = diffMap(before.webhooks, after.webhooks);
  for (const id of webhookDiff.added) {
    const webhook = after.webhooks[id];
    if (!previouslyScanned.has(webhook.channelId)) continue;
    changes.push({
      title: "🪝 Webhook Created",
      lines: [
        `**Channel:** <#${webhook.channelId}>`,
        `**Name:** ${webhook.name}`,
      ],
      colour: "#2ECC71",
      actorId: webhook.creatorId,
      actorSource: "Stoat webhook creator",
    });
  }
  for (const id of webhookDiff.removed) {
    const webhook = before.webhooks[id];
    if (!previouslyScanned.has(webhook.channelId)) continue;
    changes.push({
      title: "🪝 Webhook Removed",
      lines: [
        `**Channel:** <#${webhook.channelId}>`,
        `**Name:** ${webhook.name}`,
      ],
      colour: "#E74C3C",
    });
  }
  for (const id of webhookDiff.shared) {
    const previous = before.webhooks[id];
    const current = after.webhooks[id];
    const lines = changedFields(previous, current, [["name", "Name"]]);
    if (!same(previous.avatar, current.avatar))
      lines.push("**Avatar:** changed");
    lines.push(
      ...permissionLines(
        "Permissions",
        previous.permissions,
        current.permissions
      )
    );
    if (lines.length && previouslyScanned.has(current.channelId)) {
      changes.push({
        title: "🪝 Webhook Updated",
        lines: [`**Channel:** <#${current.channelId}>`, ...lines],
        colour: "#F1C40F",
      });
    }
  }

  return changes;
}

export function createSettingsMonitor(
  client,
  {
    request,
    emit,
    logger = console,
    now = Date.now,
    scheduleInterval = setInterval,
    scheduleTimeout = setTimeout,
    reconcileIntervalMs = DEFAULT_RECONCILE_INTERVAL_MS,
    webhookBatchSize = DEFAULT_WEBHOOK_BATCH_SIZE,
  } = {}
) {
  if (typeof request !== "function")
    throw new TypeError("Settings monitoring requires a REST requester.");
  if (typeof emit !== "function")
    throw new TypeError("Settings monitoring requires an audit emitter.");

  const queues = new Map();
  const debounceTimers = new Map();
  const runtimeStatus = new Map();
  let started = false;

  function setStatus(serverId, patch) {
    runtimeStatus.set(serverId, {
      ...(runtimeStatus.get(serverId) ?? {}),
      ...patch,
    });
  }

  async function call(method, path) {
    try {
      return await request(method, path);
    } catch (error) {
      logger.warn(
        `settings-monitor: request failed path=${opaqueIdentity(path).slice(0, 12)} ${safeErrorSummary(error)}`
      );
      return { ok: false, status: 0, data: null };
    }
  }

  async function get(path) {
    const response = await call("GET", path);
    return response?.ok ? response.data : null;
  }

  async function fetchCore(serverId, previous) {
    const serverResponse = await get(
      `/servers/${serverId}?include_channels=true`
    );
    const core = normaliseServerResponse(serverResponse);
    if (!core) return null;

    const [emojiResult, inviteResult] = await Promise.all([
      call("GET", `/servers/${serverId}/emojis`),
      call("GET", `/servers/${serverId}/invites`),
    ]);

    return {
      version: SNAPSHOT_VERSION,
      capturedAt: now(),
      ...core,
      emojis:
        normaliseEmojis(emojiResult?.ok ? emojiResult.data : null) ??
        clone(previous?.emojis) ??
        {},
      invites:
        normaliseInvites(inviteResult?.ok ? inviteResult.data : null) ??
        clone(previous?.invites) ??
        {},
      webhooks: clone(previous?.webhooks) ?? {},
      webhookScannedChannels: clone(previous?.webhookScannedChannels) ?? [],
      webhookCursor: previous?.webhookCursor ?? 0,
      coverage: {
        server: true,
        emojis: Boolean(emojiResult?.ok),
        invites: Boolean(inviteResult?.ok),
        webhooks: previous?.coverage?.webhooks ?? false,
      },
    };
  }

  async function scanWebhooks(snapshot) {
    const textChannelIds = Object.values(snapshot.channels)
      .filter((channel) => channel.type === "TextChannel")
      .map((channel) => channel.id)
      .sort();
    if (!textChannelIds.length) return { snapshot, scanned: 0, failures: 0 };

    const start = snapshot.webhookCursor % textChannelIds.length;
    const count = Math.min(webhookBatchSize, textChannelIds.length);
    const selected = Array.from(
      { length: count },
      (_, index) => textChannelIds[(start + index) % textChannelIds.length]
    );
    const webhooks = Object.fromEntries(
      Object.entries(snapshot.webhooks).filter(([, webhook]) =>
        textChannelIds.includes(webhook.channelId)
      )
    );
    const scanned = new Set(snapshot.webhookScannedChannels);
    let failures = 0;

    for (const channelId of selected) {
      const response = await call("GET", `/channels/${channelId}/webhooks`);
      if (!response?.ok) {
        failures++;
        continue;
      }
      for (const [id, webhook] of Object.entries(webhooks)) {
        if (webhook.channelId === channelId) delete webhooks[id];
      }
      Object.assign(
        webhooks,
        normaliseWebhooks(response.data, channelId) ?? {}
      );
      scanned.add(channelId);
    }

    const scannedChannels = [...scanned]
      .filter((id) => textChannelIds.includes(id))
      .sort();

    return {
      snapshot: {
        ...snapshot,
        webhooks: sortedObject(Object.entries(webhooks)),
        webhookScannedChannels: scannedChannels,
        webhookCursor: (start + count) % textChannelIds.length,
        coverage: {
          ...snapshot.coverage,
          webhooks:
            failures === 0 && scannedChannels.length === textChannelIds.length,
        },
      },
      scanned: selected.length - failures,
      failures,
    };
  }

  function serialise(serverId, operation) {
    const previous = queues.get(serverId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    queues.set(serverId, next);
    next.then(
      () => {
        if (queues.get(serverId) === next) queues.delete(serverId);
      },
      () => {
        if (queues.get(serverId) === next) queues.delete(serverId);
      }
    );
    return next;
  }

  async function reconcileServerInternal(
    serverId,
    { source, scanSupplemental }
  ) {
    if (!isAuditLogEnabled(serverId)) {
      removeServerSettingsSnapshot(serverId);
      runtimeStatus.delete(serverId);
      return { seeded: false, changes: 0 };
    }

    const previous = getServerSettingsSnapshot(serverId);
    let next = await fetchCore(serverId, previous);
    if (!next) {
      setStatus(serverId, { lastFailureAt: now() });
      logger.warn(
        `settings-monitor: core refresh failed server=${auditAlias(serverId)}`
      );
      return { seeded: false, changes: 0, failed: true };
    }

    let webhookResult = { scanned: 0, failures: 0 };
    if (scanSupplemental) {
      webhookResult = await scanWebhooks(next);
      next = webhookResult.snapshot;
    }

    if (!previous) {
      setServerSettingsSnapshot(serverId, next);
      setStatus(serverId, {
        lastSuccessAt: now(),
        webhookFailures: webhookResult.failures,
      });
      return { seeded: true, changes: 0 };
    }

    const changes = diffSettingsSnapshots(previous, next);
    setServerSettingsSnapshot(serverId, next);
    setStatus(serverId, {
      lastSuccessAt: now(),
      lastFailureAt: null,
      webhookFailures: webhookResult.failures,
    });
    const emittedChanges = changes.slice(0, MAX_EMITS_PER_RECONCILE - 1);
    if (changes.length >= MAX_EMITS_PER_RECONCILE) {
      const omitted = changes.slice(MAX_EMITS_PER_RECONCILE - 1);
      const titles = [...new Set(omitted.map((change) => change.title))];
      emittedChanges.push({
        title: "⚙️ Additional Settings Changes Detected",
        lines: [
          `**Additional changes:** ${omitted.length}`,
          `**Kinds:** ${titles.join(", ")}`,
          "The persisted baseline contains the complete resulting state.",
        ],
        colour: "#9B59B6",
      });
    }
    for (const change of emittedChanges) {
      const embed = buildAuditEmbed(
        change.title,
        [...change.lines, ...attributionLines(client, change, source)],
        change.colour
      );
      emit(serverId, embed);
    }
    return { seeded: false, changes: changes.length };
  }

  function reconcileServer(
    serverId,
    { source = "reconciliation", scanSupplemental = true } = {}
  ) {
    if (!isSafeId(serverId)) return Promise.resolve({ failed: true });
    return serialise(serverId, () =>
      reconcileServerInternal(serverId, { source, scanSupplemental })
    ).catch((error) => {
      setStatus(serverId, { lastFailureAt: now() });
      logger.error(
        `settings-monitor: reconcile error server=${auditAlias(serverId)} ${safeErrorSummary(error)}`
      );
      return { failed: true };
    });
  }

  function serverIdForEvent(event) {
    if (event.type === "ServerUpdate" || event.type.startsWith("ServerRole"))
      return event.id;
    if (event.type === "ChannelCreate") return event.server;
    if (event.type === "ChannelUpdate" || event.type === "ChannelDelete") {
      return (
        client.channels?.get?.(event.id)?.serverId ??
        getAuditLogServers().find(({ serverId }) =>
          Boolean(getServerSettingsSnapshot(serverId)?.channels?.[event.id])
        )?.serverId
      );
    }
    if (event.type === "EmojiCreate")
      return event.parent?.type === "Server" ? event.parent.id : null;
    if (event.type === "EmojiDelete") {
      return getAuditLogServers().find(({ serverId }) =>
        Boolean(getServerSettingsSnapshot(serverId)?.emojis?.[event.id])
      )?.serverId;
    }
    return null;
  }

  function handleRawEvent(event) {
    const monitoredTypes = new Set([
      "ServerUpdate",
      "ServerRoleUpdate",
      "ServerRoleDelete",
      "ChannelCreate",
      "ChannelUpdate",
      "ChannelDelete",
      "EmojiCreate",
      "EmojiDelete",
    ]);
    if (!monitoredTypes.has(event?.type)) return;
    const serverId = serverIdForEvent(event);
    if (!isSafeId(serverId) || !isAuditLogEnabled(serverId)) return;

    const existing = debounceTimers.get(serverId);
    if (existing) clearTimeout(existing);
    const timer = scheduleTimeout(() => {
      debounceTimers.delete(serverId);
      reconcileServer(serverId, { source: "gateway", scanSupplemental: false });
    }, 500);
    timer?.unref?.();
    debounceTimers.set(serverId, timer);
  }

  async function sweepNow({ scanSupplemental = true } = {}) {
    const results = [];
    for (const { serverId } of getAuditLogServers()) {
      results.push(await reconcileServer(serverId, { scanSupplemental }));
    }
    return results;
  }

  async function start() {
    if (started) return;
    started = true;
    // Do not hold the ready handler on per-channel webhook scans. Core state,
    // emoji, and invite reconciliation completes first; the bounded webhook
    // sweep continues in the background and is serialized per server.
    await sweepNow({ scanSupplemental: false });
    sweepNow().catch((error) =>
      logger.error(
        `settings-monitor: initial sweep error ${safeErrorSummary(error)}`
      )
    );
    const timer = scheduleInterval(() => {
      sweepNow().catch((error) =>
        logger.error(`settings-monitor: sweep error ${safeErrorSummary(error)}`)
      );
    }, reconcileIntervalMs);
    timer?.unref?.();
  }

  function configurationChanged(serverId) {
    if (!isAuditLogEnabled(serverId)) {
      removeServerSettingsSnapshot(serverId);
      runtimeStatus.delete(serverId);
      return Promise.resolve({ disabled: true });
    }
    // Establish the core baseline immediately without making an enable/move
    // command wait for the bounded per-channel webhook inventory.
    return reconcileServer(serverId, { scanSupplemental: false });
  }

  function status(serverId) {
    const snapshot = getServerSettingsSnapshot(serverId);
    const runtime = runtimeStatus.get(serverId) ?? {};
    return {
      baselineReady: Boolean(snapshot),
      lastSnapshotAt: snapshot?.capturedAt ?? null,
      lastSuccessAt: runtime.lastSuccessAt ?? null,
      lastFailureAt: runtime.lastFailureAt ?? null,
      channels: Object.keys(snapshot?.channels ?? {}).length,
      roles: Object.keys(snapshot?.roles ?? {}).length,
      emojis: Object.keys(snapshot?.emojis ?? {}).length,
      invites: Object.keys(snapshot?.invites ?? {}).length,
      webhooks: Object.keys(snapshot?.webhooks ?? {}).length,
      webhookChannelsScanned: snapshot?.webhookScannedChannels?.length ?? 0,
      webhookFailures: runtime.webhookFailures ?? 0,
      emojiCoverage: snapshot?.coverage?.emojis ?? false,
      inviteCoverage: snapshot?.coverage?.invites ?? false,
      webhookCoverage: snapshot?.coverage?.webhooks ?? false,
    };
  }

  client.events.on("event", handleRawEvent);

  return {
    start,
    sweepNow,
    reconcileServer,
    configurationChanged,
    status,
    handleRawEvent,
  };
}
