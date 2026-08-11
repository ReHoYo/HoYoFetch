import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchCodes,
  fetchNTECodes,
  fetchWuWaCodes,
  formatRewards,
  normaliseRewards,
  parseGame8NTECodes,
  parseGame8WuWaCodes,
} from "../api.js";
import { detectFreshCodes } from "../store.js";

const NOW = 1_800_000_000_000;
const ONE_HOUR_MS = 60 * 60 * 1000;

const game8Fixture = `
  <h3 class='a-header--3'>All Active Redeem Codes</h3>
  <table class='a-table'>
    <tr>
      <th>Redeem Code</th>
      <th>Rewards</th>
    </tr>
    <tr>
      <td class="center">
        <div class='a-clipboard__container'>
          <input type='text' class='a-clipboard__textInput' value='NTEvtuber200' readonly>
          <button class='a-clipboard__copyButton'>Copy</button>
          <div class='a-clipboard__copyMessage'>Copied</div>
        </div>
        <span class="gameNav__icon gameNav__icon--new">NEW</span><br>
        <span class='a-red'>Expiry Date: TBA</span>
      </td>
      <td>
        <div class='align'>・<a class='a-link'><img alt='Fons Image'> Fons</a> x10,000</div>
        <div class='align'>・<a class='a-link'><img alt='Beetle Coin Image'> Beetle Coin</a> x10,000</div>
      </td>
    </tr>
    <tr>
      <td class="center">
        <input type='text' class='a-clipboard__textInput' value='NTEFREE' readonly>
      </td>
      <td>
        <div class='align'>・<a class='a-link'>Fons</a> x30,000</div>
      </td>
    </tr>
    <tr>
      <td class="center">
        <input type='text' class='a-clipboard__textInput' value='ntefree' readonly>
      </td>
      <td>
        <div class='align'>・Duplicate reward x1</div>
      </td>
    </tr>
  </table>
  <h2 class='a-header--2'>Neverness to Everness Expired Codes</h2>
  <table class='a-table'>
    <tr>
      <td><input type='text' class='a-clipboard__textInput' value='NTEEXPIRED' readonly></td>
      <td><div class='align'>・Expired Reward x1</div></td>
    </tr>
  </table>
`;

const textFallbackFixture = `
  <h3>All Active Redeem Codes</h3>
  <table class='a-table'>
    <tr>
      <th>Redeem Code</th>
      <th>Rewards</th>
    </tr>
    <tr>
      <td class="center">
        <button>Copy</button>
        <strong>RaceNoLimit</strong>
        <span>NEW</span>
        <span>Expiry Date: TBA</span>
      </td>
      <td>
        <div class='align'>・Elite Hunter Guide x2</div>
      </td>
    </tr>
  </table>
  <h2>Expired Neverness to Everness Codes</h2>
  <table>
    <tr>
      <td><strong>NTEEXPIREDTEXT</strong></td>
      <td>Expired Reward x1</td>
    </tr>
  </table>
`;

const game8WuWaFixture = `
  <h2 class='a-header--2'>Wuthering Waves Codes</h2>
  <h3 class='a-header--3'>Limited-Time Collaboration Code</h3>
  <table class='a-table'>
    <tr><th>Limited-Time Code</th></tr>
    <tr>
      <td>
        <div class='a-clipboard__container'>
          <input type='text' class='a-clipboard__textInput' value='F5F4D3B2A2' readonly>
          <div class='a-clipboard__copyMessage'>Copied</div>
        </div>
        <b>Expiry:</b> August 19, 2026
        <div class='align'><a>Escape from Duckov Collab Livery</a> x1</div>
      </td>
    </tr>
  </table>
  <h3 class='a-header--3'>All Active Codes</h3>
  <table class='a-table'>
    <tr><th>All Active Code(s)</th></tr>
    <tr>
      <td>
        <input type='text' class='a-clipboard__textInput' value='WUTHERINGGIFT' readonly>
        <div class='align'><a>Astrite</a> x50</div>
        <div class='align'><a>Premium Resonance Potion</a> x2</div>
        <div class='align'><a>Shell Credit</a> x15,000</div>
      </td>
    </tr>
    <tr>
      <td>
        <input type='text' class='a-clipboard__textInput' value='wutheringgift' readonly>
        <div class='align'>Duplicate Reward x1</div>
      </td>
    </tr>
  </table>
  <h2 class='a-header--2'>How to Redeem Wuthering Waves Codes</h2>
  <p>Use the Redemption Code feature in-game.</p>
  <h2 class='a-header--2'>Expired Redeem Codes</h2>
  <table class='a-table'>
    <tr>
      <td>
        <input type='text' class='a-clipboard__textInput' value='WUWAEXPIRED' readonly>
        <div class='align'>Expired Reward x1</div>
      </td>
    </tr>
  </table>
`;

