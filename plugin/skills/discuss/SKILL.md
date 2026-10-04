---
name: discuss
description: Hold a read-only conversation about one docket finding, updating the finding's options and triage as understanding improves.
disable-model-invocation: true
argument-hint: "<finding-id>"
allowed-tools: Bash(docket *), Bash(git *), Read, Grep, Glob
---

# Discuss a finding

!`"${CLAUDE_PLUGIN_ROOT}/bin/docket" status`

If the line above does not say "Docket is active.", stop and tell the user to start docket first.

The finding is `$0`. This conversation only reads code. Never edit files, commit, or push. Only the applier changes code.

## Start

1. Run `docket discuss start $0 --session-id ${CLAUDE_SESSION_ID}`. If it fails, tell the user why and stop.
2. Run `docket show $0`. Read the code at its location and around it.
3. Give the user a short briefing: what the code does, what the reviewer said, the verdict, the options with their blast radius, and the recommendation. Then ask what they want to explore.

## During the conversation

Answer the user's questions with evidence from the code. After each exchange that taught something, record it:

`docket discuss entry $0 --data '<json>'`

with `question` (the user's question, condensed) and `answer` (your answer, condensed, Markdown).

When the conversation changes the options, include the full revised `options` array and `recommendedOptionId` in the same entry, in the same format the research skill uses. When it changes how complex or how certain the recommended fix is, include `triage` (`complexity`, `complexityReason`, `confidence`, `confidenceReason`, scored as in the research skill). The panel moves the card to its new lane.

## Decisions

Record a decision only when the user states it:

- Fix with an option: `docket decide $0 --option <id>`, with `--instruction "<extra direction>"` if the user gave any. This queues it for the applier.
- Their own fix: `docket decide $0 --option custom --kind fix --instruction "<what to do>"`.
- Leave it: `docket decide $0 --option custom --kind acknowledge --instruction "<reason>"`.
- Later: `docket decide $0 --option <defer option id> --instruction "<why it waits>"`. Docket writes a deferral file the user can pick up later.

## End

When the user is done, run `docket discuss end $0` unless a decision already moved the finding on.
