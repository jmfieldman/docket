import { execFileSync } from 'node:child_process'
import { DocketError } from './errors.ts'
import { badInput, compact, decide, setStale } from './findings.ts'
import { EXIT, type Workspace } from './workspace.ts'
import { isOpen, type Finding, type Iteration, type Option, type Verification } from './types.ts'

function git(ws: Workspace, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: ws.worktree.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    throw new DocketError('bad_input', `git ${args.join(' ')} failed`, EXIT.badInput)
  }
}

function currentIteration(finding: Finding): Iteration {
  const it = finding.iterations.at(-1)
  if (!it) throw new DocketError('invalid_state', `${finding.id} has no decision`, EXIT.invalidState)
  return it
}

function requireFixing(finding: Finding): Iteration {
  if (finding.state !== 'fixing') {
    throw new DocketError('invalid_state', `${finding.id} is ${finding.state}, not fixing. Run \`docket apply next\` first.`, EXIT.invalidState)
  }
  return currentIteration(finding)
}

function chosenOption(finding: Finding, it: Iteration): Option | undefined {
  return finding.research?.options.find((o) => o.id === it.decision.optionId)
}

export interface ApplyTask {
  finding: Finding
  iteration: Iteration
  option: Option | null
  remainingInQueue: number
}

function queued(ws: Workspace): Finding[] {
  return ws
    .allFindings()
    .filter((f) => f.state === 'queued')
    .sort((a, b) => (currentIteration(a).queue?.position ?? 0) - (currentIteration(b).queue?.position ?? 0))
}

/**
 * Hands the applier its next finding. A finding already in `fixing` comes back
 * first, so an applier that restarts resumes its work. Returns null and marks
 * the applier idle when the queue is empty.
 */
export function nextTask(ws: Workspace, terminalHandle?: string): ApplyTask | null {
  const inProgress = ws.allFindings().find((f) => f.state === 'fixing')
  const pending = queued(ws)
  const finding = inProgress ?? pending.shift()
  if (!finding) {
    if (ws.unit.applier?.state !== 'idle') {
      ws.saveUnit({ ...ws.unit, applier: { state: 'idle', since: ws.now } })
    }
    return null
  }
  const iteration = currentIteration(finding)
  let saved = finding
  if (!inProgress) {
    iteration.outcome = 'fixing'
    iteration.startedAt = ws.now
    ws.event('applier', 'state_changed', { findingId: finding.id, from: 'queued', to: 'fixing' })
    finding.state = 'fixing'
    saved = ws.saveFinding(finding)
    ws.event('applier', 'apply_started', { findingId: finding.id, iteration: iteration.n })
  }
  ws.saveUnit({ ...ws.unit, applier: compact({ state: 'running' as const, terminalHandle: terminalHandle ?? ws.unit.applier?.terminalHandle, since: ws.unit.applier?.state === 'running' ? ws.unit.applier.since : ws.now }) })
  const it = currentIteration(saved)
  return { finding: saved, iteration: it, option: chosenOption(saved, it) ?? null, remainingInQueue: pending.length }
}

/** Line ranges (new side) changed by a commit, per file. */
function changedRanges(ws: Workspace, sha: string): Map<string, Array<[number, number]>> {
  const diff = git(ws, ['show', '--unified=0', '--format=', '--no-color', sha])
  const ranges = new Map<string, Array<[number, number]>>()
  let file: string | null = null
  for (const line of diff.split('\n')) {
    const header = line.match(/^\+\+\+ b\/(.+)$/)
    if (header?.[1]) {
      file = header[1]
      ranges.set(file, ranges.get(file) ?? [])
      continue
    }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunk && file) {
      const start = Number(hunk[3])
      const count = hunk[4] === undefined ? 1 : Number(hunk[4])
      ranges.get(file)?.push([start, start + Math.max(count, 1) - 1])
    }
  }
  return ranges
}

