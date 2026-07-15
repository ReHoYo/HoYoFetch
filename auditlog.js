// auditlog.js — Server action audit log (Stoat has no native audit log)
// ────────────────────────────────────────────────────────────────────
// Listens to every moderation-relevant revolt.js event we can and relays
// a formatted embed to whichever channel an admin/mod enabled via
// /enable-auditlog. See buildAuditLogEnabledEmbed() in embeds.js for the
// list of things the platform simply does not report (actor attribution,
// kick vs leave, etc.) — those limits are inherent to the gateway, not
// bugs in this module.
import {
  buildAuditEmbed,
  buildAuditBulkDeleteEmbed,
  buildAuditChannelEmbed,
  buildAuditLogEnabledEmbed,
  buildAuditMemberEmbed,
  buildAuditMessageDeleteEmbed,
  buildAuditMessageEditEmbed,
  buildAuditServerUpdateEmbed,
  buildStatusEmbed,
} from "./embeds.js";
import {
  enableAuditLog,
  getAuditLogChannel,
  getAuditLogServers,
  getKnownBans,
  setKnownBans,
  disableAuditLog,
  isAuditLogEnabled,
} from "./store.js";
import {
  recordMessage,
  getArchivedMessage,
  applyEdit,
  startArchiveMaintenance,
  archiveSize,
} from "./message-archive.js";
import { uploadAttachmentBytes } from "./easter-eggs.js";
import {
  saveEvidence,
  readEvidence,
  isEvidenceEnabled,
  perFileCapBytes,
  evidenceStats,
  startEvidenceMaintenance,
} from "./evidence-store.js";

const UNBAN_POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_PENDING_SENDS = 50;
const MAX_CONSECUTIVE_FAILURES = 5;
const MEMBER_REFRESH_TTL_MS = 15 * 60 * 1000;
const DEBUG = process.env.AUDITLOG_DEBUG === "1";
const memberSnapshots = new Map();
const ignoredSystemMessages = createMessageCache(5_000);

// Set by initAuditLog so runAuditLogTest can reuse the real send pipeline.
let sendRef = null;
// Downloads (evidence capture) and uploads (re-hosting on delete) go through
// this so tests can inject a fake without touching the network.
let fetchImplRef = fetch;

function debugLog(message) {
  if (DEBUG) console.log(`[auditlog] ${message}`);
}

// ── Send queue (serialised so bursts don't hit the API concurrently) ──
let chain = Promise.resolve();
let pending = 0;
const failureCounts = new Map(); // serverId -> consecutive failure count

function queueSend(serverId, channelId, send, embed, attachments) {
  if (pending >= MAX_PENDING_SENDS) {
    console.warn(
      `auditlog: send queue full, dropping an event for server ${serverId}`
    );
    return;
  }
  pending++;
  chain = chain.then(async () => {
    try {
      const payload = { embeds: [embed] };
      if (attachments?.length) payload.attachments = attachments;
      const result = await send(channelId, payload);
      if (result === undefined) {
        bumpFailure(serverId);
      } else {
        failureCounts.delete(serverId);
      }
    } catch (err) {
      console.error("auditlog: send error:", err?.message || err);
      bumpFailure(serverId);
    } finally {
      pending--;
    }
  });
}

function bumpFailure(serverId) {
  const count = (failureCounts.get(serverId) || 0) + 1;
  failureCounts.set(serverId, count);
  if (count === MAX_CONSECUTIVE_FAILURES) {
    console.warn(
      `auditlog: ${MAX_CONSECUTIVE_FAILURES} consecutive send failures for server ${serverId}; keeping the configured channel for recovery`
    );
  }
}

function emitAudit(send, serverId, embed, attachments) {
  if (!serverId) return;
  const channelId = getAuditLogChannel(serverId);
  if (!channelId) {
    debugLog(
      `emitAudit: audit log not enabled for server ${serverId}, dropping "${embed.title}"`
    );
    return;
  }
  debugLog(`emitAudit: queueing "${embed.title}" → channel ${channelId}`);
  queueSend(serverId, channelId, send, embed, attachments);
}

/**
 * Push a synthetic test event through the real emitAudit → queue → send
 * pipeline so mods can verify end-to-end delivery from inside Stoat.
 * @param  {string} serverId
 * @return {{enabled: boolean, channelId: string|null, archivedCount: number,
 *           consecutiveFailures: number, queuedTest: boolean}}
 */
