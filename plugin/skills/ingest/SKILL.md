---
name: ingest
description: Read review comments on this branch's PR (or a local review report) and turn them into docket findings, incrementally.
disable-model-invocation: true
argument-hint: "[path-to-local-review-report]"
allowed-tools: Bash(docket *), Bash(gh *), Bash(git *)
---

# Ingest review findings

!`"${CLAUDE_PLUGIN_ROOT}/bin/docket" status`

If the line above does not say "Docket is active.", stop and tell the user to start docket first.

Docket is reviewer-agnostic. Reviewers post findings as inline threads, one large PR comment, review bodies, or a local report. You convert each of them into findings. Never change code in this skill.

## 1. Collect sources

**Local report** (when `$ARGUMENTS` names a file): read it. The whole file is one source:
`sourceId` = `local:` + the sha256 of the absolute path, `kind` = `local_report`, `externalId` = the absolute path, `text` = the file contents.

**PR** (otherwise):

1. Read the PR from `docket list --json` → `unit.pr`. If `unit.pr` is null, run `docket pr attach`. If that fails, tell the user there is no PR and stop.
2. Fetch everything in one query. Replace OWNER, NAME and NUMBER from `unit.repo` and `unit.pr`:

```bash
gh api graphql -F owner=OWNER -F name=NAME -F number=NUMBER -f query='
query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  reviewThreads(first:100){nodes{id isResolved isOutdated path line startLine
    comments(first:50){nodes{databaseId author{login __typename} body updatedAt url}}}}
  reviews(first:100){nodes{databaseId author{login __typename} body state updatedAt url}}
  comments(first:100){nodes{databaseId author{login __typename} body updatedAt url}}
}}}'
```

If any list has 100 entries, page with `after:` cursors until it is complete.

3. Build one source per item. Skip review bodies and comments with empty bodies, and skip comments by the PR author that only reply to someone.

| Item | `sourceId` | `kind` | `externalId` | `text` |
|---|---|---|---|---|
| Review thread | `gh:thread:<thread id>` | `github_review_thread` | thread id | every comment body in order, joined with blank lines |
| Review body | `gh:review:<databaseId>` | `github_review` | databaseId | the body |
| PR comment | `gh:comment:<databaseId>` | `github_issue_comment` | databaseId | the body |

Also pass `url`, `author` (login), `isBot` (`__typename == "Bot"`), `updatedAt`, `replyCount` (thread comments minus one), and for threads `threadResolved` and `threadOutdated`.

## 2. Upsert each source

Run `docket source upsert --data '<json>'` for each source. The result has `status` (`new`, `changed`, `unchanged`), `resolvedNow`, and `findingIds`.

- `unchanged`: skip it.
- `resolvedNow` is true: run `docket resolve-external <id>` for each id in `findingIds` that is still open.
- `new` or `changed`: extract findings (step 3).

Sources from the earlier ingest that no longer appear on the PR: run `docket source delete <sourceId>`. Their findings keep their state.

## 3. Extract findings

Read the current findings first: `docket list --json`, and `docket show <id>` for any that look related.

Split each source into atomic findings. One finding is one issue that one change could fix. A comment that lists five problems produces five findings. Pleasantries, approvals, questions already answered in the thread, and summaries of the PR produce no finding.

For each extracted issue:

- **Same issue as an existing finding** (from any reviewer): `docket finding merge <id> --data '{"sourceId":"…","excerpt":"…","ordinal":N}'`.
- **Changed source, issue reworded**: `docket finding update <id> --data '{"summary":"…"}'` when the meaning changed.
- **Changed source, issue removed**: `docket stale <id> --reason "The reviewer removed this from their comment."`
- **New issue**: `docket finding add --data '<json>'` with:
  - `title`: 120 characters or fewer, neutral, specific ("Retry loop has no upper bound").
  - `summary`: two or three neutral sentences.
  - `category`: one of bug, security, performance, reliability, test, design, style, docs, question, other.
  - `reviewerSeverity`: what the reviewer claimed (critical, high, medium, low, nit), or `unknown`.
  - `location`: `{"path","symbol","startLine","endLine"}` from the thread, or from the text. Use null when there is none.
  - `sources`: `[{"sourceId","excerpt","ordinal"}]`. `excerpt` is the reviewer's own words for this one issue, verbatim.

Omit any field you do not know. Never pass `null` for a field; leave it out. Line numbers must be integers.

Never invent an issue the reviewer did not raise.

## 4. Finish

1. Run `docket ingest done`.
2. Report: sources new, changed, unchanged; findings added, merged, marked stale, closed as resolved on GitHub.
3. Tell the user the next step: `/docket:research` to investigate the new findings.
