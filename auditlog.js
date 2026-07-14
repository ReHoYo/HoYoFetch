// auditlog.js — Server action audit log (Stoat has no native audit log)
// ────────────────────────────────────────────────────────────────────
// Listens to every moderation-relevant revolt.js event we can and relays
// a formatted embed to whichever channel an admin/mod enabled via
// /enable-auditlog. See buildAuditLogEnabledEmbed() in embeds.js for the
// list of things the platform simply does not report (actor attribution,
// kick vs leave, etc.) — those limits are inherent to the gateway, not
// bugs in this module.
import { buildAuditEmbed } from "./embeds.js";
import {
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
const DEBUG = process.env.AUDITLOG_DEBUG === "1";

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
    console.warn(`auditlog: send queue full, dropping an event for server ${serverId}`);
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
  if (count >= MAX_CONSECUTIVE_FAILURES) {
    disableAuditLog(serverId);
    failureCounts.delete(serverId);
    console.warn(
      `auditlog: disabled for server ${serverId} after ${MAX_CONSECUTIVE_FAILURES} consecutive send failures`
    );
  }
}

function emitAudit(send, serverId, embed, attachments) {
  if (!serverId) return;
  const channelId = getAuditLogChannel(serverId);
  if (!channelId) {
    debugLog(`emitAudit: audit log not enabled for server ${serverId}, dropping "${embed.title}"`);
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
function truncate(str, max = 700) {
  if (!str) return "*(none)*";
  return str.length > max ? `${str.slice(0, max)}… *(truncated)*` : str;
}

function formatContent(content) {
  if (content === undefined) return "*content not cached*";
  if (content === "") return "*(no text — attachment/embed only)*";
  return truncate(content);
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
  return Boolean(autumnBase) && typeof url === "string" && url.startsWith(autumnBase);
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
        const bytes = await downloadAttachmentBytes(descriptor.url, perFileCapBytes());
        if (bytes) {
          descriptor.evidencePath = saveEvidence(messageId, i, bytes, descriptor.contentType);
          debugLog(`evidence captured for ${descriptor.id} (${bytes.length} bytes)`);
        } else {
          debugLog(`evidence download unavailable/too large for ${descriptor.id}`);
        }
      } catch (err) {
        debugLog(`evidence capture error for ${descriptor.id}: ${err?.message || err}`);
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
      lines.push(`⚠️ \`${att.filename}\` (${sizeLabel}) — not preserved (too large or evidence capture was disabled)`);
      continue;
    }

    const bytes = readEvidence(att.evidencePath);
    if (!bytes) {
      lines.push(`⚠️ \`${att.filename}\` (${sizeLabel}) — evidence copy was evicted before this deletion`);
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
      lines.push(`✅ \`${att.filename}\` (${sizeLabel}) — preserved, attached above`);
    } catch (err) {
      debugLog(`evidence re-upload failed for ${att.id}: ${err?.message || err}`);
      lines.push(`⚠️ \`${att.filename}\` (${sizeLabel}) — preserved locally but re-upload failed`);
    }
  }

  return { lines, ids };
}

// ═══════════════════════════════════════════════════
//  Event wiring
// ═══════════════════════════════════════════════════

