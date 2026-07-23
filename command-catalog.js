// command-catalog.js — Public HoYoFetch command reference shared by the bot
// help menu, documentation website, and documentation consistency tests.

export const DOCS_URL = "https://rehoyo.github.io/HoYoFetch/";

export const COMMAND_SECTIONS = Object.freeze({
  MEMBER: "member",
  SETUP: "setup",
  MODERATION: "moderation",
});

export const COMMAND_CATALOG = Object.freeze([
  {
    id: "fetch-gi",
    section: COMMAND_SECTIONS.MEMBER,
    route: "fetchgi",
    access: "member",
    syntax: "/FetchGI",
    summary: "Fetch active Genshin Impact redemption codes.",
    help: "Fetch active **Genshin Impact** redemption codes",
    examples: ["/FetchGI"],
  },
  {
    id: "fetch-hsr",
    section: COMMAND_SECTIONS.MEMBER,
    route: "fetchhsr",
    access: "member",
    syntax: "/FetchHSR",
    summary: "Fetch active Honkai: Star Rail redemption codes.",
    help: "Fetch active **Honkai: Star Rail** redemption codes",
    examples: ["/FetchHSR"],
  },
  {
    id: "fetch-zzz",
    section: COMMAND_SECTIONS.MEMBER,
    route: "fetchzzz",
    access: "member",
    syntax: "/FetchZZZ",
    summary: "Fetch active Zenless Zone Zero redemption codes.",
    help: "Fetch active **Zenless Zone Zero** redemption codes",
    examples: ["/FetchZZZ"],
  },
  {
    id: "fetch-hi3",
    section: COMMAND_SECTIONS.MEMBER,
    route: "fetchhi3",
    access: "member",
    syntax: "/FetchHI3",
    summary: "Fetch active Honkai Impact 3rd redemption codes.",
    help: "Fetch active **Honkai Impact 3rd** codes",
    examples: ["/FetchHI3"],
    notes: ["Honkai Impact 3rd codes must be redeemed in-game."],
  },
  {
    id: "fetch-nte",
    section: COMMAND_SECTIONS.MEMBER,
    route: "fetchnte",
    access: "member",
    syntax: "/FetchNTE",
    summary: "Fetch active Neverness to Everness redemption codes.",
    help: "Fetch active **Neverness to Everness** codes",
    examples: ["/FetchNTE"],
    notes: ["Neverness to Everness codes must be redeemed in-game."],
  },
  {
    id: "fetch-wuwa",
    section: COMMAND_SECTIONS.MEMBER,
    route: "fetchwuwa",
    access: "member",
    syntax: "/FetchWuWa",
    summary: "Fetch active Wuthering Waves redemption codes.",
    help: "Fetch active **Wuthering Waves** codes",
    examples: ["/FetchWuWa"],
    notes: ["Wuthering Waves codes must be redeemed in-game."],
  },
  {
    id: "help",
    section: COMMAND_SECTIONS.MEMBER,
    route: "helphoyofetch",
    access: "member",
    syntax: "/HelpHoyoFetch",
    summary: "Open the two-page command reference inside Stoat.",
    help: "Show the two-page in-chat help reference",
    examples: ["/HelpHoyoFetch"],
  },
  {
    id: "docs",
    section: COMMAND_SECTIONS.MEMBER,
    route: "docs",
    access: "member",
    syntax: "/Docs",
    summary: "Open the permanent, searchable Irminsul documentation site.",
    help: `[Open the full searchable documentation](${DOCS_URL})`,
    examples: ["/Docs"],
  },
  {
    id: "report-spam",
    section: COMMAND_SECTIONS.MEMBER,
    route: "report-spam",
    access: "member",
    syntax: "/Report-Spam @member <what happened>",
    summary:
      "Privately submit suspected friend-request, DM, commission, or scam spam for review.",
    help: "Privately submit suspected friend-request or DM spam for review",
    examples: [
      "/Report-Spam @member sent an unsolicited commission scam DM",
      "/Report-Spam @member for repeated friend-request spam",
    ],
    notes: [
      "Describe what happened in plain words, between 10 and 300 characters. The older `reason:` delimiter still works.",
      "The command works only where Irminsul can remove the invocation. Reports never punish an account automatically.",
    ],
  },
  {
    id: "enable-fetch",
    section: COMMAND_SECTIONS.SETUP,
    route: "enablefetch",
    access: "fetch_manager",
    syntax: "/EnableFetch",
    summary:
      "Enable hourly code announcements for every supported game in this channel.",
    help: "Enable hourly auto-fetch of **HoYoverse + NTE + WuWa** codes in this channel _(admins/mods only)_",
    permission:
      "Server owner, Manage Server, or a recognized moderation capability",
    examples: ["/EnableFetch"],
  },
  {
    id: "enable-fetch-hoyo",
    section: COMMAND_SECTIONS.SETUP,
    route: "enablefetchhoyo",
    access: "fetch_manager",
    syntax: "/EnableFetchHoyo",
    summary: "Enable hourly HoYoverse-only code announcements in this channel.",
    help: "Enable hourly auto-fetch of **HoYoverse-only** codes in this channel _(admins/mods only)_",
    permission:
      "Server owner, Manage Server, or a recognized moderation capability",
    examples: ["/EnableFetchHoyo"],
  },
  {
    id: "enable-fetch-nte",
    section: COMMAND_SECTIONS.SETUP,
    route: "enablefetchnte",
    access: "fetch_manager",
    syntax: "/EnableFetchNTE",
    summary: "Enable hourly NTE-only code announcements in this channel.",
    help: "Enable hourly auto-fetch of **NTE-only** codes in this channel _(admins/mods only)_",
    permission:
      "Server owner, Manage Server, or a recognized moderation capability",
    examples: ["/EnableFetchNTE"],
  },
  {
    id: "enable-fetch-wuwa",
    section: COMMAND_SECTIONS.SETUP,
    route: "enablefetchwuwa",
    access: "fetch_manager",
    syntax: "/EnableFetchWuWa",
    summary: "Enable hourly WuWa-only code announcements in this channel.",
    help: "Enable hourly auto-fetch of **WuWa-only** codes in this channel _(admins/mods only)_",
    permission:
      "Server owner, Manage Server, or a recognized moderation capability",
    examples: ["/EnableFetchWuWa"],
  },
  {
    id: "enable-fetch-nte-wuwa",
    section: COMMAND_SECTIONS.SETUP,
    route: "enablefetchntewuwa",
    access: "fetch_manager",
    syntax: "/EnableFetchNTEWuWa",
    summary: "Enable hourly NTE and WuWa code announcements in this channel.",
    help: "Enable hourly auto-fetch of **NTE + WuWa** codes in this channel _(admins/mods only)_",
    permission:
      "Server owner, Manage Server, or a recognized moderation capability",
    examples: ["/EnableFetchNTEWuWa"],
  },
  {
    id: "disable-fetch",
    section: COMMAND_SECTIONS.SETUP,
    route: "disablefetch",
    access: "fetch_manager",
    syntax: "/DisableFetch",
    summary: "Disable automatic code announcements in the current channel.",
    help: "Disable auto-fetch in this channel _(admins/mods only)_",
    permission:
      "Server owner, Manage Server, or a recognized moderation capability",
    examples: ["/DisableFetch"],
  },
  {
    id: "emoji-mode",
    section: COMMAND_SECTIONS.SETUP,
    route: "emojimode",
    access: "fetch_manager",
    syntax: "/EmojiMode [unicode|custom]",
    summary: "Show or change how reward emoji are rendered.",
    help: "Show or switch how reward emoji are rendered _(admins/mods only)_",
    permission:
      "Server owner, Manage Server, or a recognized moderation capability",
    examples: ["/EmojiMode", "/EmojiMode custom", "/EmojiMode unicode"],
  },
  {
    id: "audit-log",
    section: COMMAND_SECTIONS.SETUP,
    route: "auditlog",
    routeAliases: [
      "enable-auditlog",
      "enableauditlog",
      "disable-auditlog",
      "disableauditlog",
    ],
    access: "fetch_manager",
    syntax: "/AuditLog [status|here|#channel|off]",
    summary: "View or configure the protected audit log for this server.",
    help: "Log messages, moderation, username changes, and server settings _(admins/mods only)_",
    permission:
      "Server owner, Manage Server, or a recognized moderation capability",
    examples: [
      "/AuditLog status",
      "/AuditLog here",
      "/AuditLog #moderation-log",
      "/AuditLog off",
    ],
    notes: [
      "The older /Enable-AuditLog and /Disable-AuditLog forms remain accepted for compatibility.",
    ],
  },
  {
    id: "test-audit-log",
    section: COMMAND_SECTIONS.SETUP,
    route: "test-auditlog",
    routeAliases: ["testauditlog"],
    access: "fetch_manager",
    syntax: "/Test-AuditLog",
    summary:
      "Test protected audit delivery and report current archive coverage.",
    help: "Test protected delivery and show settings-monitor coverage _(admins/mods only)_",
    permission:
      "Server owner, Manage Server, or a recognized moderation capability",
    examples: ["/Test-AuditLog"],
  },
  {
    id: "exclude-channel",
    section: COMMAND_SECTIONS.SETUP,
    route: "exclude-channel",
    routeAliases: ["excludechannel"],
    access: "fetch_manager",
    syntax: "/Exclude-Channel [action]",
    summary: "Withhold message content after approval from Enka#4961.",
    help: "Enka-approved channel privacy _(admins/mods only)_",
    permission:
      "Server owner, Manage Server, or a recognized moderation capability; Enka#4961 must approve changes",
    examples: [
      "/Exclude-Channel status",
      "/Exclude-Channel #private-channel",
      "/Exclude-Channel remove #private-channel",
      "/Exclude-Channel confirm 123456",
    ],
    notes: [
      "Both exclusion and removal require a fresh one-time code sent to Enka#4961.",
      "Channel, role, permission, moderation, and membership events remain logged.",
    ],
  },
  {
    id: "restart",
    section: COMMAND_SECTIONS.SETUP,
    route: "restart",
    access: "fetch_manager",
    syntax: "/Restart",
    summary: "Restart the currently deployed bot process after an update.",
    help: "Restart the bot process after deploying updates _(admins/mods only)_",
    permission:
      "Server owner, Manage Server, or a recognized moderation capability",
    examples: ["/Restart"],
    notes: [
      "This restarts the running process. It does not pull or deploy new source code.",
    ],
  },
  {
    id: "ban",
    section: COMMAND_SECTIONS.MODERATION,
    route: "ban",
    access: "ban",
    syntax: "/Ban @member <reason>",
    summary:
      "Confirm and ban a member, then choose a message-cleanup window by reaction.",
    help: "Confirm with ✅, then pick a cleanup window (1h–29d) by reaction. The 10-minute ↩️ undo only unbans _(Ban Members; cleanup also needs Manage Messages)_",
    permission: "Ban Members; Manage Messages is also required for cleanup",
    examples: [
      "/Ban @member for spamming and stuff",
      "/Ban @member 7d raid cleanup",
    ],
    notes: [
      "Write the reason in plain words; the member, an optional window, and the reason may appear in any order.",
      "Nothing happens until the moderator who ran the command reacts ✅ to the confirmation naming the target and reason.",
      "Undo unbans the account but cannot restore server membership or deleted messages.",
    ],
  },
  {
    id: "kick",
    section: COMMAND_SECTIONS.MODERATION,
    route: "kick",
    access: "kick",
    syntax: "/Kick @member <reason>",
    summary:
      "Confirm and remove a member, then choose a message-cleanup window by reaction.",
    help: "Confirm with ✅, then pick a cleanup window (1h–29d) by reaction. There is no undo; the member must rejoin with an invite _(Kick Members)_",
    permission: "Kick Members; Manage Messages is also required for cleanup",
    examples: [
      "/Kick @member for raiding",
      "/Kick @member 1d throwaway account",
    ],
    notes: [
      "Because a kick cannot be undone, nothing happens until the moderator who ran the command reacts ✅.",
    ],
  },
  {
    id: "mute",
    section: COMMAND_SECTIONS.MODERATION,
    route: "mute",
    access: "timeout",
    syntax: "/Mute @member [10m|30m|1h|4h|24h|3d|7d] <reason>",
    summary:
      "Apply a native timeout, then choose a message-cleanup window by reaction.",
    help: "Type a duration and confirm with ✅, or omit it for the 1️⃣–7️⃣ picker, then pick a cleanup window by reaction. The 10-minute ↩️ undo releases it _(Timeout Members)_",
    permission: "Timeout Members; Manage Messages is also required for cleanup",
    examples: [
      "/Mute @member 1h cooldown",
      "/Mute @member for arguing with staff",
    ],
    notes: [
      "Choosing a duration from the picker is itself the confirmation, so only a typed duration shows a separate ✅/❌ prompt.",
    ],
  },
  {
    id: "purge-user",
    section: COMMAND_SECTIONS.MODERATION,
    route: "purge-user",
    access: "manage_messages",
    syntax: "/Purge-User @member <reason>",
    summary: "Confirm and delete a member's messages observed by Irminsul.",
    help: "Pick a window by reaction (1h–29d), then ✅/❌ to confirm. Audit evidence is preserved _(Manage Messages)_",
    permission: "Manage Messages",
    examples: [
      "/Purge-User @member because of spam",
      "/Purge-User @member 29d scam link flood",
    ],
    notes: [
      "Protected audit records and retained evidence are never erased by a purge.",
    ],
  },
  {
    id: "automod-release",
    section: COMMAND_SECTIONS.MODERATION,
    route: "automod release",
    access: "timeout",
    syntax: "/Automod release @member <reason>",
    summary:
      "Release a timeout and reset that member's automod escalation history.",
    help: "Release the timeout immediately and reset that member's automod strikes _(Timeout Members)_",
    permission: "Timeout Members",
    examples: ["/Automod release @member false positive"],
  },
  {
    id: "automod",
    section: COMMAND_SECTIONS.MODERATION,
    route: "automod",
    access: "fetch_manager",
    syntax: "/Automod [status|monitor|enforce|off|quorum|approve]",
    summary: "Inspect and configure Irminsul anti-raid protection.",
    help: "Configure anti-raid moderation. Enforcement escalates 10m → 1h → 24h → 7d; strikes reset after 14 quiet days _(ban approval: Ban Members)_",
    permission:
      "Configuration: recognized moderator capability; ban approval: owner, Manage Server, or Ban Members",
    examples: [
      "/Automod status",
      "/Automod monitor here",
      "/Automod enforce #automod-log",
      "/Automod quorum 2",
      "/Automod approve CASE_ID",
      "/Automod off",
    ],
  },
]);

export const COMMAND_ACCESS_BY_ROUTE = Object.freeze(
  Object.fromEntries(
    COMMAND_CATALOG.flatMap((command) =>
      [command.route, ...(command.routeAliases ?? [])].map((route) => [
        route,
        command.access,
      ])
    )
  )
);

export function formatCommandSyntax(syntax, prefix = "/") {
  return syntax.startsWith("/") ? `${prefix}${syntax.slice(1)}` : syntax;
}

export function getHelpCommandTuples(section, prefix = "/") {
  return COMMAND_CATALOG.filter((command) => command.section === section).map(
    (command) => [formatCommandSyntax(command.syntax, prefix), command.help]
  );
}
