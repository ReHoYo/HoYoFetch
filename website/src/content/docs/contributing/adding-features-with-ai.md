---
title: A Guide for Adding Contributions to Irminsul / New Features with Claude Code or ChatGPT Codex
description: A safe, beginner-friendly workflow for planning, building, testing, and reviewing Irminsul contributions with an AI coding agent.
---

Irminsul is now maintained by its moderator community. You do not need to know every file before contributing, but you do need to make each change reviewable, testable, and safe for the people whose messages and moderation records the bot handles.

This tutorial takes one feature from an idea to a draft pull request using either [Claude Code Desktop](https://code.claude.com/docs/en/desktop) or [ChatGPT Codex](https://learn.chatgpt.com/docs/app). The screens differ, but the discipline is the same:

> **Plan first, approve the plan, implement in isolation, review the diff, validate it, and ask another person to review it.**

:::caution[An AI coding agent is not the maintainer]
Claude Code and Codex can inspect and change the repository, but you remain responsible for the feature's behavior. Never give an agent a bot token, personal access token, production `.env` file, private moderation evidence, invite code, webhook token, or other secret.
:::

## Before you begin

You need:

- a GitHub account with permission to contribute to `ReHoYo/HoYoFetch`, or a fork from which you can open a pull request;
- [Git](https://git-scm.com/downloads) installed and signed in to GitHub through a credential manager;
- Node.js 18 or newer;
- Claude Desktop with access to its **Code** tab, or the ChatGPT desktop app with **Codex**; and
- a local clone of the repository.

Clone and install Irminsul from a terminal:

```bash
git clone https://github.com/ReHoYo/HoYoFetch.git
cd HoYoFetch
npm ci
npm --prefix website ci
```

These commands assume you can push branches to the main repository. If you need to contribute through a fork, create the fork on GitHub first, clone the fork instead, and add `https://github.com/ReHoYo/HoYoFetch.git` as an `upstream` remote. Synchronize from `upstream/main` and push your feature branch to your fork's `origin`.

If you already have a clone, update it before starting a feature:

```bash
git switch main
git fetch origin
git pull --ff-only origin main
```

The `--ff-only` option stops instead of silently creating a merge commit when your local `main` has diverged. Ask another contributor for help if it stops.

Open the **HoYoFetch repository folder** in the coding agent. Do not open its parent folder, an empty folder, the production VPS, or a directory containing unrelated projects.

:::tip[Keep production separate]
Develop in a clone on your computer. Use fake or disposable test data and a dedicated Stoat test server. Production deployment is a separate, human-approved operation described in [Self-hosting](/HoYoFetch/administration/self-hosting/).
:::

## The contribution workflow

Use this sequence for every feature, even when the idea looks small:

1. Start from the latest `main`.
2. Isolate the work in a feature branch or desktop worktree.
3. Describe one focused outcome and its success criteria.
4. Enter **Plan mode before allowing edits**.
5. Read the plan, challenge assumptions, and request corrections.
6. Approve the final plan and let the agent implement it.
7. Review every changed file and run the validation gates.
8. Exercise platform-facing behavior in a test server.
9. Open a draft pull request and ask another moderator to review it.

Do not combine unrelated ideas in one session or pull request. “Add a queue limit to Post Gate” is reviewable. “Improve moderation, rewrite the help system, and clean up the code” is not.

## Step 1: isolate the change

An isolated branch keeps unfinished work away from `main` and makes the final diff understandable.

For a local session, create a branch first:

```bash
git switch -c feature/short-description
```

Use a short name such as `feature/post-gate-queue-limit` or `fix/audit-retry-status`. Do not develop directly on `main`.

Both desktop tools can also create isolated Git worktrees. A worktree is a separate checkout connected to the same repository. It is useful when you want to keep `main` untouched or work on more than one contribution at a time.

- In **Claude Desktop**, start a new Code session for the repository and use its automatic worktree isolation when offered.
- In **ChatGPT Codex**, choose **Worktree** for an isolated checkout. Choose **Local** only when you have already created and selected the intended feature branch.

One feature should have one branch, one worktree, and one primary agent session. Parallel agents must not edit the same files unless you deliberately coordinate them.

## Step 2: write a focused feature request

Before opening Plan mode, write down:

- the problem a moderator or member experiences;
- the exact behavior you want;
- who may use it and what permission they need;
- what must remain unchanged;
- failure behavior;
- examples of success and rejection; and
- whether it changes stored data, documentation, or production operation.

A useful request looks like this:

```text
Add a bounded per-server limit to the Post Gate review queue.

Success means:
- moderators can see the configured limit in Post Gate status;
- a full queue fails closed without losing the original accountability record;
- existing servers keep their current behavior by default;
- no raw message content or account IDs are added to diagnostics;
- unit tests, command/help metadata, configuration docs, and Post Gate docs stay synchronized.

Do not edit anything yet. Inspect the current implementation in Plan mode first.
```

Avoid prompts such as “make this better,” “add whatever is needed,” or “fix all related code.” They leave important product decisions to the agent and make accidental scope growth difficult to spot.

## Step 3: use Plan mode

### Claude Code Desktop

1. Open Claude Desktop and select the **Code** tab.
2. Start a session with the HoYoFetch repository as the project folder.
3. Choose the intended local or worktree environment.
4. Use the mode selector next to the send button and select **Plan**.
5. Send the planning prompt below.
6. Read the proposed plan. Choose the option to keep planning when anything is vague, missing, or based on an assumption.
7. Approve only the final, corrected plan. For a first contribution, choose the option that lets you manually review edits.

Claude's Plan mode reads and explores the project without editing source files. The mode must be selected in the UI; merely writing “please plan” is not the same permission boundary. See Anthropic's [Plan mode reference](https://code.claude.com/docs/en/permission-modes) for the current controls.

### ChatGPT Codex

1. Open ChatGPT, select **Codex**, and start a new task.
2. Select the HoYoFetch repository folder.
3. Choose **Worktree** for automatic isolation, or **Local** if you already created the feature branch.
4. Select **Plan** from the mode or collaboration control before sending the request.
5. Send the planning prompt below.
6. Answer the agent's product questions and ask it to revise weak or incomplete sections.
7. Accept the plan only when it is decision-complete, then switch to the normal implementation mode and explicitly request implementation.

Codex can run locally in the selected project or in an isolated worktree. OpenAI's [environment reference](https://learn.chatgpt.com/docs/environments/modes) explains that distinction.

### Reusable planning prompt

Copy this prompt, then replace the bracketed sections:

```text
We are planning one contribution to Irminsul.

Goal:
[Describe the user-visible outcome.]

Success criteria:
[List observable behaviors, permissions, failures, and compatibility requirements.]

Constraints:
- Do not edit files, create commits, push, open a PR, deploy, or contact external services.
- Inspect the current checkout before proposing changes. Do not assume a route, API, schema, or module exists.
- Trace the full behavior from message input through command routing, authorization,
  validation, persistence, protected output, help/catalog metadata, and documentation.
- Preserve unrelated behavior and existing stored data.
- Keep diagnostics developer-only and redact tokens, raw account IDs, invite codes,
  webhook material, unsafe URLs, and private evidence.
- Identify edge cases, failure modes, exact validation commands, and live Stoat QA.
- Ask me about product decisions that the repository cannot answer.

Return a decision-complete implementation plan. Name the important integration points,
tests, documentation, compatibility concerns, and acceptance criteria.
```

### Why the plan matters

Plan mode is not a ceremonial step or a prettier to-do list. A good plan proves that the agent found the real architecture before it writes code. It should tell you:

- where input enters and how the route reaches its handler;
- which permission and validation boundaries apply;
- what state changes and how older state remains readable;
- what can fail before, during, and after a mutation;
- how sensitive data stays out of public output and logs;
- what automated tests demonstrate; and
- what still requires live verification on Stoat.

Reject or revise a plan when it says “update the relevant files,” invents an API, cannot name the authorization path, ignores existing tests, or treats a successful build as proof that a live workflow works.

## Step 4: review the Irminsul-specific plan

Use the following checklist before approving implementation.

### Commands and authorization

- Does a new or changed public command update `command-catalog.js`?
- Does `command-routing.js` map the canonical route to the real handler?
- Does `security.js` enforce the correct capability without weakening other commands?
- Are actor, target, bot permission, hierarchy, channel, and server checks refreshed when needed?
- Do in-chat help, the website, and authorization all describe the same command?

Read [Commands](/HoYoFetch/commands/) and [Permissions](/HoYoFetch/permissions/) before changing a public route.

### Feature ownership

- Does the change extend the module that already owns the behavior?
- For moderation, audit logging, Automod, Post Gate, code fetching, or protected messages, did the agent trace the adjacent modules rather than adding a disconnected shortcut?
- Does failure stop before a mutation when authorization or validation is uncertain?

Use [Architecture](/HoYoFetch/administration/architecture/) to locate the existing ownership boundaries.

### State and compatibility

- Is persistent data written atomically through existing storage helpers?
- Can the current release read old records after the change?
- Is a migration necessary, and is it bounded, restart-safe, and testable?
- Are in-memory queues, caches, retries, files, and retention periods bounded?
- Does a restart preserve only the state that should survive?

Do not approve a destructive migration without a human-written backup and rollback procedure.

### Privacy and diagnostics

- Are bot tokens, session material, webhook tokens, usable invite codes, unsafe URLs, and private evidence excluded?
- Are account and server identifiers redacted from developer diagnostics unless strictly required for a protected internal operation?
- Does moderator-visible output avoid republishing prohibited or private content?
- Does a privacy or retention change receive explicit human review?

Review [Configuration](/HoYoFetch/administration/configuration/) before adding an environment setting.

### Tests and documentation

- Does each new success, denial, retry, malformed input, and compatibility path have a test?
- Are command catalog, help output, configuration examples, architecture, and feature docs updated where applicable?
- Is the behavior described without promising more than the code or Stoat platform can prove?
- Does the plan include live test-server acceptance steps for platform behavior?

## Step 5: approve and implement

Once the plan is complete, leave Plan mode and send this implementation prompt:

```text
Implement the approved plan on the current feature branch/worktree.

- Keep the change within the approved scope.
- Preserve unrelated work and compatibility.
- Add or update focused tests and documentation as you implement.
- Run the full validation gates when finished.
- Do not commit, push, open or merge a PR, deploy, use production credentials,
  or make external writes unless I separately ask for that action.
- Report the changed behavior, validation evidence, remaining live QA, and any
  assumption that could not be verified.
```

Stay present while the agent works. Answer questions with product intent, not guesses about code. If it discovers that the approved design was based on a false assumption, stop implementation and return to Plan mode.

## Step 6: review the diff yourself

An agent saying “done” is the beginning of review, not the end. Inspect the working tree:

```bash
git status --short
git diff --stat
git diff
```

In either desktop app, open the visual changes or diff pane and read every changed file. Check that:

- only files required by the feature changed;
- no `.env`, token, personal data, local database, moderation evidence, build output, or unrelated generated artifact is present;
- the implementation matches the approved plan;
- permission failures stop safely;
- tests check behavior rather than only helper functions;
- comments and documentation match the code;
- no debug bypass, temporary logging, or hard-coded identifier remains; and
- large mechanical rewrites are separated from behavior changes or removed.

If you do not understand a change, ask the agent to explain the input, state change, failure path, and test that covers it. Do not approve code you cannot explain to the next moderator.

## Step 7: run the validation gates

From the repository root, run:

```bash
npm ci
npm --prefix website ci
npm run lint
npm test
npm run docs:build
npm run format:check
git diff --check
```

What these commands prove:

- `npm ci` installs exactly the locked dependency versions.
- `npm --prefix website ci` installs the separately locked documentation dependencies.
- `npm run lint` checks JavaScript correctness and repository rules.
- `npm test` runs the Node test suite.
- `npm run docs:build` checks and builds Irminsul Docs, including internal links.
- `npm run format:check` detects files that do not match the repository format.
- `git diff --check` detects whitespace errors in the proposed change.

Do not replace the full gates with one focused test. Focused tests are useful while editing; the complete suite catches effects in adjacent systems.

## Step 8: perform live Stoat QA

Automated tests cannot prove that Stoat permissions, gateway payloads, reactions, attachment claims, REST errors, or protected messages behave like mocks. Any platform-facing change needs a separate acceptance pass in a test server.

Use disposable test accounts and non-production channels. Test at least:

1. the intended successful path;
2. an unauthorized member;
3. missing bot permission;
4. malformed, missing, expired, or duplicated input;
5. restart behavior when state should persist;
6. simultaneous or repeated actions where races are possible;
7. protected output and redaction; and
8. recovery from a denied request or temporary Stoat failure.

Record what you actually observed for the pull request. Keep a feature marked **not live-verified** until this pass succeeds. Never test bans, locks, purges, privacy deletion, or migrations against the production server first.

## Step 9: prepare a draft pull request

After the diff and gates pass, create a focused commit:

```bash
git status --short
git add path/to/intended-file path/to/its-test
git diff --cached
git commit -m "Add short feature description"
git push -u origin feature/short-description
```

Stage explicit paths rather than blindly staging everything. Authenticate through GitHub's normal credential manager; never paste a personal access token into an agent prompt or commit it to the repository.

Open a **draft** pull request against `main`. Its description should include:

- the user or moderator problem;
- the chosen behavior and important non-goals;
- the main security, permission, privacy, or compatibility decisions;
- automated validation commands and results;
- live test-server scenarios and results, or a clear “not yet live-verified” note;
- screenshots only when they contain no private data; and
- any migration, operator action, rollback step, or known limitation.

Ask another moderator to review it. Do not merge your own security-sensitive, moderation, permission, privacy, persistence, or deployment change without a second human review. Resolve findings, rerun the gates, and update the QA evidence before marking the pull request ready.

## Stop and ask a human

Stop the agent and obtain explicit approval before it:

- connects to, restarts, or deploys production;
- reads, copies, rotates, or reuses credentials;
- deletes or rewrites persistent data;
- changes who may moderate, view evidence, or bypass a protection;
- changes archive, evidence, or privacy retention;
- sends external messages, changes GitHub settings, merges a pull request, or publishes a release;
- performs a destructive Git or filesystem command; or
- encounters product behavior that the repository and written request do not decide.

An agent requesting broader authority is a decision point, not an inconvenience to click through.

## Common mistakes to avoid

- **Coding before tracing the route:** a helper test can pass while the live command never reaches it.
- **Accepting a vague plan:** “update the relevant modules” hides architectural guesses.
- **Trusting an invented API:** require the agent to inspect installed SDK code or current primary documentation.
- **Mixing several features:** unrelated changes make review and rollback harder.
- **Letting the agent deploy automatically:** a merged or tested change is not permission to touch production.
- **Treating tests as live proof:** mocks do not establish real Stoat behavior.
- **Pasting secrets into chat:** prompts and transcripts are not secret managers.
- **Skipping the diff:** validation can pass while an unrelated file or unsafe diagnostic slips in.
- **Working directly on `main`:** unfinished work becomes difficult to isolate or discard.
- **Merging without another reviewer:** AI-generated code still needs accountable human review.

## When something goes wrong

Do not ask the agent to “try random fixes.” Return to Plan mode with the exact command, error, and relevant redacted output. Ask it to identify the first failing boundary, prove the cause from current source, and propose the smallest correction before editing.

Use [Troubleshooting](/HoYoFetch/troubleshooting/) for known runtime problems and [Self-hosting](/HoYoFetch/administration/self-hosting/) for operator checks. If a change cannot be explained, validated, or safely rolled back, leave the pull request in draft.
