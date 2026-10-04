import { execFileSync } from 'node:child_process'
import { DocketError } from './errors.ts'

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim()
    throw new DocketError('git_failed', `git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`)
  }
}

function gitOptional(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args)
  } catch {
    return null
  }
}

export interface WorktreeInfo {
  /** Top-level directory of the checked-out worktree. */
  root: string
  /** Absolute per-worktree git directory: <clone>/.git for the main worktree, <clone>/.git/worktrees/<name> for a linked one. */
  gitDir: string
  /** Current branch, or null when HEAD is detached. */
  branch: string | null
  head: string
  remoteUrl: string | null
}

export function readWorktree(cwd: string): WorktreeInfo {
  if (gitOptional(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    throw new DocketError('not_a_worktree', `${cwd} is not inside a git worktree`)
  }
  const head = gitOptional(cwd, ['rev-parse', '--verify', 'HEAD'])
  if (!head) throw new DocketError('no_commits', 'the worktree has no commits yet')
  const branch = gitOptional(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return {
    root: git(cwd, ['rev-parse', '--show-toplevel']),
    gitDir: git(cwd, ['rev-parse', '--absolute-git-dir']),
    branch,
    head,
    remoteUrl: gitOptional(cwd, ['remote', 'get-url', 'origin'])
  }
}

/** True when `ancestor` is reachable from `descendant`. False also when either commit is unknown. */
export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** owner and name from a GitHub remote URL (ssh or https). Null for anything else. */
export function parseGitHubRemote(url: string | null): { owner: string; name: string } | null {
  if (!url) return null
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  return match?.[1] && match[2] ? { owner: match[1], name: match[2] } : null
}
