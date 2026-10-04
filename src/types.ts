// TypeScript shapes for the docket files. spec/schema is the source of truth;
// every write is validated against it, so these types only help the compiler.

export type State =
  | 'new' | 'ready' | 'discussing' | 'queued' | 'fixing' | 'needs_attention'
  | 'completed' | 'acknowledged' | 'deferred' | 'resolved_externally'

export type ClosedOutcome = 'completed' | 'acknowledged' | 'deferred' | 'resolved_externally'
export type OptionKind = 'fix' | 'acknowledge' | 'defer'
export type Lane = 'quick' | 'decide' | 'scope' | 'dig'
export type Origin = 'panel' | 'quick' | 'session'

export const OPEN_STATES: readonly State[] = ['new', 'ready', 'discussing', 'queued', 'fixing', 'needs_attention']
export const CLOSED_STATES: readonly State[] = ['completed', 'acknowledged', 'deferred', 'resolved_externally']
export const isOpen = (state: State): boolean => OPEN_STATES.includes(state)

export interface Location {
  path: string
  symbol?: string
  startLine?: number
  endLine?: number
  commit?: string
}

export interface BlastRadius {
  level: 'surgical' | 'contained' | 'broad' | 'sweeping'
  estimatedFiles?: number
  areas?: string[]
  publicApi?: boolean
  migration?: boolean
  featureFlag?: boolean
  notes?: string
}

export interface Option {
  id: string
  kind: OptionKind
  title: string
  description: string
  pros: string[]
  cons: string[]
  effort: 'trivial' | 'small' | 'medium' | 'large'
  blastRadius: BlastRadius
}

export interface Research {
  verdict: 'valid' | 'partially_valid' | 'not_valid' | 'unclear'
  confidence: 'low' | 'medium' | 'high'
  assessedSeverity?: 'critical' | 'high' | 'medium' | 'low' | 'nit'
  analysis: string
  evidence?: Array<{ path: string; symbol?: string; startLine?: number; endLine?: number; note: string }>
  options: Option[]
  recommendedOptionId: string
  researchedAt: string
  researchedAtCommit: string
}

export interface Triage {
  complexity: number
  complexityReason: string
  confidence: number
  confidenceReason: string
  lane: Lane
  assessedAt: string
  assessedAtCommit: string
}

export interface Verification {
  status: 'passed' | 'failed' | 'skipped'
  checks: Array<{ name: string; result: 'passed' | 'failed' | 'skipped'; detail?: string }>
  notes?: string
}

export interface Iteration {
  n: number
  origin: Origin
  decision: { optionId: string; kind: OptionKind; instruction?: string }
  decidedAt: string
  decidedAtCommit: string
  queue?: { position: number; queuedAt: string }
  startedAt?: string
  commits?: Array<{ sha: string; message: string }>
  verification?: Verification
  alsoResolves?: string[]
  outcome: 'pending' | 'queued' | 'fixing' | 'completed' | 'needs_attention' | 'abandoned' | 'acknowledged' | 'deferred'
  bounceReason?: string
  summary?: string
  endedAt?: string
}

export interface Resolution {
  outcome: ClosedOutcome
  summary: string
  reason?: string
  closedAt: string
  closedAtCommit: string
  resolvedBy?: { findingId: string; iteration: number }
  deferral?: { id: string; path: string }
}

export interface Discussion {
  sessionId?: string
  startedAt: string
  lastActiveAt?: string
  entries: Array<{ at: string; head: string; question: string; answer: string; optionsChanged?: boolean }>
}

export interface Reply {
  status: 'none' | 'drafted' | 'approved' | 'posted' | 'skipped'
  draft?: string
  targetSourceId?: string
  resolveThread?: boolean
  postedUrl?: string
  postedAt?: string
}

export interface FindingSourceRef {
  sourceId: string
  excerpt: string
  ordinal?: number
}

export interface Finding {
  schemaVersion: 1
  id: string
  rev: number
  state: State
  stale?: { reason: string; since: string; sinceCommit: string } | null
  title: string
  summary: string
  explanation?: string
  severityRationale?: string
  category?: string
  reviewerSeverity?: string
  location?: Location | null
  detectedAtCommit: string
  sources: FindingSourceRef[]
  research?: Research | null
  triage?: Triage | null
  discussion?: Discussion | null
  iterations: Iteration[]
  resolution?: Resolution | null
  reply?: Reply | null
  createdAt: string
  updatedAt: string
}

export interface SourceRecord {
  kind: 'github_review_thread' | 'github_review' | 'github_issue_comment' | 'local_report' | 'session_review'
  externalId: string
  title?: string
  url?: string
  author?: string
  isBot?: boolean
  updatedAt?: string
  contentHash: string
  replyCount?: number
  threadResolved?: boolean
  threadOutdated?: boolean
  status: 'active' | 'deleted'
  findingIds: string[]
  ingestedAt: string
}

export interface SourcesFile {
  schemaVersion: 1
  sources: Record<string, SourceRecord>
}
