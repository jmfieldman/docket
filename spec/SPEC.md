# Docket data model — v1

This document defines the docket data model. Every docket component reads and writes this model: the ingest, research, discuss, apply, reply and deferrals skills, the `docket` CLI, and the Orca plugin.

## Scope

Docket does not produce findings. A reviewer produces findings with any tool and in any format: inline code comments, one large PR comment, a review body, or a local report file. Docket converts those findings into this model and tracks how the author resolves each finding.

## Storage

Docket keeps data in two places.

| Store | Location | Lifetime | Contents |
|---|---|---|---|
| Worktree docket | `$(git rev-parse --git-dir)/docket/` | Deleted with the worktree | Findings for one branch |
| Deferral catalog | `${DOCKET_HOME:-~/.docket}/deferrals/` | Kept until the user removes it | Work deferred out of a branch |

### Worktree docket

```
$(git rev-parse --git-dir)/docket/
  unit.json         # worktree, branch, PR, applier, last view time
  sources.json      # every ingested source and the findings it produced
  findings/
    f-0001.json     # one file per finding
  events.jsonl      # append-only log of every change
```

For a linked worktree, the path is `<clone>/.git/worktrees/<name>/docket/`. Git never commits files in this directory. `git worktree remove` and `git worktree prune` delete it. This is intended behavior.

#### Stale docket guard

`unit.json` records the branch and the first head commit that docket saw. On each read, the CLI does these checks:

1. If the current branch equals `unit.branch`, use the docket.
2. If the branch is different and the current HEAD descends from `unit.firstSeenHead`, ask the user whether the branch was renamed.
3. If the branch is different and HEAD does not descend from `unit.firstSeenHead`, move the directory to `docket.stale-<timestamp>/` and start a new docket.

### Deferral catalog

```
${DOCKET_HOME:-~/.docket}/deferrals/
  2026-10-04-cap-login-retries.md     # status open or picked_up
  archive/
    2026-09-26-refactor-token-store.md  # status done or dropped
```

