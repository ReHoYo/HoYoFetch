// api.js — Fetches codes from multiple sources
// ────────────────────────────────────────────────
import { CONFIG, GAMES, HI3_SOURCES, getEmojiMap } from "./config.js";

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
  const codes = Array.isArray(data) ? data : data.codes ?? data.data ?? [];
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
  const arr = data.active ?? (Array.isArray(data) ? data : data.codes ?? data.data ?? []);
  return arr.map((item) => {
    // ennead returns rewards as an array of strings — join them
    const rewards =
      Array.isArray(item.rewards) ? item.rewards.join(", ") : item.rewards;
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
//  Normalisation & reward formatting
// ═══════════════════════════════════════════════════

function normalise(raw) {
  return {
    code: String(raw.code ?? raw.Code ?? "").trim().toUpperCase(),
    rewards: raw.rewards ?? raw.reward ?? raw.Rewards ?? null,
    date: raw.date ?? raw.added_at ?? raw.Date ?? null,
    source: raw.source ?? raw.Source ?? null,
  };
}

/**
 * Enrich the reward string with emoji from the active emoji map.
 */
export function formatRewards(rawRewards, gameKey) {
  const emojiMap = getEmojiMap();

  if (!rawRewards || rawRewards.trim() === "") {
    return "_Reward details unavailable — check in-game mail after redeeming._";
  }

  // Limit input length to prevent ReDoS on maliciously crafted API responses
  const safeRewards = rawRewards.length > 500 ? rawRewards.slice(0, 500) : rawRewards;

  // Clean up messy reward strings from APIs
  let cleaned = cleanRewards(safeRewards);

  // Add emoji before matching keywords
  for (const [keyword, emoji] of Object.entries(emojiMap)) {
    const regex = new RegExp(`(${escapeRegex(keyword)})`, "gi");
    cleaned = cleaned.replace(regex, `${emoji} $1`);
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
  return raw
    // Split on semicolons, clean each part, rejoin with commas
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      return part
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
        .trim();
    })
    .join(", ");
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
