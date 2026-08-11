// api.js — Fetches codes from multiple sources
// ────────────────────────────────────────────────
import {
  CONFIG,
  GAMES,
  GAME8_SOURCES,
  HI3_SOURCES,
  NTE_SOURCE,
  REWARD_BACKFILL_SOURCES,
  WUWA_SOURCE,
  getEmojiMap,
} from "./config.js";
import { getSourceCache, setSourceCache } from "./store.js";

/**
 * Fetch active codes for a given game.
 * Routes to the correct source based on game config, then best-effort
 * backfills reward text for any code the primary source left blank.
 *
 * @param  {string}   gameKey — one of the keys in GAMES
 * @param  {Object}   opts
 * @param  {number}   opts.now
 * @param  {Function} opts.fetchImpl
 * @param  {Function} opts.readCache
 * @param  {Function} opts.writeCache
 * @param  {boolean}  opts.backfill — set false to skip the backfill pass
 * @return {Promise<Array>} — array of normalised code objects
 */
export async function fetchCodes(
  gameKey,
  {
    now = Date.now(),
    fetchImpl = fetch,
    readCache = getSourceCache,
    writeCache = setSourceCache,
    backfill = true,
  } = {}
) {
  const game = GAMES[gameKey];
  if (!game) throw new Error(`Unknown game key: ${gameKey}`);

  let codes;
  if (game.source === "hi3_multi") {
    // HI3 uses a multi-source fallback chain
    codes = await fetchHI3Codes({ fetchImpl });
  } else if (game.source === "game8") {
    // NTE and WuWa are scraped from Game8 with independent one-hour caches.
    codes = await fetchGame8Codes(gameKey, {
      now,
      fetchImpl,
      readCache,
      writeCache,
    });
  } else {
    // All other games use seria's hoyo-codes API
    codes = await fetchFromSeria(game.apiParam, { fetchImpl });
  }

  if (!backfill) return codes;
  return backfillRewards(gameKey, codes, {
    now,
    fetchImpl,
    readCache,
    writeCache,
  });
}

// ═══════════════════════════════════════════════════
//  Source: seria (hoyo-codes.seria.moe)
// ═══════════════════════════════════════════════════