test("parseGame8NTECodes extracts active codes, dedupes casing, and ignores expired codes", () => {
  const codes = parseGame8NTECodes(game8Fixture);

  assert.deepEqual(
    codes.map((entry) => entry.code),
    ["NTEvtuber200", "NTEFREE"]
  );
  assert.equal(codes[0].rewards, "Fons x10,000, Beetle Coin x10,000");
  assert.equal(codes[1].rewards, "Fons x30,000");
  assert.equal(codes[0].source, "Game8");
  assert.ok(!codes.some((entry) => entry.code === "NTEEXPIRED"));
});

test("parseGame8NTECodes falls back to code-cell text when input markup changes", () => {
  const codes = parseGame8NTECodes(textFallbackFixture);

  assert.deepEqual(
    codes.map((entry) => entry.code),
    ["RaceNoLimit"]
  );
  assert.equal(codes[0].rewards, "Elite Hunter Guide x2");
});

test("parseGame8WuWaCodes aggregates active tables and ignores expired codes", () => {
  const codes = parseGame8WuWaCodes(game8WuWaFixture);

  assert.deepEqual(
    codes.map((entry) => entry.code),
    ["F5F4D3B2A2", "WUTHERINGGIFT"]
  );
  assert.equal(codes[0].rewards, "Escape from Duckov Collab Livery x1");
  assert.equal(
    codes[1].rewards,
    "Astrite x50, Premium Resonance Potion x2, Shell Credit x15,000"
  );
  assert.ok(!codes.some((entry) => entry.code === "WUWAEXPIRED"));
});

test("detectFreshCodes treats Game8 codes as case-insensitive identities only", () => {
  assert.deepEqual(
    detectFreshCodes("nte", ["NTEFREE"], ["ntefree", "NTEBRANDNEW"]),
    ["NTEBRANDNEW"]
  );
  assert.deepEqual(
    detectFreshCodes(
      "wuwa",
      ["WUTHERINGGIFT"],
      ["wutheringgift", "WUWABRANDNEW"]
    ),
    ["WUWABRANDNEW"]
  );
  assert.deepEqual(
    detectFreshCodes("genshin", ["GENSHINCODE"], ["genshincode"]),
    ["genshincode"]
  );
});

test("fetchNTECodes returns fresh cache without fetching Game8", async () => {
  let fetchCount = 0;
  const cache = {
    nte: {
      lastAttemptAt: NOW - 1_000,
      lastSuccessAt: NOW - 1_000,
      codes: [
        { code: "NTEvtuber200", rewards: "Fons x10,000", source: "Game8" },
      ],
    },
  };

  const codes = await fetchNTECodes({
    now: NOW,
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("should not fetch");
    },
    readCache: (key) => cache[key],
    writeCache: (key, entry) => {
      cache[key] = entry;
    },
  });

  assert.equal(fetchCount, 0);
  assert.deepEqual(
    codes.map((entry) => entry.code),
    ["NTEvtuber200"]
  );
});

