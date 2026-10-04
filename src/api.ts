// The action layer behind every docket UI: the Claude Code pane (through
// `docket api`) and the local web app (`docket ui`). Each call names a
// worktree path explicitly.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pause, resume, start, status, type Context, type Unit } from './docket.ts'
import { DocketError } from './errors.ts'
import { readJson } from './fsio.ts'
import { acceptRecommended, decide, draftReply, endDiscussion, markViewed, reopen, unqueue, setReplyStatus, clearStale, type DecisionInput } from './findings.ts'
import { readWorktree } from './git.ts'
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

export interface WorktreeItem {
  path: string
  branch: string | null
  head: string | null
  isCurrent: boolean
  docket: PeekState
}

/** The repository's worktrees from `git worktree list`, with docket's state in each. */
export function worktrees(path: string): { items: WorktreeItem[] } {
  ctxFor(path)
  let out: string
  try {
    out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return { items: [] }
  }
  let current: string | null = null
  try {
    current = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    current = null
  }
  const items: WorktreeItem[] = []
  for (const block of out.split(/\n\n+/)) {
    const lines = block.split('\n')
    const wtPath = lines.find((l) => l.startsWith('worktree '))?.slice(9)
    if (!wtPath || lines.includes('bare') || lines.includes('prunable')) continue
    const branch = lines.find((l) => l.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? null
    const head = lines.find((l) => l.startsWith('HEAD '))?.slice(5) ?? null
    items.push({ path: wtPath, branch, head, isCurrent: wtPath === current, docket: peek(wtPath).state })
  }
  return { items }
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
        discussionSessionId: f.discussion?.sessionId ?? null,
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
  | 'accept' | 'decide' | 'unqueue' | 'reopen' | 'unstale' | 'endDiscussion'
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
      return write((ws) => acceptRecommended(ws, ids.map(findingId)))
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
    case 'unqueue':
      return write((ws) => unqueue(ws, findingId(args.id), typeof args.rev === 'number' ? args.rev : undefined))
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

// ---------- agent plans ----------
//
// Agent work runs as a docket skill in a Claude Code session. A plan names the
// skill and its arguments; the pane runs it in its own session, and the web
// app shows it for the user to run.

export type PlanKind = 'ingest' | 'research' | 'apply' | 'reply' | 'discuss' | 'quickFix'

export interface AgentPlan {
  /** The skill to run, such as `docket:apply`. */
  command: string
  /** Its arguments, such as `f-0003`. */
  args: string
  /** What the user types in Claude Code: `/docket:apply`. */
  prompt: string
  /** Set when something deserves a word before the skill runs. */
  warning?: string
  /** For a discussion: the session that held it before, for `claude --resume`. */
  resumeSessionId?: string
}

function planFor(command: string, args: string[] = [], extra: Partial<AgentPlan> = {}): AgentPlan {
  const joined = args.join(' ')
  return { command: `docket:${command}`, args: joined, prompt: `/docket:${command}${joined ? ` ${joined}` : ''}`, ...extra }
}

function applyPlan(unit: Unit, sessionId?: string): AgentPlan {
  const applier = unit.applier
  const elsewhere = applier?.state === 'running' && applier.sessionId && applier.sessionId !== sessionId
  return planFor('apply', [], elsewhere ? { warning: `An applier has been running in another session since ${applier.since ?? 'earlier'}. Run apply here only if that session ended.` } : {})
}

export function plan(path: string, kind: PlanKind, args: Record<string, any> = {}, options: ApiOptions = {}) {
  const ctx = ctxFor(path, options)
  const unitOf = () => withWorkspace(ctx, 'read', (ws) => ws.unit)
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined

  switch (kind) {
    case 'ingest':
    case 'reply':
      unitOf()
      return planFor(kind)
    case 'research': {
      unitOf()
      const ids = Array.isArray(args.ids) ? args.ids.map(findingId) : []
      return planFor('research', ids)
    }
    case 'apply':
      return applyPlan(unitOf(), sessionId)
    case 'quickFix': {
      const id = findingId(args.id)
      const decided = withWorkspace(ctx, 'write', (ws) => {
        const f = ws.readFinding(id)
        const optionId = typeof args.optionId === 'string' ? args.optionId : (f.research?.recommendedOptionId ?? bad(`${id} has no recommendation; research it first`))
        return decide(ws, id, { optionId, origin: 'quick' })
      })
      return { finding: decided, plan: decided.state === 'queued' ? applyPlan(unitOf(), sessionId) : null }
    }
    case 'discuss': {
      const id = findingId(args.id)
      const f = withWorkspace(ctx, 'read', (ws) => ws.readFinding(id))
      if (!isOpen(f.state)) bad(`${id} is closed; reopen it to discuss`)
      return planFor('discuss', [id], f.discussion?.sessionId ? { resumeSessionId: f.discussion.sessionId } : {})
    }
  }
  bad(`unknown plan ${String(kind)}`)
}
