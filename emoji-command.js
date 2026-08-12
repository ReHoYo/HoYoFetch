// emoji-command.js — resource-oriented reward emoji command controller.
import { buildStatusEmbed } from "./embeds.js";
import { safeErrorSummary } from "./security.js";

const FAILURE_REASONS = Object.freeze({
  hub_not_configured: "No emoji hub configured. Set `EMOJI_HUB_SERVER_ID`.",
  fetch_emojis_failed: "Could not read the hub server's existing emoji list.",
});

export function createEmojiCommand({
  client,
  send,
  prefix = "/",
  emojiHubServerId,
  manifestLength,
  getEmojiMode,
  setEmojiMode,
  getRegistry,
  provision,
} = {}) {
  if (typeof send !== "function")
    throw new TypeError("Emoji requires a sender.");

  async function respond(message, title, description, colour) {
    await send(message.channel, {
      embeds: [buildStatusEmbed(title, description, colour)],
    });
  }

  async function status(message) {
    const isHub = Boolean(
      emojiHubServerId && message.server?.id === emojiHubServerId
    );
    const provisioned = Object.keys(getRegistry()).length;
    const hubNote = !emojiHubServerId
      ? "\nNo hub server configured — set `EMOJI_HUB_SERVER_ID` first."
      : isHub
        ? ""
        : `\nRun \`${prefix}Emoji provision\` in the configured hub server to provision or update icons.`;
    await respond(
      message,
      "🎨 Emoji Status",
      `**${provisioned} of ${manifestLength}** reward keywords have a provisioned custom emoji.\nEmoji mode: **${getEmojiMode()}**.${hubNote}`,
      "#3498DB"
    );
    return { outcome: "status", provisioned, total: manifestLength, isHub };
  }

  async function handleCommand(message, args = []) {
    const [rawAction = "status", ...rest] = args;
    const action = String(rawAction).toLowerCase();
    if (action === "status" && rest.length === 0) return status(message);

    if (action === "mode" && rest.length === 1) {
      const mode = String(rest[0]).toLowerCase();
      if (!setEmojiMode(mode)) {
        await respond(
          message,
          "⚠️ Invalid Emoji Mode",
          `Use \`${prefix}Emoji mode unicode\` or \`${prefix}Emoji mode custom\`.`,
          "#E74C3C"
        );
        return { outcome: "invalid_mode" };
      }
      await respond(
        message,
        "✅ Emoji Mode Updated",
        `Emoji rendering is now set to **${getEmojiMode()}**.`,
        "#2ECC71"
      );
      return { outcome: "mode_updated", mode: getEmojiMode() };
    }

    if (action === "provision" && rest.length === 0) {
      const server = message.server;
      if (!emojiHubServerId || server?.id !== emojiHubServerId) {
        return status(message);
      }
      await respond(
        message,
        "⏳ Provisioning…",
        `Downloading and uploading reward icons to **${server.name ?? server.id}**. A full run can take a minute.`,
        "#F39C12"
      );

      let summary;
      try {
        summary = await provision({ client });
      } catch (error) {
        await respond(
          message,
          "❌ Provisioning Failed",
          `Something went wrong: ${safeErrorSummary(error)}`,
          "#E74C3C"
        );
        return { outcome: "failed" };
      }
      if (!summary.ok) {
        const reason =
          summary.error === "hub_not_found"
            ? `Irminsul is not a member of hub server \`${summary.serverId}\`.`
            : (FAILURE_REASONS[summary.error] ??
              `Provisioning failed: ${summary.error}`);
        await respond(message, "❌ Provisioning Failed", reason, "#E74C3C");
        return { outcome: "failed", reason: summary.error };
      }

      const colour =
        summary.failed.length === 0
          ? "#2ECC71"
          : summary.created.length > 0 || summary.reused.length > 0
            ? "#E67E22"
            : "#E74C3C";
      const lines = [
        `**Created:** ${summary.created.length}`,
        `**Reused:** ${summary.reused.length}`,
        `**Skipped:** ${summary.skipped.length}`,
        `**Failed:** ${summary.failed.length}`,
        `**Capacity:** ${summary.capacity.used}/${summary.capacity.limit} server emoji used`,
      ];
      const failures = summary.failed
        .slice(0, 10)
        .map((entry) => `\`${entry.name}\`: ${entry.reason}`);
      if (failures.length) {
        lines.push("", "**Failures:**", ...failures);
        if (summary.failed.length > 10) {
          lines.push(`_…and ${summary.failed.length - 10} more_`);
        }
      }
      lines.push("", `Switch rendering with \`${prefix}Emoji mode custom\`.`);
      await respond(
        message,
        summary.failed.length === 0
          ? "✅ Emoji Provisioning Complete"
          : "⚠️ Emoji Provisioning Finished With Errors",
        lines.join("\n"),
        colour
      );
      return { outcome: "provisioned", summary };
    }

    await respond(
      message,
      "⚠️ Invalid Emoji Command",
      `Use \`${prefix}Emoji status\`, \`${prefix}Emoji mode unicode|custom\`, or \`${prefix}Emoji provision\`.`,
      "#E74C3C"
    );
    return { outcome: "invalid_command" };
  }

  return { handleCommand };
}
