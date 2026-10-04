// The action layer behind every docket UI: the local web app (`docket ui`)
// and the Orca panel worker. Each call names a worktree path explicitly.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pause, resume, start, status, type Context, type Unit } from './docket.ts'
import { DocketError } from './errors.ts'
import { readJson } from './fsio.ts'
import { decide, draftReply, endDiscussion, markViewed, reopen, setReplyStatus, startDiscussion, clearStale, type DecisionInput } from './findings.ts'
import { readWorktree } from './git.ts'
import { createTerminal, findOrca, focusTerminal, listOrcaWorktrees, sendToTerminal, terminalAlive } from './orca.ts'
import { isOpen, type Finding, type OptionKind, type Origin } from './types.ts'
import { sortSummaries, summarize } from './view.ts'
import { EXIT, withWorkspace } from './workspace.ts'
import { listDeferrals } from './deferrals.ts'
import { execFileSync } from 'node:child_process'

export interface ApiOptions {
  now?: () => string
  prLookup?: boolean
}

const FINDING_ID = /^f-\d{4,}$/
const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/

function ctxFor(path: string, options: ApiOptions = {}): Context {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new DocketError('bad_input', 'path must be an absolute worktree path', EXIT.badInput)
  return { cwd: path, now: options.now ?? (() => new Date().toISOString()), prLookup: options.prLookup ?? true }
}

function bad(message: string): never {
  throw new DocketError('bad_input', message, EXIT.badInput)
}

function findingId(value: unknown): string {
  if (typeof value !== 'string' || !FINDING_ID.test(value)) bad('a finding id such as f-0001 is required')
  return value
}

// ---------- worktrees ----------

type PeekState = 'active' | 'paused' | 'not_started' | 'unknown'

/** Docket state without side effects (no stale guard), for listings. */
function peek(path: string): { state: PeekState; open: number } {
  try {
    const wt = readWorktree(path)
    const unitPath = join(wt.gitDir, 'docket', 'unit.json')
    if (!existsSync(unitPath)) return { state: 'not_started', open: 0 }
    const unit = readJson<Unit>(unitPath)
    return { state: unit.status, open: 0 }
  } catch {
    return { state: 'unknown', open: 0 }
  }
}

export function worktrees() {
  const orca = findOrca()
  if (!orca) return { orca: false, items: [] as Array<Record<string, unknown>> }
  const items = listOrcaWorktrees()
    .filter((w) => !w.isArchived)
    .map((w) => ({ ...w, docket: peek(w.path).state }))
  return { orca: true, items }
}

// ---------- reads ----------

