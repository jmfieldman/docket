---
name: research
description: Investigate open docket findings and write a verdict, options with pros and cons, and triage scores for each.
disable-model-invocation: true
argument-hint: "[finding-id ...]"
allowed-tools: Bash(docket *), Bash(git *), Read, Grep, Glob, Agent
---

# Research findings

!`"${CLAUDE_PLUGIN_ROOT}/bin/docket" status`

If the line above does not say "Docket is active.", stop and tell the user to start docket first.

Research only reads code. Never edit files, commit, or push in this skill.

## 1. Pick the findings

- If `$ARGUMENTS` names finding ids, research those.
- Otherwise run `docket list --state open --json` and take every finding whose `state` is `new`, plus every open finding whose `stale` is set and whose state is `new`, `ready` or `needs_attention`.

If there are none, say so and stop.

## 2. Research in parallel

Start one read-only subagent per finding (Agent tool) in a single message, so they run in parallel. Give each one the output of `docket show <id>` and these instructions, and tell it to return only the JSON described in step 3. Tell it not to edit files.

For each finding, the subagent must:

1. Read the code at `location` and everything it needs to understand it: callers, tests, config. The user often has not seen this code, so learn it well enough to explain it.
2. Decide whether the reviewer is right.
3. Design 2 to 6 options and pick one.

## 3. The JSON each finding needs

```json
{
  "explanation": "Markdown. Background for a reader who has never seen this code: what it does, why the issue happens, what breaks.",
  "severityRationale": "Why it matters and how much, in one or two sentences.",
  "research": {
    "verdict": "valid | partially_valid | not_valid | unclear",
    "confidence": "low | medium | high",
    "assessedSeverity": "critical | high | medium | low | nit",
    "analysis": "Markdown. Why the verdict holds, with file:line references.",
    "evidence": [{ "path": "…", "symbol": "…", "startLine": 1, "note": "…" }],
    "options": [
      {
        "id": "A",
        "kind": "fix | acknowledge | defer",
        "title": "80 characters or fewer",
        "description": "Markdown. Exactly what changes, or why no change is needed now.",
        "pros": ["…"],
        "cons": ["…"],
        "effort": "trivial | small | medium | large",
        "blastRadius": { "level": "surgical | contained | broad | sweeping", "estimatedFiles": 2, "areas": ["Auth"], "publicApi": false, "migration": false, "featureFlag": false }
      }
    ],
    "recommendedOptionId": "A"
  },
  "triage": { "complexity": 1, "complexityReason": "140 characters or fewer", "confidence": 3, "confidenceReason": "140 characters or fewer" }
}
```

### Options

- Option ids are `A`, `B`, `C` … in order. 2 to 6 options.
- A valid finding has at least one `fix` option. Offer the smallest correct fix first, then broader ones.
- Add an `acknowledge` option when leaving the code as is is defensible. A `not_valid` finding recommends `acknowledge`, and its description says why the reviewer is wrong.
- Add a `defer` option when the right fix is larger than this branch should carry.
- `description` must be concrete enough that another agent can implement it without asking.

### Blast radius

| Level | Meaning |
|---|---|
| surgical | A few lines in one file |
| contained | One module or feature area |
| broad | Several modules, or a shared type or interface |
| sweeping | Many files across the codebase, a public API, a migration, or a feature flag |

### Triage scores

Score the **recommended** option.

| Score | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| complexity | trivial: a few obvious lines | modest: one area, straightforward | involved: several areas, or tricky logic such as concurrency, state or security | major: cross-cutting change, refactor, API or migration |
| confidence | unclear: needs a product answer or more information | split: two good options with a real trade-off | likely: the recommendation is clearly better, alternatives are weaker | certain: one obviously right answer |

Complexity is about how hard the change is to get right, not only its size. A 40-file mechanical rename can be `2`. A 3-line concurrency change can be `3`. Confidence is about the recommendation, not the verdict: a clear "acknowledge, the reviewer misread the code" is high confidence.

## 4. Write the results

For each finding, write the JSON to a temp file and run:

`docket research <id> --rev <rev from docket show> --data @<file>`

If it fails with exit code 13, the finding changed; read it again and retry once. If it fails with exit code 2, fix the JSON from the error message and retry.

## 5. Report

List each finding with its lane (quick, decide, scope, dig) and recommendation, quick lanes first. Remind the user that the Docket panel, or `docket accept <id>` and `docket decide <id> --option X`, records decisions, and `/docket:apply` implements queued fixes.
