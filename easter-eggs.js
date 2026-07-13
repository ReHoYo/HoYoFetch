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

  const uploadUrl = getAttachmentUploadUrl(autumnUrl);
  const [headerName, headerValue] = authenticationHeader ?? [];
  if (
    !["X-Bot-Token", "X-Session-Token"].includes(headerName) ||
    typeof headerValue !== "string" ||
    !headerValue
  ) {
    throw new Error("Easter egg upload authentication is unavailable.");
  }

  let bytes;
  try {
    bytes = await readFileImpl(asset.url);
  } catch {
    throw new Error("Easter egg asset is unavailable.");
  }

  const body = new FormData();
  body.append(
    "file",
    new Blob([bytes], { type: asset.contentType }),
    asset.filename
  );

  let response;
  try {
    response = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: { [headerName]: headerValue },
      body,
    });
  } catch {
    throw new Error("Easter egg upload request failed.");
  }

  if (!response?.ok) {
    const status = Number.isInteger(response?.status)
      ? response.status
      : "unknown";
    throw new Error(`Easter egg upload failed (HTTP ${status}).`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Easter egg upload returned an invalid response.");
  }

  if (
    typeof data?.id !== "string" ||
    !ATTACHMENT_ID_PATTERN.test(data.id)
  ) {
    throw new Error("Easter egg upload returned an invalid attachment ID.");
  }

  return data.id;
}

function getAttachmentUploadUrl(autumnUrl) {
  if (typeof autumnUrl !== "string" || !autumnUrl) {
    throw new Error("Easter egg media service is unavailable.");
  }

  try {
    const baseUrl = new URL(autumnUrl);
    if (!["http:", "https:"].includes(baseUrl.protocol)) throw new Error();
    return `${baseUrl.toString().replace(/\/+$/, "")}/attachments`;
  } catch {
    throw new Error("Easter egg media service is unavailable.");
  }
}
