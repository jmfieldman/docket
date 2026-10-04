import { createHash } from 'node:crypto'
import { DocketError } from './errors.ts'
import { writeDeferral } from './deferrals.ts'
import { EXIT, type Workspace } from './workspace.ts'
import {
  isOpen,
  type Finding,
  type FindingSourceRef,
  type Iteration,
  type Lane,
  type Location,
  type Option,
  type OptionKind,
  type Origin,
  type Research,
  type SourceRecord,
  type State,
  type Triage
} from './types.ts'

// ---------- helpers ----------

export function badInput(message: string): never {
  throw new DocketError('bad_input', message, EXIT.badInput)
}

function invalidState(finding: Finding, action: string): never {
  throw new DocketError('invalid_state', `cannot ${action} ${finding.id}: it is ${finding.state}`, EXIT.invalidState)
}

/** Drops keys whose value is undefined, so optional fields stay absent (exactOptionalPropertyTypes). */
export function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') badInput(`${name} is required`)
  return value
}

/** SPEC.md "Lanes": the boundary on both axes falls between levels 2 and 3. */
export function laneFor(complexity: number, confidence: number): Lane {
  const simple = complexity <= 2
  const confident = confidence >= 3
  if (simple) return confident ? 'quick' : 'decide'
  return confident ? 'scope' : 'dig'
}

function setState(ws: Workspace, finding: Finding, to: State, actor: Parameters<Workspace['event']>[0]): void {
  if (finding.state === to) return
  ws.event(actor, 'state_changed', { findingId: finding.id, from: finding.state, to })
  finding.state = to
}

/** The latest iteration that has not finished. */
function openIteration(finding: Finding): Iteration | undefined {
  const last = finding.iterations.at(-1)
  return last && ['pending', 'queued', 'fixing', 'needs_attention'].includes(last.outcome) ? last : undefined
}

/** A bounced iteration keeps its needs_attention outcome as history; only waiting work is abandoned. */
function abandonPending(ws: Workspace, finding: Finding): void {
  const last = finding.iterations.at(-1)
  if (last && (last.outcome === 'pending' || last.outcome === 'queued')) {
    last.outcome = 'abandoned'
    last.endedAt = ws.now
  }
}

// ---------- sources ----------

export function normalizedHash(text: string): string {
  return `sha256:${createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex')}`
}

export interface SourceInput {
  sourceId: string
  kind: SourceRecord['kind']
  externalId: string
  /** Full text including replies. Hashed to detect changes. Give text or contentHash. */
  text?: string
  contentHash?: string
  url?: string
  author?: string
  isBot?: boolean
  updatedAt?: string
  replyCount?: number
  threadResolved?: boolean
  threadOutdated?: boolean
}

export function upsertSource(ws: Workspace, input: SourceInput) {
  requireString(input.sourceId, 'sourceId')
  const contentHash = input.contentHash ?? (input.text !== undefined ? normalizedHash(input.text) : badInput('text or contentHash is required'))
  const sources = ws.readSources()
  const previous = sources.sources[input.sourceId]
  const status: 'new' | 'changed' | 'unchanged' = !previous ? 'new' : previous.contentHash !== contentHash || previous.status === 'deleted' ? 'changed' : 'unchanged'
  const resolvedNow = input.threadResolved === true && previous?.threadResolved !== true

  const record: SourceRecord = compact({
    kind: input.kind,
    externalId: input.externalId,
    url: input.url ?? previous?.url,
    author: input.author ?? previous?.author,
    isBot: input.isBot ?? previous?.isBot,
    updatedAt: input.updatedAt ?? previous?.updatedAt,
    contentHash,
    replyCount: input.replyCount ?? previous?.replyCount,
    threadResolved: input.threadResolved ?? previous?.threadResolved,
    threadOutdated: input.threadOutdated ?? previous?.threadOutdated,
    status: 'active' as const,
    findingIds: previous?.findingIds ?? [],
    ingestedAt: ws.now
  })
  sources.sources[input.sourceId] = record
  ws.saveSources(sources)
  if (status !== 'unchanged') ws.event('ingest', status === 'new' ? 'source_added' : 'source_changed', { sourceId: input.sourceId })
  return { sourceId: input.sourceId, status, resolvedNow, findingIds: record.findingIds }
}

