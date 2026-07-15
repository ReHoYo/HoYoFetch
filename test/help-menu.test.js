import test from "node:test";
import assert from "node:assert/strict";
import {
  createHelpMenu,
  HELP_NEXT_EMOJI,
  HELP_PREVIOUS_EMOJI,
} from "../help-menu.js";

function makeHarness() {
  const requests = [];
  const sent = [];
  const client = { user: { id: "BOT123" }, events: { on() {} } };
  const menu = createHelpMenu(client, {
    attach: false,
    send: async (channelId, data) => {
      sent.push({ channelId, data });
      return { _id: "HELP123" };
    },
    request: async (method, path, body) => {
      requests.push({ method, path, body });
      return { ok: true, status: 200 };
    },
  });
  return { menu, requests, sent };
}

test("help menu opens on page one and seeds both navigation reactions", async () => {
  const { menu, requests, sent } = makeHarness();
  await menu.open({ authorId: "USER123", channelId: "CHANNEL123" });

  assert.match(sent[0].data.embeds[0].title, /\(1\/2\)/);
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["PUT", "PUT"]
  );
  assert.ok(
    requests.some(({ path }) =>
      path.includes(encodeURIComponent(HELP_PREVIOUS_EMOJI))
    )
  );
  assert.ok(
    requests.some(({ path }) =>
      path.includes(encodeURIComponent(HELP_NEXT_EMOJI))
    )
  );
});

test("only the invoker can turn pages and navigation wraps", async () => {
  const { menu, requests } = makeHarness();
  await menu.open({ authorId: "USER123", channelId: "CHANNEL123" });
  requests.length = 0;

  await menu.handleRawEvent({
    type: "MessageReact",
    id: "HELP123",
    user_id: "OTHER123",
    emoji_id: HELP_NEXT_EMOJI,
  });
  assert.equal(requests.length, 0);

  await menu.handleRawEvent({
    type: "MessageReact",
    id: "HELP123",
    user_id: "USER123",
    emoji_id: HELP_NEXT_EMOJI,
  });
  assert.equal(requests[0].method, "PATCH");
  assert.match(requests[0].body.embeds[0].title, /\(2\/2\)/);
  assert.equal(requests[1].method, "DELETE");
  assert.match(requests[1].path, /user_id=USER123$/);

  await menu.handleRawEvent({
    type: "MessageReact",
    id: "HELP123",
    user_id: "USER123",
    emoji_id: HELP_NEXT_EMOJI,
  });
  assert.match(requests[2].body.embeds[0].title, /\(1\/2\)/);
});
