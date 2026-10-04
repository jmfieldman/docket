# orca-docket

Docket collects review findings on a branch and helps you resolve each one. It works with any review agent or reviewer.

Reviewers post findings in many formats: inline code comments, one large PR comment, review bodies, or a local report file. Docket converts all of them into one data model. Each finding then moves through research, decision and fix on its own, so easy findings do not wait for hard ones.

## Components

| Component | Status | Purpose |
|---|---|---|
| `spec/` | v1 draft | Data model, JSON Schemas, examples |
| `docket` CLI | Not started | The only writer of docket files |
| `docket-ingest` skill | Not started | Converts PR comments or a local report into findings, incrementally |
| `docket-research` skill | Not started | Investigates each finding and writes options with pros and cons |
| `docket-discuss` skill | Not started | Read-only conversation about one finding. Updates the finding as it goes. |
| `docket-apply` skill | Not started | Applies decided findings in order, one commit each, then verifies and closes them |
| `docket-reply` skill | Not started | Drafts replies to reviewers. Posts only after approval. |
| `docket-deferrals` skill | Not started | Lists deferred work across all repos and picks it up later |
| Orca plugin | Not started | Right-pane panel to review findings, decide, quick fix, and queue |

## Data model

Read [spec/SPEC.md](spec/SPEC.md). In summary:

- Each git worktree has one docket at `$(git rev-parse --git-dir)/docket/`. The docket is deleted with the worktree.
- Deferred work goes to `${DOCKET_HOME:-~/.docket}/deferrals/` as self-contained markdown files, so it outlives the worktree.
- Each finding is one file with its own state, `rev` counter, and history of iterations by commit.
- A finding closes as `completed` (fixed and verified), `acknowledged` (no change, with a reason), `deferred`, or `resolved_externally`.
- Research and discussion only read code, so they run in parallel. Only the applier edits code, one finding at a time.

## Validate the spec

```bash
pnpm install
pnpm run spec:validate
```
