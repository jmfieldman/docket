---
name: record
description: Record that work in this session resolved a finding docket is tracking. Use only when the session brief says "Docket is active in this worktree" and you just committed a change that fixes one of the listed open findings.
allowed-tools: Bash(docket *), Bash(git *)
---

# Record session work on a docket finding

!`"${CLAUDE_PLUGIN_ROOT}/bin/docket" status`

If the line above does not say "Docket is active.", do nothing more with docket in this session.

Use this when the user and you fixed a tracked finding in an ordinary session, outside the docket applier.

1. Identify the finding. Run `docket list --state open --json` and `docket show <id>`. If you are not sure the work resolves that exact finding, ask the user. Never create a finding.
2. Make sure the work is committed. Collect the commit shas (`git log --oneline`).
3. Verify: run the tests that cover the change, and confirm the reviewer's concern is addressed.
4. Record it:

```bash
docket record <id> --data '{
  "optionId": "<the research option you followed, or custom>",
  "instruction": "<what was done, when custom>",
  "commits": ["<sha>"],
  "verification": {"status": "passed", "checks": [{"name": "<test command>", "result": "passed"}, {"name": "concern re-check", "result": "passed"}]},
  "summary": "<one line: what changed>"
}'
```

Add `"also": ["f-0004"]` when the same change resolved other open findings.

5. If the result has a `warning`, tell the user. Tell the user the finding is recorded and shows as "inferred" in the Docket pane.
