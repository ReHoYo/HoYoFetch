// audit-log-command.js — one AuditLog resource facade for destination and privacy.
export function createAuditLogCommand({
  auditLogConfiguration,
  channelExclusion,
} = {}) {
  if (!auditLogConfiguration || !channelExclusion) {
    throw new TypeError(
      "AuditLog requires destination and privacy controllers."
    );
  }

  async function handleCommand(message, args = []) {
    const action = String(args[0] ?? "status").toLowerCase();
    if (action === "privacy") {
      return channelExclusion.handleCommand(message, args.slice(1));
    }
    if (
      (action === "confirm" || action === "cancel") &&
      channelExclusion.getPending(
        message.server?.id ?? message.channel?.serverId
      )
    ) {
      return channelExclusion.handleCommand(message, args);
    }
    return auditLogConfiguration.handleCommand(message, args);
  }

  return { handleCommand };
}
