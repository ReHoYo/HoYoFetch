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
      "Describe what happened in plain words, between 10 and 300 characters.",
      "The command works only where Irminsul can remove the invocation. Reports never punish an account automatically.",
      "A plain-text @Username#1234 (not a real mention) resolves only if Irminsul already has that exact account cached from a shared server; otherwise use an actual @mention or an ID from /Get-Info.",
    ],
  },
  {
    id: "enable-fetch",
    section: COMMAND_SECTIONS.SETUP,
    route: "enablefetch",
    access: "fetch_manager",
    syntax: "/EnableFetch [all|hoyo|nte|wuwa|nte-wuwa]",
    summary:
      "Enable hourly code announcements for a selected game scope in this channel.",
    help: "Enable hourly auto-fetch for **all, HoYoverse, NTE, WuWa, or NTE + WuWa** _(admins/mods only)_",
    permission:
      "Server owner, Manage Server, or a recognized moderation capability",
    examples: [
      "/EnableFetch",
      "/EnableFetch hoyo",
      "/EnableFetch nte",
      "/EnableFetch wuwa",
      "/EnableFetch nte-wuwa",
    ],
    notes: ["Omitting the scope enables every supported game."],
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
    id: "emoji-setup",
    section: COMMAND_SECTIONS.SETUP,
    route: "emojisetup",
    access: "server_moderator",
    syntax: "/EmojiSetup [status]",
    summary:
      "Auto-provision reward icons as custom emoji on the configured hub server.",
    help: "Auto-provision reward icons as custom emoji, or check progress _(admins/mods only)_",
    permission: "Server owner, Kick/Ban/Timeout Members, or admin",
    examples: ["/EmojiSetup", "/EmojiSetup status"],
    notes: [
      "Only runs in the server set as EMOJI_HUB_SERVER_ID — elsewhere it reports registry status without uploading anything.",
      "Safe to run repeatedly: an already-provisioned keyword is reused, never re-uploaded.",
      "Downloads and uploads happen one icon at a time; a broken icon URL is reported but does not stop the rest.",
      "Switch rendering over to the result with `/EmojiMode custom`.",
    ],
  },
  {
    id: "audit-log",
    section: COMMAND_SECTIONS.SETUP,
    route: "auditlog",
    access: "fetch_manager",
    syntax: "/AuditLog [action]",
    summary: "View or configure the protected audit log for this server.",
    help: "Log messages, moderation, username changes, and server settings _(admins/mods only)_",
    permission:
      "Server owner, Manage Server, or a recognized moderation capability",
    examples: [
      "/AuditLog status",
      "/AuditLog test",
      "/AuditLog here",
      "/AuditLog #moderation-log",
      "/AuditLog off",
      "/AuditLog confirm 123456",
      "/AuditLog cancel",
    ],
    notes: [
      "Enabling, moving, or disabling audit logging requires a one-time code approved by Enka#4961.",
      "Status and test remain read-only and do not require approval.",
    ],
  },
  {
    id: "exclude-channel",
    section: COMMAND_SECTIONS.SETUP,
    route: "exclude-channel",
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
    id: "post-gate",
    section: COMMAND_SECTIONS.SETUP,
    route: "post-gate",
    access: "fetch_manager",
    syntax: "/Post-Gate [action]",
    summary:
      "Hold a new or first-time poster's first link or attachment for review, after approval from Enka#4961.",
    help: "Enka-approved first-post review queue _(admins/mods only)_",
    permission:
      "Server owner, Manage Server, or a recognized moderation capability; Enka#4961 must approve changes",
    examples: [
      "/Post-Gate status",
      "/Post-Gate here",
      "/Post-Gate #new-member-review",
      "/Post-Gate off",
      "/Post-Gate confirm 123456",
      "/Post-Gate holds",
      "/Post-Gate terms",
    ],
    notes: [
      "Turning the gate on, moving its review channel, and turning it off each require a fresh one-time code sent to Enka#4961.",
      "A message is held when its author is already in Post Gate, when it matches the prohibited-term filter, or when it carries a link or attachment from an account created under 7 days ago, a member who joined under 24 hours ago, or a member with no other archived message in this server.",
      "Link checks normalize common spacing, invisible-character, Unicode-punctuation, bracketed-dot, hxxp, domain, and IP obfuscations before deciding whether to hold the original post.",
      "The prohibited-term filter matches whole words and phrases after Unicode, case, invisible-character, homoglyph, and leetspeak normalization, keeps an allowlist for known false positives, and only ever holds — it never bans, times out, or strikes on its own.",
      "The same filter screens usernames, display names, and server nicknames on join, on nickname change, and on every message; a match places the account in full Post Gate automatically, and the offending name is never shown on a card — only the rule id and which field matched.",
      "`/Post-Gate terms` reports the active term list and reloads `prohibited_terms.json` from the data directory without a restart; `/Post-Gate holds` lists the members currently in Post Gate.",
      "Recognized moderators are always exempt, and privacy-excluded channels are never queued at Levels 1–2.",
    ],
  },
  {
    id: "level",
    section: COMMAND_SECTIONS.SETUP,
    route: "level",
    access: "fetch_manager",
    syntax: "/Level [status|1|2|3|4 confirm]",
    summary: "Inspect or change the server-wide moderation policy level.",
    help: "Set link/media review or server lockdown behavior _(admins/mods only)_",
    permission:
      "Server owner, Manage Server, or a recognized moderation capability",
    examples: [
      "/Level status",
      "/Level 1",
      "/Level 2",
      "/Level 3",
      "/Level 4 confirm",
    ],
    notes: [
      "An Enka-approved Post Gate review channel must be configured first.",
      "Levels 1 and 2 hold qualifying links/media; Levels 3 and 4 remove Send Messages from the server default role and delete slipped regular-member posts without queueing them.",
      "Irminsul needs Manage Permissions and explicit review-channel View/Send access; trusted staff and bot roles also need explicit Send Messages during lockdown.",
      "Level 4 requires a two-minute invoker-only reaction confirmation and automatically bans authors whose messages reach Irminsul through an explicit permission override.",
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
    id: "server-info",
    section: COMMAND_SECTIONS.SETUP,
    route: "server-info",
    access: "fetch_manager",
    syntax: "/Server-Info",
    summary:
      "Show local server, archive, bot-health, and safe VPS diagnostics.",
    help: "Show server, archive, feature-health, and safe VPS diagnostics _(admins/mods only)_",
    permission:
      "Server owner, Manage Server, or a recognized moderation capability",
    examples: ["/Server-Info"],
    notes: [
      "Uses cached and local data only; it does not make live Stoat requests.",
      "Hostnames, IP addresses, filesystem paths, secrets, and environment values are never shown.",
    ],
  },
  {
    id: "ban",
    section: COMMAND_SECTIONS.MODERATION,
    route: "ban",
    access: "ban",
    syntax: "/Ban <@member|account ID> <reason>",
    summary:
      "Confirm and ban a current, departed, or never-joined account, then choose a message-cleanup window by reaction.",
    help: "Ban a current or never-joined account by mention or raw ID after ✅ confirmation, then pick a cleanup window (1h–1y). The 10-minute ↩️ undo only unbans _(Ban Members; cleanup also needs Manage Messages)_",
    permission: "Ban Members; Manage Messages is also required for cleanup",
    examples: [
      "/Ban @member for spamming and stuff",
      "/Ban 01ABCDEFGHJKMNPQRSTVWXYZ12 for coordinating a raid",
      "/Ban for coordinating a raid 01ABCDEFGHJKMNPQRSTVWXYZ12",
    ],
    notes: [
      "Write the reason in plain words; the account, an optional window, and the reason may appear in any order — a bare account ID is recognized anywhere in the command, not only first.",
      "Stoat's native ban endpoint accepts raw account IDs, so the target does not need to be a current or former server member. Use this for a departed or never-joined account; /Kick and /Mute require a current member.",
      "A plain-text @Username#1234 (not a real mention) resolves only if Irminsul already has that exact account cached from a shared server; otherwise use an actual @mention or a raw account ID.",
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
    help: "Confirm with ✅, then pick a cleanup window (1h–1y) by reaction. There is no undo; the member must rejoin with an invite _(Kick Members)_",
    permission: "Kick Members; Manage Messages is also required for cleanup",
    examples: [
      "/Kick @member for raiding",
      "/Kick @member 1d throwaway account",
    ],
    notes: [
      "Because a kick cannot be undone, nothing happens until the moderator who ran the command reacts ✅.",
      "The target must be a current server member; use /Ban for a departed or never-joined account.",
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
      "The target must be a current server member; a departed account cannot be muted.",
    ],
  },
  {
    id: "purge-user",
    section: COMMAND_SECTIONS.MODERATION,
    route: "purge-user",
    access: "manage_messages",
    syntax: "/Purge-User @member <reason>",
    summary: "Confirm and delete a member's messages observed by Irminsul.",
    help: "Pick a window by reaction (1h–1y), then ✅/❌ to confirm. Audit evidence is preserved _(Manage Messages)_",
    permission: "Manage Messages",
    examples: [
      "/Purge-User @member because of spam",
      "/Purge-User @member 1y scam link flood",
    ],
    notes: [
      "Protected audit records and retained evidence are never erased by a purge.",
    ],
  },
  {
    id: "get-info",
    section: COMMAND_SECTIONS.MODERATION,
    route: "get-info",
    access: "fetch_manager",
    syntax: "/Get-Info <@member|account ID>",
    summary:
      "Look up account, membership, ban, archive, and bot-risk detail for current, departed, banned, or never-joined accounts.",
    help: "Tiered account, membership, ban, archive, and bot-risk detail for any Stoat account ID _(admins/mods only)_",
    permission:
      "Server owner, Manage Server, or a recognized moderation capability",
    examples: ["/Get-Info @member", "/Get-Info 01ABCDEFGHJKMNPQRSTVWXYZ12"],
    notes: [
      "The lookup scope states whether the target is current, banned, former, visible elsewhere, platform-only, or inconclusive.",
      "Ban reasons require Irminsul to have Ban Members; without it, the report states that a local ban could not be ruled out.",
      "For accounts cached in another mutual server, the report names up to three of those servers to authorized moderators.",
      "A plain-text @Username#1234 (not a real mention) resolves only if Irminsul already has that exact account cached from a shared server; Stoat has no username search, so an uncached non-member can only be looked up by account ID.",
      "Signals are heuristics for a moderator to look at, not proof an account is a bot.",
      "Messages sent counts only what the archive observed while audit logging was active; deleted and purged messages are excluded.",
    ],
  },
  {
    id: "post-gate-review",
    section: COMMAND_SECTIONS.MODERATION,
    route: "post-gate approve",
    routeAliases: [
      "post-gate reject",
      "post-gate deny-hold",
      "post-gate release",
    ],
    access: "manage_messages",
    syntax: "/Post-Gate approve QUEUE_ID",
    summary:
      "Clear the author of a held post, discard it with a strike, or discard it and hold every later message from that author.",
    help: "React ✅/❌/🔒 on the held-post review card, or use `/Post-Gate approve|reject|deny-hold QUEUE_ID` _(Manage Messages)_",
    permission: "Manage Messages in the review channel",
    examples: [
      "/Post-Gate approve PGABCDEF01234567",
      "/Post-Gate reject PGABCDEF01234567",
      "/Post-Gate deny-hold PGABCDEF01234567",
      "/Post-Gate release @member",
    ],
    notes: [
      "Approving clears the author and resets their automod strike; it does not repost the held content, which the author may post again themselves.",
      "Rejecting discards the held content and increases the author's automod strike stage; it does not apply a timeout by itself.",
      "Deny + Hold User (🔒) also places the author in Post Gate, so every later message they send is held until a moderator releases them. A persistent control card in the review channel records who held them and when.",
      "Release (🔓 or `/Post-Gate release @member`) restores normal posting straight away; messages already in the review queue stay queued and are reviewed individually.",
      "A standing hold never expires on its own. After 24 hours (configurable with POST_GATE_HOLD_REMINDER_HOURS) Irminsul reminds moderators and offers Release / Continue Holding.",
      "Unreviewed holds expire and are discarded after 7 days.",
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
