#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { addCommit, bounceTask, completeTask, nextTask, queueSummary, recordSessionWork, writeVerification } from './apply.ts'
import { closeDeferral, findDeferral, listDeferrals, pickUpDeferral, reopenDeferral } from './deferrals.ts'
import { EXIT_CODE, pause, rebind, resume, start, status, type Context, type StatusReport } from './docket.ts'
import { DocketError } from './errors.ts'
import {
  acceptRecommended,
  addDiscussionEntry,
  addFinding,
  attachPr,
  badInput,
  clearStale,
  decide,
  deleteSource,
  draftReply,
  endDiscussion,
  markViewed,
  mergeSourceIntoFinding,
  recordIngest,
  recordRemoteCheck,
  reopen,
  resolveExternally,
  setReplyStatus,
  setStale,
  startDiscussion,
  updateFinding,
  upsertSessionSource,
  upsertSource,
  writeResearch
} from './findings.ts'
import type { OptionKind, Origin } from './types.ts'
import { brief, listFindings, panelSnapshot } from './view.ts'
import { withWorkspace, type Workspace } from './workspace.ts'
import { DEFAULT_PORT, runUi } from './ui-server.ts'
import { action, finding, plan, snapshot, worktrees, type ActionName, type PlanKind } from './api.ts'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const USAGE = `Usage: docket [-C <path>] <command> [args] [options]

Activation
  start | status | pause | resume | rebind

Reading
  list [--state open|closed|all]      Findings, sorted by lane
  show <id>                           One finding (JSON)
  snapshot                            Everything the panel needs (JSON)
  brief [--hook]                      Session brief; prints nothing when dormant
  procedure <name>                    Print a shared skill procedure (skills include it at load time)
  view                                Mark findings as seen

Ingest
  source upsert --data <json>         Record a source; reports new, changed or unchanged
  source session --file <path|-> --session-id <id> [--title <t>]
                                      Record review output from this conversation (text from the file, or stdin with -)
  source delete <sourceId>
  source list
  finding add --data <json>
  finding merge <id> --data <json>    Add a source to an existing finding
  finding update <id> --data <json>
  resolve-external <id> [--reason]
  ingest done | remote-check --count <n> | pr attach [--number <n> --url <u>]

Research and discussion
  research <id> --data <json>         Write research and triage (lane is computed)
  stale <id> --reason <text> | unstale <id>
  discuss start <id> [--session-id <s>]
  discuss entry <id> --data <json>
  discuss end <id>

Decisions and apply
  decide <id> --option <A-F|custom> [--kind fix|acknowledge|defer] [--instruction <text>] [--origin panel|quick|session]
  accept <id>...                      Take the recommended option (origin quick)
  reopen <id> --reason <text>
  apply next [--session-id <s>] | apply queue
  apply commit <id> <sha> | apply verify <id> --data <json>
  apply complete <id> --summary <text> [--also <id,id>] | apply bounce <id> --reason <text>
  record <id> --data <json>           Record work an ad-hoc session already committed

Replies
  reply draft <id> --text <t> [--target <sourceId>] [--resolve-thread]
  reply approve <id> | reply posted <id> --url <u> | reply skip <id>

UI
  ui [--open] [--port <n>]            Serve the Docket web UI on 127.0.0.1 (default port 4747);
                                      --open starts it in the background and opens this worktree in the browser
  api snapshot | api worktrees | api finding <id>
  api action <name> --data <json> | api plan <kind> --data <json>
                                      The UI action layer as JSON: always {"ok":true,"result"} or {"ok":false,"error"}

Deferrals (any directory)
  deferrals list [--all] | deferrals show <id>
  deferrals pickup <id> --ref <where> [--by <who>]
  deferrals done <id> --reason <text> | deferrals drop <id> --reason <text> | deferrals reopen <id>

Options: -C <path>, --json, --quiet, --rev <n> (reject if the finding changed), --data <json | @file | ->
Exit status: 0 ok, 1 error, 2 bad input, 10 not started, 11 paused, 12 branch mismatch, 13 rev conflict, 14 invalid state, 15 not found.`

type Values = ReturnType<typeof parse>['values']

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      C: { type: 'string', short: 'C' },
      json: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      'no-pr': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      hook: { type: 'boolean', default: false },
      data: { type: 'string' },
      rev: { type: 'string' },
      option: { type: 'string' },
      kind: { type: 'string' },
      instruction: { type: 'string' },
      origin: { type: 'string' },
      reason: { type: 'string' },
      summary: { type: 'string' },
      also: { type: 'string' },
      'session-id': { type: 'string' },
      text: { type: 'string' },
      file: { type: 'string' },
      title: { type: 'string' },
      target: { type: 'string' },
      'resolve-thread': { type: 'boolean', default: false },
      url: { type: 'string' },
      number: { type: 'string' },
      count: { type: 'string' },
      state: { type: 'string' },
      all: { type: 'boolean', default: false },
      by: { type: 'string' },
      ref: { type: 'string' },
      port: { type: 'string' },
      open: { type: 'boolean', default: false }
    }
  })
}