function unpushed(cwd: string): number | null {
  try {
    return Number(execFileSync('git', ['rev-list', '--count', '@{upstream}..HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
  } catch {
    return null
  }
}

/** Everything the UI needs to render the list. Full finding detail comes from finding(). */
export function snapshot(path: string, options: ApiOptions = {}) {
  const ctx = ctxFor(path, options)
  const current = status(ctx)
  const base = { state: current.state, message: current.message, worktree: current.worktree }
  if (current.state !== 'active' && current.state !== 'paused') return { ...base, unit: null, summaries: [], counts: {}, deferralsOpen: openDeferralCount() }
  return withWorkspace(ctx, 'read', (ws) => {
    const findings = ws.allFindings()
    const counts: Record<string, number> = {}
    for (const f of findings) counts[f.state] = (counts[f.state] ?? 0) + 1
    const summaries = sortSummaries(findings.map((f) => summarize(f, ws.unit))).map((s) => {
      const f = findings.find((x) => x.id === s.id) as Finding
      return {
        ...s,
        options: s.open
          ? (f.research?.options ?? []).map((o) => ({ id: o.id, kind: o.kind, title: o.title, effort: o.effort, blast: o.blastRadius.level }))
          : [],
        discussionLive: Boolean(f.discussion?.terminalHandle) && f.state === 'discussing',
        lastIterationOutcome: f.iterations.at(-1)?.outcome ?? null,
        bounceReason: f.state === 'needs_attention' ? (f.iterations.at(-1)?.bounceReason ?? null) : null
      }
    })
    return { ...base, unit: ws.unit, head: ws.head, unpushedCommits: unpushed(ws.worktree.root), counts, summaries, deferralsOpen: openDeferralCount() }
  })
}

function openDeferralCount(): number {
  try {
    return listDeferrals(false).length
  } catch {
    return 0
  }
}

export function finding(path: string, id: string, options: ApiOptions = {}) {
  return withWorkspace(ctxFor(path, options), 'read', (ws) => {
    const f = ws.readFinding(findingId(id))
    const sources = ws.readSources().sources
    return {
      finding: f,
      sources: Object.fromEntries(f.sources.map((s) => [s.sourceId, sources[s.sourceId] ?? null]))
    }
  })
}

// ---------- actions ----------

export type ActionName =
  | 'start' | 'pause' | 'resume' | 'view'
  | 'accept' | 'decide' | 'reopen' | 'unstale' | 'endDiscussion'
  | 'replyApprove' | 'replySkip' | 'replyEdit'

export function action(path: string, name: ActionName, args: Record<string, any> = {}, options: ApiOptions = {}) {
  const ctx = ctxFor(path, options)
  const write = <T>(fn: Parameters<typeof withWorkspace<T>>[2]) => withWorkspace(ctx, 'write', fn)
  switch (name) {
    case 'start':
      return start(ctx)
    case 'pause':
      return pause(ctx)
    case 'resume':
      return resume(ctx)
    case 'view':
      return write(markViewed)
    case 'accept': {
      const ids: unknown = args.ids
      if (!Array.isArray(ids) || ids.length === 0) bad('ids must be a non-empty array')
      return write((ws) =>
        ids.map((raw) => {
          const fid = findingId(raw)
          const f = ws.readFinding(fid)
          const optionId = f.research?.recommendedOptionId ?? bad(`${fid} has no recommendation; research it first`)
          return decide(ws, fid, { optionId, origin: 'quick' })
        })
      )
    }
    case 'decide': {
      const input: DecisionInput = {
        optionId: typeof args.optionId === 'string' ? args.optionId : bad('optionId is required'),
        kind: args.kind as OptionKind | undefined,
        instruction: typeof args.instruction === 'string' && args.instruction.trim() ? args.instruction : undefined,
        origin: (args.origin ?? 'panel') as Origin,
        doneWhen: Array.isArray(args.doneWhen) ? args.doneWhen.filter((x: unknown) => typeof x === 'string' && x.trim()) : undefined
      }
      if (!['panel', 'quick'].includes(input.origin as string)) bad('origin must be panel or quick')
      return write((ws) => decide(ws, findingId(args.id), input, typeof args.rev === 'number' ? args.rev : undefined))
    }
    case 'reopen':
      return write((ws) => reopen(ws, findingId(args.id), typeof args.reason === 'string' && args.reason.trim() ? args.reason : 'Reopened from the panel.'))
    case 'unstale':
      return write((ws) => clearStale(ws, findingId(args.id)))
    case 'endDiscussion':
      return write((ws) => endDiscussion(ws, findingId(args.id)))
    case 'replyApprove':
      return write((ws) => setReplyStatus(ws, findingId(args.id), 'approved'))
    case 'replySkip':
      return write((ws) => setReplyStatus(ws, findingId(args.id), 'skipped'))
    case 'replyEdit':
      return write((ws) => {
        const f = ws.readFinding(findingId(args.id))
        return draftReply(ws, f.id, {
          text: typeof args.text === 'string' ? args.text : bad('text is required'),
          targetSourceId: f.reply?.targetSourceId,
          resolveThread: f.reply?.resolveThread
        })
      })
  }
  bad(`unknown action ${String(name)}`)
}

// ---------- agent dispatch ----------

export type DispatchKind = 'ingest' | 'research' | 'apply' | 'reply' | 'discuss' | 'ask' | 'quickFix' | 'focus'

/** Appliers started in the last two minutes, so a double click cannot start two. */
const recentAppliers = new Map<string, { handle: string; at: number }>()

function claudeCommand(prompt: string): string {
  // Prompts are built from fixed skill names and validated ids only.
  if (!/^[\w:\s/.-]+$/.test(prompt)) bad('unsafe prompt')
  return `claude "${prompt}"`
}

function requireOrca(command: string): void {
  if (!findOrca()) throw new DocketError('orca_missing', `The Orca CLI was not found. Run this in a terminal in the worktree instead: ${command}`)
}

function applierHandle(path: string, unit: Unit): string | null {
  const recent = recentAppliers.get(path)
  if (recent && Date.now() - recent.at < 120_000 && terminalAlive(recent.handle)) return recent.handle
  if (unit.applier?.state === 'running' && unit.applier.terminalHandle && terminalAlive(unit.applier.terminalHandle)) return unit.applier.terminalHandle
  return null
}

function startApplier(path: string, unit: Unit): { handle: string; reused: boolean; command: string } {
  const command = claudeCommand('/docket:apply')
  requireOrca(command)
  const existing = applierHandle(path, unit)
  if (existing) return { handle: existing, reused: true, command }
  const handle = createTerminal(path, 'docket: apply', command, false)
  recentAppliers.set(path, { handle, at: Date.now() })
  return { handle, reused: false, command }
}

export function dispatch(path: string, kind: DispatchKind, args: Record<string, any> = {}, options: ApiOptions = {}) {
  const ctx = ctxFor(path, options)
  const unitOf = () => withWorkspace(ctx, 'read', (ws) => ws.unit)

  switch (kind) {
    case 'ingest':
    case 'research':
    case 'reply': {
      unitOf()
      const ids = kind === 'research' && Array.isArray(args.ids) ? args.ids.map(findingId) : []
      const command = claudeCommand(`/docket:${kind}${ids.length ? ` ${ids.join(' ')}` : ''}`)
      requireOrca(command)
      return { handle: createTerminal(path, `docket: ${kind}`, command, true), command }
    }
    case 'apply':
      return startApplier(path, unitOf())
    case 'quickFix': {
      const id = findingId(args.id)
      const decided = withWorkspace(ctx, 'write', (ws) => {
        const f = ws.readFinding(id)
        const optionId = typeof args.optionId === 'string' ? args.optionId : (f.research?.recommendedOptionId ?? bad(`${id} has no recommendation; research it first`))
        return decide(ws, id, { optionId, origin: 'quick' })
      })
      // The decision stands even when the applier cannot start, so report both.
      if (decided.state !== 'queued') return { finding: decided, applier: null }
      try {
        return { finding: decided, applier: startApplier(path, unitOf()) }
      } catch (error) {
        if (!(error instanceof DocketError)) throw error
        return { finding: decided, applier: null, applierError: error.message }
      }
    }
    case 'discuss': {
      const id = findingId(args.id)
      const f = withWorkspace(ctx, 'read', (ws) => ws.readFinding(id))
      if (!isOpen(f.state)) bad(`${id} is closed; reopen it to discuss`)
      const live = f.discussion?.terminalHandle && terminalAlive(f.discussion.terminalHandle) ? f.discussion.terminalHandle : null
      if (live) {
        focusTerminal(live)
        return { handle: live, reused: true }
      }
      const sessionId = f.discussion?.sessionId
      const command = sessionId && SESSION_ID.test(sessionId) ? `claude --resume ${sessionId}` : claudeCommand(`/docket:discuss ${id}`)
      requireOrca(command)
      const handle = createTerminal(path, `docket: ${id}`, command, true)
      withWorkspace(ctx, 'write', (ws) => startDiscussion(ws, id, { terminalHandle: handle }))
      return { handle, reused: false, command }
    }
    case 'ask': {
      const id = findingId(args.id)
      const text = typeof args.text === 'string' && args.text.trim() ? args.text.trim() : bad('text is required')
      const f = withWorkspace(ctx, 'read', (ws) => ws.readFinding(id))
      const handle = f.discussion?.terminalHandle
      if (!handle || !terminalAlive(handle)) throw new DocketError('no_discussion', `No live discussion for ${id}. Press Discuss first.`, EXIT.invalidState)
      sendToTerminal(handle, text)
      return { handle, sent: true }
    }
    case 'focus': {
      const handle = typeof args.handle === 'string' ? args.handle : bad('handle is required')
      focusTerminal(handle)
      return { handle }
    }
  }
  bad(`unknown dispatch ${String(kind)}`)
}
