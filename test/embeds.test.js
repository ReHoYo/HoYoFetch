import test from "node:test";
import assert from "node:assert/strict";
import { buildCodesEmbed, buildHelpEmbeds } from "../embeds.js";

test("WuWa code embeds include reward emoji, in-game steps, and the correct source", () => {
  const embed = buildCodesEmbed("wuwa", [
    {
      code: "WUTHERINGGIFT",
      rewards: "Astrite x50, Shell Credit x15,000",
      source: "Game8",
    },
  ]);

  assert.match(embed.title, /Wuthering Waves/);
  assert.match(embed.description, /💎 Astrite ×50/);
  assert.match(embed.description, /🪙 Shell Credit ×15,000/);
  assert.match(
    embed.description,
    /Settings → Other Settings → Redemption Code/
  );
  assert.match(
    embed.description,
    /game8\.co\/games\/Wuthering-Waves\/archives\/453149/
  );
});

test("in-chat help attributes both Game8 sources and uses canonical admin commands", () => {
  const [memberPage, setupPage] = buildHelpEmbeds("/");

  assert.match(memberPage.description, /Game8: NTE \+ WuWa/);
  assert.match(memberPage.description, /\/FetchWuWa/);
  assert.match(setupPage.description, /\/Auto-Fetch \[status\|enable\|off\]/);
  assert.doesNotMatch(setupPage.description, /Automod|EnableFetch/);
});

test("a batch of rewardless codes links the source article exactly once", () => {
  const codes = [
    { code: "CODEONE", rewards: null, source: "seria" },
    { code: "CODETWO", rewards: null, source: "seria" },
    { code: "CODETHREE", rewards: null, source: "seria" },
  ];
  const embed = buildCodesEmbed("genshin", codes);

  const matches =
    embed.description.match(
      /game8\.co\/games\/Genshin-Impact\/archives\/304759/g
    ) || [];
  assert.equal(matches.length, 1);
  assert.equal(
    (embed.description.match(/Rewards not listed by this source/g) || [])
      .length,
    3
  );
});

test("a ten-code all-rewardless batch stays under the embed description cap", () => {
  const codes = Array.from({ length: 10 }, (_, i) => ({
    code: `CODE${i}`,
    rewards: null,
    source: "seria",
  }));
  const embed = buildCodesEmbed("genshin", codes);

  assert.ok(embed.description.length <= 2000, embed.description.length);
});
