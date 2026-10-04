---
schemaVersion: 1
id: 2026-09-26-refactor-token-store
title: Split TokenStore into storage and refresh
status: done
createdAt: "2026-09-26T18:00:00Z"
severity: low
category: design
blastRadius:
  level: contained
  estimatedFiles: 5
  areas: [Auth]
origin:
  repo:
    remoteUrl: git@github.com:example/app.git
  branch: feat/passkeys
  pr: null
  findingId: f-0012
  head: "3333333333333333333333333333333333333333"
codeRefs:
  - path: Sources/Auth/TokenStore.swift
    symbol: TokenStore
    commit: "3333333333333333333333333333333333333333"
pickedUp:
  at: "2026-09-30T17:00:00Z"
  by: monty
  ref: https://github.com/example/app/pull/57
closed:
  at: "2026-10-02T21:00:00Z"
  reason: Merged in example/app#57.
tags: [auth, refactor]
---

## Summary

TokenStore mixes keychain storage with refresh scheduling. Split it into two types.

## Background

TokenStore grew from a keychain wrapper into the owner of refresh timing.

## Why it was deferred

Found during a local review before the passkeys PR existed. Out of scope for that work.

## Where the code is

- `Sources/Auth/TokenStore.swift`, `TokenStore`.

## Recommended approach

Extract `TokenRefresher`; keep `TokenStore` as storage only.

## Done when

- TokenStore has no timers.
- Existing tests pass.

## Original review comments

> TokenStore does too much.

— local review agent
