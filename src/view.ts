import { readWorktree } from './git.ts'
import { status as docketStatus, type Context, type Unit } from './docket.ts'
import { isOpen, type Finding, type Lane } from './types.ts'
import type { Workspace } from './workspace.ts'

const LANE_ORDER: Record<Lane | 'untriaged', number> = { untriaged: 0, quick: 1, decide: 2, scope: 3, dig: 4 }
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, nit: 4, unknown: 5 }

export interface FindingSummary {
  id: string
  rev: number
  title: string
  state: Finding['state']
  open: boolean
  lane: Lane | null
  complexity: number | null
  confidence: number | null
  severity: string | null
  recommended: { id: string; kind: string; title: string } | null
  stale: string | null
  isNew: boolean
  iterations: number
  lastOrigin: string | null
  resolutionSummary: string | null
  closedAt: string | null
  replyStatus: string
}

export function summarize(finding: Finding, unit: Unit): FindingSummary {
  const recommended = finding.research?.options.find((o) => o.id === finding.research?.recommendedOptionId)
  return {
    id: finding.id,
    rev: finding.rev,
    title: finding.title,
    state: finding.state,
    open: isOpen(finding.state),
    lane: finding.triage?.lane ?? null,
    complexity: finding.triage?.complexity ?? null,
    confidence: finding.triage?.confidence ?? null,
    severity: finding.research?.assessedSeverity ?? finding.reviewerSeverity ?? null,
    recommended: recommended ? { id: recommended.id, kind: recommended.kind, title: recommended.title } : null,
    stale: finding.stale?.reason ?? null,
    isNew: unit.lastViewedAt === null || finding.createdAt > unit.lastViewedAt,
    iterations: finding.iterations.length,
    lastOrigin: finding.iterations.at(-1)?.origin ?? null,
    resolutionSummary: finding.resolution?.summary ?? null,
    closedAt: finding.resolution?.closedAt ?? null,
    replyStatus: finding.reply?.status ?? 'none'
  }
}

/** Open findings first, by lane (untriaged, quick, decide, scope, dig), then severity, then age. Closed findings after, newest first. */
export function sortSummaries(items: FindingSummary[]): FindingSummary[] {
  return [...items].sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1
    if (!a.open) return (b.closedAt ?? '').localeCompare(a.closedAt ?? '')
    const lane = LANE_ORDER[a.lane ?? 'untriaged'] - LANE_ORDER[b.lane ?? 'untriaged']
    if (lane) return lane
    const severity = (SEVERITY_ORDER[a.severity ?? 'unknown'] ?? 5) - (SEVERITY_ORDER[b.severity ?? 'unknown'] ?? 5)
    return severity || a.id.localeCompare(b.id)
  })
}

export function listFindings(ws: Workspace, which: 'open' | 'closed' | 'all') {
  const all = sortSummaries(ws.allFindings().map((f) => summarize(f, ws.unit)))
  const findings = all.filter((s) => which === 'all' || (which === 'open' ? s.open : !s.open))
  const counts: Record<string, number> = {}
  for (const s of all) counts[s.state] = (counts[s.state] ?? 0) + 1
  return { unit: ws.unit, counts, findings }
}

/** A full snapshot for scripts: unit, summaries, full open findings, applier and unpushed commit count. */
export function panelSnapshot(ws: Workspace, unpushed: number | null) {
  const findings = ws.allFindings()
  return {
    unit: ws.unit,
    head: ws.head,
    unpushedCommits: unpushed,
    summaries: sortSummaries(findings.map((f) => summarize(f, ws.unit))),
    findings: Object.fromEntries(findings.map((f) => [f.id, f]))
  }
}

/**
 * The SessionStart brief. Empty when the docket is dormant, so a dormant
 * worktree gives the agent no information about docket at all.
 */
export function brief(ctx: Context, read: (fn: (ws: Workspace) => string) => string): string {
  try {
    readWorktree(ctx.cwd)
  } catch {
    return ''
  }
  const current = docketStatus(ctx)
  if (current.state !== 'active') return ''
  return read((ws) => {
    const open = sortSummaries(ws.allFindings().map((f) => summarize(f, ws.unit))).filter((s) => s.open)
    const lines = [
      `Docket is active in this worktree (branch ${ws.unit.branch}${ws.unit.pr ? `, PR #${ws.unit.pr.number}` : ''}).`,
      'Docket tracks review findings for this branch. Its data lives in the git dir and changes only through the `docket` CLI.',
      ''
    ]
    if (open.length === 0) lines.push('There are no open findings.')
    else {
      lines.push(`Open findings (${open.length}):`)
      for (const s of open) {
        const lane = s.lane ? `[${s.lane}] ` : '[untriaged] '
        const rec = s.recommended ? ` — recommended ${s.recommended.id}: ${s.recommended.title}` : ''
        lines.push(`- ${s.id} ${lane}${s.title} (${s.state}${s.stale ? ', stale' : ''})${rec}`)
      }
    }
    lines.push(
      '',
      'Rules for this session:',
      '- If work in this session resolves one of these findings, record it with `docket record <id> --data \'{...}\'` after you commit and verify. Read `docket show <id>` first.',
      '- Never create findings. If you notice a new issue, tell the user and write nothing.',
      '- Never push. Never edit files under the git dir by hand.'
    )
    if (ws.unit.applier?.state === 'running') lines.push('- The docket applier is running in this worktree. Tell the user before you edit code.')
    return lines.join('\n')
  })
}