export function deleteSource(ws: Workspace, sourceId: string) {
  const sources = ws.readSources()
  const record = sources.sources[sourceId]
  if (!record) throw new DocketError('not_found', `no source ${sourceId}`, EXIT.notFound)
  record.status = 'deleted'
  ws.saveSources(sources)
  ws.event('ingest', 'source_deleted', { sourceId })
  return { sourceId, findingIds: record.findingIds }
}

function linkSource(ws: Workspace, sourceId: string, findingId: string): void {
  const sources = ws.readSources()
  const record = sources.sources[sourceId]
  if (!record) badInput(`source ${sourceId} is not recorded; run \`docket source upsert\` first`)
  if (!record.findingIds.includes(findingId)) {
    record.findingIds.push(findingId)
    ws.saveSources(sources)
  }
}

// ---------- findings ----------

export interface FindingInput {
  title: string
  summary: string
  explanation?: string
  severityRationale?: string
  category?: string
  reviewerSeverity?: string
  location?: Location | null
  sources: FindingSourceRef[]
}

export function addFinding(ws: Workspace, input: FindingInput): Finding {
  requireString(input.title, 'title')
  requireString(input.summary, 'summary')
  if (!Array.isArray(input.sources) || input.sources.length === 0) badInput('sources needs at least one entry')
  const id = `f-${String(ws.unit.nextFindingNumber).padStart(4, '0')}`
  for (const ref of input.sources) linkSource(ws, ref.sourceId, id)

  const finding: Finding = compact({
    schemaVersion: 1 as const,
    id,
    rev: -1,
    state: 'new' as State,
    stale: null,
    title: input.title,
    summary: input.summary,
    explanation: input.explanation,
    severityRationale: input.severityRationale,
    category: input.category,
    reviewerSeverity: input.reviewerSeverity,
    location: input.location ?? null,
    detectedAtCommit: ws.head,
    sources: input.sources.map((ref) => compact({ sourceId: ref.sourceId, excerpt: ref.excerpt, ordinal: ref.ordinal })),
    research: null,
    triage: null,
    discussion: null,
    iterations: [],
    resolution: null,
    reply: { status: 'none' as const },
    createdAt: ws.now,
    updatedAt: ws.now
  })
  const saved = ws.saveFinding(finding)
  ws.saveUnit({ ...ws.unit, nextFindingNumber: ws.unit.nextFindingNumber + 1 })
  ws.event('ingest', 'finding_created', { findingId: id, sourceId: input.sources[0]?.sourceId, to: 'new', rev: saved.rev })
  return saved
}

export function mergeSourceIntoFinding(ws: Workspace, id: string, ref: FindingSourceRef, rev?: number): Finding {
  const finding = ws.readFinding(id)
  requireString(ref.sourceId, 'sourceId')
  linkSource(ws, ref.sourceId, id)
  if (!finding.sources.some((s) => s.sourceId === ref.sourceId)) {
    finding.sources.push(compact({ sourceId: ref.sourceId, excerpt: ref.excerpt, ordinal: ref.ordinal }))
  }
  const saved = ws.saveFinding(finding, rev)
  ws.event('ingest', 'finding_merged', { findingId: id, sourceId: ref.sourceId, rev: saved.rev })
  return saved
}

const UPDATABLE = ['title', 'summary', 'explanation', 'severityRationale', 'category', 'reviewerSeverity', 'location'] as const

export function updateFinding(ws: Workspace, id: string, patch: Partial<FindingInput>, rev?: number): Finding {
  const finding = ws.readFinding(id) as unknown as Record<string, unknown>
  for (const key of Object.keys(patch)) {
    if (!(UPDATABLE as readonly string[]).includes(key)) badInput(`cannot update ${key}; allowed: ${UPDATABLE.join(', ')}`)
    finding[key] = (patch as Record<string, unknown>)[key]
  }
  const saved = ws.saveFinding(finding as unknown as Finding, rev)
  ws.event('ingest', 'finding_updated', { findingId: id, rev: saved.rev, data: { fields: Object.keys(patch) } })
  return saved
}

// ---------- research and triage ----------

export interface TriageInput {
  complexity: number
  complexityReason: string
  confidence: number
  confidenceReason: string
}

function buildTriage(ws: Workspace, input: TriageInput): Triage {
  for (const key of ['complexity', 'confidence'] as const) {
    if (!Number.isInteger(input[key]) || input[key] < 1 || input[key] > 4) badInput(`triage.${key} must be an integer 1-4`)
  }
  return {
    complexity: input.complexity,
    complexityReason: requireString(input.complexityReason, 'triage.complexityReason'),
    confidence: input.confidence,
    confidenceReason: requireString(input.confidenceReason, 'triage.confidenceReason'),
    lane: laneFor(input.complexity, input.confidence),
    assessedAt: ws.now,
    assessedAtCommit: ws.head
  }
}

