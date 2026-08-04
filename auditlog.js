// auditlog.js — Server action audit log (Stoat has no native audit log)
// ────────────────────────────────────────────────────────────────────
// Listens to every moderation-relevant revolt.js event we can and relays
// a formatted embed to whichever channel an admin/mod enabled via
// /enable-auditlog. Audit-log configuration is gated separately in
// audit-log-configuration.js. Platform limits around actor attribution,
// kick vs leave, and similar events are inherent to the gateway.
import {
  buildAuditEmbed,
  buildAuditBulkDeleteEmbed,
  buildAuditMemberEmbed,
  buildAuditMessageDeleteEmbed,
  buildAuditMessageEditEmbed,
} from "./embeds.js";
import {
  getAuditLogChannel,
  getAuditLogServers,
  getKnownBans,
  setKnownBans,
  disableAuditLog,
  isChannelExcluded,
  isAuditLogEnabled,
  getProtectedMessageByRecordId,
} from "./store.js";
import {
  recordMessage,
  getArchivedMessage,
  applyEdit,
  markMessageDeleted,
  markMessagesDeleted,
  startArchiveMaintenance,
  archiveSize,
} from "./message-archive.js";
import { evidenceModeStats, purgeLegacyEvidence } from "./evidence-store.js";
import {
  buildAttachmentArchiveEmbed,
  createAttachmentArchiveQueue,
  finaliseArchiveDescriptors,
  humanReadableSize,
  metadataOnlyDescriptors,
  prepareAttachmentCopies,
  resolveAttachmentArchive,
  SKIP_REASONS,
} from "./attachment-evidence.js";
import { createSettingsMonitor } from "./settings-monitor.js";
import { auditAlias, safeErrorSummary } from "./security.js";
import {
  buildUserInfoLines,
  collectUserInfo,
  evaluateBotSignals,
} from "./user-info.js";

const UNBAN_POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_PENDING_SENDS = 50;
const MAX_CONSECUTIVE_FAILURES = 5;
const MEMBER_REFRESH_TTL_MS = 15 * 60 * 1000;
const DEBUG = process.env.AUDITLOG_DEBUG === "1";
const ACTOR_UNAVAILABLE_LINE =
  "**Actor:** Unavailable — Stoat did not include an actor for this change.";
const memberSnapshots = new Map();
const ignoredSystemMessages = createMessageCache(5_000);

// Member joins and leaves reach us from two sources each (see the raw member
// dispatcher below), so every departure/arrival is claimed exactly once here.
const loggedMemberEvents = createMessageCache(5_000);
// How long the raw join path waits for the hydrated listener to claim a join.
// The hydrated event carries a real ServerMember (join date, roles), so it is
// worth a short delay to prefer it — but revolt.js can drop it entirely.
const RAW_JOIN_FALLBACK_DELAY_MS = 1_000;
// A claim only has to outlive the gap between the two sources. It must expire:
// keying on server+user forever would silently swallow the second departure of
// anyone who leaves, rejoins, and leaves again.
const MEMBER_EVENT_CLAIM_TTL_MS = 30_000;

// Counters behind /AuditLog test and /Server-Info. Member events are the only
// audit path that can fail with nothing to show for it — the gateway may never
// deliver them, or a payload guard may discard them — so what we saw on the
// wire is tracked separately from what we actually posted.
const memberEventStats = {
  lastJoinSeenAt: null,
  lastJoinPostedAt: null,
  lastLeaveSeenAt: null,
  lastLeavePostedAt: null,
  joinsDropped: 0,
  leavesDropped: 0,
  lastDropReason: null,
};

function memberEventKey(kind, serverId, userId) {
  return `${kind}:${serverId}:${userId}`;
}

/**
 * Claim one member event for one of its two sources. Returns false when the
 * other source already posted it.
 */
export function claimMemberEvent(kind, serverId, userId, now = Date.now()) {
  const key = memberEventKey(kind, serverId, userId);
  const claimedAt = loggedMemberEvents.get(key);
  if (claimedAt && now - claimedAt < MEMBER_EVENT_CLAIM_TTL_MS) return false;
  loggedMemberEvents.set(key, now);
  return true;
}

/**
 * Record a member event that arrived but produced no audit record. Reserved for
 * causes worth investigating — the bot's own arrivals/departures and servers
 * without audit logging are expected, and counting those would bury a real
 * malformed-payload drop in noise.
 */
