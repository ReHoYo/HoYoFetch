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

test("in-chat help attributes both Game8 code sources", () => {
  const [help] = buildHelpEmbeds("/");

  assert.match(help.description, /Game8: NTE \+ WuWa/);
  assert.match(help.description, /\/FetchWuWa/);
  assert.match(help.description, /\/EnableFetchNTEWuWa/);
});
