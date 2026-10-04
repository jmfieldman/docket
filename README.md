# docket

Docket is a Claude Code plugin. It collects the review findings on a branch and helps you resolve each one. It works with any review agent or reviewer.

Reviewers post findings in many formats: inline code comments, one large PR comment, review bodies, or a local report file. Docket converts all of them into one data model. Each finding then moves through research, decision and fix on its own, so easy findings do not wait for hard ones.

## Install

Docket needs Claude Code 2.1.287 or later (for the pane) and Node.js 23.6 or later.

In Claude Code, add this repository as a marketplace and install the plugin:

```
/plugin marketplace add jmfieldman/docket
/plugin install docket@docket
```

To use a local clone instead, run `/plugin marketplace add ~/Development/docket`.

The plugin puts `docket` on the PATH of Claude's Bash tool. To use `docket` in your own shell, link the launcher:

```bash
ln -s ~/Development/docket/plugin/bin/docket /usr/local/bin/docket
```

The launcher finds `node` on your PATH, in Homebrew, Volta, mise, asdf or nvm locations, or at `$DOCKET_NODE`.

## The Docket pane

Run `/docket` in a Claude Code session. The pane opens beside the transcript (or above the prompt in a narrow terminal) and shows:

- the findings by lane, with complexity and confidence meters and the recommended option,
- the full finding when you press its number: summary, verdict, options with blast radius, pros and cons, discussion, and the reviewer's words,
- controls to decide, queue, quick-fix, leave as is, discuss, approve replies, reopen, pause and resume.

Agent work runs as docket skills in the same session: **Ingest** runs `/docket:ingest`, **Quick fix** queues the finding and runs `/docket:apply`, and so on. While Claude is working, the pane holds the run and starts it when the turn ends.

| Key | Action | Key | Action |
|---|---|---|---|
| `1`–`9` | Expand a finding | `q` | Quick fix the expanded finding |
| `i` | Ingest review comments | `f` | Queue, defer or leave, per the selected option |
| `r` | Research new findings | `l` | Leave as is with your note |
| `a` | Apply the queue | `d` | Discuss the expanded finding |
| `y` | Draft and post replies | `z` | Accept all quick recommendations |
| `o` / `c` | Open or closed findings | `b` | Open the browser view |
| `p` | Pause or resume | `s` | Start docket (dormant worktrees) |

Tab moves between controls, and Esc returns to the prompt. The pane draws in the Claude Code CLI and in the Code tab of the Claude Desktop app. The VS Code extension, `claude -p` and cloud sessions run the skills but do not draw panes.

### Browser view

`docket ui --open` starts a local web app on `127.0.0.1:4747` (in the background, if it is not already running) and opens the current worktree in your browser. It records decisions like the pane. For agent work, it shows the skill command to run in Claude Code and copies it. Writes need a custom header and a same-origin request, so other web pages cannot drive it.

## Workflow

1. Open a worktree for your branch. Run `/docket`, then press **Start docket** (or run `/docket:start`). Until you do, docket is dormant in that worktree: no skill acts on its own, the pane does not open by itself, and no brief appears.
2. Ingest the review comments on the PR (`i`, or `/docket:ingest`), or run `/docket:ingest <file>` for a local review report.
3. Research (`r`). Each finding gets an explanation, options with pros, cons and blast radius, and a lane: `quick`, `decide`, `scope` or `dig`.
4. Decide. Accept quick findings in bulk, pick options for the rest, and discuss anything that needs a conversation.
5. Apply (`a`). The agent implements the queue in order, one commit and one verification per finding. It never pushes.
6. Replies (`y`). The agent drafts replies to reviewers. Nothing posts until you approve it.
7. Later, run `/docket:deferrals` from anywhere to pick up work you deferred.

In any ordinary session in a worktree where docket is active, a session-start brief lists the open findings. If you fix one there, the agent records it with the `record` skill.

## Components

| Component | Purpose |
|---|---|
| `spec/` | Data model, JSON Schemas, examples |
| `src/` → `plugin/bin/docket.cjs` | The `docket` CLI, the only writer of docket files. Bundled with its dependencies and schemas. |
| `plugin/skills/` | `start`, `ingest`, `research`, `discuss`, `apply`, `record`, `reply`, `deferrals` |
| `plugin/hooks/pane.js` | The Docket pane and the `/docket` command (a Claude Code mod) |
| `plugin/hooks/hooks.json` | Loads the pane, and a `SessionStart` brief that is empty unless docket is active |
| `plugin/tests/` | Pane tests, run with `claude plugin test ./plugin` |
| `src/api.ts` | The action layer behind the pane (`docket api`) and the browser view |
| `ui/index.html`, `src/ui-server.ts` | The browser view and its local HTTP server (`docket ui`) |
| `scripts/demo.mjs` | `pnpm run demo`: a throwaway repo with findings in every lane, served on port 4848 |

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
| UI | `ui [--open]`, `api snapshot`, `api worktrees`, `api finding`, `api action`, `api plan` |

Every command accepts `-C <path>` and `--json`. Writes accept `--rev <n>` and fail with exit 13 when the finding changed since it was read. `docket status` exits 0 when active, 10 when not started, 11 when paused, 12 on a branch mismatch.

## Development

```bash
pnpm install
pnpm run check
```

`check` regenerates the embedded schemas, typechecks, runs the tests against the TypeScript sources and against the bundle, runs the pane tests, validates the spec examples and the plugin, and fails if the committed bundle is stale. Tests use temporary git repos and a temporary `DOCKET_HOME`.

To work on the pane, start Claude Code with `claude --plugin-dir ./plugin`. Claude Code reloads the pane when you save `plugin/hooks/pane.js`. Tested with Claude Code 2.1.289.
