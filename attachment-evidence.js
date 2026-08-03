// attachment-evidence.js — Shared attachment descriptor and evidence-capture
// logic, used by both auditlog.js (message create/delete/edit/bulk-delete)
// and post-gate.js (held first-post review). Consolidated so every caller
// records and reports attachment evidence the same way instead of each
// module growing its own slightly different copy.
import { uploadAttachmentBytes } from "./easter-eggs.js";
import {
  isEvidenceEnabled,
  perFileCapBytes,
  readEvidence,
  saveEvidence,
} from "./evidence-store.js";

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

async function downloadAttachmentBytes(fetchImpl, url, maxBytes) {
  let response;
  try {
    response = await fetchImpl(url);
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
 * Why a non-qualifying attachment wasn't captured as local evidence. Kept
 * as distinct reasons (rather than one generic "not preserved") so an audit
 * embed can tell an operator-disabled feature apart from a download that
 * genuinely failed.
 */
export const SKIP_REASONS = Object.freeze({
  EVIDENCE_DISABLED: "evidence_disabled",
  UNTRUSTED_URL: "untrusted_url",
  TOO_LARGE: "too_large",
  DOWNLOAD_FAILED: "download_failed",
  CAPTURE_ERROR: "capture_error",
});

const SKIP_REASON_LABELS = {
  [SKIP_REASONS.EVIDENCE_DISABLED]:
    "evidence capture is disabled on this server",
  [SKIP_REASONS.UNTRUSTED_URL]:
    "the attachment URL was not a recognized Stoat CDN link",
  [SKIP_REASONS.TOO_LARGE]: "the file exceeded the evidence size cap",
  [SKIP_REASONS.DOWNLOAD_FAILED]:
    "the download failed, was unavailable, or exceeded the size cap",
  [SKIP_REASONS.CAPTURE_ERROR]: "saving the local copy failed",
};

/**
 * Build attachment descriptors for a freshly created message, downloading
 * and locally caching bytes for attachments that qualify as evidence.
 * `skipReason` records exactly why a non-qualifying attachment wasn't
 * preserved, instead of collapsing every cause into one "not preserved"
 * line downstream.
 */
export async function buildAttachmentDescriptors(
  client,
  messageId,
  attachments,
  { fetchImpl = fetch, debugLog = () => {} } = {}
) {
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
      skipReason: null,
    };

    if (!isEvidenceEnabled()) {
      descriptor.skipReason = SKIP_REASONS.EVIDENCE_DISABLED;
    } else if (
      !descriptor.url ||
      !isTrustedAttachmentUrl(client, descriptor.url)
    ) {
      descriptor.skipReason = SKIP_REASONS.UNTRUSTED_URL;
    } else if (!(descriptor.size > 0) || descriptor.size > perFileCapBytes()) {
      descriptor.skipReason = SKIP_REASONS.TOO_LARGE;
    }

    if (!descriptor.skipReason) {
      try {
        const bytes = await downloadAttachmentBytes(
          fetchImpl,
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
          if (!descriptor.evidencePath) {
            descriptor.skipReason = SKIP_REASONS.CAPTURE_ERROR;
          } else {
            debugLog(
              `evidence captured for ${descriptor.id} (${bytes.length} bytes)`
            );
          }
        } else {
          descriptor.skipReason = SKIP_REASONS.DOWNLOAD_FAILED;
          debugLog(
            `evidence download unavailable/too large for ${descriptor.id}`
          );
        }
      } catch (err) {
        descriptor.skipReason = SKIP_REASONS.CAPTURE_ERROR;
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
 * For a deleted (or held) message's archived attachments, re-upload any
 * locally saved evidence and describe what happened to each attachment for
 * the embed body.
 * @param {number} [maxReuploads] cap how many files get re-uploaded from
 *   this one event; excess preserved attachments are reported as counted
 *   but not re-uploaded rather than left off the embed entirely.
 * @return {{lines: string[], ids: string[]}}
 */
export async function resolveAttachmentEvidence(
  client,
  entry,
  { fetchImpl = fetch, debugLog = () => {}, maxReuploads = Infinity } = {}
) {
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

  let reuploaded = 0;
  for (const att of attachments) {
    const sizeLabel = humanReadableSize(att.size);
    if (!att.evidencePath) {
      const reason = SKIP_REASON_LABELS[att.skipReason] ?? "not preserved";
      lines.push(
        `⚠️ \`${att.filename}\` (${sizeLabel}) — not preserved (${reason})`
      );
      continue;
    }

    if (reuploaded >= maxReuploads) {
      lines.push(
        `⚠️ \`${att.filename}\` (${sizeLabel}) — preserved locally, but this event's re-upload limit was already reached`
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
        fetchImpl,
      });
      ids.push(newId);
      reuploaded += 1;
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
