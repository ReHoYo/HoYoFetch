import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import {
  EASTER_EGG_COMMAND_NAMES,
  EASTER_EGG_COMMANDS,
  uploadEasterEggAttachment,
} from "../easter-eggs.js";
import { buildHelpEmbeds } from "../embeds.js";

const EXPECTED_ASSETS = Object.freeze({
  chison: {
    filename: "chison.jpeg",
    contentType: "image/jpeg",
    sha256: "65473e46b1e75968aa8409943e3079927b28b545b3c1d670a454d5f0e8a4a68e",
  },
  potential: {
    filename: "potential.webp",
    contentType: "image/webp",
    sha256: "9722b6a5304f440a4cab1096184e0afa1f5689d4d162054047b31cacfd437d7e",
  },
  me: {
    filename: "me.webp",
    contentType: "image/webp",
    sha256: "36f770a1202bf5dae850b1414e4775988486556c95da9b7a72ab74c36c546e51",
  },
});

test("easter egg commands map to the expected bundled images", async () => {
  assert.deepEqual(EASTER_EGG_COMMAND_NAMES, ["chison", "potential", "me"]);

  for (const [command, expected] of Object.entries(EXPECTED_ASSETS)) {
    const asset = EASTER_EGG_COMMANDS[command];
    assert.equal(asset.filename, expected.filename);
    assert.equal(asset.contentType, expected.contentType);

    const bytes = await readFile(asset.url);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expected.sha256
    );
  }
});

test("easter egg commands stay hidden from help and the README", async () => {
  const helpEmbeds = buildHelpEmbeds("/");
  const publicHelp = JSON.stringify(helpEmbeds).toLowerCase();
  assert.equal(helpEmbeds.length, 2);
  for (const helpEmbed of helpEmbeds) {
    assert.ok(helpEmbed.description.length <= 2_000);
  }
  assert.match(helpEmbeds[1].description, /moderator-only commands/i);
  const readme = (
    await readFile(new URL("../README.md", import.meta.url), "utf8")
  ).toLowerCase();

  for (const command of EASTER_EGG_COMMAND_NAMES) {
    assert.doesNotMatch(publicHelp, new RegExp(`/${command}\\b`));
    assert.doesNotMatch(readme, new RegExp(`/${command}\\b`));
  }
});

test("attachment upload sends authenticated multipart data and returns its ID", async () => {
  const asset = EASTER_EGG_COMMANDS.chison;
  const sourceBytes = Buffer.from("image bytes");
  let readUrl;
  let request;

  const attachmentId = await uploadEasterEggAttachment({
    asset,
    autumnUrl: "https://autumn.example.test/",
    authenticationHeader: ["X-Bot-Token", "secret-token"],
    readFileImpl: async (url) => {
      readUrl = url;
      return sourceBytes;
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "ATTACHMENT_123" }),
      };
    },
  });

  assert.equal(readUrl, asset.url);
  assert.equal(request.url, "https://autumn.example.test/attachments");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(request.options.headers, {
    "X-Bot-Token": "secret-token",
  });

  const uploadedFile = request.options.body.get("file");
  assert.equal(uploadedFile.name, asset.filename);
  assert.equal(uploadedFile.type, asset.contentType);
  assert.equal(uploadedFile.size, sourceBytes.length);
  assert.equal(attachmentId, "ATTACHMENT_123");
});

test("attachment upload rejects unavailable files without exposing their path", async () => {
  await assert.rejects(
    uploadEasterEggAttachment({
      asset: EASTER_EGG_COMMANDS.me,
      autumnUrl: "https://autumn.example.test",
      authenticationHeader: ["X-Bot-Token", "secret-token"],
      readFileImpl: async () => {
        throw new Error("ENOENT: /private/source/path/me.webp");
      },
    }),
    (error) => {
      assert.equal(error.message, "Easter egg asset is unavailable.");
      assert.doesNotMatch(error.message, /private|source|path/);
      return true;
    }
  );
});

test("attachment upload rejects HTTP failures and malformed IDs", async () => {
  const common = {
    asset: EASTER_EGG_COMMANDS.potential,
    autumnUrl: "https://autumn.example.test",
    authenticationHeader: ["X-Bot-Token", "secret-token"],
    readFileImpl: async () => Buffer.from("image bytes"),
  };

  await assert.rejects(
    uploadEasterEggAttachment({
      ...common,
      fetchImpl: async () => ({ ok: false, status: 413 }),
    }),
    { message: "Easter egg upload failed (HTTP 413)." }
  );

  await assert.rejects(
    uploadEasterEggAttachment({
      ...common,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ id: "../../not-safe" }),
      }),
    }),
    { message: "Easter egg upload returned an invalid attachment ID." }
  );

  await assert.rejects(
    uploadEasterEggAttachment({
      ...common,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }),
    }),
    { message: "Easter egg upload returned an invalid response." }
  );
});
