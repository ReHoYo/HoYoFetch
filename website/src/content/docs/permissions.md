---
title: Permissions
description: How Irminsul decides who can run member, setup, audit, automod, and manual moderation commands.
---

Irminsul uses Stoat's **effective permissions**, not role names. A role called “Admin” or “Mod” does not grant access by its name alone.

## Access matrix

| Capability                                                 | Commands                                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Every human server member                                  | `/Fetch*`, `/HelpHoyoFetch`, `/Docs`, `/Report-Spam`                                    |
| Owner, Manage Server, or a recognized moderator capability | Auto-fetch, emoji mode, audit-log configuration/testing, restart, automod configuration |
| Ban Members                                                | `/Ban`, automod ban approval                                                            |
| Kick Members                                               | `/Kick`                                                                                 |
| Timeout Members                                            | `/Mute`, `/Automod release`                                                             |
| Manage Messages in the current channel                     | `/Purge-User`; also required for `/Ban`, `/Kick`, and `/Mute` message cleanup           |

Recognized moderator capabilities for management commands are **Kick Members**, **Ban Members**, **Timeout Members**, or effective **Manage Messages** in the current channel. The server owner and members with **Manage Server** also qualify.

`/Report-Spam` is member-accessible, but Irminsul itself must have freshly verified **Manage Messages** in the source channel. This lets it remove the sensitive invocation before parsing or recording the report.

## Exact checks for destructive actions

Manual moderation does not treat all moderators as interchangeable. Irminsul refreshes both the moderator and bot permission state before acting and requires the capability specific to the action.

For example, someone with Manage Messages can purge observed messages but cannot ban a member unless they also have Ban Members.

## Automod approval is stricter

Automod configuration uses the broader moderator policy. A permanent-ban approval requires the server owner, **Manage Server**, or **Ban Members**. Manage Messages alone cannot approve a ban.

## Fail-closed behavior

If member, server, channel, hierarchy, or permission information cannot be refreshed safely, Irminsul rejects or downgrades the action. It does not infer access from a role name or stale partial context.
