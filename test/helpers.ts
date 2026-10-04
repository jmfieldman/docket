import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')
const ENV = { ...process.env, DOCKET_NO_GH: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd, encoding: 'utf8', env: ENV
  }).trim()
}

export function commit(cwd: string, message: string): string {
  writeFileSync(join(cwd, `${message.replace(/\W+/g, '-')}.txt`), message)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

export interface Repo {
  root: string
  clone: string
  cleanup: () => void
}

/** A clone with one commit on main, plus a linked worktree on branch `feature`. */
export function makeRepo(): Repo & { worktree: string } {
  const root = mkdtempSync(join(tmpdir(), 'docket-test-'))
  const clone = join(root, 'clone')
  git(root, 'init', '-q', clone)
  git(clone, 'remote', 'add', 'origin', 'git@github.com:example/app.git')
  commit(clone, 'initial')
  const worktree = join(root, 'wt-lisbon')
  git(clone, 'worktree', 'add', '-q', '-b', 'feature', worktree)
  commit(worktree, 'feature work')
  return { root, clone, worktree, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

export interface CliResult {
  code: number
  stdout: string
  stderr: string
  json: () => any
}

export function cli(cwd: string, ...args: string[]): CliResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout, stderr: '', json: () => JSON.parse(stdout) }
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string }
    return { code: e.status, stdout: e.stdout, stderr: e.stderr, json: () => JSON.parse(e.stdout) }
  }
}

export function cliAsync(cwd: string, ...args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: ENV, stdio: 'ignore' })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

export function readEvents(docketDir: string): any[] {
  return readFileSync(join(docketDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}
