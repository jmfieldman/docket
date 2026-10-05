# Ingest procedure

Docket is reviewer-agnostic. Reviewers post findings as inline threads, one large PR comment, review bodies, a report in this conversation, or a local report file. You convert each of them into findings. Never change code while you ingest.

Run each `docket` command as its own Bash call that starts with `docket`. Do not prefix it with a variable assignment, and do not chain or loop it with other commands. The skill's pre-approved permissions match only a command that starts with `docket`, so a combined command stops for a permission prompt.

Check the three places below in order. Skip a place that has nothing; never stop because one place is empty. Keep a tally for the report: per place, sources new, changed and unchanged, and findings added, merged, marked stale and closed.

## 1. This conversation

Look back through this conversation for review output that docket has not ingested yet:

- The report of a review skill, command or agent, such as `/multi-lens`, `/review` or a code-review subagent.
- Review comments or reviewer notes that the user pasted.

These are not review output: your own explanations and plans, docket's own output (`docket list`, briefs, the pane), and questions the user asked you.

For each review run, separately and oldest first:

1. Copy the review's findings **verbatim**: every finding with its title, severity, location and description, exactly as the review wrote them. Leave out progress lines, tool chatter and summaries that repeat the findings.
2. Record it. Use the session id given above this procedure, a short title that names the review and when it ran, and a quoted heredoc so nothing in the text expands:

```bash
docket source session --session-id <session id> --title "<review name>, <HH:MM>" --file - <<'DOCKET_REVIEW_END'
<the findings, verbatim>
DOCKET_REVIEW_END
```

3. The result has `sourceId` and `status`. `unchanged` means docket already ingested this review: skip it. `new` or `changed`: extract findings from it (step 4). A later review in the same conversation often repeats earlier findings. Merge those into the existing findings rather than adding duplicates.

If the conversation has no review output, say so in one line and continue.

## 2. The PR

1. Read the PR from `docket list --json` → `unit.pr`. If `unit.pr` is null, run `docket pr attach`. If that fails, this branch has no PR: say so in one line and continue to step 3.
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

4. Run `docket source upsert --data '<json>'` for each source. The result has `status` (`new`, `changed`, `unchanged`), `resolvedNow`, and `findingIds`.

   - `unchanged`: skip it.
   - `resolvedNow` is true: run `docket resolve-external <id>` for each id in `findingIds` that is still open.
   - `new` or `changed`: extract findings (step 4).

5. Sources with a `gh:` id from an earlier ingest that no longer appear on the PR: run `docket source delete <sourceId>`. Their findings keep their state.
6. Run `docket remote-check --count 0`, so the pane stops showing new PR activity.

## 3. A file

Only when a file path is given above this procedure. Read the file. The whole file is one source: `sourceId` = `local:` + the sha256 of the absolute path, `kind` = `local_report`, `externalId` = the absolute path, `text` = the file contents. Upsert it and handle the result as in step 2.4.

## 4. Extract findings from a new or changed source

Read the current findings first: `docket list --json`, and `docket show <id>` for any that look related.

Split each source into atomic findings. One finding is one issue that one change could fix. A comment that lists five problems produces five findings. Pleasantries, approvals, questions already answered in the thread, and summaries of the PR produce no finding.

For each extracted issue:

- **Same issue as an existing finding** (from any reviewer or source): `docket finding merge <id> --data '{"sourceId":"…","excerpt":"…","ordinal":N}'`.
- **Changed source, issue reworded**: `docket finding update <id> --data '{"summary":"…"}'` when the meaning changed.
- **Changed source, issue removed**: `docket stale <id> --reason "The reviewer removed this from their comment."`
- **New issue**: `docket finding add --data '<json>'` with:
  - `title`: 120 characters or fewer, neutral, specific ("Retry loop has no upper bound").
  - `summary`: two or three neutral sentences.
  - `category`: one of bug, security, performance, reliability, test, design, style, docs, question, other.
  - `reviewerSeverity`: what the reviewer claimed (critical, high, medium, low, nit), or `unknown`.
  - `location`: `{"path","symbol","startLine","endLine"}` from the thread, or from the text. Omit it when there is none.
  - `sources`: `[{"sourceId","excerpt","ordinal"}]`. `excerpt` is the reviewer's own words for this one issue, verbatim.

Omit any field you do not know. Never pass `null` for a field; leave it out. Line numbers must be integers.

Never invent an issue the reviewer did not raise.

## 5. Finish

1. Run `docket ingest done`.
2. Report the tally per place: this conversation, the PR, the file. Name the findings you added.
3. Tell the user the next step: `/docket:research` (or **r** in the `/docket` pane) to investigate the new findings.