A deferral is valid work that the author chose not to do in the current branch. The worktree docket is deleted with the worktree, so a deferral must live outside it. See [Deferrals](#deferrals).

## Files and writers

| File | Schema | Writer |
|---|---|---|
| `unit.json` | `schema/unit.schema.json` | CLI |
| `sources.json` | `schema/sources.schema.json` | CLI, for ingest |
| `findings/f-NNNN.json` | `schema/finding.schema.json` | CLI |
| `events.jsonl` | `schema/event.schema.json`, one event per line | CLI, append-only |
| `deferrals/*.md` | `schema/deferral.schema.json` for the frontmatter | CLI, for apply and deferrals |

Skills and the plugin never edit these files directly. They call the `docket` CLI. The CLI validates each write against the schema, increments `rev`, and appends an event.

### Concurrent writes

Each finding has a `rev` counter. A writer passes the `rev` that it read. If the stored `rev` is different, the CLI rejects the write, and the writer must read the finding again. The CLI writes each file atomically: it writes a temporary file, then renames it.

## Activation

Docket is dormant in a worktree until the user starts it.

### Enabled, paused and dormant

| Condition | Docket state | Behavior |
|---|---|---|
| No `docket/` directory | Dormant | No skill acts. No hook injects anything. Nothing polls GitHub. |
| `unit.status` is `paused` | Dormant | Same as above. The data stays. |
| `unit.status` is `active` | Enabled | Skills and hooks act, including in ad-hoc sessions. |

Only two actions create a docket: the **Start docket** button in the panel, and the explicit `/docket-start` command. Both run `docket start`. No other skill, hook or command creates the `docket/` directory.

**Pause** sets `status` to `paused`. **Resume** sets it to `active`. Deleting the worktree deletes the docket.

### How docket stays dormant

Skill instructions alone cannot keep an agent dormant, because the agent selects a skill from its description. Docket uses three layers:

1. **Session hook.** A `SessionStart` hook runs `docket status`. If the docket is dormant, the hook injects nothing, and the agent has no information about docket in that session. If the docket is enabled, the hook injects a short brief: the open findings and how to record work with the CLI.
2. **Gate in every skill.** The first step of every skill is `docket status`. If the docket is dormant, the skill stops, says so in one line, and writes nothing.
3. **Explicit-only skills.** `docket-start` and `docket-ingest` run only when the user names them. Automatic selection is turned off in their frontmatter.

### Ad-hoc sessions

When the docket is enabled, an agent session that the user started for another reason can record docket work. Its limits:

- It updates existing findings only. It records an iteration with `origin: session`, its commits and its verification, and it can close the finding as `completed`.
- It does not create findings. If it notices a new issue, it tells the user and writes nothing.
- It obeys the single-applier rule. If `unit.applier.state` is `running`, it warns the user before it edits code.
- After it commits, it sets the stale flag on open findings whose `location` overlaps the changed lines.

The panel shows `origin: session` iterations with an "inferred" badge. The user can reopen the finding in one action if the agent linked the wrong one.

### Ingest triggers

Ingest runs only when the user triggers it: from the panel, or with `/docket-ingest`. When the docket is enabled, the panel can check the PR for sources newer than `unit.lastIngest`. It records the result in `unit.remoteCheck` and shows "N new" on the re-ingest control. The check never ingests.

## Sources

A source is one unit of reviewer output. Docket identifies a source by where the output came from, never by its format. This rule makes docket independent of the reviewer.

| `kind` | `sourceId` format | Origin |
|---|---|---|
| `github_review_thread` | `gh:thread:<graphql node id>` | An inline code comment thread |
| `github_review` | `gh:review:<review id>` | The body of a submitted review |
| `github_issue_comment` | `gh:comment:<comment id>` | A PR conversation comment |
| `local_report` | `local:<sha256 of path>` | A file from a local review agent |

One source can produce many findings, for example one PR comment that lists five issues. One finding can have many sources, for example two reviewers who report the same issue.

### Incremental ingest

Each source records `contentHash` (a sha256 of its normalized text, including replies) and `updatedAt`. On each ingest run:

1. A new source: extract its findings. Merge each finding into an existing finding if both describe the same issue. Otherwise, create a new finding.
2. A changed source (different `contentHash`): extract its findings again. Match them to the findings that the source produced before. Update matched findings and create new ones. Set the stale flag on open findings that the source no longer contains.
3. A thread that GitHub marks resolved: close its open findings as `resolved_externally`.
4. A new reply in a thread: record it on the source. If the reply disagrees with an `acknowledged` finding, reopen the finding.
5. A source that no longer exists: set the source `status` to `deleted`. Its findings keep their state.

New findings have `createdAt` later than `unit.lastViewedAt`. The panel shows them as new and lists them first.

## Finding content

Each finding carries text for two reading speeds.

| Field | Purpose |
|---|---|
| `title` | One line, 120 characters or fewer |
| `summary` | The issue in two or three neutral sentences |
| `explanation` | Background for a reader who does not know this code: what the code does, why the issue occurs, what breaks |
| `severityRationale` | Why the issue matters, and how much |
| `resolution.summary` | One line that says how the finding closed. Shown on collapsed closed findings. |

### Options

Research writes 2 to 6 options. Each option has a `kind`:

| `kind` | Result when chosen |
|---|---|
| `fix` | The applier implements it. The finding closes as `completed`. |
| `acknowledge` | No change. The finding closes as `acknowledged`. A reason is required. |
| `defer` | No change in this branch. Docket writes a deferral file. The finding closes as `deferred`. |

Each option has `effort` and `blastRadius`. These measure different things: a rename across 40 files is trivial effort with a sweeping blast radius.

| `blastRadius.level` | Meaning |
|---|---|
| `surgical` | A few lines in one file |
| `contained` | One module or feature area |
| `broad` | Several modules, or a shared type or interface |
| `sweeping` | Many files across the codebase, a public API, a migration, or a flag |

`blastRadius` also records `estimatedFiles`, `areas`, and the booleans `publicApi`, `migration` and `featureFlag`.

## Triage

Each researched finding sits on two axes. Research writes both scores, each with a reason of 140 characters or fewer. Discussion rewrites them when it changes the options.

| Score | Axis | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| `complexity` | The recommended option, simple to complicated | trivial | modest | involved | major |
| `confidence` | Certainty that the recommended option is right | unclear | split | likely | certain |

- **Complexity** combines the recommended option's effort, blast radius, and how hard the change is to get right. A 40-file mechanical rename is broad but can be `modest`. A 3-line change to concurrency logic can be `involved`.
- **Confidence** is about the recommendation, not the verdict. "Two good options with a real trade-off" is `split`. "Needs a product answer or more information" is `unclear`. A finding that is not valid, with a clear "acknowledge" recommendation, has high confidence.

### Lanes

The CLI derives one lane from the two scores. The lane name says what the user does next.

| | Confidence 3-4 | Confidence 1-2 |
|---|---|---|
| **Complexity 1-2** | `quick`: accept the recommendation | `decide`: small change, but a judgment call |
| **Complexity 3-4** | `scope`: direction is clear, the work is large. Fix now or defer. | `dig`: discuss before deciding |

Each score has 4 levels, so each lane boundary falls between levels 2 and 3. No score is ambiguous.

### Panel presentation

- Open findings group by lane in this order: `quick`, `decide`, `scope`, `dig`. The fast decisions come first. Inside a lane, findings sort by assessed severity, then by `createdAt`.
- Each card shows the lane as a colored chip and the two scores as two 4-segment meters, labeled "Complexity" and "Confidence", with the level name. The reasons show on hover and in the expanded card.
- The primary action changes with the lane:

| Lane | Primary action | Card shows by default |
|---|---|---|
| `quick` | **Accept** (quick fix, or acknowledge when the recommendation is acknowledge) | Title, recommendation title, one-line reason |
| `decide` | Choose an option | Title, all options as compact rows |
| `scope` | **Fix now** or **Defer** | Title, recommended option with its blast radius |
| `dig` | **Discuss** | Title, summary, open questions |

- The `quick` group has a bulk control: **Accept all (N)**. It opens a checklist with every item selected. The user clears any item, then confirms. Each accepted item becomes an iteration with `origin: quick`.
- When discussion changes the scores, the card moves to its new lane. A `dig` finding often becomes `quick` after one or two questions.
- Severity is separate from the lane. It shows as a text badge, colored only for `critical` and `high`.

## Finding states

```
            research                 decide(fix)            applier            verify ok
  new ───────────────▶ ready ───────────────────▶ queued ─────────▶ fixing ─────────────▶ completed
                       │  ▲                                           │
            discuss    │  │ discussion ends                           └─ decision no longer fits ─▶ needs_attention ─▶ ready
                       ▼  │
                    discussing

  ready ── decide(acknowledge) ──▶ acknowledged
  ready ── decide(defer) ─────────▶ deferred
  any open state ── thread resolved on GitHub ──▶ resolved_externally
  any closed state ── reopen ──▶ ready
```

| State | Open or closed | Meaning | Set by |
|---|---|---|---|
| `new` | Open | Ingested. No research yet. | ingest |
| `ready` | Open | Research is done. Options are ready for a decision. | research, discuss, reopen |
| `discussing` | Open | A discussion session is active for this finding. | dispatcher |
| `queued` | Open | A fix decision waits for the applier. | UI |
| `fixing` | Open | The applier is working on this finding. | applier |
| `needs_attention` | Open | The applier stopped: the decision no longer fits the code, or verification failed. | applier |
| `completed` | Closed | A fix was implemented and verified. | applier |
| `acknowledged` | Closed | The user chose no change, with a reason. | UI |
| `deferred` | Closed | The user moved the work out of this branch. A deferral file exists. | UI |
| `resolved_externally` | Closed | The thread was resolved on GitHub outside docket. | ingest |

The user never sets `completed`. The applier sets it after it commits the fix and the verification passes.

### Stale flag

`stale` is a flag on an open finding, not a state. Docket sets it when the code under the finding changes, or when the source text changes. The finding keeps its state. Before anyone decides, research or discussion reads the code again and clears the flag.

### Iterations

Each decision starts an iteration. The finding keeps all iterations in `iterations[]`, oldest first. An iteration records:

- where the decision came from (`origin`: `panel`, `quick`, or `session`),
- the decision (option, kind, instruction),
- the head commit when the decision was made,
- the queue position, the commits the applier made, and the verification result,
- the outcome and a one-line summary.

A finding can need several fix iterations. For example, iteration 1 caps retries, review finds a problem, and iteration 2 adds jitter. `acknowledge` and `defer` decisions are iterations too, so the history is uniform.

One fix can close several findings. The iteration lists them in `alsoResolves`. Each of those findings closes as `completed` with `resolution.resolvedBy` pointing back to the iteration.

### History

Every event in `events.jsonl` records `head`, the worktree HEAD commit when the event occurred. The history of one finding is its iterations plus its events. The panel shows it when the user expands a finding.

| Milestone | Where it is recorded |
|---|---|
| Detected | `detectedAtCommit` |
| Each decision | `iterations[].decidedAtCommit` |
| Each fix commit | `iterations[].commits[]` |
| Closed | `resolution.closedAtCommit` |

### Discussion

A discussion is a conversation between the user and an agent about one finding. It runs in its own terminal, in the same worktree, and it only reads code. The full conversation stays in that terminal. After each exchange, the agent writes one entry to `discussion.entries[]`: the question, a short answer, and whether it changed the options. If it changed them, it writes the new options to `research.options`. The panel updates from these writes.

`discussion.sessionId` stores the agent session ID, so the user can continue the discussion later.

## Apply

Research and discussion only read code, so they can run in parallel. Only the applier edits code.

1. One applier runs per worktree. `unit.applier` records whether it is running.
2. It takes `queued` findings in queue order.
3. Before each fix, it checks that the decision still fits the code. If it does not, it sets `needs_attention` with a reason and continues with the next finding. It never makes a fix the user did not choose.
4. It makes one commit per iteration.
5. It verifies the fix: it runs the relevant tests, and it reads the change again against the reviewer's concern. It records the result in `iterations[].verification`. If verification fails, it sets `needs_attention`.
6. If verification passes, it closes the finding as `completed` and writes `resolution.summary`.
7. After each commit, it sets the stale flag on open findings whose `location` overlaps the changed lines.

A quick fix records the decision with `origin: quick`, queues the finding, and starts the applier if it is idle. It does not skip the queue.

The applier commits. It never pushes. The user pushes.

## Replies

The reply to the reviewer is not a state. The `reply` field tracks it: `none`, `drafted`, `approved`, `posted`, or `skipped`. The reply skill drafts replies for closed findings: the fix commit for `completed`, the reason for `acknowledged` and `deferred`. It posts a reply and resolves the GitHub thread only after the user approves it, because the reply posts as the user.

## Deferrals

### When docket writes a deferral

When the user chooses a `defer` option, the CLI does these steps:

1. Write the deferral file to `${DOCKET_HOME:-~/.docket}/deferrals/`.
2. Record its path and ID in the iteration and in `resolution.deferral`.
3. Close the finding as `deferred`.

### File name

`YYYY-MM-DD-<slug>.md`. The date is the deferral date. The slug is 3 to 6 lowercase words from the title, joined with hyphens. If the name exists, add `-2`, `-3`, and so on.

### Frontmatter

The frontmatter follows `schema/deferral.schema.json`.

| Field | Meaning |
|---|---|
| `schemaVersion` | `1` |
| `id` | The file name without `.md`. Stable for the life of the deferral. |
| `title` | One line |
| `status` | `open`, `picked_up`, `done`, or `dropped` |
| `createdAt` | When the deferral was written |
| `severity`, `category`, `blastRadius` | Copied from the finding and the chosen option |
| `origin` | Where the work came from: repo, branch, PR (if one existed), finding ID, head commit, source URLs |
| `codeRefs` | Each location: path, symbol, line, and the commit where the line was true |
| `pickedUp` | When work started and where it went (a branch, a PR, a ticket, a brain page) |
| `closed` | When it ended, and why |
| `tags` | Free-form labels |

### Body

The body must make sense to a reader with no other context: a person months later, or an agent in a different repository. It has these sections, in this order:

1. `## Summary` — what the work is, in two or three sentences
2. `## Background` — what the code does today and why the issue exists
3. `## Why it was deferred` — the reason it was not done in the original branch
4. `## Where the code is` — each code reference, with how to find it if lines moved
5. `## Recommended approach` — the chosen option, plus the other options with pros, cons and blast radius
6. `## Done when` — acceptance criteria that a reviewer can check
7. `## Original review comments` — the reviewers' text, verbatim, with links

### Code references

A commit SHA is not enough. A squash merge removes branch commits, so a SHA can disappear. Each code reference records the path, the symbol name (function, type or test), and the line at a named commit. To find the code later, search for the symbol first and use the line only as a hint.

### Status lifecycle

```
open ──▶ picked_up ──▶ done
  │          │
  └──────────┴──▶ dropped
```

| Status | Meaning | Location |
|---|---|---|
| `open` | Not started | `deferrals/` |
| `picked_up` | Work started. `pickedUp.ref` says where. | `deferrals/` |
| `done` | The work landed. | `deferrals/archive/` |
| `dropped` | No longer needed. `closed.reason` says why. | `deferrals/archive/` |

The deferrals skill lists open and picked-up deferrals. For each one, it checks:

- whether the origin branch merged,
- whether the code references still exist on the default branch,
- whether someone already fixed the issue.

Then the user picks one up, or drops it. When work starts, the skill sets `picked_up` with a reference. When the work lands, it sets `done` and moves the file to `archive/`. The skill never deletes a deferral file.

## Versioning

Every file has `schemaVersion`. This document defines version 1. A CLI that reads a higher version than it knows must refuse to write.