function checkOptions(options: Option[], recommendedOptionId: string): void {
  if (!Array.isArray(options) || options.length < 2) badInput('research needs at least 2 options')
  const ids = options.map((o) => o.id)
  if (new Set(ids).size !== ids.length) badInput('option ids must be unique')
  if (!ids.includes(recommendedOptionId)) badInput(`recommendedOptionId ${recommendedOptionId} is not one of ${ids.join(', ')}`)
}

export interface ResearchInput {
  research: Omit<Research, 'researchedAt' | 'researchedAtCommit'>
  triage: TriageInput
  explanation?: string
  severityRationale?: string
}

export function writeResearch(ws: Workspace, id: string, input: ResearchInput, rev?: number): Finding {
  const finding = ws.readFinding(id)
  if (!isOpen(finding.state) || finding.state === 'queued' || finding.state === 'fixing') invalidState(finding, 'research')
  if (!input?.research || !input.triage) badInput('research and triage are required')
  checkOptions(input.research.options, input.research.recommendedOptionId)

  finding.research = { ...input.research, researchedAt: ws.now, researchedAtCommit: ws.head }
  finding.triage = buildTriage(ws, input.triage)
  if (input.explanation !== undefined) finding.explanation = input.explanation
  if (input.severityRationale !== undefined) finding.severityRationale = input.severityRationale
  finding.stale = null
  if (finding.state !== 'discussing') setState(ws, finding, 'ready', 'research')
  const saved = ws.saveFinding(finding, rev)
  ws.event('research', 'research_written', { findingId: id, rev: saved.rev })
  ws.event('research', 'triage_written', { findingId: id, data: { lane: saved.triage?.lane } })
  return saved
}

export function setStale(ws: Workspace, id: string, reason: string, actor: Parameters<Workspace['event']>[0] = 'ingest'): Finding {
  const finding = ws.readFinding(id)
  if (!isOpen(finding.state)) return finding
  finding.stale = { reason: requireString(reason, 'reason'), since: ws.now, sinceCommit: ws.head }
  const saved = ws.saveFinding(finding)
  ws.event(actor, 'stale_flag_set', { findingId: id, data: { reason } })
  return saved
}

export function clearStale(ws: Workspace, id: string): Finding {
  const finding = ws.readFinding(id)
  if (!finding.stale) return finding
  finding.stale = null
  const saved = ws.saveFinding(finding)
  ws.event('research', 'stale_flag_cleared', { findingId: id })
  return saved
}

// ---------- discussion ----------

export function startDiscussion(ws: Workspace, id: string, input: { sessionId?: string; terminalHandle?: string }): Finding {
  const finding = ws.readFinding(id)
  if (!['new', 'ready', 'needs_attention', 'discussing'].includes(finding.state)) invalidState(finding, 'discuss')
  const previous = finding.discussion
  finding.discussion = compact({
    sessionId: input.sessionId ?? previous?.sessionId,
    terminalHandle: input.terminalHandle ?? previous?.terminalHandle,
    startedAt: previous?.startedAt ?? ws.now,
    lastActiveAt: ws.now,
    entries: previous?.entries ?? []
  })
  setState(ws, finding, 'discussing', 'dispatcher')
  const saved = ws.saveFinding(finding)
  ws.event('discuss', 'discussion_started', { findingId: id })
  return saved
}

export interface DiscussionEntryInput {
  question: string
  answer: string
  options?: Option[]
  recommendedOptionId?: string
  triage?: TriageInput
}

export function addDiscussionEntry(ws: Workspace, id: string, input: DiscussionEntryInput, rev?: number): Finding {
  const finding = ws.readFinding(id)
  if (!isOpen(finding.state)) invalidState(finding, 'discuss')
  if (!finding.discussion) finding.discussion = { startedAt: ws.now, entries: [] }
  const optionsChanged = input.options !== undefined || input.recommendedOptionId !== undefined
  if (optionsChanged) {
    if (!finding.research) badInput('write research before revising options')
    const options = input.options ?? finding.research.options
    const recommended = input.recommendedOptionId ?? finding.research.recommendedOptionId
    checkOptions(options, recommended)
    finding.research = { ...finding.research, options, recommendedOptionId: recommended }
  }
  if (input.triage) finding.triage = buildTriage(ws, input.triage)
  finding.discussion.entries.push(
    compact({ at: ws.now, head: ws.head, question: requireString(input.question, 'question'), answer: requireString(input.answer, 'answer'), optionsChanged: optionsChanged || undefined })
  )
  finding.discussion.lastActiveAt = ws.now
  finding.stale = null
  const saved = ws.saveFinding(finding, rev)
  ws.event('discuss', 'discussion_entry', { findingId: id, rev: saved.rev })
  if (optionsChanged) ws.event('discuss', 'options_revised', { findingId: id })
  if (input.triage) ws.event('discuss', 'triage_written', { findingId: id, data: { lane: saved.triage?.lane } })
  return saved
}

