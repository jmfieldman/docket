import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DocketError } from './errors.ts'
import { appendLine, readJson, withLock, writeJsonAtomic } from './fsio.ts'
import { isAncestor, parseGitHubRemote, readWorktree, type WorktreeInfo } from './git.ts'
import { assertValid } from './schema.ts'

export interface Unit {
  schemaVersion: 1
  status: 'active' | 'paused'
  startedAt: string
  pausedAt: string | null
  repo: { remoteUrl: string; owner?: string; name?: string }
  branch: string
  worktreePath: string
  firstSeenHead: string
  pr: { number: number; url: string } | null
  lastIngest: { at: string; head: string } | null
  remoteCheck: { at: string; newSourceCount: number } | null
  lastViewedAt: string | null
  applier: { state: 'idle' | 'running'; sessionId?: string; since?: string }
  nextFindingNumber: number
  createdAt: string
  updatedAt: string
}

export type EventActor = 'ingest' | 'research' | 'discuss' | 'ui' | 'session' | 'dispatcher' | 'applier' | 'reply' | 'deferrals' | 'cli'

export interface Context {
  cwd: string
  now: () => string
  /** Look up the PR for the branch with the gh CLI. Off in tests. */
  prLookup: boolean
}

export type DocketState = 'active' | 'paused' | 'not_started' | 'branch_mismatch'

export interface StatusReport {
  state: DocketState
  docketDir: string
  worktree: { root: string; branch: string | null; head: string }
  unit: Unit | null
  /** Set when this call moved an unrelated old docket aside. */
  movedStaleTo?: string
  message: string
}

/** Exit status per state, so skills and hooks can gate with `docket status --quiet`. */
export const EXIT_CODE: Record<DocketState, number> = {
  active: 0,
  not_started: 10,
  paused: 11,
  branch_mismatch: 12
}

export const docketDirFor = (worktree: WorktreeInfo): string => join(worktree.gitDir, 'docket')
export const lockDirFor = (worktree: WorktreeInfo): string => join(worktree.gitDir, 'docket.lock')

export function appendEvent(docketDir: string, ctx: Context, head: string, actor: EventActor, type: string, extra: Record<string, unknown> = {}): void {
  const event = { ts: ctx.now(), head, actor, type, ...extra }
  assertValid('event', event)
  appendLine(join(docketDir, 'events.jsonl'), event)
}

export function writeUnit(docketDir: string, unit: Unit): void {
  assertValid('unit', unit)
  writeJsonAtomic(join(docketDir, 'unit.json'), unit)
}

function readUnit(docketDir: string): Unit | null {
  const path = join(docketDir, 'unit.json')
  return existsSync(path) ? readJson<Unit>(path) : null
}

function report(state: DocketState, docketDir: string, worktree: WorktreeInfo, unit: Unit | null, message: string, movedStaleTo?: string): StatusReport {
  const base = { state, docketDir, worktree: { root: worktree.root, branch: worktree.branch, head: worktree.head }, unit, message }
  return movedStaleTo ? { ...base, movedStaleTo } : base
}

/**
 * Reads the docket for the worktree at ctx.cwd and applies the stale docket
 * guard from SPEC.md. Must run under the lock, because it can move a stale
 * docket aside.
 */
export function resolve(ctx: Context, worktree: WorktreeInfo): StatusReport {
  const docketDir = docketDirFor(worktree)
  const unit = readUnit(docketDir)
  if (!unit) return report('not_started', docketDir, worktree, null, 'Docket is not started in this worktree.')

  const sameBranch = worktree.branch === unit.branch
  const descends = isAncestor(worktree.root, unit.firstSeenHead, worktree.head)

  // A detached HEAD (rebase, bisect) never moves the docket aside.
  if (sameBranch || (worktree.branch === null && descends)) {
    const message = unit.status === 'active' ? 'Docket is active.' : 'Docket is paused.'
    return report(unit.status, docketDir, worktree, unit, message)
  }
  if (descends || worktree.branch === null) {
    return report('branch_mismatch', docketDir, worktree, unit,
      `This docket belongs to branch ${unit.branch}, but the worktree is on ${worktree.branch ?? 'a detached HEAD'}. If the branch was renamed, run \`docket rebind\`.`)
  }

  const stamp = ctx.now().replace(/[:.]/g, '-')
  const staleDir = join(worktree.gitDir, `docket.stale-${stamp}`)
  appendEvent(docketDir, ctx, worktree.head, 'cli', 'unit_marked_stale', { data: { newBranch: worktree.branch } })
  renameSync(docketDir, staleDir)
  return report('not_started', docketDir, worktree, null,
    `The old docket belonged to an unrelated branch (${unit.branch}) and was moved aside. Docket is not started in this worktree.`, staleDir)
}

export function status(ctx: Context): StatusReport {
  const worktree = readWorktree(ctx.cwd)
  // The common case reads without the lock; only a possible stale move needs it.
  if (!existsSync(join(docketDirFor(worktree), 'unit.json'))) {
    return report('not_started', docketDirFor(worktree), worktree, null, 'Docket is not started in this worktree.')
  }
  return withLock(lockDirFor(worktree), () => resolve(ctx, worktree))
}