test("fetchNTECodes refreshes stale cache and stores successful results", async () => {
  const cache = {
    nte: {
      lastAttemptAt: NOW - ONE_HOUR_MS - 1,
      lastSuccessAt: NOW - ONE_HOUR_MS - 1,
      codes: [{ code: "OLDNTE", rewards: null, source: "Game8" }],
    },
  };
  let fetchCount = 0;

  const codes = await fetchNTECodes({
    now: NOW,
    fetchImpl: async () => {
      fetchCount += 1;
      return {
        ok: true,
        text: async () => game8Fixture,
      };
    },
    readCache: (key) => cache[key],
    writeCache: (key, entry) => {
      cache[key] = entry;
    },
  });

  assert.equal(fetchCount, 1);
  assert.deepEqual(
    codes.map((entry) => entry.code),
    ["NTEvtuber200", "NTEFREE"]
  );
  assert.equal(cache.nte.lastAttemptAt, NOW);
  assert.equal(cache.nte.lastSuccessAt, NOW);
  assert.deepEqual(
    cache.nte.codes.map((entry) => entry.code),
    ["NTEvtuber200", "NTEFREE"]
  );
});

test("fetchNTECodes serves stale cache when Game8 refresh fails", async () => {
  const cache = {
    nte: {
      lastAttemptAt: NOW - ONE_HOUR_MS - 1,
      lastSuccessAt: NOW - ONE_HOUR_MS - 1,
      codes: [{ code: "NTESTALE", rewards: "Cached reward", source: "Game8" }],
    },
  };

  const codes = await fetchNTECodes({
    now: NOW,
    fetchImpl: async () => ({
      ok: false,
      status: 503,
    }),
    readCache: (key) => cache[key],
    writeCache: (key, entry) => {
      cache[key] = entry;
    },
  });

  assert.deepEqual(
    codes.map((entry) => entry.code),
    ["NTESTALE"]
  );
  assert.equal(cache.nte.lastAttemptAt, NOW);
});

test("fetchNTECodes surfaces errors when Game8 fails without cache", async () => {
  const cache = {};

  await assert.rejects(
    fetchNTECodes({
      now: NOW,
      fetchImpl: async () => ({
        ok: false,
        status: 503,
      }),
      readCache: (key) => cache[key],
      writeCache: (key, entry) => {
        cache[key] = entry;
      },
    }),
    /Game8 returned HTTP 503/
  );

  assert.equal(cache.nte.lastAttemptAt, NOW);
});

test("fetchWuWaCodes returns fresh cache without fetching Game8", async () => {
  let fetchCount = 0;
  const cache = {
    wuwa: {
      lastAttemptAt: NOW - 1_000,
      lastSuccessAt: NOW - 1_000,
      codes: [
        { code: "WUTHERINGGIFT", rewards: "Astrite x50", source: "Game8" },
      ],
    },
  };

  const codes = await fetchWuWaCodes({
    now: NOW,
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("should not fetch");
    },
    readCache: (key) => cache[key],
    writeCache: (key, entry) => {
      cache[key] = entry;
    },
  });

  assert.equal(fetchCount, 0);
  assert.deepEqual(
    codes.map((entry) => entry.code),
    ["WUTHERINGGIFT"]
  );
});

test("fetchWuWaCodes refreshes only its own stale cache", async () => {
  const nteCache = {
    lastAttemptAt: 123,
    lastSuccessAt: 123,
    codes: [{ code: "NTEFREE", rewards: null, source: "Game8" }],
  };
  const cache = {
    nte: nteCache,
    wuwa: {
      lastAttemptAt: NOW - ONE_HOUR_MS - 1,
      lastSuccessAt: NOW - ONE_HOUR_MS - 1,
      codes: [{ code: "OLDWUWA", rewards: null, source: "Game8" }],
    },
  };

  const codes = await fetchWuWaCodes({
    now: NOW,
    fetchImpl: async () => ({
      ok: true,
      text: async () => game8WuWaFixture,
    }),
    readCache: (key) => cache[key],
    writeCache: (key, entry) => {
      cache[key] = entry;
    },
  });

  assert.deepEqual(
    codes.map((entry) => entry.code),
    ["F5F4D3B2A2", "WUTHERINGGIFT"]
  );
  assert.equal(cache.wuwa.lastAttemptAt, NOW);
  assert.equal(cache.wuwa.lastSuccessAt, NOW);
  assert.equal(cache.nte, nteCache);
});

