#!/usr/bin/env node
// emoji-provision.js — Automated custom-emoji provisioning
// ────────────────────────────────────────────────────────────────────────
// Downloads every icon named in emoji-icons.js and uploads it as a Revolt
// server emoji on the configured hub server, replacing the old manual
// "download an icon, upload it by hand, copy the ID into config.js" chore.
// A hub server is unavoidable on Revolt/Stoat — custom emoji are always
// server-scoped ULIDs, unlike Discord's application-owned emoji — but every
// step of populating it is now automated.
//
// Safe to re-run: fetchEmojis() is consulted first, so an already-uploaded
// keyword is reused (never re-uploaded) and just gets its id re-recorded.
// A wiped data/ directory self-heals on the next run from the server's own
// emoji list. Per-item failures never abort the run — one broken icon URL
// shows up in the returned summary, everything else still provisions.
//
// Two entry points:
//   • provisionEmoji({ client, ... }) — called from bot.js's /EmojiSetup
//     handler, reusing the already-connected client.
//   • `node emoji-provision.js` / `npm run emoji:provision` — a headless
//     CLI that logs in on its own, mirroring emergency-lockdown.js.
import fetch from "node-fetch";
import { CONFIG, setCustomEmojiRegistry } from "./config.js";
import { EMOJI_ICON_MANIFEST } from "./emoji-icons.js";
import { uploadAttachmentBytes } from "./easter-eggs.js";
import { isSafeId } from "./security.js";
import { loadEmojiRegistry, saveEmojiRegistry } from "./store.js";

const DEFAULT_MAX_SERVER_EMOJI = 100;
const DEFAULT_MAX_ICON_BYTES = 500_000;
const DOWNLOAD_TIMEOUT_MS = 15_000;

/**
 * Create a server emoji via the raw Stoat API, bypassing revolt.js's
 * Server.createEmoji(). That helper hands whatever the PUT call returns
 * straight to its local object-store hydration, which throws an unrelated,
 * confusing "Cannot read properties of undefined (reading 'partial')"
 * TypeError whenever the response has no `_id` — which happens whenever
 * Stoat rejects the request (e.g. missing Manage Customisation) and
 * responds with an error body instead, since revolt-api's request wrapper
 * never checks the HTTP status before treating the body as success. Calling
 * the endpoint directly and validating the response ourselves turns that
 * crash into an actual, actionable per-item failure reason.
 *
 * @param  {Object} opts — { client, server, autumnId, name }
 * @return {Promise<string>} the created emoji's id
 */
async function defaultCreateEmoji({ client, server, autumnId, name }) {
  const response = await client.api.put(`/custom/emoji/${autumnId}`, {
    parent: { type: "Server", id: server.id },
    name,
  });
  if (typeof response?._id !== "string" || !response._id) {
    throw new Error(describeEmojiCreateFailure(response));
  }
  return response._id;
}

function describeEmojiCreateFailure(response) {
  const hint = "Check the bot has Manage Customisation on the hub server.";
  if (response?.type) {
    const detail = response.permission ? `: ${response.permission}` : "";
    return `Stoat rejected the emoji (${response.type}${detail}). ${hint}`;
  }
  return `Stoat did not return a created emoji id. ${hint}`;
}

function emptySummary(error, { serverId = null, serverName = null } = {}) {
  return {
    ok: false,
    error,
    serverId,
    serverName,
    created: [],
    reused: [],
    skipped: [],
    failed: [],
    capacity: { used: 0, limit: DEFAULT_MAX_SERVER_EMOJI },
  };
}

/**
 * Derive a flat { keyword -> ":ULID:" } map from a registry's entries
 * object, without touching the real store — keeps this pure/testable
 * regardless of the injected saveRegistry.
 */
function deriveEmojiMap(entries) {
  const map = {};
  for (const [keyword, entry] of Object.entries(entries)) {
    if (typeof entry?.emojiId === "string" && entry.emojiId) {
      map[keyword] = `:${entry.emojiId}:`;
    }
  }
  return map;
}

