import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { DocketError } from './errors.ts'
import { assertValid } from './schema.ts'
import type { Finding, Option } from './types.ts'
import { EXIT, type Workspace } from './workspace.ts'

export type DeferralStatus = 'open' | 'picked_up' | 'done' | 'dropped'

export interface DeferralFrontmatter {
  schemaVersion: 1
  id: string
  title: string
  status: DeferralStatus
  createdAt: string
  severity?: string
  category?: string
  blastRadius?: Option['blastRadius']
  origin: {
    repo: { remoteUrl: string; owner?: string; name?: string }
    branch: string
    pr?: { number: number; url: string } | null
    findingId: string
    head: string
    sourceUrls?: string[]
  }
  codeRefs: Array<{ path: string; symbol?: string; line?: number; commit: string }>
  pickedUp?: { at: string; by?: string; ref: string } | null
  closed?: { at: string; reason: string } | null
  tags?: string[]
}

export interface Deferral {
  frontmatter: DeferralFrontmatter
  body: string
  path: string
  archived: boolean
}

export function deferralsHome(): string {
  const base = process.env.DOCKET_HOME ?? join(homedir(), '.docket')
  return join(base, 'deferrals')
}

function slugify(title: string): string {
  const words = title.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean)
  const stop = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'with'])
  const kept = words.filter((w) => !stop.has(w)).slice(0, 6)
  return (kept.length >= 3 ? kept : words.slice(0, 6)).join('-') || 'deferred-work'
}

function render(frontmatter: DeferralFrontmatter, body: string): string {
  return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trim()}\n`
}

function parseFile(path: string, archived: boolean): Deferral {
  const text = readFileSync(path, 'utf8')
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match?.[1]) throw new DocketError('bad_deferral', `${path} has no frontmatter`)
  return { frontmatter: parseYaml(match[1]) as DeferralFrontmatter, body: match[2] ?? '', path, archived }
}

function bullet(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n')
}

function optionBlock(option: Option): string {
  const radius = option.blastRadius
  const files = radius.estimatedFiles !== undefined ? `, about ${radius.estimatedFiles} files` : ''
  const areas = radius.areas?.length ? ` in ${radius.areas.join(', ')}` : ''
  return [
    `**${option.title}** (${option.kind}). ${option.description}`,
    '',
    bullet([
      ...option.pros.map((p) => `Pro: ${p}`),
      ...option.cons.map((c) => `Con: ${c}`),
      `Effort: ${option.effort}. Blast radius: ${radius.level}${files}${areas}.`
    ])
  ].join('\n')
}

/** Builds a deferral body that stands alone, from the finding and the chosen option. */
function buildBody(ws: Workspace, finding: Finding, option: Option | undefined, reason: string, doneWhen: string[] | undefined): string {
  const sources = ws.readSources().sources
  const short = (sha: string) => sha.slice(0, 7)
  const refs: string[] = []
  if (finding.location) {
    const l = finding.location
    refs.push(`\`${l.path}\`${l.symbol ? `, \`${l.symbol}\`` : ''}${l.startLine ? ` (line ${l.startLine} at ${short(l.commit ?? ws.head)})` : ''}`)
  }
  for (const e of finding.research?.evidence ?? []) {
    refs.push(`\`${e.path}\`${e.symbol ? `, \`${e.symbol}\`` : ''}: ${e.note}${e.startLine ? ` (line ${e.startLine} at ${short(ws.head)})` : ''}`)
  }
  const others = (finding.research?.options ?? []).filter((o) => o.id !== option?.id && o.kind !== 'acknowledge')
  const comments = finding.sources.map((s) => {
    const source = sources[s.sourceId]
    const who = [source?.author, source?.url].filter(Boolean).join(', ')
    return `${s.excerpt.split('\n').map((line) => `> ${line}`).join('\n')}\n\n— ${who || s.sourceId}`
  })

  return [
    '## Summary',
    '',
    finding.summary,
    '',
    '## Background',
    '',
    finding.explanation ?? finding.research?.analysis ?? finding.summary,
    '',
    '## Why it was deferred',
    '',
    `${reason}\n\nIt came up while working on branch \`${ws.unit.branch}\`${ws.unit.pr ? ` (${ws.unit.pr.url})` : ''}.`,
    '',
    '## Where the code is',
    '',
    refs.length ? bullet(refs) : '- No code location was recorded.',
    '',
    'Search for the symbol names first. Line numbers are valid only at the commit shown, which can disappear after a squash merge.',
    '',
    '## Recommended approach',
    '',
    option ? optionBlock(option) : reason,
    ...(others.length ? ['', 'Other options considered:', '', ...others.map(optionBlock)] : []),
    '',
    '## Done when',
    '',
    bullet(doneWhen?.length ? doneWhen : ['The issue described in Summary no longer occurs.', 'The original review comments below are addressed.']),
    '',
    '## Original review comments',
    '',
    comments.join('\n\n')
  ].join('\n')
}