function lookupPr(root: string): Unit['pr'] {
  try {
    const out = execFileSync('gh', ['pr', 'view', '--json', 'number,url'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
    const pr = JSON.parse(out) as { number?: number; url?: string }
    return typeof pr.number === 'number' && typeof pr.url === 'string' ? { number: pr.number, url: pr.url } : null
  } catch {
    return null
  }
}

function setStatus(ctx: Context, worktree: WorktreeInfo, current: StatusReport, next: 'active' | 'paused'): StatusReport {
  const unit = current.unit as Unit
  if (unit.status === next) return current
  const now = ctx.now()
  const updated: Unit = { ...unit, status: next, pausedAt: next === 'paused' ? now : null, updatedAt: now }
  writeUnit(current.docketDir, updated)
  appendEvent(current.docketDir, ctx, worktree.head, 'ui', next === 'paused' ? 'unit_paused' : 'unit_resumed')
  return report(next, current.docketDir, worktree, updated, next === 'paused' ? 'Docket is paused.' : 'Docket is active.')
}

function requireUsable(current: StatusReport): void {
  if (current.state === 'branch_mismatch') throw new DocketError('branch_mismatch', current.message, EXIT_CODE.branch_mismatch)
}

/** Creates the docket, or resumes a paused one. Safe to call again on an active docket. */
export function start(ctx: Context): StatusReport {
  const worktree = readWorktree(ctx.cwd)
  return withLock(lockDirFor(worktree), () => {
    const current = resolve(ctx, worktree)
    requireUsable(current)
    if (current.state === 'active') return { ...current, message: 'Docket is already active.' }
    if (current.state === 'paused') return setStatus(ctx, worktree, current, 'active')

    if (!worktree.branch) throw new DocketError('detached_head', 'Check out a branch before you start docket.')
    const now = ctx.now()
    const github = parseGitHubRemote(worktree.remoteUrl)
    const unit: Unit = {
      schemaVersion: 1,
      status: 'active',
      startedAt: now,
      pausedAt: null,
      repo: { remoteUrl: worktree.remoteUrl ?? '', ...(github ?? {}) },
      branch: worktree.branch,
      worktreePath: worktree.root,
      firstSeenHead: worktree.head,
      pr: ctx.prLookup ? lookupPr(worktree.root) : null,
      lastIngest: null,
      remoteCheck: null,
      lastViewedAt: null,
      applier: { state: 'idle' },
      nextFindingNumber: 1,
      createdAt: now,
      updatedAt: now
    }
    const sources = { schemaVersion: 1, sources: {} }
    assertValid('unit', unit)
    assertValid('sources', sources)

    // Build in a temporary directory and rename it into place, so no reader
    // ever sees a half-created docket.
    const docketDir = docketDirFor(worktree)
    const temp = join(worktree.gitDir, `docket.creating-${process.pid}`)
    rmSync(temp, { recursive: true, force: true })
    mkdirSync(join(temp, 'findings'), { recursive: true })
    writeUnit(temp, unit)
    writeJsonAtomic(join(temp, 'sources.json'), sources)
    appendEvent(temp, ctx, worktree.head, 'ui', 'unit_created', unit.pr ? { data: { pr: unit.pr.number } } : {})
    renameSync(temp, docketDir)
    return report('active', docketDir, worktree, unit, 'Docket started.')
  })
}

function changeStatus(ctx: Context, next: 'active' | 'paused'): StatusReport {
  const worktree = readWorktree(ctx.cwd)
  return withLock(lockDirFor(worktree), () => {
    const current = resolve(ctx, worktree)
    requireUsable(current)
    if (current.state === 'not_started') throw new DocketError('not_started', 'Docket is not started in this worktree. Run `docket start` first.', EXIT_CODE.not_started)
    return setStatus(ctx, worktree, current, next)
  })
}

export const pause = (ctx: Context): StatusReport => changeStatus(ctx, 'paused')
export const resume = (ctx: Context): StatusReport => changeStatus(ctx, 'active')

/** Confirms a branch rename: points the docket at the current branch. */
export function rebind(ctx: Context): StatusReport {
  const worktree = readWorktree(ctx.cwd)
  return withLock(lockDirFor(worktree), () => {
    const current = resolve(ctx, worktree)
    if (current.state !== 'branch_mismatch') return current
    if (!worktree.branch) throw new DocketError('detached_head', 'Check out the renamed branch before you run `docket rebind`.')
    const unit = current.unit as Unit
    const updated: Unit = { ...unit, branch: worktree.branch, updatedAt: ctx.now() }
    writeUnit(current.docketDir, updated)
    appendEvent(current.docketDir, ctx, worktree.head, 'ui', 'unit_rebound', { data: { from: unit.branch, to: worktree.branch } })
    return report(updated.status, current.docketDir, worktree, updated, `Docket now follows branch ${worktree.branch}.`)
  })
}