/** Sets the stale flag on open findings whose location overlaps lines a commit changed. */
function flagOverlaps(ws: Workspace, sha: string, exclude: Set<string>, actor: 'applier' | 'session'): string[] {
  const ranges = changedRanges(ws, sha)
  const flagged: string[] = []
  for (const other of ws.allFindings()) {
    if (exclude.has(other.id) || !isOpen(other.state) || other.state === 'fixing' || !other.location) continue
    const touched = ranges.get(other.location.path)
    if (!touched) continue
    const { startLine, endLine } = other.location
    const overlaps =
      startLine === undefined ||
      touched.some(([a, b]) => a <= (endLine ?? startLine) + 3 && b >= startLine - 3)
    if (overlaps) {
      setStale(ws, other.id, `Code under this finding changed in ${sha.slice(0, 7)}.`, actor)
      flagged.push(other.id)
    }
  }
  return flagged
}

export function addCommit(ws: Workspace, id: string, ref: string, actor: 'applier' | 'session' = 'applier') {
  const finding = ws.readFinding(id)
  const it = requireFixing(finding)
  const sha = git(ws, ['rev-parse', '--verify', `${ref}^{commit}`])
  const message = git(ws, ['log', '-1', '--format=%s', sha])
  it.commits = [...(it.commits ?? []).filter((c) => c.sha !== sha), { sha, message }]
  const saved = ws.saveFinding(finding)
  ws.event(actor, 'apply_committed', { findingId: id, iteration: it.n, data: { commit: sha } })
  const staleFlagged = flagOverlaps(ws, sha, new Set([id, ...(it.alsoResolves ?? [])]), actor)
  return { finding: saved, commit: { sha, message }, staleFlagged }
}

function checkVerification(input: Verification): Verification {
  if (!['passed', 'failed', 'skipped'].includes(input?.status)) badInput('verification.status must be passed, failed or skipped')
  if (!Array.isArray(input.checks)) badInput('verification.checks must be an array')
  if (input.status === 'skipped' && !input.notes) badInput('a skipped verification needs notes that say why')
  return compact({ status: input.status, checks: input.checks.map((c) => compact({ ...c })), notes: input.notes })
}

export function writeVerification(ws: Workspace, id: string, input: Verification, actor: 'applier' | 'session' = 'applier'): Finding {
  const finding = ws.readFinding(id)
  const it = requireFixing(finding)
  it.verification = checkVerification(input)
  const saved = ws.saveFinding(finding)
  ws.event(actor, 'verification_written', { findingId: id, iteration: it.n, data: { status: input.status } })
  return saved
}

function closeAlsoResolved(ws: Workspace, by: Finding, it: Iteration, lastSha: string, actor: 'applier' | 'session'): void {
  for (const otherId of it.alsoResolves ?? []) {
    const other = ws.readFinding(otherId)
    if (!isOpen(other.state) || other.state === 'fixing') continue
    const pending = other.iterations.at(-1)
    if (pending && ['pending', 'queued', 'needs_attention'].includes(pending.outcome)) {
      pending.outcome = 'abandoned'
      pending.endedAt = ws.now
    }
    ws.event(actor, 'state_changed', { findingId: otherId, from: other.state, to: 'completed' })
    other.state = 'completed'
    other.stale = null
    other.resolution = {
      outcome: 'completed',
      summary: `Closed by ${by.id} iteration ${it.n} (${lastSha.slice(0, 7)}).`,
      closedAt: ws.now,
      closedAtCommit: lastSha,
      resolvedBy: { findingId: by.id, iteration: it.n }
    }
    const saved = ws.saveFinding(other)
    ws.event(actor, 'finding_closed', { findingId: otherId, to: 'completed', rev: saved.rev, data: { resolvedBy: `${by.id}#${it.n}` } })
  }
}