export function writeDeferral(ws: Workspace, finding: Finding, input: { option: Option | undefined; reason: string; doneWhen?: string[] | undefined }): { id: string; path: string } {
  const home = deferralsHome()
  mkdirSync(join(home, 'archive'), { recursive: true })
  const title = input.option?.title && input.option.kind === 'defer' ? input.option.title : finding.title
  const date = ws.now.slice(0, 10)
  const base = `${date}-${slugify(title)}`
  let id = base
  for (let n = 2; existsSync(join(home, `${id}.md`)) || existsSync(join(home, 'archive', `${id}.md`)); n++) id = `${base}-${n}`

  const codeRefs: DeferralFrontmatter['codeRefs'] = []
  if (finding.location) {
    const l = finding.location
    codeRefs.push(stripUndefined({ path: l.path, symbol: l.symbol, line: l.startLine, commit: l.commit ?? ws.head }))
  }
  for (const e of finding.research?.evidence ?? []) {
    codeRefs.push(stripUndefined({ path: e.path, symbol: e.symbol, line: e.startLine, commit: ws.head }))
  }
  const sources = ws.readSources().sources
  const sourceUrls = finding.sources.map((s) => sources[s.sourceId]?.url).filter((u): u is string => Boolean(u))
  const frontmatter: DeferralFrontmatter = stripUndefined({
    schemaVersion: 1 as const,
    id,
    title,
    status: 'open' as const,
    createdAt: ws.now,
    severity: finding.research?.assessedSeverity,
    category: finding.category,
    blastRadius: input.option?.blastRadius,
    origin: stripUndefined({
      repo: ws.unit.repo,
      branch: ws.unit.branch,
      pr: ws.unit.pr,
      findingId: finding.id,
      head: ws.head,
      sourceUrls: sourceUrls.length ? sourceUrls : undefined
    }),
    codeRefs,
    pickedUp: null,
    closed: null
  })
  assertValid('deferral', frontmatter)
  const path = join(home, `${id}.md`)
  writeFileSync(path, render(frontmatter, buildBody(ws, finding, input.option, input.reason, input.doneWhen)))
  return { id, path }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

export function listDeferrals(includeArchived: boolean): Deferral[] {
  const home = deferralsHome()
  const read = (dir: string, archived: boolean) =>
    existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseFile(join(dir, f), archived)) : []
  return [...read(home, false), ...(includeArchived ? read(join(home, 'archive'), true) : [])].sort((a, b) =>
    a.frontmatter.createdAt.localeCompare(b.frontmatter.createdAt)
  )
}

export function findDeferral(id: string): Deferral {
  const found = listDeferrals(true).find((d) => d.frontmatter.id === id)
  if (!found) throw new DocketError('not_found', `no deferral ${id} in ${deferralsHome()}`, EXIT.notFound)
  return found
}

function save(deferral: Deferral, frontmatter: DeferralFrontmatter): Deferral {
  assertValid('deferral', frontmatter)
  const archive = frontmatter.status === 'done' || frontmatter.status === 'dropped'
  const target = join(deferralsHome(), archive ? 'archive' : '', `${frontmatter.id}.md`)
  writeFileSync(deferral.path, render(frontmatter, deferral.body))
  if (target !== deferral.path) {
    mkdirSync(join(deferralsHome(), 'archive'), { recursive: true })
    renameSync(deferral.path, target)
  }
  return { frontmatter, body: deferral.body, path: target, archived: archive }
}

export function pickUpDeferral(id: string, input: { ref: string; by?: string }, now: string): Deferral {
  const deferral = findDeferral(id)
  if (deferral.archived) throw new DocketError('invalid_state', `${id} is ${deferral.frontmatter.status}`, EXIT.invalidState)
  if (!input.ref?.trim()) throw new DocketError('bad_input', 'ref is required (a branch, PR URL, ticket or brain page)', EXIT.badInput)
  return save(deferral, { ...deferral.frontmatter, status: 'picked_up', pickedUp: stripUndefined({ at: now, by: input.by, ref: input.ref }) })
}

export function closeDeferral(id: string, status: 'done' | 'dropped', reason: string, now: string): Deferral {
  const deferral = findDeferral(id)
  if (deferral.archived) throw new DocketError('invalid_state', `${id} is already ${deferral.frontmatter.status}`, EXIT.invalidState)
  if (!reason?.trim()) throw new DocketError('bad_input', 'reason is required', EXIT.badInput)
  return save(deferral, { ...deferral.frontmatter, status, closed: { at: now, reason } })
}

export function reopenDeferral(id: string): Deferral {
  const deferral = findDeferral(id)
  return save(deferral, { ...deferral.frontmatter, status: 'open', pickedUp: null, closed: null })
}
