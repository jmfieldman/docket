---
name: start
description: Start docket in the current worktree so review findings on this branch can be tracked and resolved.
disable-model-invocation: true
allowed-tools: Bash(docket *)
---

# Start docket

Docket stays dormant in a worktree until the user starts it. This skill starts it.

1. Run `docket start --json`.
2. If the result has an `error`, tell the user the message and stop.
3. Tell the user that docket is active on branch `unit.branch`. If `unit.pr` is set, name the PR. If it is null, say that docket will attach the PR when one exists.
4. Tell the user the next step: run `/docket:ingest` to read the review comments on the PR, or `/docket:ingest <path>` to read a local review report.
5. Tell the user they can see and decide on findings in the Docket pane: run `/docket`. The pane also runs ingest, research, apply and replies for them. `docket ui --open` opens the same view in a browser.

Do not ingest, research or change code in this skill.
