---
name: apply
description: Implement queued docket findings one at a time, in queue order, with one commit and a verification per finding.
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/docket *), Bash(docket *), Bash(git *), Read, Edit, Write, Grep, Glob, Bash
---

# Apply queued findings

!`${CLAUDE_PLUGIN_ROOT}/bin/docket status`

If the line above does not say "Docket is active.", stop and tell the user to start docket first.

You are the only agent that edits code for docket in this worktree. Work through the queue one finding at a time. Never push.

## Loop

1. Run `docket apply next --session-id ${CLAUDE_SESSION_ID} --json`. If it prints `null`, the queue is empty: report what you did and stop.
2. The result has `finding`, `iteration` (with `decision.optionId`, `decision.kind`, `decision.instruction`) and `option` (the chosen option, or null for a custom decision). Read the finding's `explanation`, `research.analysis` and the code at `location`.
3. **Check that the decision still fits the code.** The code can have changed since the decision. If the chosen fix no longer applies, or applying it would mean doing something the user did not choose, run `docket apply bounce <id> --reason "<what changed and why>"` and go back to step 1. Never substitute a different fix.
4. Implement exactly the chosen option and the instruction. Keep the change as small as the option describes.
5. Commit only the files you changed: `git add <files>` then `git commit -m "<type>: <finding title> (docket <id>)"`. Then run `docket apply commit <id> HEAD`.
6. **Verify.** Run the tests that cover the change (find them; run the narrowest command that exercises the code). Then read your diff against the reviewer's excerpts and confirm the concern is addressed. Record both:

   `docket apply verify <id> --data '{"status":"passed","checks":[{"name":"<test command>","result":"passed"},{"name":"concern re-check","result":"passed","detail":"<one line>"}]}'`

   If no automated test can cover it, use a `skipped` check and say why in `notes`. If a check fails, fix it and commit again (add each commit with `docket apply commit`). If you cannot make it pass, record `"status":"failed"` and run `docket apply bounce <id> --reason "<what failed>"`.
7. If the fix also resolves other open findings (check `docket list --state open --json`), name them. Complete:

   `docket apply complete <id> --summary "<one line: what changed>" [--also f-0003,f-0004]`

8. Go back to step 1.

## When the queue is empty

Report each finding: completed (with its commit) or bounced (with the reason). Remind the user that the commits are not pushed, and that `/docket:reply` drafts replies to reviewers.
