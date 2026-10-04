---
name: ingest
description: Turn review findings into docket findings, incrementally. Reads review output in this conversation, then the branch's PR, then an optional local report file.
disable-model-invocation: true
argument-hint: "[path-to-local-review-report]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/docket *), Bash(docket *), Bash(gh *), Bash(git *), Read
---

# Ingest review findings

!`${CLAUDE_PLUGIN_ROOT}/bin/docket status`

If the line above does not say "Docket is active.", stop and tell the user to start docket first.

- Session id: `${CLAUDE_SESSION_ID}`
- File: `$ARGUMENTS` (none when this is empty)

!`${CLAUDE_PLUGIN_ROOT}/bin/docket procedure ingest`