export function initAuditLog(client, { send, fetchImpl }) {
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

    const attachments = await buildAttachmentDescriptors(client, message.id, message.attachments);

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
        handleRawBulkDelete(client, send, event);
      }
    } catch (err) {
      console.error("auditlog: raw event error:", err?.message || err);
    }
  });

  async function handleRawMessageDelete(client, send, event) {
    const serverId = client.channels.get(event.channel)?.serverId;
    if (!serverId) {
      debugLog(`MessageDelete ${event.id}: skipped (no server for channel ${event.channel})`);
      return; // DM or unknown channel
    }

    const entry = getArchivedMessage(event.id);
    if (entry && isSelf(entry.authorId)) {
      debugLog(`MessageDelete ${event.id}: skipped (bot's own message)`);
      return;
    }

    debugLog(`MessageDelete ${event.id}: logging (archived=${Boolean(entry)})`);

    const { lines: attachmentLines, ids: preservedAttachmentIds } = await resolveAttachmentEvidence(client, entry);

    const bodyLines = [
      `**Author:** ${entry ? formatUser(client, entry.authorId) : "*unknown*"}`,
      `**Channel:** <#${event.channel}>`,
      `**Content:** ${entry ? formatContent(entry.content) : "*unknown — message predates the archive or was sent while I was offline*"}`,
    ];
    if (attachmentLines.length) {
      bodyLines.push("", "**Attachments:**", ...attachmentLines);
    }
    bodyLines.push(
      "_Deleter unknown — Stoat does not report who deleted a message._",
      "_It's safe to assume it was either the message author or an admin/mod — only they have permission to delete it._"
    );

    const embed = buildAuditEmbed("🗑️ Message Deleted", bodyLines, "#E74C3C");
    emitAudit(send, serverId, embed, preservedAttachmentIds);
  }

  function handleRawMessageUpdate(client, send, event) {
    const after = event.data?.content;
    if (typeof after !== "string") return; // embed-only update (e.g. link unfurl)

    const serverId = client.channels.get(event.channel)?.serverId;
    if (!serverId) return;

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

    const embed = buildAuditEmbed(
      "✏️ Message Edited",
      [
        `**Author:** ${entry ? formatUser(client, entry.authorId) : "*unknown*"}`,
        `**Channel:** <#${event.channel}>`,
        `**Before:** ${entry ? formatContent(before) : "*unknown — message predates the archive*"}`,
        `**After:** ${formatContent(after)}`,
      ],
      "#F1C40F"
    );
    emitAudit(send, serverId, embed);

    // Keep the archive current so the next edit diffs against this one
    applyEdit(event.id, after);
  }

  function handleRawBulkDelete(client, send, event) {
    const serverId = client.channels.get(event.channel)?.serverId;
    if (!serverId) return;

    const entries = (event.ids ?? []).map((id) => ({ id, entry: getArchivedMessage(id) }));
    const relevant = entries.filter(({ entry }) => !entry || !isSelf(entry.authorId));
    if (!relevant.length) return;

    const shown = relevant.slice(0, 10).map(({ entry }) =>
      entry
        ? `${formatUser(client, entry.authorId)}: ${truncate(entry.content || "*(no content)*", 150)}`
        : "*unknown message (not archived)*"
    );
    if (relevant.length > 10) shown.push(`_…and ${relevant.length - 10} more_`);

    const embed = buildAuditEmbed(
      "🗑️ Bulk Message Delete",
      [`**Channel:** <#${event.channel}>`, `**Count:** ${relevant.length}`, "", ...shown],
      "#E74C3C"
    );
    emitAudit(send, serverId, embed);
  }

  // ── Channels ────────────────────────────────────
  client.on("channelCreate", (channel) => {
    const serverId = channel.serverId;
    if (!serverId) return;
    const embed = buildAuditEmbed(
      "📁 Channel Created",
      [`**Name:** ${channel.name}`, `**Type:** ${channel.type}`, `**Channel:** <#${channel.id}>`],
      "#2ECC71"
    );
    emitAudit(send, serverId, embed);
  });

  client.on("channelUpdate", (channel, previousChannel) => {
    const serverId = channel.serverId;
    if (!serverId) return;

    const lines = [];
    if (previousChannel.name !== undefined && previousChannel.name !== channel.name) {
      lines.push(`**Name:** ${previousChannel.name} → ${channel.name}`);
    }
    if (previousChannel.description !== channel.description) {
      lines.push(
        `**Description:** ${truncate(previousChannel.description, 200)} → ${truncate(channel.description, 200)}`
      );
    }
    if (previousChannel.nsfw !== undefined && previousChannel.nsfw !== channel.nsfw) {
      lines.push(`**NSFW:** ${previousChannel.nsfw} → ${channel.nsfw}`);
    }
    if (
      previousChannel.defaultPermissions !== undefined &&
      JSON.stringify(previousChannel.defaultPermissions) !== JSON.stringify(channel.defaultPermissions)
    ) {
      lines.push("**Permissions:** default channel permissions changed");
    }
    if (!lines.length) return; // nothing user-facing changed (e.g. lastMessageId bump)

    const embed = buildAuditEmbed("📁 Channel Updated", [`**Channel:** <#${channel.id}>`, ...lines], "#F1C40F");
    emitAudit(send, serverId, embed);
  });

  client.on("channelDelete", (channel) => {
    const serverId = channel.serverId;
    if (!serverId) return;

    if (channel.id === getAuditLogChannel(serverId)) {
      disableAuditLog(serverId);
      console.warn(`auditlog: the audit log channel itself was deleted for server ${serverId}; audit logging disabled`);
      return;
    }

    const embed = buildAuditEmbed("📁 Channel Deleted", [`**Name:** ${channel.name}`], "#E74C3C");
    emitAudit(send, serverId, embed);
  });

  // ── Server / roles ──────────────────────────────
  client.on("serverUpdate", (server, previousServer) => {
    const lines = [];
    if (previousServer.name !== undefined && previousServer.name !== server.name) {
      lines.push(`**Name:** ${previousServer.name} → ${server.name}`);
    }
    if (previousServer.description !== server.description) {
      lines.push(
        `**Description:** ${truncate(previousServer.description, 200)} → ${truncate(server.description, 200)}`
      );
    }
    if (previousServer.icon?.id !== server.icon?.id) lines.push("**Icon:** changed");
    if (previousServer.banner?.id !== server.banner?.id) lines.push("**Banner:** changed");
    if (!lines.length) return;

    const embed = buildAuditEmbed("⚙️ Server Updated", lines, "#F1C40F");
    emitAudit(send, server.id, embed);
  });

  client.on("serverRoleUpdate", (server, roleId, previousRole) => {
    const role = server.roles.get(roleId);
    const prev = previousRole ?? {};
    const name = role?.name ?? prev.name ?? roleId;

    const lines = [`**Role:** ${name}`];
    if (prev.name !== undefined && prev.name !== role?.name) lines.push(`**Name:** ${prev.name} → ${role?.name}`);
    if (prev.colour !== undefined && prev.colour !== role?.colour) {
      lines.push(`**Colour:** ${prev.colour ?? "*(none)*"} → ${role?.colour ?? "*(none)*"}`);
    }
    if (prev.hoist !== undefined && prev.hoist !== role?.hoist) lines.push(`**Hoist:** ${prev.hoist} → ${role?.hoist}`);
    if (prev.rank !== undefined && prev.rank !== role?.rank) lines.push(`**Rank:** ${prev.rank} → ${role?.rank}`);
    if (lines.length === 1) lines.push("_Previous state unknown, or only permissions changed._");

    const embed = buildAuditEmbed("🎭 Role Updated", lines, "#F1C40F");
    emitAudit(send, server.id, embed);
  });

  client.on("serverRoleDelete", (server, roleId, role) => {
    const embed = buildAuditEmbed("🎭 Role Deleted", [`**Role:** ${role?.name ?? roleId}`], "#E74C3C");
    emitAudit(send, server.id, embed);
  });

  // ── Members ─────────────────────────────────────
  client.on("serverMemberJoin", (member) => {
    const serverId = member.id.server;
    const embed = buildAuditEmbed("📥 Member Joined", [`**User:** ${formatUser(client, member.id.user)}`], "#2ECC71");
    emitAudit(send, serverId, embed);
  });

  client.on("serverMemberLeave", async (member) => {
    const serverId = member.id.server;
    const userId = member.id.user;
    if (isSelf(userId)) return;

    const server = client.servers.get(serverId);
    let banned = false;
    let reason = null;

    try {
      const bans = await server?.fetchBans();
      const ban = bans?.find((b) => b.id.user === userId);
      if (ban) {
        banned = true;
        reason = ban.reason ?? null;
        // Keep the snapshot in sync so the unban poller doesn't treat this as new
        const known = new Set(getKnownBans(serverId));
        known.add(userId);
        setKnownBans(serverId, [...known]);
      }
    } catch {
      // Bot likely lacks Ban Members permission here — fall back to the generic verdict
    }

    const embed = banned
      ? buildAuditEmbed(
          "🔨 Member Banned",
          [
            `**User:** ${formatUser(client, userId)}`,
            `**Reason:** ${reason ? truncate(reason, 300) : "*(none given)*"}`,
          ],
          "#E74C3C"
        )
      : buildAuditEmbed(
          "📤 Member Left or Was Kicked",
          [
            `**User:** ${formatUser(client, userId)}`,
            "_Stoat does not distinguish a kick from a voluntary leave._",
          ],
          "#E67E22"
        );
    emitAudit(send, serverId, embed);
  });

  client.on("serverMemberUpdate", (member, previousMember) => {
    const serverId = member.id.server;
    const userId = member.id.user;
    if (isSelf(userId)) return;

    const sections = [];

    const prevTimeout = previousMember.timeout ? new Date(previousMember.timeout).getTime() : null;
    const curTimeout = member.timeout ? new Date(member.timeout).getTime() : null;
    if (prevTimeout !== curTimeout) {
      if (curTimeout) {
        sections.push({
          title: "⏳ Member Timed Out",
          colour: "#E67E22",
          lines: [`**Until:** ${new Date(member.timeout).toUTCString()}`],
        });
      } else {
        sections.push({ title: "⏳ Timeout Removed", colour: "#2ECC71", lines: [] });
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
      if (added.length) lines.push(`**Added:** ${added.map(roleName).join(", ")}`);
      if (removed.length) lines.push(`**Removed:** ${removed.map(roleName).join(", ")}`);
      sections.push({ title: "🎭 Member Roles Changed", colour: "#F1C40F", lines });
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
      [`**Name:** :${emoji.name}:`, `**By:** ${formatUser(client, emoji.creator?.id)}`],
      "#2ECC71"
    );
    emitAudit(send, emoji.parent.id, embed);
  });

  client.on("emojiDelete", (emoji) => {
    if (emoji.parent?.type !== "Server") return;
    const embed = buildAuditEmbed("😀 Emoji Deleted", [`**Name:** :${emoji.name}:`], "#E74C3C");
    emitAudit(send, emoji.parent.id, embed);
  });
}

// ═══════════════════════════════════════════════════
//  Unban polling (bans have a gateway event via serverMemberLeave;
//  unbans have none at all, so we diff the ban list periodically)
// ═══════════════════════════════════════════════════

export function startUnbanPolling(client, { send }) {
  setInterval(() => pollUnbans(client, send), UNBAN_POLL_INTERVAL_MS);
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
