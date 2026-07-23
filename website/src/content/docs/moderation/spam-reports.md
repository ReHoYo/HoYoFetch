---
title: Member spam reports
description: Privately report suspected friend-request, DM, commission, or scam spam without creating an automatic punishment.
---

`/Report-Spam` lets a current server member privately submit an allegation for review:

```text
/Report-Spam @member sent an unsolicited commission scam DM
/Report-Spam @member for repeated friend-request spam
/Report-Spam @member reason: sent an unsolicited commission scam DM
```

Describe what happened in your own words, the way the moderation commands read. The reported account
may be mentioned anywhere in the sentence, a leading `for` or `because` is treated as filler, and the
older `reason:` delimiter still works.

The description must contain 10–300 characters. The target must be a current member of the same
server.

## Secure intake

Stoat commands are ordinary channel messages, not ephemeral interactions. Irminsul therefore accepts this command only where it can freshly verify its own **Manage Messages** permission.

The intake order is deliberate:

1. verify that Irminsul can manage messages in the source channel;
2. delete the invocation;
3. apply the report-specific attempt limit;
4. parse and verify the target, reporter, and server; and
5. securely record the report.

If deletion fails, no report is accepted. Public success messages contain only an opaque report ID and never repeat the target or reason.

## Abuse controls

- One attempt per reporter per server per minute.
- At most three accepted reports per reporter per server in a rolling 24-hour window.
- One accepted report from the same reporter against the same target per 24 hours.
- Reports against the reporter, Irminsul, or the server owner are rejected.
- Reporter and target membership are freshly checked.
- Active links, mentions, and formatting are neutralized in the staff-visible reason.

Three unique reporters against the same target within 24 hours raise the review priority. Duplicate reports from one person do not increase that count.

## Review information

The secured report includes the report ID, reporter, target, source channel, sanitized reason, unique-reporter count, and whether the priority threshold was reached. It also states that no automatic action occurred.

Reports are allegations, not proof. Staff should review available messages, ask the reporter for evidence through an appropriate private process, and use the normal moderation commands only when independently justified.

## Platform limitation

Irminsul cannot inspect friend requests or DMs exchanged between ordinary users. Stoat's relationship events describe only the authenticated bot account's own relationships. This feature therefore relies on member-submitted reports rather than private-account surveillance.

## Stored data

The secured report retains the sanitized reason through Irminsul's existing tamper-protection system. `spam_reports.json` stores only correlation metadata and does not duplicate the reason.

Correlation metadata is retained for 30 days and capped at 10,000 records.
