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
| `docket-investigate` skill | Not started | Read-only session for one finding that needs discussion |
| `docket-apply` skill | Not started | Applies decided findings in order, one commit each |
| `docket-reply` skill | Not started | Drafts replies to reviewers. Posts only after approval. |
| Orca plugin | Not started | Right-pane panel to review findings, decide, and queue |

## Data model

Read [spec/SPEC.md](spec/SPEC.md). In summary:

- Each git worktree has one docket at `$(git rev-parse --git-dir)/docket/`. The docket is deleted with the worktree.
- Each finding is one file with its own state and `rev` counter.
- Research and investigation only read code, so they run in parallel. Only the applier edits code, one finding at a time.

## Validate the spec

```bash
pnpm install
pnpm run spec:validate
```
