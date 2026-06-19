import test from "node:test";
import assert from "node:assert/strict";
import { fetchNTECodes, parseGame8NTECodes } from "../api.js";
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

test("parseGame8NTECodes extracts active codes, dedupes casing, and ignores expired codes", () => {
  const codes = parseGame8NTECodes(game8Fixture);

  assert.deepEqual(codes.map((entry) => entry.code), [
    "NTEvtuber200",
    "NTEFREE",
  ]);
  assert.equal(codes[0].rewards, "Fons x10,000, Beetle Coin x10,000");
  assert.equal(codes[1].rewards, "Fons x30,000");
  assert.equal(codes[0].source, "Game8");
  assert.ok(!codes.some((entry) => entry.code === "NTEEXPIRED"));
});

test("parseGame8NTECodes falls back to code-cell text when input markup changes", () => {
  const codes = parseGame8NTECodes(textFallbackFixture);

  assert.deepEqual(codes.map((entry) => entry.code), ["RaceNoLimit"]);
  assert.equal(codes[0].rewards, "Elite Hunter Guide x2");
});

test("detectFreshCodes treats NTE codes as case-insensitive identities only", () => {
  assert.deepEqual(
    detectFreshCodes("nte", ["NTEFREE"], ["ntefree", "NTEBRANDNEW"]),
    ["NTEBRANDNEW"]
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
      codes: [{ code: "NTEvtuber200", rewards: "Fons x10,000", source: "Game8" }],
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
  assert.deepEqual(codes.map((entry) => entry.code), ["NTEvtuber200"]);
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
  assert.deepEqual(codes.map((entry) => entry.code), ["NTEvtuber200", "NTEFREE"]);
  assert.equal(cache.nte.lastAttemptAt, NOW);
  assert.equal(cache.nte.lastSuccessAt, NOW);
  assert.deepEqual(cache.nte.codes.map((entry) => entry.code), ["NTEvtuber200", "NTEFREE"]);
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

  assert.deepEqual(codes.map((entry) => entry.code), ["NTESTALE"]);
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