/**
 * Provision every manifest icon missing from the hub server. Never throws —
 * hub-resolution failures (no server id, bot not in that server, emoji list
 * unreadable) come back as {ok:false, error}; every other failure is
 * per-item and lands in the returned `failed`/`skipped` arrays instead.
 *
 * @param {Object}   opts
 * @param {Object}   opts.client         — a logged-in revolt.js Client
 * @param {string}   [opts.serverId]     — defaults to CONFIG.emojiHubServerId
 * @param {Array}    [opts.manifest]     — defaults to EMOJI_ICON_MANIFEST
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.uploadImpl]     — defaults to uploadAttachmentBytes
 * @param {Function} [opts.createEmojiImpl] — defaults to defaultCreateEmoji
 * @param {Function} [opts.loadRegistry]   — defaults to store.loadEmojiRegistry
 * @param {Function} [opts.saveRegistry]   — defaults to store.saveEmojiRegistry
 * @param {number}   [opts.maxServerEmoji]
 * @param {number}   [opts.maxIconBytes]
 * @param {Console}  [opts.logger]
 * @return {Promise<Object>} summary — see the module doc comment for shape
 */
export async function provisionEmoji({
  client,
  serverId = CONFIG.emojiHubServerId,
  manifest = EMOJI_ICON_MANIFEST,
  fetchImpl = fetch,
  uploadImpl = uploadAttachmentBytes,
  createEmojiImpl = defaultCreateEmoji,
  loadRegistry = loadEmojiRegistry,
  saveRegistry = saveEmojiRegistry,
  maxServerEmoji = DEFAULT_MAX_SERVER_EMOJI,
  maxIconBytes = DEFAULT_MAX_ICON_BYTES,
  logger = console,
} = {}) {
  if (!serverId || !isSafeId(serverId)) {
    return emptySummary("hub_not_configured");
  }

  const server = client?.servers?.get?.(serverId);
  if (!server) {
    return emptySummary("hub_not_found", { serverId });
  }

  const serverName = server.name ?? null;
  let existingByName;
  try {
    const existingEmoji = (await server.fetchEmojis()) ?? [];
    existingByName = new Map(
      existingEmoji.filter((e) => e?.name).map((e) => [e.name, e.id])
    );
  } catch (err) {
    logger?.warn?.(
      `emoji-provision: could not list existing emoji: ${err?.message || err}`
    );
    return emptySummary("fetch_emojis_failed", { serverId, serverName });
  }

  const created = [];
  const reused = [];
  const skipped = [];
  const failed = [];

  const registry = loadRegistry();
  const entries = { ...(registry?.entries ?? {}) };

  const toCreate = [];
  for (const item of manifest) {
    const existingId = existingByName.get(item.name);
    if (existingId) {
      reused.push(item.name);
      entries[item.keyword] = {
        emojiId: existingId,
        name: item.name,
        iconUrl: item.url,
        provisionedAt: entries[item.keyword]?.provisionedAt ?? Date.now(),
      };
    } else {
      toCreate.push(item);
    }
  }

  // Capacity pre-flight: ascending tier first (currency before consumables),
  // drop whatever doesn't fit as skipped rather than failing them.
  const budget = Math.max(0, maxServerEmoji - existingByName.size);
  const byTier = [...toCreate].sort((a, b) => (a.tier ?? 99) - (b.tier ?? 99));
  const withinBudget = byTier.slice(0, budget);
  for (const item of byTier.slice(budget)) {
    skipped.push({ name: item.name, reason: "server_emoji_limit" });
  }

  const autumnUrl = client?.configuration?.features?.autumn?.url;
  const authenticationHeader = client?.authenticationHeader;

  // Sequential, not parallel — this is a write path against a
  // rate-limited API, and one broken icon must not race the next upload.
  for (const item of withinBudget) {
    try {
      const res = await fetchImpl(item.url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res?.ok) {
        // Include the status so a blocked/challenged host (403) reads
        // differently from a simply-renamed file (404) in the report.
        const status = Number.isInteger(res?.status) ? res.status : "?";
        failed.push({
          name: item.name,
          reason: `download_failed (HTTP ${status})`,
        });
        continue;
      }

      const contentType = res.headers?.get?.("content-type") || "";
      if (contentType && !contentType.startsWith("image/")) {
        skipped.push({ name: item.name, reason: "not_an_image" });
        continue;
      }

      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0) {
        failed.push({
          name: item.name,
          reason: "download_failed (empty body)",
        });
        continue;
      }
      if (bytes.length > maxIconBytes) {
        skipped.push({ name: item.name, reason: "too_large" });
        continue;
      }

      const autumnId = await uploadImpl({
        bytes,
        filename: `${item.name}.png`,
        contentType: contentType || "image/png",
        autumnUrl,
        authenticationHeader,
        bucket: "emojis",
        fetchImpl,
      });

      const emojiId = await createEmojiImpl({
        client,
        server,
        autumnId,
        name: item.name,
      });
      created.push(item.name);
      entries[item.keyword] = {
        emojiId,
        name: item.name,
        iconUrl: item.url,
        provisionedAt: Date.now(),
      };
    } catch (err) {
      failed.push({
        name: item.name,
        reason: err?.message || "provision_failed",
      });
      logger?.warn?.(
        `emoji-provision: ${item.name} failed: ${err?.message || err}`
      );
    }
  }

  saveRegistry({ version: 1, serverId, updatedAt: Date.now(), entries });
  const applied = setCustomEmojiRegistry(deriveEmojiMap(entries));
  logger?.log?.(
    `emoji-provision: ${applied} keyword(s) now mapped to custom emoji (server=${serverId})`
  );

  return {
    ok: true,
    error: null,
    serverId,
    serverName,
    created,
    reused,
    skipped,
    failed,
    capacity: {
      used: existingByName.size + created.length,
      limit: maxServerEmoji,
    },
  };
}

