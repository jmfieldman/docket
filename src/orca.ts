import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { DocketError } from './errors.ts'

const APP_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'

/** The Orca CLI: $DOCKET_ORCA, then `orca` on PATH, then the app bundle. Null when Orca is not installed. */
export function findOrca(): string | null {
  if (process.env.DOCKET_ORCA) return process.env.DOCKET_ORCA === 'none' ? null : process.env.DOCKET_ORCA
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'orca'))) return join(dir, 'orca')
  }
  return existsSync(APP_CLI) ? APP_CLI : null
}

function orcaJson(args: string[]): any {
  const orca = findOrca()
  if (!orca) throw new DocketError('orca_missing', 'The Orca CLI was not found. Install Orca, or set DOCKET_ORCA.')
  let out: string
  try {
    out = execFileSync(orca, [...args, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 })
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    out = e.stdout ?? ''
    if (!out.trim()) throw new DocketError('orca_failed', `orca ${args.join(' ')} failed: ${e.stderr?.trim() ?? 'no output'}`)
  }
  const parsed = JSON.parse(out) as { ok?: boolean; result?: unknown; error?: { message?: string } }
  if (parsed.ok === false) throw new DocketError('orca_failed', parsed.error?.message ?? `orca ${args.join(' ')} failed`)
  return parsed.result ?? parsed
}

export interface OrcaWorktree {
  path: string
  displayName: string
  branch: string | null
  repo: string | null
  isArchived: boolean
}

export function listOrcaWorktrees(): OrcaWorktree[] {
  const result = orcaJson(['worktree', 'list'])
  const items: any[] = Array.isArray(result) ? result : (result.worktrees ?? [])
  return items
    .filter((w) => typeof w.path === 'string' && !w.isBare)
    .map((w) => ({
      path: w.path,
      displayName: w.displayName ?? w.path,
      branch: typeof w.branch === 'string' ? w.branch.replace(/^refs\/heads\//, '') : null,
      repo: typeof w.projectId === 'string' ? w.projectId.replace(/^github:/, '') : null,
      isArchived: Boolean(w.isArchived)
    }))
}

/** Opens a visible terminal tab in the worktree running `command`. Returns the terminal handle. */
export function createTerminal(worktreePath: string, title: string, command: string, focus: boolean): string {
  const args = ['terminal', 'create', '--worktree', `path:${worktreePath}`, '--title', title, '--command', command]
  if (focus) args.push('--focus')
  const result = orcaJson(args)
  const handle = result?.handle ?? result?.terminal?.handle ?? result?.terminalHandle ?? result?.startupTerminal?.handle
  if (typeof handle !== 'string') throw new DocketError('orca_failed', 'orca terminal create returned no handle')
  return handle
}

export function terminalAlive(handle: string): boolean {
  try {
    const result = orcaJson(['terminal', 'list'])
    const terminals: any[] = Array.isArray(result) ? result : (result.terminals ?? [])
    return terminals.some((t) => t.handle === handle && t.connected !== false && t.orphaned !== true)
  } catch {
    return false
  }
}

export function sendToTerminal(handle: string, text: string): void {
  orcaJson(['terminal', 'send', '--terminal', handle, '--text', text, '--enter'])
}

export function focusTerminal(handle: string): void {
  orcaJson(['terminal', 'switch', '--terminal', handle])
}

export function openBrowserTab(url: string): boolean {
  try {
    orcaJson(['tab', 'create', '--url', url])
    return true
  } catch {
    return false
  }
}
