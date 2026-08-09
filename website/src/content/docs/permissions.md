---
title: Permissions
description: How Irminsul decides who can run member, setup, audit, automod, and manual moderation commands.
---

Irminsul uses Stoat's **effective permissions**, not role names. A role called “Admin” or “Mod” does not grant access by its name alone.

## Access matrix

| Capability                                                 | Commands                                                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every human server member                                  | `/Fetch*`, `/HelpHoyoFetch`, `/Docs`, `/Report-Spam`                                                                                                                           |
| Owner, Manage Server, or a recognized moderator capability | Auto-fetch, emoji mode, audit-log configuration/testing and privacy exclusions, restart, `/Server-Info`, automod configuration, post-gate configuration, `/Level`, `/Get-Info` |
| Ban Members                                                | `/Ban`, automod ban approval                                                                                                                                                   |
| Kick Members                                               | `/Kick`                                                                                                                                                                        |
| Timeout Members                                            | `/Mute`, `/Automod release`                                                                                                                                                    |
| Manage Messages in the current channel                     | `/Purge-User`; also required for `/Ban`, `/Kick`, and `/Mute` message cleanup, and for `/Post-Gate approve\|reject` in the review channel                                      |

Recognized moderator capabilities for management commands are **Kick Members**, **Ban Members**, **Timeout Members**, or effective **Manage Messages** in the current channel. The server owner and members with **Manage Server** also qualify.

`/Get-Info` remains available under that recognized-moderator policy. Giving Irminsul **Ban Members** improves non-member results by allowing it to confirm bans and show the stored ban reason; without that permission, the report explicitly says a ban could not be ruled out.

`/AuditLog` configuration, `/Exclude-Channel`, and `/Post-Gate` configuration all use the recognized-moderator policy shown above. Enabling, moving, or disabling any of them still requires a separate one-time code sent exclusively to **Enka#4961**. `/AuditLog status`, `/AuditLog test`, `/Post-Gate status`, and reviewing a held post with `/Post-Gate approve|reject` are read-only or immediately reversible and never require that approval.

Once the Post Gate review channel is approved, the same recognized-moderator policy may select server Levels 1–3 and start `/Level 4 confirm`. Level 4 still requires the requester's second ✅ reaction, plus a fresh check of the requester and Irminsul's Ban Members permission.

Levels 3–4 require Irminsul to have **Manage Permissions**. Its bot role must explicitly retain **View Channel** and **Send Messages** in the protected review channel after the server default role loses Send Messages; inherited default access is not sufficient. **Manage Messages** should be granted wherever slipped-message deletion is expected, but a missing deletion permission produces a warning rather than preventing the permission lock. Trusted staff and bot roles that need to keep posting during lockdown also require an explicit Send Messages grant.

`/Report-Spam` is member-accessible, but Irminsul itself must have freshly verified **Manage Messages** in the source channel. This lets it remove the sensitive invocation before parsing or recording the report.

## Exact checks for destructive actions

Manual moderation does not treat all moderators as interchangeable. Irminsul refreshes both the moderator and bot permission state before acting and requires the capability specific to the action.

For example, someone with Manage Messages can purge observed messages but cannot ban a member unless they also have Ban Members.

## Automod approval is stricter

Automod configuration uses the broader moderator policy. A permanent-ban approval requires the server owner, **Manage Server**, or **Ban Members**. Manage Messages alone cannot approve a ban.

## Fail-closed behavior

If member, server, channel, hierarchy, or permission information cannot be refreshed safely, Irminsul rejects or downgrades the action. It does not infer access from a role name or stale partial context.