export function endDiscussion(ws: Workspace, id: string): Finding {
  const finding = ws.readFinding(id)
  if (finding.state !== 'discussing') return finding
  setState(ws, finding, finding.research ? 'ready' : 'new', 'discuss')
  if (finding.discussion) finding.discussion.lastActiveAt = ws.now
  const saved = ws.saveFinding(finding)
  ws.event('discuss', 'discussion_ended', { findingId: id })
  return saved
}

// ---------- decisions ----------

export interface DecisionInput {
  optionId: string
  kind?: OptionKind
  instruction?: string
  origin?: Origin
  /** Deferral only: acceptance criteria for the deferral file. */
  doneWhen?: string[]
}

function nextQueuePosition(ws: Workspace): number {
  let max = 0
  for (const f of ws.allFindings()) {
    const it = openIteration(f)
    if (it?.queue && (f.state === 'queued' || f.state === 'fixing')) max = Math.max(max, it.queue.position)
  }
  return max + 1
}

function firstLine(text: string, max = 100): string {
  const line = text.split('\n')[0]?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function decide(ws: Workspace, id: string, input: DecisionInput, rev?: number): Finding {
  const finding = ws.readFinding(id)
  if (!['new', 'ready', 'discussing', 'needs_attention'].includes(finding.state)) invalidState(finding, 'decide on')
  const optionId = requireString(input.optionId, 'option')
  const option = optionId === 'custom' ? undefined : finding.research?.options.find((o) => o.id === optionId)
  if (optionId !== 'custom' && !option) badInput(`${id} has no option ${optionId}`)
  const kind = input.kind ?? option?.kind ?? badInput('kind is required for a custom decision')
  if (optionId === 'custom' && !input.instruction) badInput('instruction is required for a custom decision')
  const origin = input.origin ?? 'panel'

  abandonPending(ws, finding)

  const n = finding.iterations.length + 1
  const iteration: Iteration = compact({
    n,
    origin,
    decision: compact({ optionId, kind, instruction: input.instruction }),
    decidedAt: ws.now,
    decidedAtCommit: ws.head,
    outcome: 'pending' as const
  })
  finding.iterations.push(iteration)
  ws.event(origin === 'session' ? 'session' : 'ui', 'decision_written', { findingId: id, iteration: n, data: { optionId, kind, origin } })

  if (kind === 'fix') {
    iteration.queue = { position: nextQueuePosition(ws), queuedAt: ws.now }
    iteration.outcome = 'queued'
    setState(ws, finding, 'queued', 'ui')
    finding.stale = null
    const saved = ws.saveFinding(finding, rev)
    ws.event('ui', 'queued', { findingId: id, iteration: n, data: { position: iteration.queue.position } })
    return saved
  }

  const reason = input.instruction ?? option?.description ?? badInput('a reason (instruction) is required')
  iteration.endedAt = ws.now
  if (kind === 'acknowledge') {
    iteration.outcome = 'acknowledged'
    iteration.summary = `Acknowledged: ${firstLine(reason, 80)}`
    finding.resolution = { outcome: 'acknowledged', summary: iteration.summary, reason, closedAt: ws.now, closedAtCommit: ws.head }
  } else {
    const deferral = writeDeferral(ws, finding, { option, reason, doneWhen: input.doneWhen })
    iteration.outcome = 'deferred'
    iteration.summary = `Deferred: ${option?.title ?? firstLine(reason, 80)}`
    finding.resolution = { outcome: 'deferred', summary: iteration.summary, reason, closedAt: ws.now, closedAtCommit: ws.head, deferral }
    ws.event('ui', 'deferral_written', { findingId: id, iteration: n, data: { id: deferral.id } })
  }
  finding.stale = null
  setState(ws, finding, kind === 'acknowledge' ? 'acknowledged' : 'deferred', 'ui')
  const saved = ws.saveFinding(finding, rev)
  ws.event('ui', 'finding_closed', { findingId: id, iteration: n, to: saved.state, rev: saved.rev })
  return saved
}

export function reopen(ws: Workspace, id: string, reason: string): Finding {
  const finding = ws.readFinding(id)
  if (isOpen(finding.state)) invalidState(finding, 'reopen')
  finding.resolution = null
  if (finding.reply && finding.reply.status !== 'posted') finding.reply = { status: 'none' }
  setState(ws, finding, finding.research ? 'ready' : 'new', 'ui')
  const saved = ws.saveFinding(finding)
  ws.event('ui', 'finding_reopened', { findingId: id, data: { reason: requireString(reason, 'reason') } })
  return saved
}

export function resolveExternally(ws: Workspace, id: string, note?: string): Finding {
  const finding = ws.readFinding(id)
  if (!isOpen(finding.state)) return finding
  if (finding.state === 'fixing') invalidState(finding, 'resolve externally')
  abandonPending(ws, finding)
  finding.resolution = { outcome: 'resolved_externally', summary: note ?? 'Thread resolved on GitHub outside docket.', closedAt: ws.now, closedAtCommit: ws.head }
  finding.stale = null
  setState(ws, finding, 'resolved_externally', 'ingest')
  const saved = ws.saveFinding(finding)
  ws.event('ingest', 'finding_closed', { findingId: id, to: 'resolved_externally', rev: saved.rev })
  return saved
}

// ---------- replies ----------

export function draftReply(ws: Workspace, id: string, input: { text: string; targetSourceId?: string; resolveThread?: boolean }): Finding {
  const finding = ws.readFinding(id)
  if (isOpen(finding.state)) invalidState(finding, 'draft a reply for')
  const target = input.targetSourceId ?? finding.sources[0]?.sourceId
  if (target && !finding.sources.some((s) => s.sourceId === target)) badInput(`${target} is not a source of ${id}`)
  finding.reply = compact({ status: 'drafted' as const, draft: requireString(input.text, 'text'), targetSourceId: target, resolveThread: input.resolveThread })
  const saved = ws.saveFinding(finding)
  ws.event('reply', 'reply_drafted', { findingId: id })
  return saved
}

export function setReplyStatus(ws: Workspace, id: string, status: 'approved' | 'posted' | 'skipped', postedUrl?: string): Finding {
  const finding = ws.readFinding(id)
  const reply = finding.reply ?? { status: 'none' as const }
  if (status === 'approved' && reply.status !== 'drafted') badInput(`${id} has no drafted reply to approve`)
  if (status === 'posted' && reply.status !== 'approved') badInput(`${id} reply must be approved before it is posted`)
  finding.reply = compact({ ...reply, status, postedUrl: status === 'posted' ? postedUrl : reply.postedUrl, postedAt: status === 'posted' ? ws.now : reply.postedAt })
  const saved = ws.saveFinding(finding)
  if (status !== 'skipped') ws.event('reply', status === 'approved' ? 'reply_approved' : 'reply_posted', { findingId: id })
  return saved
}

// ---------- unit bookkeeping ----------

export function markViewed(ws: Workspace) {
  ws.saveUnit({ ...ws.unit, lastViewedAt: ws.now })
  ws.event('ui', 'unit_viewed')
  return ws.unit
}

export function recordRemoteCheck(ws: Workspace, newSourceCount: number) {
  if (!Number.isInteger(newSourceCount) || newSourceCount < 0) badInput('count must be a non-negative integer')
  ws.saveUnit({ ...ws.unit, remoteCheck: { at: ws.now, newSourceCount } })
  ws.event('ui', 'remote_checked', { data: { newSourceCount } })
  return ws.unit
}

export function recordIngest(ws: Workspace) {
  ws.saveUnit({ ...ws.unit, lastIngest: { at: ws.now, head: ws.head }, remoteCheck: ws.unit.remoteCheck ? { at: ws.now, newSourceCount: 0 } : null })
  return ws.unit
}

export function attachPr(ws: Workspace, pr: { number: number; url: string }) {
  if (!Number.isInteger(pr.number) || pr.number < 1) badInput('number must be a positive integer')
  ws.saveUnit({ ...ws.unit, pr: { number: pr.number, url: requireString(pr.url, 'url') } })
  ws.event('cli', 'pr_attached', { data: { number: pr.number } })
  return ws.unit
}
