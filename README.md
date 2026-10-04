# orca-docket

Docket collects review findings on a branch and helps you resolve each one. It works with any review agent or reviewer.

Reviewers post findings in many formats: inline code comments, one large PR comment, review bodies, or a local report file. Docket converts all of them into one data model. Each finding then moves through research, decision and fix on its own, so easy findings do not wait for hard ones.

## Install

### Claude Code plugin

In Claude Code, add this repository as a marketplace and install the plugin:

```
/plugin marketplace add jmfieldman/orca-docket
/plugin install docket@orca-docket
```

To use a local clone instead, run `/plugin marketplace add ~/Development/orca-docket`.

The plugin puts `docket` on the PATH of Claude's Bash tool. To use `docket` in your own shell, link the launcher:

```bash
ln -s ~/Development/orca-docket/plugin/bin/docket /usr/local/bin/docket
```

The launcher needs Node 22 or later.

## Workflow

1. Open a worktree for your branch. Run `/docket:start` (or press **Start docket** in the Orca panel). Until you do, docket is dormant in that worktree.
2. Run `/docket:ingest` to read the review comments on the PR, or `/docket:ingest <file>` for a local review report.
3. Run `/docket:research`. Each finding gets an explanation, options with pros, cons and blast radius, and a lane: `quick`, `decide`, `scope` or `dig`.
4. Decide. Accept quick findings in bulk, pick options for the rest, and run `/docket:discuss <id>` for anything that needs a conversation.
5. Run `/docket:apply`. One agent implements the queue in order, one commit and one verification per finding.
6. Run `/docket:reply` to draft replies to reviewers. Nothing posts until you approve it.
7. Later, run `/docket:deferrals` from anywhere to pick up work you deferred.

In any ordinary session in a worktree where docket is active, a session-start brief lists the open findings. If you fix one there, the agent records it with the `record` skill.

## Components

| Component | Purpose |
|---|---|
| `spec/` | Data model, JSON Schemas, examples |
| `src/` → `plugin/bin/docket.cjs` | The `docket` CLI, the only writer of docket files. Bundled with its dependencies and schemas. |
| `plugin/skills/` | `start`, `ingest`, `research`, `discuss`, `apply`, `record`, `reply`, `deferrals` |
| `plugin/hooks/hooks.json` | `SessionStart` brief, empty unless docket is active in the worktree |
| `orca-plugin/` | Orca right-pane panel |

## Data model

Read [spec/SPEC.md](spec/SPEC.md). In summary:

- Docket is dormant in a worktree until you start it. Paused or never started, no skill or hook acts.
- Each git worktree has one docket at `$(git rev-parse --git-dir)/docket/`. The docket is deleted with the worktree.
- Each researched finding has a complexity score and a confidence score. They place it in one of four lanes.
- Deferred work goes to `${DOCKET_HOME:-~/.docket}/deferrals/` as self-contained markdown files, so it outlives the worktree.
- Each finding is one file with its own state, `rev` counter, and history of iterations by commit.
- A finding closes as `completed` (fixed and verified), `acknowledged` (no change, with a reason), `deferred`, or `resolved_externally`.
- Research and discussion only read code, so they run in parallel. Only the applier edits code, one finding at a time.

## CLI

Run `docket --help` for every command. The main groups:

| Group | Commands |
|---|---|
| Activation | `start`, `status`, `pause`, `resume`, `rebind` |
| Reading | `list`, `show`, `snapshot`, `brief`, `view` |
| Ingest | `source upsert`, `finding add`, `finding merge`, `finding update`, `resolve-external`, `ingest done` |
| Research | `research`, `stale`, `unstale`, `discuss start`, `discuss entry`, `discuss end` |
| Decide and apply | `decide`, `accept`, `reopen`, `apply next`, `apply commit`, `apply verify`, `apply complete`, `apply bounce`, `record` |
| Replies | `reply draft`, `reply approve`, `reply posted`, `reply skip` |
| Deferrals | `deferrals list`, `show`, `pickup`, `done`, `drop`, `reopen` |

Every command accepts `-C <path>` and `--json`. Writes accept `--rev <n>` and fail with exit 13 when the finding changed since it was read. `docket status` exits 0 when active, 10 when not started, 11 when paused, 12 on a branch mismatch.

## Development

```bash
pnpm install
pnpm run check
```

`check` regenerates the embedded schemas, typechecks, runs the tests against the TypeScript sources and against the bundle, validates the spec examples and the plugin, and fails if the committed bundle is stale. Tests use temporary git repos and a temporary `DOCKET_HOME`. Node 23.6 or later runs the TypeScript sources directly.
