// Library entry for the Orca plugin worker. The worker runs under Orca's
// Electron in node mode with a scrubbed environment, and has no terminal.
import { spawn } from 'node:child_process'
import { action, dispatch, finding, snapshot, worktrees, type ActionName, type DispatchKind } from './api.ts'
import { DocketError } from './errors.ts'
import { listOrcaWorktrees, openBrowserTab } from './orca.ts'
import { DEFAULT_PORT, probe, uiUrl } from './ui-server.ts'

// A GUI app's PATH rarely includes Homebrew; gh lives there.
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin']
process.env.PATH = [process.env.PATH, ...EXTRA_PATH].filter(Boolean).join(':')

export function resolveContext(branch: string | null | undefined, displayName: string | null | undefined) {
  const short = (b: string | null | undefined) => (b ?? '').replace(/^refs\/heads\//, '')
  const all = listOrcaWorktrees().filter((w) => !w.isArchived)
  const byBoth = all.filter((w) => w.displayName === displayName && short(w.branch) === short(branch))
  const candidates = byBoth.length ? byBoth : all.filter((w) => short(w.branch) === short(branch) && short(branch) !== '')
  return { candidates: candidates.map((w) => ({ path: w.path, displayName: w.displayName, branch: w.branch, repo: w.repo })) }
}

/** One entry point for every panel call: { op, ...args }. */
export function handle(args: Record<string, any>) {
  switch (args?.op) {
    case 'resolve':
      return resolveContext(args.branch, args.displayName)
    case 'worktrees':
      return worktrees()
    case 'snapshot':
      return snapshot(args.path)
    case 'finding':
      return finding(args.path, args.id)
    case 'action':
      return action(args.path, args.name as ActionName, args.args ?? {})
    case 'dispatch':
      return dispatch(args.path, args.kind as DispatchKind, args.args ?? {})
  }
  throw new DocketError('bad_input', `unknown op ${String(args?.op)}`, 2)
}

/**
 * Starts the durable UI server (a detached `docket ui`, so it outlives the
 * worker) and opens the worktree in Orca's browser.
 */
export async function openUi(options: { docketCli: string; path?: string; port?: number }) {
  const port = options.port ?? DEFAULT_PORT
  if (!(await probe(port))) {
    const child = spawn(process.execPath, [options.docketCli, 'ui', '--port', String(port)], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    child.unref()
    for (let i = 0; i < 50 && !(await probe(port)); i++) await new Promise((r) => setTimeout(r, 100))
  }
  const url = uiUrl(port, options.path)
  return { url, opened: openBrowserTab(url) }
}