function noteMemberDrop(kind, reason) {
  if (kind === "join") memberEventStats.joinsDropped++;
  else memberEventStats.leavesDropped++;
  memberEventStats.lastDropReason = `${kind}:${reason}`;
  debugLog(`member ${kind}: dropped (${reason})`);
}

function skipMemberEvent(kind, reason) {
  debugLog(`member ${kind}: skipped (${reason})`);
}

// Set by initAuditLog so runAuditLogTest can reuse the real send pipeline.
let sendRef = null;
let settingsMonitorRef = null;
// RAM-only source downloads and Stoat uploads go through this so tests can
// inject a fake without touching the network.
let fetchImplRef = fetch;

function debugLog(message) {
  if (DEBUG) console.log(`[auditlog] ${message}`);
}

// ── Send queue (serialised so bursts don't hit the API concurrently) ──
let chain = Promise.resolve();
let pending = 0;
const failureCounts = new Map(); // serverId -> consecutive failure count

function queueSend(serverId, channelId, send, embed, extras = {}) {
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
      if (extras.attachments?.length) payload.attachments = extras.attachments;
      if (extras.replies?.length) payload.replies = extras.replies;
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

function emitAudit(send, serverId, embed, extras) {
  if (!serverId) return;
  const channelId = getAuditLogChannel(serverId);
  if (!channelId) {
    debugLog(
      `emitAudit: audit log not enabled for server ${serverId}, dropping "${embed.title}"`
    );
    return;
  }
  debugLog(`emitAudit: queueing "${embed.title}" → channel ${channelId}`);
  queueSend(serverId, channelId, send, embed, extras);
}

/**
 * Push a synthetic test event through the real emitAudit → queue → send
 * pipeline so mods can verify end-to-end delivery from inside Stoat.
 * @param  {string} serverId
 * @return {{enabled: boolean, channelId: string|null, archivedCount: number,
 *           consecutiveFailures: number, queuedTest: boolean}}
 */
export function runAuditLogTest(serverId) {
  const diagnostics = getAuditDiagnostics(serverId);
  const { channelId } = diagnostics;
  const evidence = evidenceModeStats();
  const archiveQueue = attachmentArchiveQueue.stats();
  const captureFailures = Object.fromEntries(attachmentCaptureFailures);
  const captureFailureCount = Object.values(captureFailures).reduce(
    (sum, count) => sum + count,
    0
  );
  const status = {
    ...diagnostics,
    archivedCount: archiveSize(),
    queuedTest: false,
    evidenceMode: evidence.mode,
    evidenceBytes: evidence.diskBytes,
    evidencePerFileCapBytes: evidence.perFileCapBytes,
    attachmentArchiveQueue: archiveQueue,
    attachmentCaptureFailures: captureFailures,
    settings: settingsMonitorRef?.status(serverId) ?? null,
  };
  if (!channelId || !sendRef) return status;

  const embed = buildAuditEmbed(
    "🧪 Audit Log Test",
    [
      "If you can read this, the audit pipeline is delivering events to this channel.",
      `**Messages currently archived:** ${status.archivedCount}`,
      "**Attachment storage:** Stoat-hosted; 0 B retained on VPS",
      `**Per-file archive cap:** ${humanReadableSize(status.evidencePerFileCapBytes)}`,
      `**Archive queue:** ${archiveQueue.active} active, ${archiveQueue.queued} waiting, ${archiveQueue.failed} failed, ${archiveQueue.rejected} rejected`,
      `**Capture failures since startup:** ${captureFailureCount}`,
      ...formatMemberEventDiagnostics(status.memberEvents),
    ],
    "#3498DB"
  );
  emitAudit(sendRef, serverId, embed);
  status.queuedTest = true;
  return status;
}

/**
 * Return a read-only snapshot of audit delivery and settings health without
 * sending a test event or making a network request.
 */
export function getAuditDiagnostics(serverId) {
  const channelId = getAuditLogChannel(serverId);
  return {
    enabled: Boolean(channelId),
    channelId,
    consecutiveFailures: failureCounts.get(serverId) ?? 0,
    queuePending: pending,
    queueLimit: MAX_PENDING_SENDS,
    memberEvents: { ...memberEventStats },
    settings: settingsMonitorRef?.status(serverId) ?? null,
  };
}

/** Render the member-event counters as one human-readable audit line. */
export function formatMemberEventDiagnostics(stats) {
  const seen = (value) =>
    value ? new Date(value).toUTCString() : "never observed";
  return [
    `**Member joins:** seen ${seen(stats.lastJoinSeenAt)}, posted ${seen(stats.lastJoinPostedAt)}, ${stats.joinsDropped} dropped`,
    `**Member leaves:** seen ${seen(stats.lastLeaveSeenAt)}, posted ${seen(stats.lastLeavePostedAt)}, ${stats.leavesDropped} dropped`,
    `**Last member-event drop:** ${stats.lastDropReason ?? "none"}`,
  ];
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
 * Pull the server and user out of a raw ServerMemberJoin/ServerMemberLeave
 * payload. revolt.js v7 expects a flat `{id: serverId, user: userId}`, but the
 * composite `{id: {server, user}}` and snake-cased `user_id` shapes also appear
 * on the wire. A member event that matches none of them used to vanish without
 * a trace, so read every shape and let the caller account for the misses.
 *
 * @return {{serverId: string|null, userId: string|null}}
 */
export function memberIdsFromRawEvent(event) {
  const asId = (value) => (typeof value === "string" && value ? value : null);
  return {
    serverId: asId(event?.id?.server ?? event?.server ?? event?.id),
    userId: asId(event?.user ?? event?.user_id ?? event?.id?.user),
  };
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

export async function hydrateAuditMemberCache(client, serverId) {
  const server = client.servers.get(serverId);
  if (!server?.fetchMembers) {
    return { ok: false, reason: "server_unavailable", members: [] };
  }

  try {
    const result = await server.fetchMembers();
    const members = result?.members ?? [];
    memberSnapshots.set(serverId, { refreshedAt: Date.now(), members });
    return { ok: true, members };
  } catch (error) {
    console.warn(
      `auditlog: member cache hydration failed server=${auditAlias(serverId)} ${safeErrorSummary(error)}`
    );
    return { ok: false, reason: "fetch_failed", members: [] };
  }
}

async function getServerMembers(client, server) {
  const cached = memberSnapshots.get(server.id);
  if (cached && Date.now() - cached.refreshedAt < MEMBER_REFRESH_TTL_MS) {
    return cached.members;
  }

  const hydration = await hydrateAuditMemberCache(client, server.id);
  if (hydration.ok) return hydration.members;
  return [...client.serverMembers.values()].filter(
    (member) => member.id?.server === server.id
  );
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

function formatUser(client, userId) {
  if (!userId) return "Unknown user";
  const user = client.users.get(userId);
  return user ? `@${user.username} (${userId})` : `Unknown user (${userId})`;
}

function auditCodeValue(value, max = 100) {
  const text = typeof value === "string" ? value : "";
  const singleLine = text.replace(/[\r\n]+/g, " ").replaceAll("`", "ˋ");
  return `\`${truncate(singleLine, max)}\``;
}

export function buildUserIdentityAuditSections(
  client,
  user,
  previousUser = {}
) {
  const sections = [];
  if (
    typeof previousUser.username === "string" &&
    typeof user?.username === "string" &&
    previousUser.username !== user.username
  ) {
    sections.push({
      title: "🪪 Username Changed",
      colour: "#F1C40F",
      lines: [
        `**Before:** ${auditCodeValue(previousUser.username)}`,
        `**After:** ${auditCodeValue(user.username)}`,
        ACTOR_UNAVAILABLE_LINE,
      ],
      iconUrl: null,
    });
  }

  return sections;
}

function auditSectionEmbed(client, userId, section) {
  const embed = buildAuditEmbed(
    section.title,
    [`**User:** ${formatUser(client, userId)}`, ...section.lines],
    section.colour
  );
  if (section.iconUrl) embed.icon_url = section.iconUrl;
  return embed;
}

export function emitUserIdentityUpdates(client, user, previousUser, emit) {
  const userId = user?.id ?? user?._id;
  if (!userId || userId === client.user?.id || typeof emit !== "function") {
    return 0;
  }
  const sections = buildUserIdentityAuditSections(client, user, previousUser);
  if (!sections.length) return 0;

  let emitted = 0;
  for (const { serverId } of getAuditLogServers()) {
    const isMember = client.serverMembers?.hasByKey?.({
      server: serverId,
      user: userId,
    });
    if (!isMember) continue;
    for (const section of sections) {
      emit(serverId, auditSectionEmbed(client, userId, section));
      emitted++;
    }
  }
  return emitted;
}

export function buildMemberUpdateAuditSections(
  client,
  member,
  previousMember = {}
) {
  const sections = [];

  const prevTimeout = previousMember.timeout
    ? new Date(previousMember.timeout).getTime()
    : null;
  const curTimeout = member.timeout ? new Date(member.timeout).getTime() : null;
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
  const added = [...curRoles].filter((role) => !prevRoles.has(role));
  const removed = [...prevRoles].filter((role) => !curRoles.has(role));
  if (added.length || removed.length) {
    const server = client.servers.get(member.id.server);
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

  return sections;
}

const attachmentArchiveQueue = createAttachmentArchiveQueue();
const attachmentArchiveInFlight = new Map();
const attachmentCaptureFailures = new Map();
const CAPTURE_FAILURE_REASONS = new Set([
  SKIP_REASONS.DOWNLOAD_FAILED,
  SKIP_REASONS.UPLOAD_FAILED,
  SKIP_REASONS.LOGGER_SEND_FAILED,
  SKIP_REASONS.QUEUE_FULL,
]);

function trackAttachmentCaptureFailures(descriptors) {
  for (const descriptor of descriptors ?? []) {
    if (!CAPTURE_FAILURE_REASONS.has(descriptor.skipReason)) continue;
    attachmentCaptureFailures.set(
      descriptor.skipReason,
      (attachmentCaptureFailures.get(descriptor.skipReason) ?? 0) + 1
    );
  }
}

// ═══════════════════════════════════════════════════
//  Event wiring
// ═══════════════════════════════════════════════════

export function initAuditLog(
  client,
  {
    sendProtected,
    request,
    fetchImpl,
    shouldExcludeMessage = () => false,
    shouldExcludeMessageDelete = () => false,
  }
) {
  if (typeof sendProtected !== "function") {
    throw new TypeError("Audit logging requires a protected sender.");
  }
  const send = sendProtected;
  const isSelf = (userId) => userId === client.user?.id;

  sendRef = send;
  fetchImplRef = fetchImpl ?? fetch;
  startArchiveMaintenance();
  const legacyPurge = purgeLegacyEvidence();
  if (legacyPurge.files || legacyPurge.errors) {
    console.log(
      `attachment-archive: purged ${legacyPurge.files} legacy VPS file(s), ` +
        `${legacyPurge.errors} error(s)`
    );
  }
  settingsMonitorRef = createSettingsMonitor(client, {
    request,
    emit: (serverId, embed) => emitAudit(send, serverId, embed),
  });

  // ── Message archive recorder ────────────────────
  // Record every message in audit-enabled servers so deletes/edits can always
  // show the original content, even across restarts. The bot's own messages
  // are archived too — otherwise deleting them (e.g. its own loading embeds)
  // would be logged as "unknown message deleted". Qualifying attachments are
  // mirrored immediately into the protected Logger channel. Bytes exist only
  // in RAM during transfer and never enter the VPS data directory.
  client.on("messageCreate", async (message) => {
    const serverId = client.channels.get(message.channelId)?.serverId;
    if (!serverId || !isAuditLogEnabled(serverId)) return;
    if (message.channelId === getAuditLogChannel(serverId)) return;
    if (isChannelExcluded(message.channelId)) return;
    if (message.systemMessage) {
      ignoredSystemMessages.set(message.id, true);
      return;
    }
    let finishProcessing;
    const processing = new Promise((resolve) => {
      finishProcessing = resolve;
    });
    attachmentArchiveInFlight.set(message.id, processing);
    try {
      if (await shouldExcludeMessage(message)) {
        ignoredSystemMessages.set(message.id, true);
        return;
      }

      if (!message.attachments?.length) {
        recordMessage({
          id: message.id,
          channelId: message.channelId,
          serverId,
          authorId: message.authorId,
          content: message.content ?? "",
          attachments: [],
        });
        return;
      }

      await attachmentArchiveQueue
        .run(async () => {
          const prepared = await prepareAttachmentCopies(
            client,
            message.attachments,
            { fetchImpl: fetchImplRef, debugLog }
          );
          const embed = buildAttachmentArchiveEmbed({
            author: formatUser(client, message.authorId),
            channel: `<#${message.channelId}>`,
            messageId: message.id,
            descriptors: prepared.descriptors,
          });
          let posted;
          try {
            posted = await send(getAuditLogChannel(serverId), {
              embeds: [embed],
              ...(prepared.uploadIds.length
                ? { attachments: prepared.uploadIds }
                : {}),
            });
          } catch (error) {
            debugLog(`Logger archive send failed: ${error?.message || error}`);
          }
          return finaliseArchiveDescriptors(prepared.descriptors, posted);
        })
        .then((result) => {
          const attachments = !result.accepted
            ? metadataOnlyDescriptors(
                message.attachments,
                SKIP_REASONS.QUEUE_FULL
              )
            : result.error
              ? metadataOnlyDescriptors(
                  message.attachments,
                  SKIP_REASONS.LOGGER_SEND_FAILED
                )
              : result.value;
          trackAttachmentCaptureFailures(attachments);
          recordMessage({
            id: message.id,
            channelId: message.channelId,
            serverId,
            authorId: message.authorId,
            content: message.content ?? "",
            attachments,
          });
        });
    } finally {
      finishProcessing();
      if (attachmentArchiveInFlight.get(message.id) === processing) {
        attachmentArchiveInFlight.delete(message.id);
      }
    }
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
        await handleRawMessageUpdate(client, send, event);
      } else if (event.type === "BulkMessageDelete") {
        await handleRawBulkDelete(client, send, event);
      } else if (event.type === "ServerMemberJoin") {
        await handleRawMemberJoin(client, send, event);
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
    if (isChannelExcluded(event.channel)) return;
    if (ignoredSystemMessages.delete(event.id)) return;
    if (await shouldExcludeMessageDelete(event.id)) return;

    await attachmentArchiveInFlight.get(event.id);
    const entry = getArchivedMessage(event.id);
    markMessageDeleted(event.id);
    if (entry && isSelf(entry.authorId)) {
      debugLog(`MessageDelete ${event.id}: skipped (bot's own message)`);
      return;
    }

    debugLog(`MessageDelete ${event.id}: logging (archived=${Boolean(entry)})`);

    const { lines: attachmentLines, replyMessageIds } =
      resolveAttachmentArchive(entry, {
        getProtectedRecord: getProtectedMessageByRecordId,
      });

    const suspects = await computeSuspects(client, channel, entry?.authorId);
    const embed = buildAuditMessageDeleteEmbed({
      author: entry ? formatUser(client, entry.authorId) : "*unknown*",
      channelId: event.channel,
      content: entry?.content,
      messageId: event.id,
      attachmentLines,
      suspects: formatSuspects(suspects.authorLabel, suspects.moderatorLabels),
    });
    emitAudit(send, serverId, embed, {
      replies: replyMessageIds.slice(0, 1).map((id) => ({
        id,
        mention: false,
        fail_if_not_exists: false,
      })),
    });
  }

  async function handleRawMessageUpdate(client, send, event) {
    const after = event.data?.content;
    if (typeof after !== "string") return; // embed-only update (e.g. link unfurl)

    const serverId = client.channels.get(event.channel)?.serverId;
    if (!serverId) return;
    if (!isAuditLogEnabled(serverId)) return;
    if (event.channel === getAuditLogChannel(serverId)) return;
    if (isChannelExcluded(event.channel)) return;

    await attachmentArchiveInFlight.get(event.id);
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

    const attachmentCount = Array.isArray(entry?.attachments)
      ? entry.attachments.length
      : typeof entry?.attachments === "number"
        ? entry.attachments
        : 0;
    const { replyMessageIds } = resolveAttachmentArchive(entry, {
      getProtectedRecord: getProtectedMessageByRecordId,
    });
    const embed = buildAuditMessageEditEmbed({
      author: entry ? formatUser(client, entry.authorId) : "*unknown*",
      channelId: event.channel,
      before: entry ? before : undefined,
      after,
      attachmentCount,
    });
    emitAudit(send, serverId, embed, {
      replies: replyMessageIds.slice(0, 1).map((id) => ({
        id,
        mention: false,
        fail_if_not_exists: false,
      })),
    });

    // Keep the archive current so the next edit diffs against this one
    applyEdit(event.id, after);
  }

  async function handleRawBulkDelete(client, send, event) {
    const channel = client.channels.get(event.channel);
    const serverId = channel?.serverId;
    if (!serverId) return;
    if (!isAuditLogEnabled(serverId)) return;
    if (event.channel === getAuditLogChannel(serverId)) return;
    if (isChannelExcluded(event.channel)) return;

    await Promise.all(
      (event.ids ?? []).map((id) => attachmentArchiveInFlight.get(id))
    );
    const entries = (event.ids ?? [])
      .filter((id) => !ignoredSystemMessages.delete(id))
      .map((id) => ({ id, entry: getArchivedMessage(id) }));
    markMessagesDeleted(entries.map(({ id }) => id));
    const relevant = entries.filter(
      ({ entry }) => !entry || !isSelf(entry.authorId)
    );
    if (!relevant.length) return;

    const shown = relevant.map(({ id, entry }) =>
      entry
        ? `${formatUser(client, entry.authorId)}: ${truncate(entry.content || "*(no content)*", 150)}`
        : `*unknown message ${id} (not archived)*`
    );

    const attachmentLines = [];
    const replyMessageIds = [];
    for (const { entry } of relevant) {
      if (!entry) continue;
      const { lines, replyMessageIds: archiveReplies } =
        resolveAttachmentArchive(entry, {
          getProtectedRecord: getProtectedMessageByRecordId,
        });
      if (!lines.length) continue;
      attachmentLines.push(
        `**${formatUser(client, entry.authorId)}:**`,
        ...lines
      );
      for (const id of archiveReplies) {
        if (!replyMessageIds.includes(id)) replyMessageIds.push(id);
      }
    }

    const suspects = await computeSuspects(client, channel);
    const embed = buildAuditBulkDeleteEmbed({
      channelId: event.channel,
      count: relevant.length,
      entries: shown,
      attachmentLines,
      suspects: formatSuspects(null, suspects.moderatorLabels),
    });
    emitAudit(send, serverId, embed, {
      replies: replyMessageIds.slice(0, 5).map((id) => ({
        id,
        mention: false,
        fail_if_not_exists: false,
      })),
    });
  }

  async function handleRawMemberLeave(client, send, event) {
    memberEventStats.lastLeaveSeenAt = Date.now();
    const { serverId, userId } = memberIdsFromRawEvent(event);
    if (!serverId) return noteMemberDrop("leave", "no_server_id");
    if (!userId) return noteMemberDrop("leave", "no_user_id");
    if (isSelf(userId)) return skipMemberEvent("leave", "self");
    if (!isAuditLogEnabled(serverId))
      return skipMemberEvent("leave", "audit_disabled");
    if (!claimMemberEvent("leave", serverId, userId)) return;

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

    memberEventStats.lastLeavePostedAt = Date.now();
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

  /**
   * Build and queue the join embed. Shared by the hydrated listener and the
   * raw-event fallback so both render identically; `member` is null when the
   * raw path fires for an account revolt.js never cached.
   */
  function postMemberJoin(serverId, userId, member) {
    if (!claimMemberEvent("join", serverId, userId)) return false;
    const now = Date.now();
    const record = collectUserInfo(client, { serverId, userId, member });
    const signals = evaluateBotSignals(record, now);
    memberEventStats.lastJoinPostedAt = now;
    emitAudit(
      send,
      serverId,
      buildAuditEmbed(
        signals.length ? "📥 Member Joined — review" : "📥 Member Joined",
        buildUserInfoLines(record, signals, { now }),
        signals.length ? "#E67E22" : "#2ECC71"
      )
    );
    return true;
  }

  // revolt.js only emits its hydrated serverMemberJoin after `await
  // client.users.fetch(...)` succeeds (eagerFetching defaults on), and skips it
  // outright for any account already in the member cache. Either way the join
  // is lost with nothing but an unhandled rejection to show for it. The raw
  // stream has neither gate, so it backstops the hydrated listener — delayed
  // briefly so the richer hydrated record wins whenever it does arrive.
  async function handleRawMemberJoin(client, send, event) {
    memberEventStats.lastJoinSeenAt = Date.now();
    const { serverId, userId } = memberIdsFromRawEvent(event);
    if (!serverId) return noteMemberDrop("join", "no_server_id");
    if (!userId) return noteMemberDrop("join", "no_user_id");
    if (isSelf(userId)) return skipMemberEvent("join", "self");
    if (!isAuditLogEnabled(serverId))
      return skipMemberEvent("join", "audit_disabled");

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, RAW_JOIN_FALLBACK_DELAY_MS);
      timer?.unref?.();
    });

    const member =
      client.serverMembers?.getByKey?.({ server: serverId, user: userId }) ??
      null;
    if (postMemberJoin(serverId, userId, member)) {
      debugLog(`member join ${userId}: logged from the raw gateway stream`);
    }
  }

  // Settings changes are handled from raw gateway events plus persisted REST
  // reconciliation by settings-monitor.js. Keep this hydrated listener only
  // for the special case where the configured audit channel itself vanishes.
  client.on("channelDelete", (channel) => {
    const serverId = channel.serverId;
    if (!serverId) return;

    if (channel.id === getAuditLogChannel(serverId)) {
      disableAuditLog(serverId);
      console.warn(
        `auditlog: the audit log channel itself was deleted for server ${serverId}; audit logging disabled`
      );
      settingsMonitorRef?.configurationChanged(serverId);
    }
  });

  // ── Members ─────────────────────────────────────
  // These hydrated listeners are the preferred source — they carry a real
  // ServerMember — but the raw dispatcher above backstops both join and leave.
  // Each body is wrapped: revolt.js emits them from inside an un-awaited async
  // handler, so a bare throw here surfaces only as an unhandled rejection.
  function guarded(label, handler) {
    return (...args) => {
      try {
        handler(...args);
      } catch (error) {
        console.error(
          `auditlog: ${label} handler failed:`,
          safeErrorSummary(error)
        );
      }
    };
  }

  // Cache-only: a join flood must never trigger a REST call per member, so
  // this never fetches the profile (bio/banner) that /Get-Info can afford.
  client.on(
    "serverMemberJoin",
    guarded("member join", (member) => {
      const serverId = member?.id?.server;
      const userId = member?.id?.user;
      if (!serverId || !userId || isSelf(userId)) return;
      memberEventStats.lastJoinSeenAt = Date.now();
      if (!isAuditLogEnabled(serverId))
        return skipMemberEvent("join", "audit_disabled");
      postMemberJoin(serverId, userId, member);
    })
  );

  // revolt.js only emits this for members it had cached, so the raw dispatcher
  // remains the primary leave path; both claim through the same dedupe cache.
  client.on(
    "serverMemberLeave",
    guarded("member leave", (member) => {
      const serverId = member?.id?.server;
      const userId = member?.id?.user;
      if (!serverId || !userId) return;
      handleRawMemberLeave(client, send, {
        id: serverId,
        user: userId,
      }).catch((error) =>
        console.error(
          "auditlog: member leave fallback failed:",
          safeErrorSummary(error)
        )
      );
    })
  );

  client.on(
    "userUpdate",
    guarded("user update", (user, previousUser) => {
      emitUserIdentityUpdates(client, user, previousUser, (serverId, embed) =>
        emitAudit(send, serverId, embed)
      );
    })
  );

  client.on(
    "serverMemberUpdate",
    guarded("member update", (member, previousMember) => {
      const serverId = member.id.server;
      const userId = member.id.user;
      if (isSelf(userId)) return;

      const sections = buildMemberUpdateAuditSections(
        client,
        member,
        previousMember
      );

      for (const section of sections) {
        const embed = auditSectionEmbed(client, userId, section);
        emitAudit(send, serverId, embed);
      }
    })
  );

  return {
    ...settingsMonitorRef,
    async start() {
      // revolt.js only emits hydrated user/member update callbacks for objects
      // already present in its collections. Seed every audited server so
      // nickname and username changes are not silently discarded.
      for (const { serverId } of getAuditLogServers()) {
        await hydrateAuditMemberCache(client, serverId);
      }
      return settingsMonitorRef.start();
    },
    async configurationChanged(serverId) {
      if (isAuditLogEnabled(serverId)) {
        await hydrateAuditMemberCache(client, serverId);
      } else {
        memberSnapshots.delete(serverId);
      }
      return settingsMonitorRef.configurationChanged(serverId);
    },
  };
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