export function runAuditLogTest(serverId) {
  const channelId = getAuditLogChannel(serverId);
  const evidence = evidenceStats();
  const status = {
    enabled: Boolean(channelId),
    channelId,
    archivedCount: archiveSize(),
    consecutiveFailures: failureCounts.get(serverId) ?? 0,
    queuedTest: false,
    evidenceFiles: evidence.files,
    evidenceBytes: evidence.bytes,
    evidenceBudgetBytes: evidence.budgetBytes,
  };
  if (!channelId || !sendRef) return status;

  const embed = buildAuditEmbed(
    "🧪 Audit Log Test",
    [
      "If you can read this, the audit pipeline is delivering events to this channel.",
      `**Messages currently archived:** ${status.archivedCount}`,
      `**Evidence stored:** ${status.evidenceFiles} file(s), ${humanReadableSize(status.evidenceBytes)} / ${humanReadableSize(status.evidenceBudgetBytes)}`,
    ],
    "#3498DB"
  );
  emitAudit(sendRef, serverId, embed);
  status.queuedTest = true;
  return status;
}

// ── Formatting helpers ─────────────────────────────
export function truncate(str, max = 700) {
  if (!str) return "*(none)*";
  return str.length > max ? `${str.slice(0, max)}… *(truncated)*` : str;
}

/**
 * Return user-visible changes for a fixed list of fields.
 * Permission payloads are intentionally treated as opaque values.
 */
export function diffFields(before = {}, after = {}, fields = []) {
  return fields
    .filter(
      (field) =>
        JSON.stringify(before?.[field]) !== JSON.stringify(after?.[field])
    )
    .map((field) => ({
      field,
      before: before?.[field],
      after: after?.[field],
    }));
}

export function createMessageCache(limit = 5_000) {
  const maxEntries = Number.isInteger(limit) && limit > 0 ? limit : 5_000;
  const cache = new Map();
  const mapSet = cache.set.bind(cache);
  cache.set = (key, value) => {
    if (cache.has(key)) cache.delete(key);
    mapSet(key, value);
    while (cache.size > maxEntries) {
      cache.delete(cache.keys().next().value);
    }
    return cache;
  };
  return cache;
}

export function snapshotMessage(message, channel = message?.channel) {
  return {
    id: message?.id,
    channelId: message?.channelId ?? channel?.id,
    serverId: channel?.serverId ?? message?.server?.id,
    authorId: message?.authorId,
    authorLabel: message?.author?.username
      ? `@${message.author.username}`
      : "Webhook/Unknown",
    content: message?.content ?? "",
    attachments: (message?.attachments ?? []).map((attachment) => ({
      filename: attachment.filename ?? "file",
      size: attachment.size ?? 0,
    })),
    createdAt: message?.createdAt?.toISOString?.() ?? new Date().toISOString(),
  };
}

const CHANNEL_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const CHANNEL_MENTION_PATTERN = /^<#([0-9A-HJKMNP-TV-Z]{26})>$/i;

