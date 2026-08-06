// attachment-evidence.js — RAM-only Stoat attachment archiving
// ─────────────────────────────────────────────────────────────
// Attachment bytes exist only inside a bounded Buffer while they are copied
// from the source Stoat file to a new Stoat upload. Only descriptors, URLs,
// and protected Logger record ids are persisted locally.
import { uploadAttachmentBytes } from "./easter-eggs.js";
import { isEvidenceEnabled, perFileCapBytes } from "./evidence-store.js";
import { buildAuditEmbed } from "./embeds.js";

export const ATTACHMENT_ARCHIVE_CONCURRENCY = 2;
export const ATTACHMENT_ARCHIVE_MAX_PENDING = 50;

export function humanReadableSize(bytes) {
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

export function isTrustedAttachmentUrl(client, url) {
  const autumnBase = client.configuration?.features?.autumn?.url;
  return (
    Boolean(autumnBase) && typeof url === "string" && url.startsWith(autumnBase)
  );
}

export const SKIP_REASONS = Object.freeze({
  EVIDENCE_DISABLED: "evidence_disabled",
  UNTRUSTED_URL: "untrusted_url",
  TOO_LARGE: "too_large",
  DOWNLOAD_FAILED: "download_failed",
  UPLOAD_FAILED: "upload_failed",
  LOGGER_SEND_FAILED: "logger_send_failed",
  QUEUE_FULL: "queue_full",
  LEGACY_PURGED: "legacy_purged",
  MEDIA_LOST: "media_lost",
});

const SKIP_REASON_LABELS = {
  [SKIP_REASONS.EVIDENCE_DISABLED]: "Stoat attachment archiving is disabled",
  [SKIP_REASONS.UNTRUSTED_URL]: "the URL was not a recognized Stoat CDN link",
  [SKIP_REASONS.TOO_LARGE]: "the file exceeded the attachment size cap",
  [SKIP_REASONS.DOWNLOAD_FAILED]: "the source download failed or was oversized",
  [SKIP_REASONS.UPLOAD_FAILED]: "the Stoat archive upload failed",
  [SKIP_REASONS.LOGGER_SEND_FAILED]:
    "the Logger archive card could not be sent",
  [SKIP_REASONS.QUEUE_FULL]: "the bounded archive queue was full",
  [SKIP_REASONS.LEGACY_PURGED]: "the former VPS evidence cache was purged",
  [SKIP_REASONS.MEDIA_LOST]: "the Stoat archive card was deleted",
};

function baseDescriptor(att) {
  const legacy = typeof att?.evidencePath === "string";
  return {
    id: att?.id ?? null,
    filename: att?.filename || "file",
    size: att?.size ?? 0,
    contentType: att?.contentType || "application/octet-stream",
    archiveAttachmentId: att?.archiveAttachmentId ?? null,
    archiveUrl: att?.archiveUrl ?? null,
    archiveRecordId: att?.archiveRecordId ?? null,
    skipReason: legacy ? SKIP_REASONS.LEGACY_PURGED : (att?.skipReason ?? null),
  };
}

export function normaliseAttachmentDescriptors(attachments) {
  if (!Array.isArray(attachments)) return attachments;
  return attachments.map(baseDescriptor);
}

export function metadataOnlyDescriptors(attachments, skipReason) {
  return (attachments ?? []).map((att) => ({
    ...baseDescriptor(att),
    archiveAttachmentId: null,
    archiveUrl: null,
    archiveRecordId: null,
    skipReason,
  }));
}

async function downloadAttachmentBytes(fetchImpl, url, maxBytes) {
  let response;
  try {
    response = await fetchImpl(url);
  } catch {
    return null;
  }
  if (!response?.ok) return null;
  try {
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length <= maxBytes ? bytes : null;
  } catch {
    return null;
  }
}

function archiveUrl(client, id, filename) {
  const base = client.configuration?.features?.autumn?.url?.replace(/\/$/, "");
  return base
    ? `${base}/attachments/${id}/${encodeURIComponent(filename || "file")}`
    : null;
}

/** Download and immediately re-upload every qualifying file, using RAM only. */
export async function prepareAttachmentCopies(
  client,
  attachments,
  { fetchImpl = fetch, debugLog = () => {} } = {}
) {
  const descriptors = [];
  const uploadIds = [];
  for (const source of attachments ?? []) {
    const descriptor = baseDescriptor(source);
    const sourceUrl = source?.url ?? source?.archiveUrl ?? null;

    if (!isEvidenceEnabled()) {
      descriptor.skipReason = SKIP_REASONS.EVIDENCE_DISABLED;
    } else if (!sourceUrl || !isTrustedAttachmentUrl(client, sourceUrl)) {
      descriptor.skipReason = SKIP_REASONS.UNTRUSTED_URL;
    } else if (!(descriptor.size > 0) || descriptor.size > perFileCapBytes()) {
      descriptor.skipReason = SKIP_REASONS.TOO_LARGE;
    }

    if (!descriptor.skipReason) {
      const bytes = await downloadAttachmentBytes(
        fetchImpl,
        sourceUrl,
        perFileCapBytes()
      );
      if (!bytes) {
        descriptor.skipReason = SKIP_REASONS.DOWNLOAD_FAILED;
      } else {
        try {
          const id = await uploadAttachmentBytes({
            bytes,
            filename: descriptor.filename,
            contentType: descriptor.contentType,
            autumnUrl: client.configuration?.features?.autumn?.url,
            authenticationHeader: client.authenticationHeader,
            fetchImpl,
          });
          descriptor.archiveAttachmentId = id;
          descriptor.archiveUrl = archiveUrl(client, id, descriptor.filename);
          uploadIds.push(id);
          debugLog(`attachment copied to Stoat (${bytes.length} bytes)`);
        } catch (error) {
          descriptor.skipReason = SKIP_REASONS.UPLOAD_FAILED;
          debugLog(`attachment upload failed: ${error?.message || error}`);
        }
      }
    }
    descriptors.push(descriptor);
  }
  return { descriptors, uploadIds };
}

export function buildAttachmentArchiveEmbed({
  author,
  channel,
  messageId,
  descriptors,
  title = "📎 Attachment Archived",
}) {
  const lines = [
    `**Author:** ${author}`,
    `**Source channel:** ${channel}`,
    `**Source message:** \`${messageId}\``,
    "**Storage:** Stoat-hosted; Irminsul retains metadata only.",
    "",
    "**Attachments:**",
    ...descriptors.map((att) => {
      const status = att.archiveAttachmentId
        ? "archived above"
        : `not archived (${SKIP_REASON_LABELS[att.skipReason] ?? "unknown reason"})`;
      return `- \`${att.filename}\` (${humanReadableSize(att.size)}) — ${status}`;
    }),
  ];
  return buildAuditEmbed(title, lines, "#3498DB");
}

export function finaliseArchiveDescriptors(descriptors, sentMessage) {
  const recordId = sentMessage?._id ?? null;
  return descriptors.map((att) => {
    if (!att.archiveAttachmentId) return { ...att };
    if (!recordId) {
      return {
        ...att,
        archiveAttachmentId: null,
        archiveUrl: null,
        archiveRecordId: null,
        skipReason: SKIP_REASONS.LOGGER_SEND_FAILED,
      };
    }
    return { ...att, archiveRecordId: recordId, skipReason: null };
  });
}

/** Describe archived media and resolve protected records to their live ids. */
export function resolveAttachmentArchive(
  entry,
  { getProtectedRecord = () => null } = {}
) {
  const lines = [];
  const replyMessageIds = [];
  const recordIds = [];
  if (!entry) return { lines, replyMessageIds, recordIds };
  if (typeof entry.attachments === "number") {
    if (entry.attachments > 0) {
      lines.push(
        `_(${entry.attachments} attachment${entry.attachments > 1 ? "s" : ""} — recorded before attachment archiving existed)_`
      );
    }
    return { lines, replyMessageIds, recordIds };
  }

  for (const att of normaliseAttachmentDescriptors(entry.attachments) ?? []) {
    const size = humanReadableSize(att.size);
    if (!att.archiveRecordId) {
      lines.push(
        `⚠️ \`${att.filename}\` (${size}) — not archived (${SKIP_REASON_LABELS[att.skipReason] ?? "unknown reason"})`
      );
      continue;
    }
    const protectedRecord = getProtectedRecord(att.archiveRecordId);
    if (protectedRecord?.mediaLost) {
      lines.push(
        `⚠️ \`${att.filename}\` (${size}) — Logger metadata was restored, but Stoat removed the media with the deleted archive card`
      );
    } else {
      lines.push(
        `✅ \`${att.filename}\` (${size}) — archived in Logger record \`${att.archiveRecordId}\``
      );
    }
    if (!recordIds.includes(att.archiveRecordId)) {
      recordIds.push(att.archiveRecordId);
    }
    if (
      protectedRecord?.messageId &&
      !replyMessageIds.includes(protectedRecord.messageId)
    ) {
      replyMessageIds.push(protectedRecord.messageId);
    }
  }
  return { lines, replyMessageIds, recordIds };
}

/** Copy an already Stoat-hosted archive again for an approved held post. */
export async function copyArchivedAttachments(
  client,
  attachments,
  { fetchImpl = fetch, debugLog = () => {} } = {}
) {
  const descriptors = normaliseAttachmentDescriptors(attachments) ?? [];
  if (descriptors.some((att) => !att.archiveUrl || att.skipReason)) {
    throw new Error("One or more held attachments are unavailable.");
  }
  const ids = [];
  for (const att of descriptors) {
    const bytes = await downloadAttachmentBytes(
      fetchImpl,
      att.archiveUrl,
      perFileCapBytes()
    );
    if (!bytes) throw new Error(`Held attachment unavailable: ${att.filename}`);
    const id = await uploadAttachmentBytes({
      bytes,
      filename: att.filename,
      contentType: att.contentType,
      autumnUrl: client.configuration?.features?.autumn?.url,
      authenticationHeader: client.authenticationHeader,
      fetchImpl,
    });
    ids.push(id);
    debugLog(`held attachment copied to approved post (${bytes.length} bytes)`);
  }
  return ids;
}

export function createAttachmentArchiveQueue({
  concurrency = ATTACHMENT_ARCHIVE_CONCURRENCY,
  maxPending = ATTACHMENT_ARCHIVE_MAX_PENDING,
} = {}) {
  const queued = [];
  let active = 0;
  let completed = 0;
  let failed = 0;
  let rejected = 0;

  function drain() {
    while (active < concurrency && queued.length) {
      const item = queued.shift();
      active += 1;
      Promise.resolve()
        .then(item.task)
        .then((value) => {
          completed += 1;
          item.resolve({ accepted: true, value });
        })
        .catch((error) => {
          failed += 1;
          item.resolve({ accepted: true, error });
        })
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  function run(task) {
    // `maxPending` is the waiting-room bound. Active transfers are governed
    // separately by `concurrency`, so the production queue holds two active
    // source messages plus at most 50 waiting source messages.
    if (active >= concurrency && queued.length >= maxPending) {
      rejected += 1;
      return Promise.resolve({ accepted: false });
    }
    return new Promise((resolve) => {
      queued.push({ task, resolve });
      drain();
    });
  }

  return {
    run,
    stats: () => ({
      active,
      queued: queued.length,
      completed,
      failed,
      rejected,
    }),
  };
}
