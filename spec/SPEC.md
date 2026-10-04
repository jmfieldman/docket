# Docket data model — v1

This document defines the docket data model. Every docket component reads and writes this model: the ingest, research, investigate, apply and reply skills, the `docket` CLI, and the Orca plugin.

## Scope

Docket does not produce findings. A reviewer produces findings with any tool and in any format: inline code comments, one large PR comment, a review body, or a local report file. Docket converts those findings into this model and tracks how the author resolves each finding.

## Storage

Each git worktree has one docket. The docket lives in the per-worktree git directory:

```
$(git rev-parse --git-dir)/docket/
  unit.json         # worktree, branch, PR, ingest cursor
  sources.json      # every ingested source and the findings it produced
  findings/
    f-0001.json     # one file per finding
    f-0002.json
  events.jsonl      # append-only log of every change
```

For a linked worktree, the path is `<clone>/.git/worktrees/<name>/docket/`. Git never commits files in this directory.

The docket has the same lifetime as the worktree. `git worktree remove` and `git worktree prune` delete it. This is intended behavior.

### Stale docket guard

`unit.json` records the branch and the first head commit that docket saw. On each read, the CLI does these checks:

1. If the current branch equals `unit.branch`, use the docket.
2. If the branch is different and the current HEAD descends from `unit.firstSeenHead`, ask the user whether the branch was renamed.
3. If the branch is different and HEAD does not descend from `unit.firstSeenHead`, move the directory to `docket.stale-<timestamp>/` and start a new docket.

## Files

| File | Schema | Writer |
|---|---|---|
| `unit.json` | `schema/unit.schema.json` | CLI only |
| `sources.json` | `schema/sources.schema.json` | CLI only, on behalf of ingest |
| `findings/f-NNNN.json` | `schema/finding.schema.json` | CLI only |
| `events.jsonl` | `schema/event.schema.json`, one event per line | CLI only, append-only |

Skills and the plugin never edit these files directly. They call the `docket` CLI. The CLI validates each write against the schema, increments `rev`, and appends an event.

### Concurrent writes

Each finding has a `rev` counter. A writer passes the `rev` that it read. If the stored `rev` is different, the CLI rejects the write and the writer must read the finding again. The CLI writes each file atomically: it writes a temporary file, then renames it.

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
2. A changed source (different `contentHash`): extract its findings again. Match them to the findings that the source produced before. Update matched findings, create new ones, and set `stale` on findings the source no longer contains.
3. A thread that GitHub marks resolved: set `resolved_externally` on its findings, unless the finding is already `applied` or `dismissed`.
4. A new reply in a thread: record it on the source. If the reply disagrees with a `dismissed` finding, set the finding back to `triaged`.
5. A source that no longer exists: set the source `status` to `deleted`. Its findings keep their state.

## Finding states

```
new ──research──▶ triaged ──decide(fix)──▶ decided ──queue──▶ queued ──▶ applying ──▶ applied
                   │  ▲                                                     │
       investigate │  │ investigation ends                                  └──▶ needs_attention
                   ▼  │
               investigating

triaged ──decide(dismiss)──▶ dismissed
any open state ──source changed or code changed──▶ stale ──research──▶ triaged
any open state ──thread resolved on GitHub──▶ resolved_externally
```

| State | Meaning | Set by |
|---|---|---|
| `new` | Ingested. No research yet. | ingest |
| `triaged` | Research is done. Options are ready for a decision. | research, investigate |
| `investigating` | An investigation session is open for this finding. | UI (via dispatcher) |
| `decided` | The user chose a fix option. | UI |
| `queued` | Waiting for the applier. | UI |
| `applying` | The applier is working on this finding. | applier |
| `applied` | The applier committed the fix. Terminal state. | applier |
| `dismissed` | The user chose not to fix it. Terminal state. | UI |
| `needs_attention` | The applier found that the decision no longer fits the code. | applier |
| `stale` | The source text or the code under the finding changed. Research again. | ingest, applier |
| `resolved_externally` | The thread was resolved on GitHub outside docket. Terminal state. | ingest |

Open states: `new`, `triaged`, `investigating`, `decided`, `queued`, `needs_attention`, `stale`.

The reply to the reviewer is not a state. The `reply` field tracks it separately, because a reply can follow `applied` or `dismissed`.

### Serial apply

Research and investigation only read code, so they can run in parallel. Only the applier edits code. One applier per worktree takes `queued` findings in queue order and makes one commit per finding. Before each apply, it checks that the decision still fits the code. If it does not, the applier sets `needs_attention` and continues with the next finding. It never makes a different fix than the one the user chose.

After each commit, the applier sets `stale` on open findings whose `location` overlaps the changed lines.

## Versioning

Every file has `schemaVersion`. This document defines version 1. A CLI that reads a higher version than it knows must refuse to write.
