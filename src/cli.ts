#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { EXIT_CODE, pause, rebind, resume, start, status, type Context, type StatusReport } from './docket.ts'
import { DocketError } from './errors.ts'

const USAGE = `Usage: docket [-C <path>] <command> [--json] [--quiet]

Commands:
  start     Start docket in this worktree, or resume it if paused
  status    Show whether docket is active, paused, or not started
  pause     Make every docket skill and hook dormant; keep the data
  resume    Make a paused docket active again
  rebind    Confirm that the branch was renamed

Options:
  -C <path>   Run as if docket started in <path>
  --json      Print machine-readable JSON
  --quiet     Print nothing; use the exit status
  --no-pr     start: skip the GitHub PR lookup

Exit status for status: 0 active, 10 not started, 11 paused, 12 branch mismatch, 1 error.`

const COMMANDS: Record<string, (ctx: Context) => StatusReport> = { start, status, pause, resume, rebind }

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      C: { type: 'string', short: 'C' },
      json: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      'no-pr': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false }
    }
  })
  const name = positionals[0]
  if (values.help || !name) {
    console.log(USAGE)
    return name || values.help ? 0 : 1
  }
  const command = COMMANDS[name]
  if (!command) {
    console.error(`docket: unknown command ${name}\n\n${USAGE}`)
    return 1
  }

  const ctx: Context = {
    cwd: values.C ?? process.cwd(),
    now: () => process.env.DOCKET_NOW ?? new Date().toISOString(),
    prLookup: !values['no-pr'] && process.env.DOCKET_NO_GH !== '1'
  }
  try {
    const result = command(ctx)
    if (values.json) console.log(JSON.stringify(result, null, 2))
    else if (!values.quiet) console.log(result.movedStaleTo ? `${result.message}\nOld docket: ${result.movedStaleTo}` : result.message)
    return name === 'status' ? EXIT_CODE[result.state] : 0
  } catch (error) {
    if (!(error instanceof DocketError)) throw error
    if (values.json) console.log(JSON.stringify({ error: { code: error.code, message: error.message } }, null, 2))
    else if (!values.quiet) console.error(`docket: ${error.message}`)
    return error.exitCode
  }
}

process.exitCode = main(process.argv.slice(2))
