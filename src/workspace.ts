import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvent, EXIT_CODE, lockDirFor, resolve, writeUnit, type Context, type EventActor, type Unit } from './docket.ts'
import { DocketError } from './errors.ts'
import { readJson, withLock, writeJsonAtomic } from './fsio.ts'
import { readWorktree, type WorktreeInfo } from './git.ts'
import { assertValid } from './schema.ts'
import type { Finding, SourcesFile } from './types.ts'

export const EXIT = { badInput: 2, revConflict: 13, invalidState: 14, notFound: 15 } as const

export interface Workspace {
  ctx: Context
  worktree: WorktreeInfo
  docketDir: string
  unit: Unit
  now: string
  head: string
  findingIds: () => string[]
  readFinding: (id: string) => Finding
  allFindings: () => Finding[]
  /** Validates, increments rev, stamps updatedAt. Pass expectedRev to reject a stale writer. */
  saveFinding: (finding: Finding, expectedRev?: number) => Finding
  readSources: () => SourcesFile
  saveSources: (sources: SourcesFile) => void
  saveUnit: (unit: Unit) => void
  event: (actor: EventActor, type: string, extra?: Record<string, unknown>) => void
}

/**
 * Runs `fn` against the active docket of the worktree at ctx.cwd, under the
 * docket lock. Writes need an active docket. Reads also work while paused, so
 * the panel can still show a paused docket.
 */
export function withWorkspace<T>(ctx: Context, mode: 'read' | 'write', fn: (ws: Workspace) => T): T {
  const worktree = readWorktree(ctx.cwd)
  return withLock(lockDirFor(worktree), () => {
    const current = resolve(ctx, worktree)
    if (current.state === 'not_started') {
      throw new DocketError('not_started', 'Docket is not started in this worktree.', EXIT_CODE.not_started)
    }
    if (current.state === 'branch_mismatch') throw new DocketError('branch_mismatch', current.message, EXIT_CODE.branch_mismatch)
    if (current.state === 'paused' && mode === 'write') {
      throw new DocketError('paused', 'Docket is paused in this worktree. Run `docket resume` first.', EXIT_CODE.paused)
    }
    return fn(makeWorkspace(ctx, worktree, current.docketDir, current.unit as Unit))
  })
}

function makeWorkspace(ctx: Context, worktree: WorktreeInfo, docketDir: string, initialUnit: Unit): Workspace {
  const findingsDir = join(docketDir, 'findings')
  const findingPath = (id: string) => join(findingsDir, `${id}.json`)
  const now = ctx.now()

  const ws: Workspace = {
    ctx,
    worktree,
    docketDir,
    unit: initialUnit,
    now,
    head: worktree.head,
    findingIds: () =>
      existsSync(findingsDir)
        ? readdirSync(findingsDir).filter((f) => /^f-\d{4,}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort()
        : [],
    readFinding: (id) => {
      if (!/^f-\d{4,}$/.test(id)) throw new DocketError('bad_input', `${id} is not a finding id (expected f-0001)`, EXIT.badInput)
      if (!existsSync(findingPath(id))) throw new DocketError('not_found', `no finding ${id}`, EXIT.notFound)
      return readJson<Finding>(findingPath(id))
    },
    allFindings: () => ws.findingIds().map((id) => ws.readFinding(id)),
    saveFinding: (finding, expectedRev) => {
      if (expectedRev !== undefined && existsSync(findingPath(finding.id))) {
        const stored = readJson<Finding>(findingPath(finding.id))
        if (stored.rev !== expectedRev) {
          throw new DocketError('rev_conflict', `${finding.id} changed since you read it (rev ${expectedRev}, now ${stored.rev}). Read it again.`, EXIT.revConflict)
        }
      }
      const next: Finding = { ...finding, rev: finding.rev + 1, updatedAt: now }
      assertValid('finding', next)
      writeJsonAtomic(findingPath(finding.id), next)
      return next
    },
    readSources: () => readJson<SourcesFile>(join(docketDir, 'sources.json')),
    saveSources: (sources) => {
      assertValid('sources', sources)
      writeJsonAtomic(join(docketDir, 'sources.json'), sources)
    },
    saveUnit: (unit) => {
      const next = { ...unit, updatedAt: now }
      writeUnit(docketDir, next)
      ws.unit = next
    },
    event: (actor, type, extra = {}) => appendEvent(docketDir, ctx, worktree.head, actor, type, extra)
  }
  return ws
}
