// api.js — Fetches codes from multiple sources
// ────────────────────────────────────────────────
import {
  CONFIG,
  GAMES,
  GAME8_SOURCES,
  HI3_SOURCES,
  NTE_SOURCE,
  WUWA_SOURCE,
  getEmojiMap,
} from "./config.js";
import { getSourceCache, setSourceCache } from "./store.js";

/**
 * Fetch active codes for a given game.
 * Routes to the correct source based on game config.
 *
 * @param  {string} gameKey — one of the keys in GAMES
 * @return {Promise<Array>} — array of normalised code objects
 */
export async function fetchCodes(gameKey) {
  const game = GAMES[gameKey];
  if (!game) throw new Error(`Unknown game key: ${gameKey}`);

  // HI3 uses a multi-source fallback chain
  if (game.source === "hi3_multi") {
    return fetchHI3Codes();
  }

  // NTE and WuWa are scraped from Game8 with independent one-hour caches.
  if (game.source === "game8") {
    return fetchGame8Codes(gameKey);
  }

  // All other games use seria's hoyo-codes API
  return fetchFromSeria(game.apiParam);
}

// ═══════════════════════════════════════════════════
//  Source: seria (hoyo-codes.seria.moe)
// ═══════════════════════════════════════════════════

async function fetchFromSeria(apiParam) {
  const url = `${CONFIG.hoyoApiBase}?game=${apiParam}`;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Seria API returned ${res.status}`);
  }

  const data = await res.json();
  const codes = Array.isArray(data) ? data : (data.codes ?? data.data ?? []);
  return codes.map(normalise);
}

// ═══════════════════════════════════════════════════
//  Source: HI3 multi-source fallback
// ═══════════════════════════════════════════════════

async function fetchHI3Codes() {
  const errors = [];

  for (const source of HI3_SOURCES) {
    try {
      console.log(`   [HI3] Trying source: ${source.name}`);
      let codes;

      if (source.type === "json") {
        codes = await fetchJSON(source.url);
      } else if (source.type === "wiki") {
        codes = await fetchFromFandomWiki(source.url);
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
async function fetchJSON(url) {
  const res = await fetch(url, {
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
  return arr.map((item) => {
    // ennead returns rewards as an array of strings — join them
    const rewards = Array.isArray(item.rewards)
      ? item.rewards.join(", ")
      : item.rewards;
    return normalise({ ...item, rewards });
  });
}

/**
 * Scrape the Fandom Wiki Exchange_Rewards page for active HI3 codes.
 *
 * The wiki page has tables with codes. We look for the "Active" section
 * and extract code strings from table cells.
 */
async function fetchFromFandomWiki(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "text/html",
      "User-Agent": "HoyoFetch-Bot/1.0 (Revolt code fetcher)",
    },
    signal: AbortSignal.timeout(20_000),
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
  const parts = (rewardBlocks.length ? rewardBlocks : fallback)
    .map(htmlToText)
    .map((part) => part.replace(/^・\s*/, "").trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.join(", ") : null;
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
    rewards: raw.rewards ?? raw.reward ?? raw.Rewards ?? null,
    date: raw.date ?? raw.added_at ?? raw.Date ?? null,
    source: raw.source ?? raw.Source ?? null,
  };
}

/**
 * Enrich the reward string with emoji from the active emoji map.
 */
export function formatRewards(rawRewards, _gameKey) {
  const emojiMap = getEmojiMap();

  if (!rawRewards || rawRewards.trim() === "") {
    return "_Reward details unavailable — check in-game mail after redeeming._";
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