test("fetchWuWaCodes serves stale cache when Game8 refresh fails", async () => {
  const cache = {
    wuwa: {
      lastAttemptAt: NOW - ONE_HOUR_MS - 1,
      lastSuccessAt: NOW - ONE_HOUR_MS - 1,
      codes: [{ code: "WUWASTALE", rewards: "Cached reward", source: "Game8" }],
    },
  };

  const codes = await fetchWuWaCodes({
    now: NOW,
    fetchImpl: async () => ({
      ok: false,
      status: 503,
    }),
    readCache: (key) => cache[key],
    writeCache: (key, entry) => {
      cache[key] = entry;
    },
  });

  assert.deepEqual(
    codes.map((entry) => entry.code),
    ["WUWASTALE"]
  );
  assert.equal(cache.wuwa.lastAttemptAt, NOW);
});

test("fetchWuWaCodes surfaces errors when Game8 fails without cache", async () => {
  const cache = {};

  await assert.rejects(
    fetchWuWaCodes({
      now: NOW,
      fetchImpl: async () => ({
        ok: false,
        status: 503,
      }),
      readCache: (key) => cache[key],
      writeCache: (key, entry) => {
        cache[key] = entry;
      },
    }),
    /Game8 returned HTTP 503/
  );

  assert.equal(cache.wuwa.lastAttemptAt, NOW);
});

// ═══════════════════════════════════════════════════
//  normaliseRewards / cleanRewards / formatRewards
// ═══════════════════════════════════════════════════

test("normaliseRewards coerces empty or blank input to null", () => {
  assert.equal(normaliseRewards(""), null);
  assert.equal(normaliseRewards("   "), null);
  assert.equal(normaliseRewards(null), null);
  assert.equal(normaliseRewards(undefined), null);
});

test("normaliseRewards joins an array of reward strings", () => {
  assert.equal(
    normaliseRewards(["Primogem ×60", "Adventurer's Experience ×5"]),
    "Primogem ×60, Adventurer's Experience ×5"
  );
});

test("normaliseRewards formats an array of {name,count}-shaped objects", () => {
  assert.equal(
    normaliseRewards([
      { name: "Mora", count: 10000 },
      { name: "Primogem", count: 60 },
    ]),
    "Mora ×10000, Primogem ×60"
  );
});

test("normaliseRewards drops values with nothing usable, and coerces numbers", () => {
  assert.equal(normaliseRewards([]), null);
  assert.equal(normaliseRewards([""]), null);
  assert.equal(normaliseRewards({}), null);
  assert.equal(normaliseRewards(true), null);
  assert.equal(normaliseRewards(60), "60");
});

test("normaliseRewards strips control characters and collapses whitespace", () => {
  assert.equal(normaliseRewards("Primogem  ×60\n\n×"), "Primogem ×60 ×");
});

test("fetchNTECodes coerces an array-valued cached reward instead of throwing (regression)", async () => {
  const cache = {
    nte: {
      lastAttemptAt: NOW - 1_000,
      lastSuccessAt: NOW - 1_000,
      codes: [
        {
          code: "NTEvtuber200",
          rewards: ["Fons ×10,000", "Beetle Coin ×10,000"],
          source: "Game8",
        },
      ],
    },
  };

  const codes = await fetchNTECodes({
    now: NOW,
    fetchImpl: async () => {
      throw new Error("should not fetch");
    },
    readCache: (key) => cache[key],
    writeCache: () => {},
  });

  assert.equal(codes[0].rewards, "Fons ×10,000, Beetle Coin ×10,000");
  assert.doesNotThrow(() => formatRewards(codes[0].rewards, "nte"));
});

