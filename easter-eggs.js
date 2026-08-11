import { readFile } from "node:fs/promises";
import fetch, { Blob, FormData } from "node-fetch";

const ASSET_DIRECTORY = new URL("./assets/easter-eggs/", import.meta.url);
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const EASTER_EGG_COMMANDS = Object.freeze({
  chison: Object.freeze({
    filename: "chison.jpeg",
    contentType: "image/jpeg",
    url: new URL("chison.jpeg", ASSET_DIRECTORY),
  }),
  potential: Object.freeze({
    filename: "potential.webp",
    contentType: "image/webp",
    url: new URL("potential.webp", ASSET_DIRECTORY),
  }),
  me: Object.freeze({
    filename: "me.webp",
    contentType: "image/webp",
    url: new URL("me.webp", ASSET_DIRECTORY),
  }),
});

export const EASTER_EGG_COMMAND_NAMES = Object.freeze(
  Object.keys(EASTER_EGG_COMMANDS)
);

export async function uploadEasterEggAttachment({
  asset,
  autumnUrl,
  authenticationHeader,
  fetchImpl = fetch,
  readFileImpl = readFile,
}) {
  if (!asset?.url || !asset.filename || !asset.contentType) {
    throw new Error("Easter egg asset configuration is invalid.");
  }

  let bytes;
  try {
    bytes = await readFileImpl(asset.url);
  } catch {
    throw new Error("Easter egg asset is unavailable.");
  }

  try {
    return await uploadAttachmentBytes({
      bytes,
      filename: asset.filename,
      contentType: asset.contentType,
      autumnUrl,
      authenticationHeader,
      fetchImpl,
    });
  } catch (err) {
    throw new Error(
      (err?.message || "Easter egg upload failed.").replace(
        /^Attachment /,
        "Easter egg "
      )
    );
  }
}

// Autumn buckets this uploader is allowed to target. Never interpolate a
// caller-supplied string into the upload URL unchecked.
const AUTUMN_BUCKETS = new Set(["attachments", "emojis"]);

/**
 * Upload raw bytes to an Autumn bucket and return the new attachment id.
 * Shared by easter eggs, audit-log evidence re-hosting, and emoji
 * provisioning (which uses bucket: "emojis" instead of the default).
 * @param {{bytes: Buffer|Uint8Array, filename: string, contentType: string,
 *          autumnUrl: string, authenticationHeader: [string, string],
 *          bucket?: string, fetchImpl?: Function}} opts
 * @return {Promise<string>} the new Autumn attachment id
 */
export async function uploadAttachmentBytes({
  bytes,
  filename,
  contentType,
  autumnUrl,
  authenticationHeader,
  bucket = "attachments",
  fetchImpl = fetch,
}) {
  if (!bytes || !filename || !contentType) {
    throw new Error("Attachment upload configuration is invalid.");
  }

  const uploadUrl = getUploadUrl(autumnUrl, bucket);
  const [headerName, headerValue] = authenticationHeader ?? [];
  if (
    !["X-Bot-Token", "X-Session-Token"].includes(headerName) ||
    typeof headerValue !== "string" ||
    !headerValue
  ) {
    throw new Error("Attachment upload authentication is unavailable.");
  }

  const body = new FormData();
  body.append("file", new Blob([bytes], { type: contentType }), filename);

  let response;
  try {
    response = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: { [headerName]: headerValue },
      body,
    });
  } catch {
    throw new Error("Attachment upload request failed.");
  }

  if (!response?.ok) {
    const status = Number.isInteger(response?.status)
      ? response.status
      : "unknown";
    throw new Error(`Attachment upload failed (HTTP ${status}).`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Attachment upload returned an invalid response.");
  }

  if (typeof data?.id !== "string" || !ATTACHMENT_ID_PATTERN.test(data.id)) {
    throw new Error("Attachment upload returned an invalid attachment ID.");
  }

  return data.id;
}

function getUploadUrl(autumnUrl, bucket) {
  if (typeof autumnUrl !== "string" || !autumnUrl) {
    throw new Error("Media service is unavailable.");
  }
  if (!AUTUMN_BUCKETS.has(bucket)) {
    throw new Error(`Unknown Autumn bucket: ${bucket}`);
  }

  try {
    const baseUrl = new URL(autumnUrl);
    if (!["http:", "https:"].includes(baseUrl.protocol)) throw new Error();
    return `${baseUrl.toString().replace(/\/+$/, "")}/${bucket}`;
  } catch {
    throw new Error("Media service is unavailable.");
  }
}
