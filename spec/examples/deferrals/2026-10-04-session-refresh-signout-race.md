---
schemaVersion: 1
id: 2026-10-04-session-refresh-signout-race
title: Session refresh races with sign-out
status: open
createdAt: "2026-10-04T12:45:00Z"
severity: medium
category: bug
blastRadius:
  level: broad
  estimatedFiles: 9
  areas: [Auth, Networking]
origin:
  repo:
    remoteUrl: git@github.com:example/app.git
    owner: example
    name: app
  branch: fix/login-retry
  pr:
    number: 42
    url: https://github.com/example/app/pull/42
  findingId: f-0005
  head: "3333333333333333333333333333333333333333"
  sourceUrls:
    - https://github.com/example/app/pull/42#issuecomment-9001
codeRefs:
  - path: Sources/Auth/TokenStore.swift
    symbol: TokenStore.refresh()
    line: 55
    commit: "3333333333333333333333333333333333333333"
  - path: Sources/Auth/TokenStore.swift
    symbol: TokenStore.signOut()
    line: 70
    commit: "3333333333333333333333333333333333333333"
pickedUp: null
closed: null
tags: [auth, race]
---

## Summary

A token refresh that finishes after the user signs out writes the new token back into the keychain. The user is then signed in again without knowing it.

## Background

`TokenStore.refresh()` sends the refresh request, waits for the response, and saves the new token. `TokenStore.signOut()` clears the keychain. It does not cancel a refresh that is still in flight. If the response arrives after sign-out, the save restores the session.

## Why it was deferred

The issue came up in review of a PR about login retries (example/app#42). The fix touches every code path that writes a token, which is out of scope for that PR.

## Where the code is

- `Sources/Auth/TokenStore.swift`, `TokenStore.refresh()`: the save after the network call (line 55 at 3333333).
- `Sources/Auth/TokenStore.swift`, `TokenStore.signOut()`: clears the keychain without a cancel (line 70 at 3333333).

Search for the symbol names first. The line numbers are valid only at the commit shown, which can disappear after a squash merge.

## Recommended approach

Chosen: **session generation counter**. Each sign-in increments a generation number. Each refresh records the generation when it starts. Before it saves, it drops the result if the generation changed.

- Pros: fixes every late-write path, not only refresh.
- Cons: touches every token writer.
- Blast radius: broad, about 9 files in Auth and Networking.

Alternative: cancel the refresh task in `signOut()`. Smaller (contained, about 3 files), but a request that already returned can still save, so it needs the generation check anyway.

## Done when

- A refresh that completes after `signOut()` does not write a token.
- A unit test drives refresh and sign-out in both orders and proves no token is saved after sign-out.
- No other token writer can save a token from an older session.

## Original review comments

> 5. refresh() can race signOut().

— review-bot, https://github.com/example/app/pull/42#issuecomment-9001
