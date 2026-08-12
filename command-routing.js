// command-routing.js — enumerable public command dispatch and argument parsing.
// Keeping this map separate from bot startup lets tests prove that every
// catalog route has exactly one runtime destination and no handler-only alias.

export const COMMAND_DISPATCH_BY_ROUTE = Object.freeze({
  fetchgi: "fetch",
  fetchhsr: "fetch",
  fetchzzz: "fetch",
  fetchhi3: "fetch",
  fetchnte: "fetch",
  fetchwuwa: "fetch",
  helphoyofetch: "help",
  docs: "docs",
  "report-spam": "report_spam",
  "auto-fetch": "auto_fetch",
  emoji: "emoji",
  auditlog: "audit_log",
  "post-gate": "post_gate",
  level: "level",
  restart: "restart",
  "server-info": "server_info",
  ban: "manual_moderation",
  kick: "manual_moderation",
  mute: "manual_moderation",
  "purge-user": "manual_moderation",
  "get-info": "get_info",
});

export const REMOVED_COMMAND_ROUTES = Object.freeze([
  "enable-auditlog",
  "enableauditlog",
  "disable-auditlog",
  "disableauditlog",
  "test-auditlog",
  "testauditlog",
  "excludechannel",
  "getinfo",
  "postgate",
  "enablefetchhoyo",
  "enablefetchnte",
  "enablefetchwuwa",
  "enablefetchntewuwa",
  "enablefetch",
  "disablefetch",
  "emojimode",
  "emojisetup",
  "exclude-channel",
  "automod",
]);

const AUTO_FETCH_SCOPES = Object.freeze({
  all: "all",
  hoyo: "hoyo",
  nte: "nte",
  wuwa: "wuwa",
  "nte-wuwa": "nte_wuwa",
});

export function getCommandDispatch(route) {
  return COMMAND_DISPATCH_BY_ROUTE[String(route ?? "").toLowerCase()] ?? null;
}

export function parseAutoFetchScope(args = []) {
  if (!Array.isArray(args) || args.length > 1) {
    return { ok: false, reason: "invalid_scope" };
  }
  const requested = String(args[0] ?? "all").toLowerCase();
  const scope = AUTO_FETCH_SCOPES[requested];
  return scope ? { ok: true, scope } : { ok: false, reason: "invalid_scope" };
}