export function parseChannelArg(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const mention = trimmed.match(CHANNEL_MENTION_PATTERN);
  if (mention) return mention[1];
  return CHANNEL_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Clearly label the platform-limited delete attribution as a heuristic.
 */
export function formatSuspects(authorLabel, moderatorLabels = [], cap = 6) {
  const author =
    typeof authorLabel === "string" && authorLabel.trim()
      ? authorLabel.trim()
      : null;
  const moderators = [...new Set(moderatorLabels.filter(Boolean))];

  if (!author && !moderators.length) return "the author or a moderator";
  if (!moderators.length)
    return author ? `the author (${author})` : "a moderator";

  const shownLimit = Math.max(0, cap - (author ? 1 : 0));
  const shown = moderators.slice(0, shownLimit);
  const remaining = moderators.length - shown.length;
  const list = `${shown.join(", ")}${remaining > 0 ? `, … (+${remaining} more)` : ""}`;
  const moderatorPhrase = `one of ${moderators.length} member${moderators.length === 1 ? "" : "s"} with Manage Messages: ${list}`;
  return author
    ? `the author (${author}), or ${moderatorPhrase}`
    : moderatorPhrase;
}

function formatUserLabel(client, userId) {
  if (!userId) return null;
  const user = client.users.get(userId);
  return user?.username ? `@${user.username}` : null;
}

async function getServerMembers(client, server) {
  const cached = memberSnapshots.get(server.id);
  if (cached && Date.now() - cached.refreshedAt < MEMBER_REFRESH_TTL_MS) {
    return cached.members;
  }

  try {
    const result = await server.fetchMembers();
    const members = result?.members ?? [];
    memberSnapshots.set(server.id, { refreshedAt: Date.now(), members });
    return members;
  } catch {
    return [...client.serverMembers.values()].filter(
      (member) => member.id?.server === server.id
    );
  }
}

export async function computeSuspects(client, channel, authorId) {
  const server = channel?.server ?? client.servers.get(channel?.serverId);
  if (!server)
    return {
      authorLabel: formatUserLabel(client, authorId),
      moderatorLabels: [],
    };

  const members = await getServerMembers(client, server);
  const moderatorIds = new Set();
  for (const member of members) {
    const userId = member.id?.user;
    if (!userId || userId === client.user?.id || userId === authorId) continue;
    try {
      if (
        userId === server.ownerId ||
        member.hasPermission(channel, "ManageMessages")
      ) {
        moderatorIds.add(userId);
      }
    } catch {
      // A partial member or stale permission cache must not break delete logging.
    }
  }

  if (
    server.ownerId &&
    server.ownerId !== client.user?.id &&
    server.ownerId !== authorId
  ) {
    moderatorIds.add(server.ownerId);
  }

  return {
    authorLabel: formatUserLabel(client, authorId),
    moderatorLabels: [...moderatorIds]
      .map((id) => formatUserLabel(client, id))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Handle the unified /AuditLog command. The command router is responsible for
 * enforcing Manage Server before this function is called.
 */
export function handleAuditLogCommand(
  client,
  message,
  args = [],
  prefix = "/"
) {
  const serverId = message.server?.id;
  const command = `${prefix}AuditLog`;
  if (!serverId) {
    return buildStatusEmbed(
      "🔒 Server Only",
      "Audit logging can only be configured inside a server.",
      "#E74C3C"
    );
  }

  const value = args.join(" ").trim();
  const action = value.toLowerCase();
  if (!value || action === "status") {
    const channelId = getAuditLogChannel(serverId);
    return channelId
      ? buildStatusEmbed(
          "📋 Audit Log Status",
          `Audit logging is active in <#${channelId}>.\nUse \`${command} here\`, \`${command} #channel\`, or \`${command} off\` to change it.`,
          "#3498DB"
        )
      : buildStatusEmbed(
          "📋 Audit Log Status",
          `Audit logging is off. Use \`${command} here\` or \`${command} #channel\` to enable it.`,
          "#808080"
        );
  }

  if (action === "off") {
    const wasEnabled = isAuditLogEnabled(serverId);
    disableAuditLog(serverId);
    return buildStatusEmbed(
      wasEnabled ? "🔕 Audit Log Disabled" : "ℹ️ Audit Log Already Off",
      wasEnabled
        ? "This server will no longer receive audit log messages."
        : "Audit logging was already off for this server.",
      wasEnabled ? "#E67E22" : "#3498DB"
    );
  }

  const channelId =
    action === "here" ? message.channelId : parseChannelArg(value);
  if (!channelId) {
    return buildStatusEmbed(
      "⚠️ Invalid Audit Log Channel",
      `Use \`${command} here\`, \`${command} #channel\`, \`${command} CHANNEL_ID\`, \`${command} status\`, or \`${command} off\`.`,
      "#E74C3C"
    );
  }

  const channel = client.channels.get(channelId);
  let canSend = false;
  try {
    canSend = Boolean(channel?.havePermission?.("SendMessage"));
  } catch {
    canSend = false;
  }
  if (
    !channel ||
    channel.serverId !== serverId ||
    channel.type !== "TextChannel" ||
    !canSend
  ) {
    return buildStatusEmbed(
      "⚠️ Unavailable Audit Log Channel",
      "Choose a text channel in this server where I have **Send Messages** permission.",
      "#E74C3C"
    );
  }

  const result = enableAuditLog(serverId, channelId);
  if (result.wasEnabled && !result.changed) {
    return buildStatusEmbed(
      "ℹ️ Already Enabled",
      `Audit logging is already active in <#${channelId}>.`,
      "#3498DB"
    );
  }
  return buildAuditLogEnabledEmbed(prefix, {
    moved: result.wasEnabled,
    previousChannelId: result.previousChannelId,
  });
}

function formatUser(client, userId) {
  if (!userId) return "Unknown user";
  const user = client.users.get(userId);
  return user ? `@${user.username} (${userId})` : `Unknown user (${userId})`;
}

function humanReadableSize(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const decimals = unitIndex > 0 && value < 10 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function isTrustedAttachmentUrl(client, url) {
  const autumnBase = client.configuration?.features?.autumn?.url;
  return (
    Boolean(autumnBase) && typeof url === "string" && url.startsWith(autumnBase)
  );
}

async function downloadAttachmentBytes(url, maxBytes) {
  let response;
  try {
    response = await fetchImplRef(url);
  } catch {
    return null;
  }
  if (!response?.ok) return null;

  try {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length <= maxBytes ? buffer : null;
  } catch {
    return null;
  }
}

/**
 * Build attachment descriptors for a freshly created message, downloading
 * and locally caching bytes for attachments that qualify as evidence.
 */
async function buildAttachmentDescriptors(client, messageId, attachments) {
  if (!attachments?.length) return [];

  const descriptors = [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const descriptor = {
      id: att.id,
      filename: att.filename || "file",
      size: att.size ?? 0,
      contentType: att.contentType || "application/octet-stream",
      url: att.url ?? null,
      evidencePath: null,
    };

    const qualifies =
      isEvidenceEnabled() &&
      descriptor.url &&
      isTrustedAttachmentUrl(client, descriptor.url) &&
      descriptor.size > 0 &&
      descriptor.size <= perFileCapBytes();

    if (qualifies) {
      try {
        const bytes = await downloadAttachmentBytes(
          descriptor.url,
          perFileCapBytes()
        );
        if (bytes) {
          descriptor.evidencePath = saveEvidence(
            messageId,
            i,
            bytes,
            descriptor.contentType
          );
          debugLog(
            `evidence captured for ${descriptor.id} (${bytes.length} bytes)`
          );
        } else {
          debugLog(
            `evidence download unavailable/too large for ${descriptor.id}`
          );
        }
      } catch (err) {
        debugLog(
          `evidence capture error for ${descriptor.id}: ${err?.message || err}`
        );
      }
    }

    descriptors.push(descriptor);
  }
  return descriptors;
}

/**
 * For a deleted message's archived attachments, re-upload any locally saved
 * evidence and describe what happened to each attachment for the embed body.
 * @return {{lines: string[], ids: string[]}}
 */
async function resolveAttachmentEvidence(client, entry) {
  const lines = [];
  const ids = [];
  if (!entry) return { lines, ids };

  const attachments = entry.attachments;
  if (typeof attachments === "number") {
    if (attachments > 0) {
      lines.push(
        `_(${attachments} attachment${attachments > 1 ? "s" : ""} — recorded before evidence capture existed)_`
      );
    }
    return { lines, ids };
  }
  if (!Array.isArray(attachments) || !attachments.length) return { lines, ids };

  for (const att of attachments) {
    const sizeLabel = humanReadableSize(att.size);
    if (!att.evidencePath) {
      lines.push(
        `⚠️ \`${att.filename}\` (${sizeLabel}) — not preserved (too large or evidence capture was disabled)`
      );
      continue;
    }

    const bytes = readEvidence(att.evidencePath);
    if (!bytes) {
      lines.push(
        `⚠️ \`${att.filename}\` (${sizeLabel}) — evidence copy was evicted before this deletion`
      );
      continue;
    }

    try {
      const newId = await uploadAttachmentBytes({
        bytes,
        filename: att.filename,
        contentType: att.contentType,
        autumnUrl: client.configuration?.features?.autumn?.url,
        authenticationHeader: client.authenticationHeader,
        fetchImpl: fetchImplRef,
      });
      ids.push(newId);
      lines.push(
        `✅ \`${att.filename}\` (${sizeLabel}) — preserved, attached above`
      );
    } catch (err) {
      debugLog(
        `evidence re-upload failed for ${att.id}: ${err?.message || err}`
      );
      lines.push(
        `⚠️ \`${att.filename}\` (${sizeLabel}) — preserved locally but re-upload failed`
      );
    }
  }

  return { lines, ids };
}

// ═══════════════════════════════════════════════════
//  Event wiring
// ═══════════════════════════════════════════════════

export function initAuditLog(client, { sendProtected, fetchImpl }) {
  if (typeof sendProtected !== "function") {
    throw new TypeError("Audit logging requires a protected sender.");
  }
  const send = sendProtected;
  const isSelf = (userId) => userId === client.user?.id;

  sendRef = send;
  fetchImplRef = fetchImpl ?? fetch;
  startArchiveMaintenance();
  startEvidenceMaintenance();

  // ── Message archive recorder ────────────────────
  // Record every message in audit-enabled servers so deletes/edits can always
  // show the original content, even across restarts. The bot's own messages
  // are archived too — otherwise deleting them (e.g. its own loading embeds)
  // would be logged as "unknown message deleted". Qualifying attachments are
  // downloaded and cached locally here (§evidence-store.js) since Stoat is
  // likely to purge the CDN copy the moment the message is deleted.
  client.on("messageCreate", async (message) => {
    const serverId = client.channels.get(message.channelId)?.serverId;
    if (!serverId || !isAuditLogEnabled(serverId)) return;
    if (message.channelId === getAuditLogChannel(serverId)) return;
    if (message.systemMessage) {
      ignoredSystemMessages.set(message.id, true);
      return;
    }

    const attachments = await buildAttachmentDescriptors(
      client,
      message.id,
      message.attachments
    );

    recordMessage({
      id: message.id,
      channelId: message.channelId,
      serverId,
      authorId: message.authorId,
      content: message.content ?? "",
      attachments,
    });
  });

  // ── Messages: raw gateway events ────────────────
  // revolt.js drops MessageDelete/MessageUpdate for messages that are not in
  // its in-memory cache (anything sent before this process started). The raw
  // gateway stream always carries {id, channel}, so we listen at that layer
  // and use the archive for author/content.
  client.events.on("event", async (event) => {
    try {
      if (event.type === "MessageDelete") {
        await handleRawMessageDelete(client, send, event);
      } else if (event.type === "MessageUpdate") {
        handleRawMessageUpdate(client, send, event);
      } else if (event.type === "BulkMessageDelete") {
        await handleRawBulkDelete(client, send, event);
      } else if (event.type === "ServerMemberLeave") {
        await handleRawMemberLeave(client, send, event);
      }
    } catch (err) {
      console.error("auditlog: raw event error:", err?.message || err);
    }
  });

  async function handleRawMessageDelete(client, send, event) {
    const channel = client.channels.get(event.channel);
    const serverId = channel?.serverId;
    if (!serverId) {
      debugLog(
        `MessageDelete ${event.id}: skipped (no server for channel ${event.channel})`
      );
      return; // DM or unknown channel
    }
    if (!isAuditLogEnabled(serverId)) return;
    if (event.channel === getAuditLogChannel(serverId)) return;
    if (ignoredSystemMessages.delete(event.id)) return;

    const entry = getArchivedMessage(event.id);
    if (entry && isSelf(entry.authorId)) {
      debugLog(`MessageDelete ${event.id}: skipped (bot's own message)`);
      return;
    }

    debugLog(`MessageDelete ${event.id}: logging (archived=${Boolean(entry)})`);

    const { lines: attachmentLines, ids: preservedAttachmentIds } =
      await resolveAttachmentEvidence(client, entry);

    const suspects = await computeSuspects(client, channel, entry?.authorId);
    const embed = buildAuditMessageDeleteEmbed({
      author: entry ? formatUser(client, entry.authorId) : "*unknown*",
      channelId: event.channel,
      content: entry?.content,
      messageId: event.id,
      attachmentLines,
      suspects: formatSuspects(suspects.authorLabel, suspects.moderatorLabels),
    });
    emitAudit(send, serverId, embed, preservedAttachmentIds);
  }

  function handleRawMessageUpdate(client, send, event) {
    const after = event.data?.content;
    if (typeof after !== "string") return; // embed-only update (e.g. link unfurl)

    const serverId = client.channels.get(event.channel)?.serverId;
    if (!serverId) return;
    if (!isAuditLogEnabled(serverId)) return;
    if (event.channel === getAuditLogChannel(serverId)) return;

    const entry = getArchivedMessage(event.id);
    if (entry && isSelf(entry.authorId)) {
      debugLog(`MessageUpdate ${event.id}: skipped (bot's own message)`);
      return;
    }

    const before = entry?.content;
    if (before === after) {
      debugLog(`MessageUpdate ${event.id}: skipped (content unchanged)`);
      return; // no visible change
    }

    debugLog(`MessageUpdate ${event.id}: logging (archived=${Boolean(entry)})`);

    const embed = buildAuditMessageEditEmbed({
      author: entry ? formatUser(client, entry.authorId) : "*unknown*",
      channelId: event.channel,
      before: entry ? before : undefined,
      after,
    });
    emitAudit(send, serverId, embed);

    // Keep the archive current so the next edit diffs against this one
    applyEdit(event.id, after);
  }

  async function handleRawBulkDelete(client, send, event) {
    const channel = client.channels.get(event.channel);
    const serverId = channel?.serverId;
    if (!serverId) return;
    if (!isAuditLogEnabled(serverId)) return;
    if (event.channel === getAuditLogChannel(serverId)) return;

    const entries = (event.ids ?? [])
      .filter((id) => !ignoredSystemMessages.delete(id))
      .map((id) => ({ id, entry: getArchivedMessage(id) }));
    const relevant = entries.filter(
      ({ entry }) => !entry || !isSelf(entry.authorId)
    );
    if (!relevant.length) return;

    const shown = relevant.map(({ id, entry }) =>
      entry
        ? `${formatUser(client, entry.authorId)}: ${truncate(entry.content || "*(no content)*", 150)}`
        : `*unknown message ${id} (not archived)*`
    );

    const suspects = await computeSuspects(client, channel);
    const embed = buildAuditBulkDeleteEmbed({
      channelId: event.channel,
      count: relevant.length,
      entries: shown,
      suspects: formatSuspects(null, suspects.moderatorLabels),
    });
    emitAudit(send, serverId, embed);
  }

  async function handleRawMemberLeave(client, send, event) {
    const serverId = event.id;
    const userId = event.user;
    if (!serverId || !userId || isSelf(userId)) return;
    if (!isAuditLogEnabled(serverId)) return;

    const reason = typeof event.reason === "string" ? event.reason : null;
    let title = "📤 Member Left or Was Removed";
    let colour = "#E67E22";
    const lines = [`**User:** ${formatUser(client, userId)}`];

    if (reason === "Leave") {
      title = "📤 Member Left";
      lines.push("**Reason reported by server:** Left voluntarily");
    } else if (reason === "Kick") {
      title = "🥾 Member Kicked";
      lines.push("**Reason reported by server:** Kicked");
    } else if (reason === "Ban") {
      title = "🔨 Member Banned";
      colour = "#E74C3C";
      let banReason = null;
      try {
        const server = client.servers.get(serverId);
        const bans = await server?.fetchBans();
        const ban = bans?.find((entry) => entry.id.user === userId);
        banReason = ban?.reason ?? null;
        const known = new Set(getKnownBans(serverId));
        known.add(userId);
        setKnownBans(serverId, [...known]);
      } catch {
        // The raw reason still provides the ban verdict if ban-list access fails.
      }
      lines.push(
        `**Reason:** ${banReason ? truncate(banReason, 300) : "*(none given)*"}`
      );
    } else {
      lines.push(
        "**Reason:** Left or was removed (reason not provided by server)"
      );
    }

    emitAudit(
      send,
      serverId,
      buildAuditMemberEmbed({
        title,
        user: formatUser(client, userId),
        lines: lines.slice(1),
        colour,
      })
    );
  }

  // ── Channels ────────────────────────────────────
  client.on("channelCreate", (channel) => {
    const serverId = channel.serverId;
    if (!serverId) return;
    const embed = buildAuditChannelEmbed({
      title: "📁 Channel Created",
      channelId: channel.id,
      lines: [`**Name:** ${channel.name}`, `**Type:** ${channel.type}`],
      colour: "#2ECC71",
    });
    emitAudit(send, serverId, embed);
  });

  client.on("channelUpdate", (channel, previousChannel) => {
    const serverId = channel.serverId;
    if (!serverId) return;

    const lines = [];
    if (
      previousChannel.name !== undefined &&
      previousChannel.name !== channel.name
    ) {
      lines.push(`**Name:** ${previousChannel.name} → ${channel.name}`);
    }
    if (previousChannel.description !== channel.description) {
      lines.push(
        `**Description:** ${truncate(previousChannel.description, 200)} → ${truncate(channel.description, 200)}`
      );
    }
    if (
      previousChannel.nsfw !== undefined &&
      previousChannel.nsfw !== channel.nsfw
    ) {
      lines.push(`**NSFW:** ${previousChannel.nsfw} → ${channel.nsfw}`);
    }
    if (
      previousChannel.defaultPermissions !== undefined &&
      JSON.stringify(previousChannel.defaultPermissions) !==
        JSON.stringify(channel.defaultPermissions)
    ) {
      lines.push("**Permissions:** default channel permissions changed");
    }
    if (
      previousChannel.rolePermissions !== undefined &&
      JSON.stringify(previousChannel.rolePermissions) !==
        JSON.stringify(channel.rolePermissions)
    ) {
      lines.push("**Permissions:** role permission overrides changed");
    }
    if (!lines.length) return; // nothing user-facing changed (e.g. lastMessageId bump)

    const embed = buildAuditChannelEmbed({
      title: "📁 Channel Updated",
      channelId: channel.id,
      lines,
      colour: "#F1C40F",
    });
    emitAudit(send, serverId, embed);
  });

  client.on("channelDelete", (channel) => {
    const serverId = channel.serverId;
    if (!serverId) return;

    if (channel.id === getAuditLogChannel(serverId)) {
      disableAuditLog(serverId);
      console.warn(
        `auditlog: the audit log channel itself was deleted for server ${serverId}; audit logging disabled`
      );
      return;
    }

    const embed = buildAuditChannelEmbed({
      title: "📁 Channel Deleted",
      lines: [`**Name:** ${channel.name}`],
      colour: "#E74C3C",
    });
    emitAudit(send, serverId, embed);
  });

  // ── Server / roles ──────────────────────────────
  client.on("serverUpdate", (server, previousServer) => {
    const lines = [];
    if (
      previousServer.name !== undefined &&
      previousServer.name !== server.name
    ) {
      lines.push(`**Name:** ${previousServer.name} → ${server.name}`);
    }
    if (previousServer.description !== server.description) {
      lines.push(
        `**Description:** ${truncate(previousServer.description, 200)} → ${truncate(server.description, 200)}`
      );
    }
    if (previousServer.icon?.id !== server.icon?.id)
      lines.push("**Icon:** changed");
    if (previousServer.banner?.id !== server.banner?.id)
      lines.push("**Banner:** changed");
    if (!lines.length) return;

    const embed = buildAuditServerUpdateEmbed(lines);
    emitAudit(send, server.id, embed);
  });

  client.on("serverRoleUpdate", (server, roleId, previousRole) => {
    const role = server.roles.get(roleId);
    const prev = previousRole ?? {};
    const name = role?.name ?? prev.name ?? roleId;

    const lines = [`**Role:** ${name}`];
    if (prev.name !== undefined && prev.name !== role?.name)
      lines.push(`**Name:** ${prev.name} → ${role?.name}`);
    if (prev.colour !== undefined && prev.colour !== role?.colour) {
      lines.push(
        `**Colour:** ${prev.colour ?? "*(none)*"} → ${role?.colour ?? "*(none)*"}`
      );
    }
    if (prev.hoist !== undefined && prev.hoist !== role?.hoist)
      lines.push(`**Hoist:** ${prev.hoist} → ${role?.hoist}`);
    if (prev.rank !== undefined && prev.rank !== role?.rank)
      lines.push(`**Rank:** ${prev.rank} → ${role?.rank}`);
    if (lines.length === 1)
      lines.push("_Previous state unknown, or only permissions changed._");

    const embed = buildAuditEmbed("🎭 Role Updated", lines, "#F1C40F");
    emitAudit(send, server.id, embed);
  });

  client.on("serverRoleDelete", (server, roleId, role) => {
    const embed = buildAuditEmbed(
      "🎭 Role Deleted",
      [`**Role:** ${role?.name ?? roleId}`],
      "#E74C3C"
    );
    emitAudit(send, server.id, embed);
  });

  // ── Members ─────────────────────────────────────
  client.on("serverMemberJoin", (member) => {
    const serverId = member.id.server;
    const embed = buildAuditMemberEmbed({
      title: "📥 Member Joined",
      user: formatUser(client, member.id.user),
      colour: "#2ECC71",
    });
    emitAudit(send, serverId, embed);
  });

  client.on("serverMemberUpdate", (member, previousMember) => {
    const serverId = member.id.server;
    const userId = member.id.user;
    if (isSelf(userId)) return;

    const sections = [];

    const prevTimeout = previousMember.timeout
      ? new Date(previousMember.timeout).getTime()
      : null;
    const curTimeout = member.timeout
      ? new Date(member.timeout).getTime()
      : null;
    if (prevTimeout !== curTimeout) {
      if (curTimeout) {
        sections.push({
          title: "⏳ Member Timed Out",
          colour: "#E67E22",
          lines: [`**Until:** ${new Date(member.timeout).toUTCString()}`],
        });
      } else {
        sections.push({
          title: "⏳ Timeout Removed",
          colour: "#2ECC71",
          lines: [],
        });
      }
    }

    if (previousMember.nickname !== member.nickname) {
      sections.push({
        title: "✏️ Nickname Changed",
        colour: "#F1C40F",
        lines: [
          `**Before:** ${previousMember.nickname ?? "*(none)*"}`,
          `**After:** ${member.nickname ?? "*(none)*"}`,
        ],
      });
    }

    const prevRoles = new Set(previousMember.roles ?? []);
    const curRoles = new Set(member.roles ?? []);
    const added = [...curRoles].filter((r) => !prevRoles.has(r));
    const removed = [...prevRoles].filter((r) => !curRoles.has(r));
    if (added.length || removed.length) {
      const server = client.servers.get(serverId);
      const roleName = (id) => server?.roles.get(id)?.name ?? id;
      const lines = [];
      if (added.length)
        lines.push(`**Added:** ${added.map(roleName).join(", ")}`);
      if (removed.length)
        lines.push(`**Removed:** ${removed.map(roleName).join(", ")}`);
      sections.push({
        title: "🎭 Member Roles Changed",
        colour: "#F1C40F",
        lines,
      });
    }

    for (const section of sections) {
      const embed = buildAuditEmbed(
        section.title,
        [`**User:** ${formatUser(client, userId)}`, ...section.lines],
        section.colour
      );
      emitAudit(send, serverId, embed);
    }
  });

  // ── Emoji ───────────────────────────────────────
  client.on("emojiCreate", (emoji) => {
    if (emoji.parent?.type !== "Server") return;
    const embed = buildAuditEmbed(
      "😀 Emoji Created",
      [
        `**Name:** :${emoji.name}:`,
        `**By:** ${formatUser(client, emoji.creator?.id)}`,
      ],
      "#2ECC71"
    );
    emitAudit(send, emoji.parent.id, embed);
  });

  client.on("emojiDelete", (emoji) => {
    if (emoji.parent?.type !== "Server") return;
    const embed = buildAuditEmbed(
      "😀 Emoji Deleted",
      [`**Name:** :${emoji.name}:`],
      "#E74C3C"
    );
    emitAudit(send, emoji.parent.id, embed);
  });
}

// ═══════════════════════════════════════════════════
//  Unban polling (bans have a gateway event via serverMemberLeave;
//  unbans have none at all, so we diff the ban list periodically)
// ═══════════════════════════════════════════════════

export function startUnbanPolling(client, { sendProtected }) {
  if (typeof sendProtected !== "function") {
    throw new TypeError("Audit-log polling requires a protected sender.");
  }
  setInterval(() => pollUnbans(client, sendProtected), UNBAN_POLL_INTERVAL_MS);
}

async function pollUnbans(client, send) {
  for (const { serverId } of getAuditLogServers()) {
    try {
      const server = client.servers.get(serverId);
      if (!server) continue;

      const bans = await server.fetchBans();
      const currentBanIds = bans.map((b) => b.id.user);
      const known = getKnownBans(serverId);
      const unbanned = known.filter((id) => !currentBanIds.includes(id));

      for (const userId of unbanned) {
        const embed = buildAuditEmbed(
          "🔓 Member Unbanned",
          [
            `**User:** ${formatUser(client, userId)}`,
            "_Detected by periodic polling — up to ~5 minutes delayed._",
          ],
          "#2ECC71"
        );
        emitAudit(send, serverId, embed);
      }

      setKnownBans(serverId, currentBanIds);
    } catch {
      // Bot likely lacks Ban Members permission in this server — skip quietly
    }
  }
}