test("formatRewards cleans reward text — item counts and separators", () => {
  assert.match(formatRewards("Hero's Wit3", "genshin"), /Hero's Wit ×3/);
  assert.match(
    formatRewards("Teachings of Freedom*3", "genshin"),
    /Teachings of Freedom ×3/
  );
  assert.match(
    formatRewards("Mora;Primogem*60", "genshin"),
    /Mora.*Primogem ×60/
  );
  assert.match(formatRewards("Crystals x60", "honkai3rd"), /Crystals ×60/);
  assert.match(
    formatRewards("Shell Credit x15,000", "wuwa"),
    /Shell Credit ×15,000/
  );
});

test("formatRewards links the game's code article when rewards are unavailable", () => {
  const text = formatRewards(null, "genshin");
  assert.match(text, /game8\.co\/games\/Genshin-Impact\/archives\/304759/);
  assert.doesNotMatch(text, /unavailable/i);
});

test("formatRewards omits the link when includeArticleLink is false", () => {
  const text = formatRewards(null, "genshin", { includeArticleLink: false });
  assert.doesNotMatch(text, /https?:\/\//);
});

test("formatRewards falls back to a terse line for an unknown game without throwing", () => {
  assert.doesNotThrow(() => formatRewards(null, "nosuchgame"));
  assert.doesNotMatch(formatRewards(null, "nosuchgame"), /https?:\/\//);
});

test("formatRewards links the Fandom wiki for Honkai Impact 3rd", () => {
  assert.match(
    formatRewards(null, "honkai3rd"),
    /honkaiimpact3\.fandom\.com\/wiki\/Exchange_Rewards/
  );
});

test("formatRewards still applies emoji decoration without double-tagging Beetle Coin", () => {
  assert.match(formatRewards("Primogem ×60", "genshin"), /💎 Primogem ×60/);
  const text = formatRewards("Beetle Coin x1", "nte");
  assert.equal((text.match(/🪙/g) || []).length, 1);
});

// ═══════════════════════════════════════════════════
//  Reward backfill (fetchCodes)
// ═══════════════════════════════════════════════════

test("fetchCodes skips the backfill network call when nothing is missing", async () => {
  let fetchCount = 0;
  const cache = {};

  const codes = await fetchCodes("genshin", {
    now: NOW,
    fetchImpl: async () => {
      fetchCount += 1;
      return {
        ok: true,
        json: async () => ({
          codes: [{ code: "ABC123", rewards: "Primogem*60" }],
        }),
      };
    },
    readCache: (key) => cache[key],
    writeCache: (key, entry) => {
      cache[key] = entry;
    },
  });

  assert.equal(fetchCount, 1);
  // normaliseRewards only coerces shape/whitespace; the "*3" → "×3" cleanup
  // happens later, at formatRewards() render time.
  assert.equal(codes[0].rewards, "Primogem*60");
});

test("fetchCodes backfills a blank reward from ennead's active list", async () => {
  const cache = {};

  const codes = await fetchCodes("genshin", {
    now: NOW,
    fetchImpl: async (url) => {
      if (String(url).includes("seria")) {
        return {
          ok: true,
          json: async () => ({
            codes: [{ code: "P7G0XA30H0Q3", rewards: "" }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          active: [
            {
              code: "P7G0XA30H0Q3",
              rewards: ["Primogem ×60", "Adventurer's Experience ×5"],
            },
          ],
          inactive: [],
        }),
      };
    },
    readCache: (key) => cache[key],
    writeCache: (key, entry) => {
      cache[key] = entry;
    },
  });

  assert.equal(codes[0].rewards, "Primogem ×60, Adventurer's Experience ×5");
});

test("fetchCodes backfill also matches ennead's inactive list", async () => {
  const cache = {};

  const codes = await fetchCodes("genshin", {
    now: NOW,
    fetchImpl: async (url) => {
      if (String(url).includes("seria")) {
        return {
          ok: true,
          json: async () => ({ codes: [{ code: "OLDCODE", rewards: "" }] }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          active: [],
          inactive: [{ code: "OLDCODE", rewards: ["Mora ×10000"] }],
        }),
      };
    },
    readCache: (key) => cache[key],
    writeCache: (key, entry) => {
      cache[key] = entry;
    },
  });

  assert.equal(codes[0].rewards, "Mora ×10000");
});

test("fetchCodes backfill matches codes case-insensitively", async () => {
  const cache = {};

  const codes = await fetchCodes("genshin", {
    now: NOW,
    fetchImpl: async (url) => {
      if (String(url).includes("seria")) {
        return {
          ok: true,
          json: async () => ({
            codes: [{ code: "p7g0xa30h0q3", rewards: "" }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          active: [{ code: "P7G0XA30H0Q3", rewards: ["Primogem ×60"] }],
          inactive: [],
        }),
      };
    },
    readCache: (key) => cache[key],
    writeCache: (key, entry) => {
      cache[key] = entry;
    },
  });

  assert.equal(codes[0].rewards, "Primogem ×60");
});

test("fetchCodes swallows a failing backfill source and leaves rewards null", async () => {
  const cache = {};

  const codes = await fetchCodes("genshin", {
    now: NOW,
    fetchImpl: async (url) => {
      if (String(url).includes("seria")) {
        return {
          ok: true,
          json: async () => ({ codes: [{ code: "ABC123", rewards: "" }] }),
        };
      }
      return { ok: false, status: 503 };
    },
    readCache: (key) => cache[key],
    writeCache: (key, entry) => {
      cache[key] = entry;
    },
  });

  assert.equal(codes[0].rewards, null);
});

test("fetchCodes backfill reuses a fresh cached index without a new fetch", async () => {
  let enneadFetches = 0;
  const cache = {
    "ennead:genshin": {
      lastAttemptAt: NOW - 1_000,
      lastSuccessAt: NOW - 1_000,
      rewardsByCode: { ABC123: "Primogem ×60" },
    },
  };

  const codes = await fetchCodes("genshin", {
    now: NOW,
    fetchImpl: async (url) => {
      if (String(url).includes("seria")) {
        return {
          ok: true,
          json: async () => ({ codes: [{ code: "ABC123", rewards: "" }] }),
        };
      }
      enneadFetches += 1;
      throw new Error("should not fetch ennead");
    },
    readCache: (key) => cache[key],
    writeCache: (key, entry) => {
      cache[key] = entry;
    },
  });

  assert.equal(enneadFetches, 0);
  assert.equal(codes[0].rewards, "Primogem ×60");
});

test("fetchCodes backfill refreshes a stale cached index and stores the result", async () => {
  const cache = {
    "ennead:genshin": {
      lastAttemptAt: NOW - 31 * 60 * 1000,
      lastSuccessAt: NOW - 31 * 60 * 1000,
      rewardsByCode: { OLD: "Stale reward" },
    },
  };

  const codes = await fetchCodes("genshin", {
    now: NOW,
    fetchImpl: async (url) => {
      if (String(url).includes("seria")) {
        return {
          ok: true,
          json: async () => ({ codes: [{ code: "ABC123", rewards: "" }] }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          active: [{ code: "ABC123", rewards: ["Primogem ×60"] }],
          inactive: [],
        }),
      };
    },
    readCache: (key) => cache[key],
    writeCache: (key, entry) => {
      cache[key] = entry;
    },
  });

  assert.equal(codes[0].rewards, "Primogem ×60");
  assert.equal(cache["ennead:genshin"].lastAttemptAt, NOW);
  assert.equal(cache["ennead:genshin"].lastSuccessAt, NOW);
  assert.deepEqual(cache["ennead:genshin"].rewardsByCode, {
    ABC123: "Primogem ×60",
  });
});

test("fetchCodes runs no backfill attempt for Game8 games", async () => {
  let fetchCount = 0;
  const cache = {
    nte: {
      lastAttemptAt: NOW - 1_000,
      lastSuccessAt: NOW - 1_000,
      codes: [{ code: "NTEFREE", rewards: null, source: "Game8" }],
    },
  };

  const codes = await fetchCodes("nte", {
    now: NOW,
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("should not fetch");
    },
    readCache: (key) => cache[key],
    writeCache: (key, entry) => {
      cache[key] = entry;
    },
  });

  assert.equal(fetchCount, 0);
  assert.equal(codes[0].rewards, null);
});