async function fetchFromSeria(apiParam, { fetchImpl = fetch } = {}) {
  const url = `${CONFIG.hoyoApiBase}?game=${apiParam}`;

  const res = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Seria API returned ${res.status}`);
  }

  const data = await res.json();
  const codes = Array.isArray(data) ? data : (data.codes ?? data.data ?? []);
  return codes.map((item) => normalise(item));
}

// ═══════════════════════════════════════════════════
//  Source: HI3 multi-source fallback
// ═══════════════════════════════════════════════════

async function fetchHI3Codes({ fetchImpl = fetch } = {}) {
  const errors = [];

  for (const source of HI3_SOURCES) {
    try {
      console.log(`   [HI3] Trying source: ${source.name}`);
      let codes;

      if (source.type === "json") {
        codes = await fetchJSON(source.url, fetchImpl);
      } else if (source.type === "wiki") {
        codes = await fetchFromFandomWiki(source.url, { fetchImpl });
      }

      if (codes && codes.length > 0) {
        console.log(`   [HI3] Got ${codes.length} codes from ${source.name}`);
        return codes;
      }

      console.log(`   [HI3] No codes from ${source.name}, trying next…`);
    } catch (err) {
      errors.push(`${source.name}: ${err.message}`);
      console.warn(`   [HI3] ${source.name} failed: ${err.message}`);
    }
  }

  // If all sources failed, throw with details
  if (errors.length > 0) {
    throw new Error(`All HI3 sources failed:\n${errors.join("\n")}`);
  }

  return [];
}

/**
 * Generic JSON fetch for any URL returning an array of code objects.
 */
async function fetchJSON(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  // Handle various response shapes:
  //   ennead API:  { active: [...], inactive: [...] }
  //   seria API:   [...] or { codes: [...] }
  const arr =
    data.active ??
    (Array.isArray(data) ? data : (data.codes ?? data.data ?? []));
  // normalise()'s reward coercion already handles ennead's array-of-strings
  // rewards field, so no ad-hoc join is needed here.
  return arr.map((item) => normalise(item));
}

/**
 * Scrape the Fandom Wiki Exchange_Rewards page for active HI3 codes.
 *
 * The wiki page has tables with codes. We look for the "Active" section
 * and extract code strings from table cells.
 */
async function fetchFromFandomWiki(
  url,
  { fetchImpl = fetch, timeoutMs = 20_000 } = {}
) {
  const res = await fetchImpl(url, {
    headers: {
      Accept: "text/html",
      "User-Agent": "HoyoFetch-Bot/1.0 (Revolt code fetcher)",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) throw new Error(`Wiki returned HTTP ${res.status}`);
  const html = await res.text();

  // ── Locate the "Active" section ──────────────────
  // Fandom uses:  <span class="mw-headline" id="Active">Active</span>
  //          and: <span class="mw-headline" id="Legacy">Legacy</span>
  const activeStart = html.indexOf('id="Active"');
  const legacyStart = html.indexOf('id="Legacy"');

  if (activeStart === -1) {
    console.warn("   [HI3] Could not find Active section on wiki page");
    return [];
  }

  const end = legacyStart > activeStart ? legacyStart : activeStart + 10000;
  const activeSection = html.slice(activeStart, end);

  const codes = [];

  // ── Strategy 1: Parse table rows ─────────────────
  // Target table has id="tpt-acticodes"
  // Each row: <td>Used?</td> <td><b>CODE</b></td> <td>Date</td> <td>Occasion</td> <td>Rewards</td>
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(activeSection)) !== null) {
    const row = rowMatch[1];

    // Extract all <td> cells
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(row)) !== null) {
      cells.push(cellMatch[1]);
    }

    // Need at least 2 cells (code is in 2nd column)
    if (cells.length < 2) continue;

    // Extract code from <b> tag in 2nd cell
    const codeMatch = cells[1].match(/<b>([A-Za-z0-9]+)<\/b>/);
    if (!codeMatch) continue;

    const code = codeMatch[1].trim().toUpperCase();
    if (code.length < 4) continue;

    // Extract rewards from 5th cell if present
    let rewards = null;
    if (cells.length >= 5) {
      // Rewards cell contains <b><a ...>ItemName</a>&nbsp;×Qty</b> patterns
      const rewardParts = [];
      const rewardRegex = /<b>([^<]*(?:<a[^>]*>[^<]*<\/a>[^<]*)*)\s*<\/b>/g;
      let rMatch;
      while ((rMatch = rewardRegex.exec(cells[4])) !== null) {
        // Strip HTML tags and clean up
        const text = rMatch[1]
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (text) rewardParts.push(text);
      }
      if (rewardParts.length > 0) {
        rewards = rewardParts.join(", ");
      }
    }

    if (!codes.some((c) => c.code === code)) {
      codes.push(normalise({ code, rewards, source: "Fandom Wiki" }));
    }
  }

  // ── Strategy 2: Fallback — any bold code-like strings ──
  if (codes.length === 0) {
    const boldRegex = /<b>([A-Za-z0-9]{6,25})<\/b>/g;
    let match;
    while ((match = boldRegex.exec(activeSection)) !== null) {
      const code = match[1].trim().toUpperCase();
      if (
        !["ACTIVE", "LEGACY", "SERVER", "GLOBAL", "REWARDS"].includes(code) &&
        !codes.some((c) => c.code === code)
      ) {
        codes.push(normalise({ code, rewards: null, source: "Fandom Wiki" }));
      }
    }
  }

  return codes;
}

// ═══════════════════════════════════════════════════
//  Reward backfill — fills in rewards a primary source left blank
// ═══════════════════════════════════════════════════
// A short timeout keeps a slow secondary source from doubling the
// user-visible latency of a /Fetch* command that otherwise would have
// resolved immediately.
const BACKFILL_TIMEOUT_MS = 8_000;

/**
 * Best-effort reward backfill. Only makes a network/cache call when at least
 * one code is missing rewards, and never rejects — a failure just leaves the
 * affected codes as they were.
 *
 * @param  {string} gameKey
 * @param  {Array}  codes — normalised code objects
 * @param  {Object} opts  — { now, fetchImpl, readCache, writeCache }
 * @return {Promise<Array>}
 */
async function backfillRewards(gameKey, codes, opts) {
  const missing = codes.filter((entry) => !entry.rewards);
  if (missing.length === 0) return codes;

  const source = REWARD_BACKFILL_SOURCES[gameKey];
  if (!source) return codes;

  try {
    const index = await getBackfillIndex(source, opts);
    if (!index) return codes;

    return codes.map((entry) => {
      if (entry.rewards) return entry;
      const filled = index[entry.code.trim().toUpperCase()];
      return filled ? { ...entry, rewards: filled } : entry;
    });
  } catch (err) {
    console.warn(`   [backfill] ${gameKey}: ${err.message}`);
    return codes;
  }
}

/**
 * Read-through cache for a backfill source's { CODE -> reward string } index,
 * following the same lastAttemptAt/lastSuccessAt protocol fetchGame8Codes
 * uses so a failing secondary source can't be hammered every fetch.
 */
async function getBackfillIndex(
  source,
  { now = Date.now(), fetchImpl = fetch, readCache, writeCache }
) {
  const cache = readCache(source.cacheKey) || {};
  const lastAttemptAt = Number(cache.lastAttemptAt) || 0;
  const hasCachedIndex =
    cache.rewardsByCode && typeof cache.rewardsByCode === "object";

  if (lastAttemptAt > 0 && now - lastAttemptAt < source.cacheTtlMs) {
    return hasCachedIndex ? cache.rewardsByCode : null;
  }

  // Write the attempt timestamp before the request so a hard failure still
  // rate-limits the next call.
  writeCache(source.cacheKey, { ...cache, lastAttemptAt: now });

  try {
    const rewardsByCode = await fetchBackfillIndex(source, fetchImpl);
    writeCache(source.cacheKey, {
      lastAttemptAt: now,
      lastSuccessAt: now,
      rewardsByCode,
    });
    return rewardsByCode;
  } catch (err) {
    if (hasCachedIndex) {
      console.warn(
        `   [backfill] ${source.name} refresh failed, using stale index: ${err.message}`
      );
      return cache.rewardsByCode;
    }
    throw err;
  }
}

async function fetchBackfillIndex(source, fetchImpl) {
  if (source.type === "wiki") {
    const codes = await fetchFromFandomWiki(source.url, {
      fetchImpl,
      timeoutMs: BACKFILL_TIMEOUT_MS,
    });
    return buildRewardIndex(codes);
  }

  const res = await fetchImpl(source.url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(BACKFILL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  const active = Array.isArray(data.active) ? data.active : [];
  const inactive = Array.isArray(data.inactive) ? data.inactive : [];
  // active wins on collision — build inactive first, overlay active on top.
  return buildRewardIndex([...inactive, ...active]);
}

/**
 * Build a { CODE -> reward string } index from raw source rows or already
 * normalise()'d entries (both shapes carry code/rewards fields).
 */
function buildRewardIndex(rows) {
  const index = {};
  for (const row of rows) {
    const code = String(row?.code ?? row?.Code ?? "")
      .trim()
      .toUpperCase();
    if (!code) continue;
    const rewards = normaliseRewards(
      row?.rewards ?? row?.reward ?? row?.Rewards ?? null
    );
    if (rewards) index[code] = rewards;
  }
  return index;
}

// ═══════════════════════════════════════════════════
//  Source: Game8 (Neverness to Everness and Wuthering Waves)
// ═══════════════════════════════════════════════════

export function fetchNTECodes(options = {}) {
  return fetchGame8Codes(NTE_SOURCE.gameKey, options);
}

export function fetchWuWaCodes(options = {}) {
  return fetchGame8Codes(WUWA_SOURCE.gameKey, options);
}

export async function fetchGame8Codes(
  gameKey,
  {
    now = Date.now(),
    fetchImpl = fetch,
    readCache = getSourceCache,
    writeCache = setSourceCache,
  } = {}
) {
  const source = GAME8_SOURCES[gameKey];
  if (!source) throw new Error(`Unknown Game8 game key: ${gameKey}`);

  const cache = readCache(source.cacheKey) || {};
  const lastAttemptAt = Number(cache.lastAttemptAt) || 0;
  const hasCachedCodes = Array.isArray(cache.codes);

  if (lastAttemptAt > 0 && now - lastAttemptAt < source.cacheTtlMs) {
    if (hasCachedCodes) {
      return cache.codes.map((entry) =>
        normalise(entry, { preserveCodeCase: true })
      );
    }
    throw new Error(
      `${source.logLabel} cache is empty and the Game8 retry window has not elapsed`
    );
  }

  writeCache(source.cacheKey, {
    ...cache,
    lastAttemptAt: now,
  });

  try {
    const codes = await scrapeGame8Codes(source, fetchImpl);
    writeCache(source.cacheKey, {
      lastAttemptAt: now,
      lastSuccessAt: now,
      codes,
    });
    return codes;
  } catch (err) {
    if (hasCachedCodes) {
      console.warn(
        `   [${source.logLabel}] Game8 failed, serving cached codes: ${err.message}`
      );
      return cache.codes.map((entry) =>
        normalise(entry, { preserveCodeCase: true })
      );
    }
    throw err;
  }
}

export async function scrapeGame8NTECodes(url, fetchImpl = fetch) {
  return scrapeGame8Codes({ ...NTE_SOURCE, url }, fetchImpl);
}

export async function scrapeGame8WuWaCodes(url, fetchImpl = fetch) {
  return scrapeGame8Codes({ ...WUWA_SOURCE, url }, fetchImpl);
}

async function scrapeGame8Codes(source, fetchImpl = fetch) {
  const res = await fetchImpl(source.url, {
    headers: {
      Accept: "text/html",
      "User-Agent": "HoyoFetch-Bot/1.0 (Revolt code fetcher)",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) throw new Error(`Game8 returned HTTP ${res.status}`);
  return parseGame8Codes(await res.text(), source);
}

export function parseGame8NTECodes(html) {
  return parseGame8Codes(html, NTE_SOURCE);
}

export function parseGame8WuWaCodes(html) {
  return parseGame8Codes(html, WUWA_SOURCE);
}

function parseGame8Codes(html, source) {
  const activeTables = getGame8ActiveCodesTables(html, source.parser);
  const codes = [];
  const seen = new Set();
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;

  for (const activeTable of activeTables) {
    rowRegex.lastIndex = 0;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(activeTable)) !== null) {
      const row = rowMatch[1];
      const code = extractGame8Code(row);
      const codeIdentity = getGame8CodeIdentity(code);
      if (!codeIdentity || seen.has(codeIdentity)) continue;

      const cells = extractTableCells(row);
      const rewards = extractGame8Rewards(row, cells);

      seen.add(codeIdentity);
      codes.push(
        normalise(
          {
            code: code.trim(),
            rewards,
            source: source.name,
          },
          { preserveCodeCase: true }
        )
      );
    }
  }

  return codes;
}

function getGame8ActiveCodesTables(html, parser) {
  if (parser === "wuwa") return getGame8WuWaActiveCodesTables(html);
  return [getGame8NTEActiveCodesTable(html)];
}

function getGame8NTEActiveCodesTable(html) {
  const activeStart = getPatternIndex(html, /All\s+Active\s+Redeem\s+Codes/i);
  if (activeStart === -1) {
    throw new Error("Could not find the Game8 active redeem codes section");
  }

  const activeEnd = getFirstPatternIndex(
    html,
    [
      /Neverness\s+to\s+Everness\s+Expired\s+Codes/i,
      /Expired\s+Neverness\s+to\s+Everness\s+Codes/i,
      /List\s+of\s+All\s+Expired\s+Redeem\s+Codes/i,
    ],
    activeStart + 1
  );
  const tableStart = html.indexOf("<table", activeStart);

  if (tableStart === -1 || (activeEnd !== -1 && tableStart > activeEnd)) {
    throw new Error("Could not find the Game8 active redeem codes table");
  }

  const tableEnd = html.indexOf("</table>", tableStart);
  if (tableEnd === -1) {
    throw new Error(
      "Could not find the end of the Game8 active redeem codes table"
    );
  }

  return html.slice(tableStart, tableEnd + "</table>".length);
}

function getGame8WuWaActiveCodesTables(html) {
  const activeStart = getHeadingIndex(html, 2, /Wuthering\s+Waves\s+Codes/i);
  if (activeStart === -1) {
    throw new Error("Could not find the Game8 Wuthering Waves codes section");
  }

  const activeEnd = Math.min(
    ...[
      getHeadingIndex(
        html,
        2,
        /How\s+to\s+Redeem\s+Wuthering\s+Waves\s+Codes/i,
        activeStart + 1
      ),
      getHeadingIndex(html, 2, /Expired\s+Redeem\s+Codes/i, activeStart + 1),
      html.length,
    ].filter((index) => index !== -1)
  );
  const section = html.slice(
    activeStart,
    activeEnd === -1 ? html.length : activeEnd
  );
  const tables = section.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) || [];

  if (tables.length === 0) {
    throw new Error(
      "Could not find the Game8 Wuthering Waves active code tables"
    );
  }

  return tables;
}

function extractGame8Code(rowHtml) {
  const preferred = extractGame8InputCode(rowHtml, {
    requireClipboardClass: true,
  });
  if (preferred) return preferred;

  const cells = extractTableCells(rowHtml);
  if (cells.length === 0) return null;
  const codeCell = cells[0] ?? rowHtml;
  const inputFallback = extractGame8InputCode(codeCell, {
    requireClipboardClass: false,
  });
  if (inputFallback) return inputFallback;

  return extractGame8TextCode(codeCell);
}

function extractGame8InputCode(html, { requireClipboardClass }) {
  const inputs = html.match(/<input\b[^>]*>/gi) || [];
  for (const input of inputs) {
    const className = getHtmlAttr(input, "class") || "";
    if (
      requireClipboardClass &&
      !className.split(/\s+/).includes("a-clipboard__textInput")
    ) {
      continue;
    }

    const value = getHtmlAttr(input, "value");
    if (!value) continue;

    const code = cleanGame8CodeCandidate(value);
    if (code) return code;
  }
  return null;
}

function extractGame8TextCode(cellHtml) {
  const ignored = new Set([
    "active",
    "code",
    "codes",
    "copied",
    "copy",
    "date",
    "expired",
    "expiry",
    "new",
    "redeem",
    "rewards",
    "still",
    "tba",
  ]);
  const text = htmlToText(cellHtml);
  const candidates = text.match(/[A-Za-z0-9][A-Za-z0-9_-]{3,40}/g) || [];

  for (const candidate of candidates) {
    if (ignored.has(candidate.toLowerCase())) continue;
    const code = cleanGame8CodeCandidate(candidate);
    if (code) return code;
  }

  return null;
}

function cleanGame8CodeCandidate(value) {
  const code = decodeHtml(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{3,40}$/.test(code)) return null;
  return code;
}

function getGame8CodeIdentity(code) {
  return typeof code === "string" ? code.trim().toUpperCase() : "";
}

function extractTableCells(rowHtml) {
  const cells = [];
  const cellRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let match;
  while ((match = cellRegex.exec(rowHtml)) !== null) {
    cells.push(match[1]);
  }
  return cells;
}

function extractGame8Rewards(rowHtml, cells) {
  const rewardBlocks =
    rowHtml.match(
      /<div\b[^>]*class=['"][^'"]*\balign\b[^'"]*['"][^>]*>[\s\S]*?<\/div>/gi
    ) || [];
  const fallback = cells.length >= 2 ? [cells[1]] : [];
  const blocks = rewardBlocks.length ? rewardBlocks : fallback;

  const parts = blocks
    .map(htmlToText)
    .map((part) => part.replace(/^・\s*/, "").trim())
    .filter(Boolean);

  if (parts.length > 0) return parts.join(", ");

  // Icon-only reward cells have no visible item name — the only signal left
  // is each <img>'s alt/title text. Only tried once normal text extraction
  // finds nothing, so blocks with visible text (the common case) never see
  // this path or its output.
  const iconParts = blocks.flatMap(extractImageAltTexts).filter(Boolean);
  return iconParts.length > 0 ? iconParts.join(", ") : null;
}

function extractImageAltTexts(html) {
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  return imgs
    .map((tag) => getHtmlAttr(tag, "alt") || getHtmlAttr(tag, "title") || "")
    .map((alt) =>
      decodeHtml(alt)
        .replace(/\s+(Image|Icon)$/i, "")
        .trim()
    )
    .filter(Boolean);
}

function getHtmlAttr(tag, name) {
  const attrRegex = new RegExp(
    `${name}\\s*=\\s*(?:(")([\\s\\S]*?)"|(')([\\s\\S]*?)'|([^\\s"'=<>]+))`,
    "i"
  );
  const match = tag.match(attrRegex);
  return match?.[2] ?? match?.[4] ?? match?.[5] ?? null;
}

function htmlToText(html) {
  return decodeHtml(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/・/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(text) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (key.startsWith("#x")) {
      return String.fromCodePoint(parseInt(key.slice(2), 16));
    }
    if (key.startsWith("#")) {
      return String.fromCodePoint(parseInt(key.slice(1), 10));
    }
    return named[key] ?? match;
  });
}

function getPatternIndex(text, pattern, start = 0) {
  pattern.lastIndex = 0;
  const match = pattern.exec(text.slice(start));
  return match ? start + match.index : -1;
}

function getFirstPatternIndex(text, patterns, start = 0) {
  const matches = patterns
    .map((pattern) => getPatternIndex(text, pattern, start))
    .filter((idx) => idx !== -1);
  return matches.length > 0 ? Math.min(...matches) : -1;
}

function getHeadingIndex(html, level, textPattern, start = 0) {
  const headingRegex = new RegExp(
    `<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`,
    "gi"
  );
  headingRegex.lastIndex = start;

  let match;
  while ((match = headingRegex.exec(html)) !== null) {
    textPattern.lastIndex = 0;
    if (textPattern.test(htmlToText(match[1]))) return match.index;
  }

  return -1;
}

// ═══════════════════════════════════════════════════
//  Normalisation & reward formatting
// ═══════════════════════════════════════════════════

function normalise(raw, { preserveCodeCase = false } = {}) {
  const code = String(raw.code ?? raw.Code ?? "").trim();
  return {
    code: preserveCodeCase ? code : code.toUpperCase(),
    rewards: normaliseRewards(raw.rewards ?? raw.reward ?? raw.Rewards ?? null),
    date: raw.date ?? raw.added_at ?? raw.Date ?? null,
    source: raw.source ?? raw.Source ?? null,
  };
}

/**
 * Coerce a reward value of unknown shape — string, array of strings, array
 * of {name,count}-ish objects, number, or null — into a clean display string
 * or null. Every source funnels through this via `normalise`, so downstream
 * code can always treat `entry.rewards` as "non-empty trimmed string or
 * null", never "" and never a non-string (the source of a long-standing
 * TypeError when an API returned an array here).
 *
 * @param  {*} value
 * @return {string|null}
 */
export function normaliseRewards(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === "number" || typeof value === "bigint") {
    return cleanRewardText(String(value));
  }

  if (Array.isArray(value)) {
    const parts = value.map(normaliseRewardItem).filter(Boolean);
    return parts.length > 0 ? cleanRewardText(parts.join(", ")) : null;
  }

  if (typeof value === "string") {
    return cleanRewardText(value);
  }

  if (typeof value === "object") {
    const part = normaliseRewardItem(value);
    return part ? cleanRewardText(part) : null;
  }

  return null;
}

/**
 * Coerce a single reward element (string, number, or a {name,count}-shaped
 * object) into a display fragment. Returns "" when nothing usable is present.
 */
function normaliseRewardItem(item) {
  if (typeof item === "string") return item;
  if (typeof item === "number" || typeof item === "bigint") return String(item);
  if (!item || typeof item !== "object") return "";

  const name = item.name ?? item.item ?? item.title;
  const count = item.count ?? item.amount ?? item.quantity ?? item.num;
  if (typeof name !== "string" || !name.trim()) return "";

  return count !== undefined && count !== null && Number.isFinite(Number(count))
    ? `${name.trim()} ×${count}`
    : name.trim();
}

/**
 * Strip control characters and collapse whitespace left over from a coerced
 * reward value, returning null (not "") once trimmed to empty — the tail
 * every normaliseRewards() branch shares.
 */
function cleanRewardText(text) {
  const cleaned = text
    // eslint-disable-next-line no-control-regex -- stripping stray control bytes from third-party API text
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

/**
 * Enrich the reward string with emoji from the active emoji map. When no
 * reward text is available, point at the game's human-readable code article
 * instead of a dead end.
 *
 * @param  {string|null} rawRewards
 * @param  {string}      gameKey
 * @param  {Object}      opts
 * @param  {boolean}     opts.includeArticleLink — set false to keep the
 *   fallback line short (used for every rewardless code after the first in
 *   a batch, so a 10-code embed can't blow the 2000-char description cap)
 * @return {string}
 */
export function formatRewards(
  rawRewards,
  gameKey,
  { includeArticleLink = true } = {}
) {
  const emojiMap = getEmojiMap();

  if (
    !rawRewards ||
    (typeof rawRewards === "string" && rawRewards.trim() === "")
  ) {
    const game = GAMES[gameKey];
    if (includeArticleLink && game?.codesArticleUrl) {
      return `_Rewards not listed by this source — see the [${game.name} code list](${game.codesArticleUrl})._`;
    }
    return "_Rewards not listed by this source._";
  }

  // Limit input length to prevent ReDoS on maliciously crafted API responses
  const safeRewards =
    rawRewards.length > 500 ? rawRewards.slice(0, 500) : rawRewards;

  // Clean up messy reward strings from APIs
  let cleaned = cleanRewards(safeRewards);

  const emojiEntries = Object.entries(emojiMap)
    .filter(([, emoji]) => emoji)
    .sort(([a], [b]) => b.length - a.length);

  // Add emoji before matching reward keywords. One pass avoids double-tagging
  // phrases such as "Beetle Coin" with both "beetle coin" and "coin".
  if (emojiEntries.length > 0) {
    const emojiByKeyword = new Map(
      emojiEntries.map(([keyword, emoji]) => [keyword.toLowerCase(), emoji])
    );
    const keywordPattern = emojiEntries
      .map(([keyword]) => escapeRegex(keyword))
      .join("|");
    const regex = new RegExp(
      `(^|[^A-Za-z0-9])(${keywordPattern})(?=$|[^A-Za-z0-9])`,
      "gi"
    );
    cleaned = cleaned.replace(regex, (full, prefix, keyword) => {
      return `${prefix}${emojiByKeyword.get(keyword.toLowerCase())} ${keyword}`;
    });
  }

  return cleaned;
}

/**
 * Clean up messy reward strings from various API sources.
 * Examples:
 *   "Hero's Wit3"             → "Hero's Wit ×3"
 *   "Teachings of Freedom*3"  → "Teachings of Freedom ×3"
 *   "Mora;Primogem*60"        → "Mora, Primogem ×60"
 *   "Crystals x60"            → "Crystals ×60"
 */
function cleanRewards(raw) {
  return (
    raw
      // Split on semicolons, clean each part, rejoin with commas
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        return (
          part
            // "ItemName*3" → "ItemName ×3"
            .replace(/\*(\d+)/g, " ×$1")
            // "x60" or "X60" or " x 60" → " ×60"
            .replace(/\bx\s*(\d+)/gi, "×$1")
            // "ItemName3" (letter/quote followed by digits at end) → "ItemName ×3"
            .replace(/([a-zA-Z)'])(\d+)$/g, "$1 ×$2")
            // Normalise "× 3" or "×  3" → "×3"
            .replace(/×\s+/g, "×")
            // Ensure space before ×
            .replace(/(\S)×/g, "$1 ×")
            .trim()
        );
      })
      .join(", ")
  );
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
