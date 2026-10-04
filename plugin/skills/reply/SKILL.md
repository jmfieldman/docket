---
name: reply
description: Draft replies to reviewers for closed docket findings and, after the user approves, post them and resolve the threads.
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/docket *), Bash(docket *), Bash(gh *)
---

# Reply to reviewers

!`${CLAUDE_PLUGIN_ROOT}/bin/docket status`

If the line above does not say "Docket is active.", stop and tell the user to start docket first.

Replies post on GitHub as the user. Never post a reply the user has not approved in this conversation.

## 1. Draft

Run `docket list --state closed --json`. For each finding with `replyStatus` `none` or `drafted`, read `docket show <id>` and draft one short reply:

- `completed`: what changed and the short sha of the last commit.
- `acknowledged`: the reason, politely, in one or two sentences.
- `deferred`: that it is valid and will be done in a follow-up after this PR lands.
- `resolved_externally`: no reply; run `docket reply skip <id>`.

Record each draft: `docket reply draft <id> --text "<reply>" [--resolve-thread]`. Use `--resolve-thread` for completed findings from review threads.

## 2. Approve

Show the user every draft in one list, with the finding title. Ask which to post. Accept edits. For each one the user approves, run `docket reply approve <id>`. For each one they decline, run `docket reply skip <id>`.

## 3. Post

For each approved reply, read `reply.targetSourceId` from `docket show <id>`:

- `gh:thread:<id>`: post with
  `gh api graphql -f query='mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{url}}}' -F id=<thread id> -f body="<reply>"`.
  If `reply.resolveThread` is true, then run
  `gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread id>`.
- `gh:comment:<id>` or `gh:review:<id>`: post one PR comment that quotes the reviewer's excerpt, with `gh pr comment <number> --body "<quote>\n\n<reply>"`. Several replies to the same comment can share one PR comment.

After each post, run `docket reply posted <id> --url <url>`.

## 4. Report

List what was posted, skipped and left as drafts.
