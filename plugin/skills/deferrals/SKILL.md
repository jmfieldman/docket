---
name: deferrals
description: Review deferred docket work across all repositories and pick an item up, mark it done, or drop it.
disable-model-invocation: true
argument-hint: "[deferral-id]"
allowed-tools: Bash(docket *), Bash(gh *), Bash(git *), Read
---

# Deferred work

Deferrals live in `~/.docket/deferrals/` (or `$DOCKET_HOME/deferrals/`), outside any worktree. This skill works from any directory, and docket does not need to be active.

## 1. List

Run `docket deferrals list --json`. If `$ARGUMENTS` names an id, work on that one. Otherwise show the open and picked-up items, oldest first: id, status, repository, title.

## 2. Check each item before the user decides

For an item the user is interested in, run `docket deferrals show <id>` and check:

1. **Did the origin branch land?** If `origin.pr` is set, run `gh pr view <url> --json state,mergedAt`. If the PR closed without merging, say so: the deferral may be moot.
2. **Does the code still exist?** In a clone of `origin.repo`, on the default branch, search for each `codeRefs[].symbol` (the line number is only a hint).
3. **Is it already fixed?** Read the code against the "Done when" section.

Report what you found and recommend: pick up, drop, or mark done.

## 3. Act on the user's choice

- **Pick up**: ask where the work will happen (a new worktree, a branch, a ticket). If the user wants a worktree, offer `git -C <clone of origin.repo> worktree add -b <slug> ../<slug> <default branch>`, and give them the deferral body to paste into a Claude Code session there. Then record it: `docket deferrals pickup <id> --ref "<branch, PR URL, ticket or brain page>" --by <who>`.
- **Done**: `docket deferrals done <id> --reason "<where it landed>"`. The file moves to `archive/`.
- **Drop**: `docket deferrals drop <id> --reason "<why it is no longer needed>"`. The file moves to `archive/`.

Never delete a deferral file.
