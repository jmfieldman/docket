import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { assertValid } from '../src/schema.ts'
import { cli, cliAsync, commit, git, makeRepo, readEvents } from './helpers.ts'

process.env.DOCKET_HOME = mkdtempSync(join(tmpdir(), 'docket-home-'))

let cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups) cleanup()
  cleanups = []
})
function repo() {
  const r = makeRepo()
  cleanups.push(r.cleanup)
  return r
}
const linkedDocket = (clone: string) => join(realpathSync(clone), '.git', 'worktrees', 'wt-lisbon', 'docket')

describe('status before start', () => {
  it('reports not started with exit 10 and creates nothing', () => {
    const { clone, worktree } = repo()
    const result = cli(worktree, 'status', '--json')
    assert.equal(result.code, 10)
    assert.equal(result.json().state, 'not_started')
    assert.equal(existsSync(linkedDocket(clone)), false)
  })

  it('exits 1 with an error code outside a git repo', () => {
    const { root } = repo()
    const result = cli(root, 'status', '--json')
    assert.equal(result.code, 1)
    assert.equal(result.json().error.code, 'not_a_worktree')
  })
})

describe('start', () => {
  it('creates a schema-valid docket in the per-worktree git dir', () => {
    const { clone, worktree } = repo()
    const result = cli(worktree, 'start', '--json')
    assert.equal(result.code, 0)
    const docketDir = linkedDocket(clone)
    assert.equal(result.json().docketDir, docketDir)

    const unit = JSON.parse(readFileSync(join(docketDir, 'unit.json'), 'utf8'))
    assertValid('unit', unit)
    assert.equal(unit.status, 'active')
    assert.equal(unit.branch, 'feature')
    assert.equal(unit.firstSeenHead, git(worktree, 'rev-parse', 'HEAD'))
    assert.deepEqual(unit.repo, { remoteUrl: 'git@github.com:example/app.git', owner: 'example', name: 'app' })
    assert.equal(unit.pr, null)
    assertValid('sources', JSON.parse(readFileSync(join(docketDir, 'sources.json'), 'utf8')))
    assert.deepEqual(readdirSync(join(docketDir, 'findings')), [])

    const events = readEvents(docketDir)
    assert.deepEqual(events.map((e) => e.type), ['unit_created'])
    for (const event of events) assertValid('event', event)
    assert.equal(cli(worktree, 'status', '--quiet').code, 0)
  })

  it('leaves no temporary or lock directories behind', () => {
    const { clone, worktree } = repo()
    cli(worktree, 'start')
    const gitDir = join(realpathSync(clone), '.git', 'worktrees', 'wt-lisbon')
    assert.deepEqual(readdirSync(gitDir).filter((name) => name.startsWith('docket')), ['docket'])
  })

  it('is safe to call again on an active docket', () => {
    const { clone, worktree } = repo()
    cli(worktree, 'start')
    const again = cli(worktree, 'start', '--json')
    assert.equal(again.code, 0)
    assert.equal(again.json().message, 'Docket is already active.')
    assert.equal(readEvents(linkedDocket(clone)).length, 1)
  })

  it('creates exactly one docket when five starts race', async () => {
    const { clone, worktree } = repo()
    const codes = await Promise.all(Array.from({ length: 5 }, () => cliAsync(worktree, 'start', '--quiet')))
    assert.deepEqual(codes, [0, 0, 0, 0, 0])
    assert.deepEqual(readEvents(linkedDocket(clone)).map((e) => e.type), ['unit_created'])
  })

  it('uses <clone>/.git/docket in the main worktree', () => {
    const { clone } = repo()
    assert.equal(cli(clone, 'start', '--json').json().docketDir, join(realpathSync(clone), '.git', 'docket'))
  })

  it('refuses a detached HEAD', () => {
    const { worktree } = repo()
    git(worktree, 'checkout', '-q', '--detach')
    const result = cli(worktree, 'start', '--json')
    assert.equal(result.code, 1)
    assert.equal(result.json().error.code, 'detached_head')
  })
})

describe('pause and resume', () => {
  it('moves between active and paused and logs each change', () => {
    const { clone, worktree } = repo()
    cli(worktree, 'start')
    assert.equal(cli(worktree, 'pause').code, 0)
    assert.equal(cli(worktree, 'status', '--quiet').code, 11)
    const paused = JSON.parse(readFileSync(join(linkedDocket(clone), 'unit.json'), 'utf8'))
    assert.equal(paused.status, 'paused')
    assert.ok(paused.pausedAt)

    assert.equal(cli(worktree, 'resume').code, 0)
    assert.equal(cli(worktree, 'status', '--quiet').code, 0)
    assert.deepEqual(readEvents(linkedDocket(clone)).map((e) => e.type), ['unit_created', 'unit_paused', 'unit_resumed'])
  })

  it('start resumes a paused docket', () => {
    const { worktree } = repo()
    cli(worktree, 'start')
    cli(worktree, 'pause')
    assert.equal(cli(worktree, 'start', '--json').json().state, 'active')
  })

  it('pause again is a no-op', () => {
    const { clone, worktree } = repo()
    cli(worktree, 'start')
    cli(worktree, 'pause')
    cli(worktree, 'pause')
    assert.equal(readEvents(linkedDocket(clone)).length, 2)
  })

  it('refuses pause before start with exit 10', () => {
    const { worktree } = repo()
    const result = cli(worktree, 'pause', '--json')
    assert.equal(result.code, 10)
    assert.equal(result.json().error.code, 'not_started')
  })
})

describe('stale docket guard', () => {
  it('keeps the docket on a detached HEAD that descends from it', () => {
    const { worktree } = repo()
    cli(worktree, 'start')
    commit(worktree, 'more work')
    git(worktree, 'checkout', '-q', '--detach')
    assert.equal(cli(worktree, 'status', '--json').json().state, 'active')
  })

  it('reports a rename as branch_mismatch, and rebind confirms it', () => {
    const { clone, worktree } = repo()
    cli(worktree, 'start')
    git(worktree, 'branch', '-q', '-m', 'feature-renamed')
    assert.equal(cli(worktree, 'status', '--quiet').code, 12)
    assert.equal(cli(worktree, 'start', '--quiet').code, 12)

    const rebound = cli(worktree, 'rebind', '--json')
    assert.equal(rebound.code, 0)
    assert.equal(rebound.json().unit.branch, 'feature-renamed')
    assert.equal(cli(worktree, 'status', '--quiet').code, 0)
    assert.equal(readEvents(linkedDocket(clone)).at(-1).type, 'unit_rebound')
  })

  it('moves an unrelated docket aside when the worktree switches branches', () => {
    const { clone, worktree } = repo()
    cli(worktree, 'start')
    git(worktree, 'checkout', '-q', '-b', 'unrelated', 'main')
    commit(worktree, 'unrelated work')

    const result = cli(worktree, 'status', '--json')
    assert.equal(result.code, 10)
    const moved = result.json().movedStaleTo
    assert.ok(moved && existsSync(join(moved, 'unit.json')))
    assert.equal(existsSync(linkedDocket(clone)), false)
    assert.equal(readEvents(moved).at(-1).type, 'unit_marked_stale')

    assert.equal(cli(worktree, 'start', '--json').json().unit.branch, 'unrelated')
  })
})