export function completeTask(ws: Workspace, id: string, input: { summary: string; also?: string[] }, actor: 'applier' | 'session' = 'applier'): Finding {
  const finding = ws.readFinding(id)
  const it = requireFixing(finding)
  const lastSha = it.commits?.at(-1)?.sha
  if (!lastSha) badInput(`${id} has no commit; run \`docket apply commit ${id} <sha>\` first`)
  if (!it.verification) badInput(`${id} has no verification; run \`docket apply verify ${id}\` first`)
  if (it.verification.status === 'failed') badInput(`${id} failed verification; run \`docket apply bounce ${id}\` instead`)
  if (!input.summary?.trim()) badInput('summary is required')

  const also = [...new Set((input.also ?? []).filter((x) => x && x !== id))]
  for (const otherId of also) ws.readFinding(otherId)
  if (also.length) it.alsoResolves = also
  it.outcome = 'completed'
  it.summary = input.summary
  it.endedAt = ws.now
  ws.event(actor, 'state_changed', { findingId: id, from: 'fixing', to: 'completed' })
  finding.state = 'completed'
  finding.stale = null
  finding.resolution = { outcome: 'completed', summary: input.summary, closedAt: ws.now, closedAtCommit: lastSha }
  closeAlsoResolved(ws, finding, it, lastSha, actor)
  const saved = ws.saveFinding(finding)
  ws.event(actor, 'finding_closed', { findingId: id, iteration: it.n, to: 'completed', rev: saved.rev })
  return saved
}

export function bounceTask(ws: Workspace, id: string, reason: string, actor: 'applier' | 'session' = 'applier'): Finding {
  const finding = ws.readFinding(id)
  const it = requireFixing(finding)
  if (!reason?.trim()) badInput('reason is required')
  it.outcome = 'needs_attention'
  it.bounceReason = reason
  it.endedAt = ws.now
  ws.event(actor, 'state_changed', { findingId: id, from: 'fixing', to: 'needs_attention' })
  finding.state = 'needs_attention'
  const saved = ws.saveFinding(finding)
  ws.event(actor, 'apply_bounced', { findingId: id, iteration: it.n, data: { reason } })
  return saved
}

export interface RecordInput {
  optionId: string
  instruction?: string
  commits: string[]
  verification: Verification
  summary: string
  also?: string[]
}

/**
 * Records work an ad-hoc session already did on an existing finding: one
 * session-origin iteration with its commits and verification. Closes the
 * finding as completed when verification did not fail.
 */
export function recordSessionWork(ws: Workspace, id: string, input: RecordInput) {
  const warning = ws.unit.applier?.state === 'running' ? 'The applier is running in this worktree. Coordinate before editing code.' : undefined
  if (!Array.isArray(input.commits) || input.commits.length === 0) badInput('commits needs at least one sha')
  const verification = checkVerification(input.verification)

  const decided = decide(ws, id, compact({ optionId: input.optionId, kind: 'fix' as const, instruction: input.instruction, origin: 'session' as const }))
  const it = currentIteration(decided)
  delete it.queue
  it.outcome = 'fixing'
  it.startedAt = ws.now
  ws.event('session', 'state_changed', { findingId: id, from: 'queued', to: 'fixing' })
  decided.state = 'fixing'
  ws.saveFinding(decided)

  for (const ref of input.commits) addCommit(ws, id, ref, 'session')
  writeVerification(ws, id, verification, 'session')
  const finding = verification.status === 'failed'
    ? bounceTask(ws, id, verification.notes ?? 'Verification failed.', 'session')
    : completeTask(ws, id, compact({ summary: input.summary, also: input.also }), 'session')
  return compact({ finding, warning })
}

export function queueSummary(ws: Workspace) {
  const items = ws.allFindings().filter((f) => f.state === 'queued' || f.state === 'fixing')
  return {
    applier: ws.unit.applier ?? { state: 'idle' },
    items: items
      .map((f) => ({ id: f.id, title: f.title, state: f.state, position: currentIteration(f).queue?.position ?? null, origin: currentIteration(f).origin }))
      .sort((a, b) => (a.state === 'fixing' ? -1 : b.state === 'fixing' ? 1 : (a.position ?? 0) - (b.position ?? 0)))
  }
}
