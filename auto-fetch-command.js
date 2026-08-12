// auto-fetch-command.js — resource-oriented auto-fetch command controller.
import { buildStatusEmbed } from "./embeds.js";
import { parseAutoFetchScope } from "./command-routing.js";

function scopeLabel(scope) {
  if (scope === "hoyo") return "HoYoverse codes";
  if (scope === "nte") return "NTE codes";
  if (scope === "wuwa") return "WuWa codes";
  if (scope === "nte_wuwa") return "NTE and WuWa codes";
  return "HoYoverse, NTE, and WuWa codes";
}

export function createAutoFetchCommand({
  sendProtected,
  store,
  prefix = "/",
} = {}) {
  if (typeof sendProtected !== "function") {
    throw new TypeError("Auto-Fetch requires a protected sender.");
  }
  if (!store) throw new TypeError("Auto-Fetch requires a store.");

  async function respond(message, title, description, colour) {
    await sendProtected(message.channel, {
      embeds: [buildStatusEmbed(title, description, colour)],
    });
  }

  async function handleCommand(message, args = []) {
    const channelId = message.channelId;
    const [rawAction = "status", ...rest] = args;
    const action = String(rawAction).toLowerCase();

    if (action === "status" && rest.length === 0) {
      const enabled = store.isChannelEnabled(channelId);
      const scope = store.getChannelScope(channelId);
      await respond(
        message,
        "📡 Auto-Fetch Status",
        enabled
          ? `Auto-fetch is active in this channel for ${scopeLabel(scope)}.`
          : "Auto-fetch is off in this channel.",
        enabled ? "#3498DB" : "#808080"
      );
      return { outcome: "status", enabled, scope };
    }

    if (action === "enable") {
      const parsed = parseAutoFetchScope(rest);
      if (!parsed.ok) {
        await respond(
          message,
          "⚠️ Invalid Auto-Fetch Scope",
          `Use \`${prefix}Auto-Fetch enable [all|hoyo|nte|wuwa|nte-wuwa]\`.`,
          "#E74C3C"
        );
        return { outcome: "invalid_scope" };
      }
      const result = store.enableChannel(channelId, parsed.scope);
      const label = scopeLabel(result.currentScope);
      await respond(
        message,
        result.wasEnabled && !result.changed
          ? "ℹ️ Already Enabled"
          : result.wasEnabled
            ? "✅ Auto-Fetch Updated"
            : "✅ Auto-Fetch Enabled",
        result.wasEnabled && !result.changed
          ? `Auto-fetch is already active in this channel for ${label}.`
          : `This channel will now receive new ${label} automatically every hour.\nUse \`${prefix}Auto-Fetch off\` to stop.`,
        result.wasEnabled && !result.changed ? "#3498DB" : "#2ECC71"
      );
      return { outcome: result.changed ? "enabled" : "no_change", ...result };
    }

    if (action === "off" && rest.length === 0) {
      if (!store.isChannelEnabled(channelId)) {
        await respond(
          message,
          "ℹ️ Already Disabled",
          "Auto-fetch is already off in this channel.",
          "#3498DB"
        );
        return { outcome: "no_change" };
      }
      store.disableChannel(channelId);
      await respond(
        message,
        "🔕 Auto-Fetch Disabled",
        "This channel will no longer receive automatic code updates.",
        "#E67E22"
      );
      return { outcome: "disabled" };
    }

    await respond(
      message,
      "⚠️ Invalid Auto-Fetch Command",
      `Use \`${prefix}Auto-Fetch status\`, \`${prefix}Auto-Fetch enable [all|hoyo|nte|wuwa|nte-wuwa]\`, or \`${prefix}Auto-Fetch off\`.`,
      "#E74C3C"
    );
    return { outcome: "invalid_command" };
  }

  return { handleCommand };
}
