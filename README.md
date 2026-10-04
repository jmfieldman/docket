# orca-docket

Docket collects review findings on a branch and helps you resolve each one. It works with any review agent or reviewer.

Reviewers post findings in many formats: inline code comments, one large PR comment, review bodies, or a local report file. Docket converts all of them into one data model. Each finding then moves through research, decision and fix on its own, so easy findings do not wait for hard ones.

## Components

| Component | Status | Purpose |
|---|---|---|
| `spec/` | v1 draft | Data model, JSON Schemas, examples |
| `docket` CLI | Activation done | The only writer of docket files |
| `docket-ingest` skill | Not started | Converts PR comments or a local report into findings, incrementally |
| `docket-research` skill | Not started | Investigates each finding and writes options with pros and cons |
| `docket-discuss` skill | Not started | Read-only conversation about one finding. Updates the finding as it goes. |
| `docket-apply` skill | Not started | Applies decided findings in order, one commit each, then verifies and closes them |
| `docket-reply` skill | Not started | Drafts replies to reviewers. Posts only after approval. |
| `docket-deferrals` skill | Not started | Lists deferred work across all repos and picks it up later |
| `SessionStart` hook | Not started | Briefs agent sessions on open findings, only in worktrees where docket is started |
| Orca plugin | Not started | Right-pane panel: start or pause docket, findings grouped by lane, quick fix, queue |

## Data model

Read [spec/SPEC.md](spec/SPEC.md). In summary:

- Docket is dormant in a worktree until you start it. Paused or never started, no skill or hook acts.
- Each git worktree has one docket at `$(git rev-parse --git-dir)/docket/`. The docket is deleted with the worktree.
- Each researched finding has a complexity score and a confidence score. They place it in one of four lanes: `quick`, `decide`, `scope`, `dig`.
- Deferred work goes to `${DOCKET_HOME:-~/.docket}/deferrals/` as self-contained markdown files, so it outlives the worktree.
- Each finding is one file with its own state, `rev` counter, and history of iterations by commit.
- A finding closes as `completed` (fixed and verified), `acknowledged` (no change, with a reason), `deferred`, or `resolved_externally`.
- Research and discussion only read code, so they run in parallel. Only the applier edits code, one finding at a time.

## CLI

Build and put `docket` on your PATH:

```bash
pnpm install
pnpm run build
pnpm link --global
```

| Command | Effect |
|---|---|
| `docket start` | Start docket in this worktree, or resume it if paused |
| `docket status` | Exit 0 active, 10 not started, 11 paused, 12 branch mismatch |
| `docket pause` | Make every docket skill and hook dormant. The data stays. |
| `docket resume` | Make a paused docket active again |
| `docket rebind` | Confirm that the branch was renamed |

Every command accepts `-C <path>`, `--json` and `--quiet`. Skills and hooks gate on `docket status --quiet`.

## Development

```bash
pnpm run check   # typecheck, tests, spec validation
```

Tests create temporary git repos and worktrees. Node 23.6 or later runs the TypeScript sources directly.
