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
} from "./store.js";

const UNBAN_POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_PENDING_SENDS = 50;
const MAX_CONSECUTIVE_FAILURES = 5;

// ── Send queue (serialised so bursts don't hit the API concurrently) ──
let chain = Promise.resolve();
let pending = 0;
const failureCounts = new Map(); // serverId -> consecutive failure count

function queueSend(serverId, channelId, send, embed) {
  if (pending >= MAX_PENDING_SENDS) {
    console.warn(`auditlog: send queue full, dropping an event for server ${serverId}`);
    return;
  }
  pending++;
  chain = chain.then(async () => {
    try {
      const result = await send(channelId, { embeds: [embed] });
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

function emitAudit(send, serverId, embed) {
  if (!serverId) return;
  const channelId = getAuditLogChannel(serverId);
  if (!channelId) return;
  queueSend(serverId, channelId, send, embed);
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

// ═══════════════════════════════════════════════════
//  Event wiring
// ═══════════════════════════════════════════════════

export function initAuditLog(client, { send }) {
  const isSelf = (userId) => userId === client.user?.id;

  // ── Messages ────────────────────────────────────
  client.on("messageDelete", (msg) => {
    if (isSelf(msg.authorId)) return;
    const channel = client.channels.get(msg.channelId);
    const serverId = channel?.serverId;
    if (!serverId) return; // DM or uncached channel
    if (msg.channelId === getAuditLogChannel(serverId)) return;

    const embed = buildAuditEmbed(
      "🗑️ Message Deleted",
      [
        `**Author:** ${formatUser(client, msg.authorId)}`,
        `**Channel:** <#${msg.channelId}>`,
        `**Content:** ${formatContent(msg.content)}`,
        "_Deleter unknown — Stoat does not report who deleted a message._",
      ],
      "#E74C3C"
    );
    emitAudit(send, serverId, embed);
  });

  client.on("messageUpdate", (message, previousMessage) => {
    if (isSelf(message.authorId)) return;
    const channelId = message.channelId;
    if (!channelId) return;
    const channel = client.channels.get(channelId);
    const serverId = channel?.serverId;
    if (!serverId) return;
    if (channelId === getAuditLogChannel(serverId)) return;

    const before = previousMessage.content;
    const after = message.content;
    if (before === after) return; // e.g. link-embed unfurl (MessageAppend), not a real edit

    const embed = buildAuditEmbed(
      "✏️ Message Edited",
      [
        `**Author:** ${formatUser(client, message.authorId)}`,
        `**Channel:** <#${channelId}>`,
        `**Before:** ${formatContent(before)}`,
        `**After:** ${formatContent(after)}`,
      ],
      "#F1C40F"
    );
    emitAudit(send, serverId, embed);
  });

  client.on("messageDeleteBulk", (messages, channel) => {
    const serverId = channel?.serverId;
    if (!serverId) return;
    if (channel.id === getAuditLogChannel(serverId)) return;

    const relevant = messages.filter((m) => !isSelf(m.authorId));
    if (!relevant.length) return;

    const shown = relevant.slice(0, 10).map(
      (m) => `${formatUser(client, m.authorId)}: ${truncate(m.content || "*(no content)*", 150)}`
    );
    if (relevant.length > 10) shown.push(`_…and ${relevant.length - 10} more_`);

    const embed = buildAuditEmbed(
      "🗑️ Bulk Message Delete",
      [`**Channel:** <#${channel.id}>`, `**Count:** ${relevant.length}`, "", ...shown],
      "#E74C3C"
    );
    emitAudit(send, serverId, embed);
  });

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