// ── Headless CLI ────────────────────────────────────
// `node emoji-provision.js` / `npm run emoji:provision` — logs in on its
// own, provisions once, then disconnects. Mirrors emergency-lockdown.js.
async function runCli() {
  const { Client } = await import("revolt.js");
  if (typeof globalThis.WebSocket === "undefined") {
    const { WebSocket } = await import("ws");
    globalThis.WebSocket = WebSocket;
  }

  if (!CONFIG.token) {
    throw new Error("BOT_TOKEN is not configured.");
  }
  if (!CONFIG.emojiHubServerId) {
    throw new Error("EMOJI_HUB_SERVER_ID is not configured.");
  }

  const client = new Client();
  await new Promise((resolve, reject) => {
    client.once("ready", resolve);
    client.once("error", reject);
    client.loginBot(CONFIG.token).catch(reject);
  });

  try {
    const summary = await provisionEmoji({ client });
    if (!summary.ok) {
      console.error(`❌ Provisioning failed: ${summary.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `✅ Provisioned ${summary.serverName ?? summary.serverId}: ` +
        `${summary.created.length} created, ${summary.reused.length} reused, ` +
        `${summary.skipped.length} skipped, ${summary.failed.length} failed ` +
        `(${summary.capacity.used}/${summary.capacity.limit} emoji used).`
    );
    for (const item of summary.failed) {
      console.warn(`   ✖ ${item.name}: ${item.reason}`);
    }
    for (const item of summary.skipped) {
      console.warn(`   ⚠️ ${item.name}: ${item.reason}`);
    }
  } finally {
    client.websocket?.disconnect?.();
  }
}

const isMainModule =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runCli().catch((error) => {
    console.error(`❌ ${error?.message || error}`);
    process.exitCode = 1;
  });
}
