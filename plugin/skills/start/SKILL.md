---
name: start
description: Start docket in the current worktree and ingest the review findings already available, so they can be tracked and resolved.
disable-model-invocation: true
argument-hint: "[path-to-local-review-report]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/docket *), Bash(docket *), Bash(gh *), Bash(git *), Read
---

# Start docket

Docket stays dormant in a worktree until the user starts it. This skill starts it, then ingests what is already there.

1. Run `docket start --json`. If the result has an `error`, tell the user the message and stop.
2. Tell the user that docket is active on branch `unit.branch`, and name the PR when `unit.pr` is set.
3. Ingest now, with the procedure below. The user should not need to run `/docket:ingest` after this.
4. After the ingest report, tell the user they can see and decide on findings in the Docket pane: run `/docket`. The pane also runs research, apply and replies. `docket ui --open` opens the same view in a browser.

Do not research or change code in this skill.

- Session id: `${CLAUDE_SESSION_ID}`
- File: `$ARGUMENTS` (none when this is empty)

!`${CLAUDE_PLUGIN_ROOT}/bin/docket procedure ingest`