function readData(values: Values): any {
  const raw = values.data
  if (raw === undefined) badInput('--data is required')
  const text = raw === '-' ? readFileSync(0, 'utf8') : raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw
  try {
    return JSON.parse(text)
  } catch {
    badInput('--data is not valid JSON')
  }
}

function rev(values: Values): number | undefined {
  if (values.rev === undefined) return undefined
  const n = Number(values.rev)
  if (!Number.isInteger(n) || n < 0) badInput('--rev must be a non-negative integer')
  return n
}

function need(value: string | undefined, name: string): string {
  if (!value) badInput(`${name} is required`)
  return value
}

function unpushedCommits(cwd: string): number | null {
  try {
    return Number(execFileSync('git', ['rev-list', '--count', '@{upstream}..HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
  } catch {
    return null
  }
}

function lookupPr(cwd: string): { number: number; url: string } {
  try {
    const out = execFileSync('gh', ['pr', 'view', '--json', 'number,url'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
    return JSON.parse(out)
  } catch {
    throw new DocketError('not_found', 'gh found no PR for this branch; pass --number and --url', 15)
  }
}

/** A Claude Code hook passes JSON on stdin; its `cwd` is the session's directory. */
function hookCwd(): string | undefined {
  if (process.stdin.isTTY) return undefined
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}') as { cwd?: unknown }
    return typeof input.cwd === 'string' ? input.cwd : undefined
  } catch {
    return undefined
  }
}

const ACTIVATION: Record<string, (ctx: Context) => StatusReport> = { start, status, pause, resume, rebind }

function humanList(result: ReturnType<typeof listFindings>): string {
  if (result.findings.length === 0) return 'No findings.'
  const meter = (n: number | null) => (n === null ? '····' : '█'.repeat(n) + '·'.repeat(4 - n))
  return result.findings
    .map((s) => {
      const lane = (s.open ? (s.state === 'new' || s.state === 'ready' ? (s.lane ?? 'new') : `${s.lane ?? 'new'}/${s.state}`) : s.state).padEnd(19)
      const tail = s.open ? (s.recommended ? `→ ${s.recommended.id} ${s.recommended.title}` : '') : (s.resolutionSummary ?? '')
      return `${s.id}  ${lane} cx ${meter(s.complexity)} cf ${meter(s.confidence)}  ${s.title}${s.stale ? '  [stale]' : ''}${s.isNew ? '  [new]' : ''}\n         ${tail}`
    })
    .join('\n')
}

function run(ctx: Context, values: Values, args: string[]): { output: unknown; human?: string } {
  const [command, sub, ...rest] = args
  const write = <T>(fn: (ws: Workspace) => T) => withWorkspace(ctx, 'write', fn)
  const read = <T>(fn: (ws: Workspace) => T) => withWorkspace(ctx, 'read', fn)
  const id = sub

  switch (command) {
    case 'list': {
      const which = (values.state ?? 'all') as 'open' | 'closed' | 'all'
      if (!['open', 'closed', 'all'].includes(which)) badInput('--state must be open, closed or all')
      const result = read((ws) => listFindings(ws, which))
      return { output: result, human: humanList(result) }
    }
    case 'show':
      return { output: read((ws) => ws.readFinding(need(id, 'finding id'))) }
    case 'snapshot':
      return { output: read((ws) => panelSnapshot(ws, unpushedCommits(ws.worktree.root))) }
    case 'brief': {
      const text = brief(ctx, (fn) => read(fn))
      return { output: { brief: text }, human: text }
    }
    case 'view':
      return { output: write(markViewed) }
    case 'source':
      if (sub === 'upsert') return { output: write((ws) => upsertSource(ws, readData(values))) }
      if (sub === 'session') {
        const file = need(values.file, '--file')
        const text = readFileSync(file === '-' ? 0 : file, 'utf8')
        return { output: write((ws) => upsertSessionSource(ws, { sessionId: need(values['session-id'], '--session-id'), text, title: values.title })) }
      }
      if (sub === 'delete') return { output: write((ws) => deleteSource(ws, need(rest[0], 'sourceId'))) }
      if (sub === 'list') return { output: read((ws) => ws.readSources()) }
      break
    case 'finding': {
      const target = rest[0]
      if (sub === 'add') return { output: write((ws) => addFinding(ws, readData(values))) }
      if (sub === 'merge') return { output: write((ws) => mergeSourceIntoFinding(ws, need(target, 'finding id'), readData(values), rev(values))) }
      if (sub === 'update') return { output: write((ws) => updateFinding(ws, need(target, 'finding id'), readData(values), rev(values))) }
      break
    }
    case 'resolve-external':
      return { output: write((ws) => resolveExternally(ws, need(id, 'finding id'), values.reason)) }
    case 'ingest':
      if (sub === 'done') return { output: write(recordIngest) }
      break
    case 'remote-check':
      return { output: write((ws) => recordRemoteCheck(ws, Number(need(values.count, '--count')))) }
    case 'pr':
      if (sub === 'attach') {
        return {
          output: write((ws) =>
            attachPr(ws, values.number ? { number: Number(values.number), url: need(values.url, '--url') } : lookupPr(ws.worktree.root))
          )
        }
      }
      break
    case 'research':
      return { output: write((ws) => writeResearch(ws, need(id, 'finding id'), readData(values), rev(values))) }
    case 'stale':
      return { output: write((ws) => setStale(ws, need(id, 'finding id'), need(values.reason, '--reason'))) }
    case 'unstale':
      return { output: write((ws) => clearStale(ws, need(id, 'finding id'))) }
    case 'discuss': {
      const target = need(rest[0], 'finding id')
      if (sub === 'start') return { output: write((ws) => startDiscussion(ws, target, { sessionId: values['session-id'] })) }
      if (sub === 'entry') return { output: write((ws) => addDiscussionEntry(ws, target, readData(values), rev(values))) }
      if (sub === 'end') return { output: write((ws) => endDiscussion(ws, target)) }
      break
    }
    case 'decide': {
      const extra = values.data ? readData(values) : {}
      return {
        output: write((ws) =>
          decide(
            ws,
            need(id, 'finding id'),
            {
              ...extra,
              optionId: need(values.option ?? extra.optionId, '--option'),
              kind: (values.kind ?? extra.kind) as OptionKind | undefined,
              instruction: values.instruction ?? extra.instruction,
              origin: (values.origin ?? extra.origin) as Origin | undefined
            },
            rev(values)
          )
        )
      }
    }
    case 'accept': {
      const ids = [sub, ...rest].filter((x): x is string => Boolean(x))
      if (ids.length === 0) badInput('accept needs at least one finding id')
      return { output: write((ws) => acceptRecommended(ws, ids)) }
    }
    case 'reopen':
      return { output: write((ws) => reopen(ws, need(id, 'finding id'), need(values.reason, '--reason'))) }
    case 'apply': {
      const target = rest[0]
      if (sub === 'next') return { output: write((ws) => nextTask(ws, values['session-id'])) }
      if (sub === 'queue') return { output: read(queueSummary) }
      if (sub === 'commit') return { output: write((ws) => addCommit(ws, need(target, 'finding id'), need(rest[1], 'commit sha'))) }
      if (sub === 'verify') return { output: write((ws) => writeVerification(ws, need(target, 'finding id'), readData(values))) }
      if (sub === 'complete') {
        const also = values.also ? values.also.split(',').map((x) => x.trim()) : []
        return { output: write((ws) => completeTask(ws, need(target, 'finding id'), { summary: need(values.summary, '--summary'), also })) }
      }
      if (sub === 'bounce') return { output: write((ws) => bounceTask(ws, need(target, 'finding id'), need(values.reason, '--reason'))) }
      break
    }
    case 'record':
      return { output: write((ws) => recordSessionWork(ws, need(id, 'finding id'), readData(values))) }
    case 'reply': {
      const target = need(rest[0], 'finding id')
      if (sub === 'draft') {
        return { output: write((ws) => draftReply(ws, target, { text: need(values.text, '--text'), targetSourceId: values.target, resolveThread: values['resolve-thread'] || undefined })) }
      }
      if (sub === 'approve') return { output: write((ws) => setReplyStatus(ws, target, 'approved')) }
      if (sub === 'posted') return { output: write((ws) => setReplyStatus(ws, target, 'posted', need(values.url, '--url'))) }
      if (sub === 'skip') return { output: write((ws) => setReplyStatus(ws, target, 'skipped')) }
      break
    }
    case 'deferrals': {
      const target = rest[0]
      if (sub === 'list' || sub === undefined) {
        const items = listDeferrals(values.all)
        const human = items.length
          ? items.map((d) => `${d.frontmatter.id}  ${d.frontmatter.status.padEnd(9)}  ${d.frontmatter.origin.repo.name ?? d.frontmatter.origin.repo.remoteUrl}  ${d.frontmatter.title}`).join('\n')
          : 'No deferrals.'
        return { output: items.map((d) => ({ ...d.frontmatter, path: d.path })), human }
      }
      if (sub === 'show') {
        const d = findDeferral(need(target, 'deferral id'))
        return { output: { ...d.frontmatter, path: d.path, body: d.body }, human: readFileSync(d.path, 'utf8') }
      }
      if (sub === 'pickup') return { output: pickUpDeferral(need(target, 'deferral id'), { ref: need(values.ref, '--ref'), by: values.by }, ctx.now()).frontmatter }
      if (sub === 'done' || sub === 'drop') {
        return { output: closeDeferral(need(target, 'deferral id'), sub === 'done' ? 'done' : 'dropped', need(values.reason, '--reason'), ctx.now()).frontmatter }
      }
      if (sub === 'reopen') return { output: reopenDeferral(need(target, 'deferral id')).frontmatter }
      break
    }
  }
  badInput(`unknown command: ${args.join(' ')}`)
}

/**
 * Prints `plugin/skills/<name>/procedure.md`. Skills include it with a
 * load-time command, which must be the docket launcher to pass the session's
 * permission check.
 */
function printProcedure(name: string | undefined): number {
  if (!name || !/^[a-z][a-z-]*$/.test(name)) {
    console.error('docket: procedure needs a name, such as ingest')
    return 2
  }
  const here = dirname(process.argv[1] ?? '.')
  const file = [resolve(here, '..', 'skills', name, 'procedure.md'), resolve(here, '..', 'plugin', 'skills', name, 'procedure.md')].find((f) => existsSync(f))
  if (!file) {
    console.error(`docket: no procedure named ${name}`)
    return 15
  }
  process.stdout.write(readFileSync(file, 'utf8'))
  return 0
}

/** `docket api`: one envelope for every outcome, so a caller parses stdout only. */
function runApi(path: string, args: string[], values: Values): number {
  const [op, arg] = args
  const data = () => (values.data === undefined ? {} : readData(values))
  try {
    let result: unknown
    if (op === 'snapshot') result = snapshot(path)
    else if (op === 'worktrees') result = worktrees(path)
    else if (op === 'finding') result = finding(path, need(arg, 'finding id'))
    else if (op === 'action') result = action(path, need(arg, 'action name') as ActionName, data())
    else if (op === 'plan') result = plan(path, need(arg, 'plan kind') as PlanKind, data())
    else badInput(`unknown api call: ${args.join(' ') || '(none)'}`)
    console.log(JSON.stringify({ ok: true, result: result ?? null }))
  } catch (error) {
    if (!(error instanceof DocketError)) {
      console.log(JSON.stringify({ ok: false, error: { code: 'internal', message: (error as Error).message } }))
      return 1
    }
    console.log(JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }))
  }
  return 0
}

function main(argv: string[]): number {
  let values: Values
  let positionals: string[]
  try {
    ;({ values, positionals } = parse(argv))
  } catch (error) {
    console.error(`docket: ${(error as Error).message}`)
    return 2
  }
  const name = positionals[0]
  if (values.help || !name) {
    console.log(USAGE)
    return values.help ? 0 : 2
  }
  const ctx: Context = {
    cwd: values.C ?? (values.hook ? hookCwd() : undefined) ?? process.cwd(),
    now: () => process.env.DOCKET_NOW ?? new Date().toISOString(),
    prLookup: !values['no-pr'] && process.env.DOCKET_NO_GH !== '1'
  }

  if (name === 'procedure') return printProcedure(positionals[1])
  if (name === 'api') return runApi(resolve(ctx.cwd), positionals.slice(1), values)

  if (name === 'ui') {
    const port = values.port ? Number(values.port) : DEFAULT_PORT
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error('docket: --port must be 1-65535')
      return 2
    }
    runUi({ port, open: values.open, cwd: ctx.cwd }).then(
      (code) => (process.exitCode = code),
      (error: Error) => {
        console.error(`docket: ${error.message}`)
        process.exitCode = 1
      }
    )
    return 0
  }

  try {
    const activation = ACTIVATION[name]
    if (activation) {
      const result = activation(ctx)
      if (values.json) console.log(JSON.stringify(result, null, 2))
      else if (!values.quiet) console.log(result.movedStaleTo ? `${result.message}\nOld docket: ${result.movedStaleTo}` : result.message)
      return name === 'status' ? EXIT_CODE[result.state] : 0
    }
    const { output, human } = run(ctx, values, positionals)
    if (values.quiet) return 0
    if (human !== undefined && !values.json) {
      if (human) console.log(human)
    } else console.log(JSON.stringify(output, null, 2))
    return 0
  } catch (error) {
    // The hook must never fail a session: a dormant or broken docket prints nothing.
    if (name === 'brief' && values.hook) return 0
    if (!(error instanceof DocketError)) throw error
    if (values.json) console.log(JSON.stringify({ error: { code: error.code, message: error.message } }, null, 2))
    else if (!values.quiet) console.error(`docket: ${error.message}`)
    return error.exitCode
  }
}

const code = main(process.argv.slice(2))
if (process.exitCode === undefined) process.exitCode = code
