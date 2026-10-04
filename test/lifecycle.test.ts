import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { parse as parseYaml } from 'yaml'
import { assertValid } from '../src/schema.ts'
import { cli as baseCli, git, makeRepo, readEvents } from './helpers.ts'

// One worktree carried through the whole lifecycle, in order.
const home = mkdtempSync(join(tmpdir(), 'docket-home-'))
process.env.DOCKET_HOME = home
const repo = makeRepo()
const wt = repo.worktree
const docketDir = join(realpathSync(repo.clone), '.git', 'worktrees', 'wt-lisbon', 'docket')
after(() => {
  repo.cleanup()
  rmSync(home, { recursive: true, force: true })
})

const cli = (...args: string[]) => baseCli(wt, ...args)
const ok = (...args: string[]) => {
  const result = cli(...args)
  assert.equal(result.code, 0, `docket ${args.join(' ')} failed: ${result.stdout}${result.stderr}`)
  return result.json()
}
const data = (value: unknown) => JSON.stringify(value)
const finding = (id: string) => ok('show', id)

function option(id: string, kind: string, title: string, level = 'surgical') {
  return { id, kind, title, description: `${title}.`, pros: ['p'], cons: ['c'], effort: 'small', blastRadius: { level, estimatedFiles: 1 } }
}
function research(options: unknown[], recommended: string, complexity: number, confidence: number) {
  return data({
    research: { verdict: 'valid', confidence: 'high', assessedSeverity: 'medium', analysis: 'Because.', options, recommendedOptionId: recommended },
    triage: { complexity, complexityReason: 'cx', confidence, confidenceReason: 'cf' },
    explanation: 'Background for a newcomer.'
  })
}
function commitFile(path: string, content: string, message: string): string {
  writeFileSync(join(wt, path), content)
  git(wt, 'add', '-A')
  git(wt, 'commit', '-q', '-m', message)
  return git(wt, 'rev-parse', 'HEAD')
}

before(() => {
  writeFileSync(join(wt, 'login.ts'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'))
  git(wt, 'add', '-A')
  git(wt, 'commit', '-q', '-m', 'add login.ts')
})

describe('gating', () => {
  it('refuses data commands before start, and the hook brief prints nothing', () => {
    assert.equal(cli('list').code, 10)
    const hook = cli('brief', '--hook')
    assert.equal(hook.code, 0)
    assert.equal(hook.stdout, '')
  })
})

describe('lifecycle', () => {
  it('starts', () => {
    ok('start', '--json')
  })

  it('records sources and reports new, unchanged and changed', () => {
    const src = { sourceId: 'gh:comment:1', kind: 'github_issue_comment', externalId: '1', text: '1. retry\n2. token', url: 'https://x/1', author: 'bot' }
    assert.equal(ok('source', 'upsert', '--data', data(src)).status, 'new')
    assert.equal(ok('source', 'upsert', '--data', data({ ...src, text: '1.  retry 2. token' })).status, 'unchanged')
    assert.equal(ok('source', 'upsert', '--data', data({ ...src, text: '1. retry\n2. token\n3. race' })).status, 'changed')
    ok('source', 'upsert', '--data', data({ sourceId: 'gh:thread:T1', kind: 'github_review_thread', externalId: 'T1', text: 'race here', threadResolved: false }))
  })

  it('adds findings with sequential ids and links sources', () => {
    const add = (title: string, location: unknown, ordinal: number) =>
      ok('finding', 'add', '--data', data({ title, summary: `${title} summary.`, reviewerSeverity: 'high', location, sources: [{ sourceId: 'gh:comment:1', excerpt: title, ordinal }] }))
    assert.equal(add('Retry has no cap', { path: 'login.ts', startLine: 5, endLine: 8 }, 0).id, 'f-0001')
    assert.equal(add('Token is logged', { path: 'token.ts', startLine: 2 }, 1).id, 'f-0002')
    assert.equal(add('Retry backoff too short', { path: 'login.ts', startLine: 7 }, 2).id, 'f-0003')
    const merged = ok('finding', 'merge', 'f-0003', '--data', data({ sourceId: 'gh:thread:T1', excerpt: 'race here' }))
    assert.equal(merged.sources.length, 2)
    assert.deepEqual(ok('source', 'list').sources['gh:comment:1'].findingIds, ['f-0001', 'f-0002', 'f-0003'])
    assert.equal(finding('f-0001').state, 'new')
  })

  it('writes research, computes the lane, and rejects bad input', () => {
    const r1 = ok('research', 'f-0001', '--data', research([option('A', 'fix', 'Cap at 3'), option('B', 'acknowledge', 'Leave')], 'A', 1, 3))
    assert.equal(r1.state, 'ready')
    assert.equal(r1.triage.lane, 'quick')
    const r2 = ok('research', 'f-0002', '--data', research([option('A', 'fix', 'Remove log'), option('B', 'fix', 'Redact', 'contained')], 'B', 3, 2))
    assert.equal(r2.triage.lane, 'dig')
    assert.equal(cli('research', 'f-0003', '--data', research([option('A', 'fix', 'x'), option('B', 'fix', 'y')], 'Z', 1, 4)).code, 2)
    assert.equal(cli('research', 'f-0003', '--data', research([option('A', 'fix', 'x'), option('B', 'fix', 'y')], 'A', 5, 4)).code, 2)
  })

  it('rejects a stale writer with exit 13', () => {
    const current = finding('f-0001')
    const result = cli('research', 'f-0001', '--rev', String(current.rev - 1), '--data', research([option('A', 'fix', 'x'), option('B', 'fix', 'y')], 'A', 1, 3))
    assert.equal(result.code, 13)
  })

  it('lists untriaged first, then quick before dig', () => {
    const list = ok('list', '--state', 'open', '--json')
    assert.deepEqual(list.findings.map((s: any) => s.id), ['f-0003', 'f-0001', 'f-0002'])
    assert.ok(list.findings.every((s: any) => s.isNew))
    ok('view')
    assert.ok(ok('list', '--json').findings.every((s: any) => !s.isNew))
  })

  it('accepts the recommendation into the queue with origin quick', () => {
    const [accepted] = ok('accept', 'f-0001')
    assert.equal(accepted.state, 'queued')
    assert.equal(accepted.iterations[0].origin, 'quick')
    assert.equal(accepted.iterations[0].queue.position, 1)
  })

  it('discussion revises options and triage, moving the card to another lane', () => {
    ok('discuss', 'start', 'f-0002', '--session-id', 'sess-1', '--terminal', 'term-1')
    assert.equal(finding('f-0002').state, 'discussing')
    const entry = ok('discuss', 'entry', 'f-0002', '--data', data({
      question: 'Is redaction enough?',
      answer: 'Yes; added a helper option.',
      options: [option('A', 'fix', 'Remove log'), option('B', 'fix', 'Redact'), option('C', 'defer', 'Logging audit', 'sweeping')],
      recommendedOptionId: 'B',
      triage: { complexity: 2, complexityReason: 'two lines', confidence: 4, confidenceReason: 'standard fix' }
    }))
    assert.equal(entry.triage.lane, 'quick')
    assert.equal(entry.discussion.entries[0].optionsChanged, true)
    assert.equal(entry.discussion.sessionId, 'sess-1')
    assert.equal(ok('discuss', 'end', 'f-0002').state, 'ready')
    assert.equal(ok('decide', 'f-0002', '--option', 'B').iterations[0].queue.position, 2)
  })

  it('applies in queue order, flags overlapping findings stale, and closes a second finding', () => {
    const task = ok('apply', 'next', '--terminal', 'applier-1')
    assert.equal(task.finding.id, 'f-0001')
    assert.equal(task.finding.state, 'fixing')
    assert.equal(task.option.title, 'Cap at 3')
    assert.equal(task.remainingInQueue, 1)
    assert.equal(ok('apply', 'queue').applier.state, 'running')

    const sha = commitFile('login.ts', Array.from({ length: 40 }, (_, i) => (i === 6 ? 'capped' : `line ${i + 1}`)).join('\n'), 'cap retries')
    const committed = ok('apply', 'commit', 'f-0001', sha)
    assert.deepEqual(committed.staleFlagged, ['f-0003'])
    assert.ok(finding('f-0003').stale)

    assert.equal(cli('apply', 'complete', 'f-0001', '--summary', 'Capped').code, 2)
    ok('apply', 'verify', 'f-0001', '--data', data({ status: 'passed', checks: [{ name: 'npm test', result: 'passed' }] }))
    const done = ok('apply', 'complete', 'f-0001', '--summary', 'Capped retries at 3.', '--also', 'f-0003')
    assert.equal(done.state, 'completed')
    assert.equal(done.resolution.closedAtCommit, sha)
    const also = finding('f-0003')
    assert.equal(also.state, 'completed')
    assert.deepEqual(also.resolution.resolvedBy, { findingId: 'f-0001', iteration: 1 })
    assert.equal(also.stale, null)
  })

  it('bounces, keeps the bounced iteration in history, and finishes on a second iteration', () => {
    assert.equal(ok('apply', 'next').finding.id, 'f-0002')
    const bounced = ok('apply', 'bounce', 'f-0002', '--reason', 'Redaction helper does not exist.')
    assert.equal(bounced.state, 'needs_attention')
    const again = ok('decide', 'f-0002', '--option', 'custom', '--kind', 'fix', '--instruction', 'Write a redact() helper first.')
    assert.deepEqual(again.iterations.map((i: any) => i.outcome), ['needs_attention', 'queued'])
    ok('apply', 'next')
    ok('apply', 'commit', 'f-0002', commitFile('token.ts', 'redacted', 'redact token'))
    ok('apply', 'verify', 'f-0002', '--data', data({ status: 'passed', checks: [{ name: 'concern re-check', result: 'passed' }] }))
    assert.equal(ok('apply', 'complete', 'f-0002', '--summary', 'Token redacted.').iterations.length, 2)
    assert.equal(ok('apply', 'next'), null)
    assert.equal(ok('apply', 'queue').applier.state, 'idle')
  })

  it('defers into a self-contained deferral file and walks its lifecycle', () => {
    const f = ok('finding', 'add', '--data', data({ title: 'Refresh races sign out', summary: 'Late refresh restores the session.', location: { path: 'token.ts', symbol: 'refresh', startLine: 3 }, sources: [{ sourceId: 'gh:comment:1', excerpt: '3. race', ordinal: 3 }] }))
    ok('research', f.id, '--data', research([option('A', 'fix', 'Cancel task'), option('B', 'defer', 'Session generation counter', 'broad')], 'B', 3, 3))
    const deferred = ok('decide', f.id, '--option', 'B', '--instruction', 'Own PR after this lands.')
    assert.equal(deferred.state, 'deferred')
    const path = deferred.resolution.deferral.path
    assert.ok(path.startsWith(home), `deferral written outside DOCKET_HOME: ${path}`)
    const text = readFileSync(path, 'utf8')
    const [, yaml, body] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? []
    const front = parseYaml(yaml ?? '')
    assertValid('deferral', front)
    assert.equal(front.origin.findingId, f.id)
    assert.equal(front.codeRefs[0].symbol, 'refresh')
    assert.deepEqual([...(body ?? '').matchAll(/^## (.+)$/gm)].map((m) => m[1]), [
      'Summary', 'Background', 'Why it was deferred', 'Where the code is', 'Recommended approach', 'Done when', 'Original review comments'
    ])

    const id = front.id
    assert.equal(baseCli(home, 'deferrals', 'list', '--json').json()[0].id, id)
    assert.equal(baseCli(home, 'deferrals', 'pickup', id, '--ref', 'branch:fix/session-gen', '--by', 'monty', '--json').json().status, 'picked_up')
    const closed = baseCli(home, 'deferrals', 'done', id, '--reason', 'Merged.', '--json').json()
    assert.equal(closed.status, 'done')
    assert.ok(existsSync(join(home, 'deferrals', 'archive', `${id}.md`)))
    assert.equal(baseCli(home, 'deferrals', 'list', '--json').json().length, 0)
    assert.equal(baseCli(home, 'deferrals', 'list', '--all', '--json').json().length, 1)
  })

  it('acknowledge needs a reason, then reopen and record ad-hoc session work', () => {
    const f = ok('finding', 'add', '--data', data({ title: 'Rename LoginClient', summary: 'Naming nit.', location: { path: 'login.ts', startLine: 30 }, sources: [{ sourceId: 'gh:thread:T1', excerpt: 'rename?' }] }))
    assert.equal(cli('decide', f.id, '--option', 'custom', '--kind', 'acknowledge').code, 2)
    const ack = ok('decide', f.id, '--option', 'custom', '--kind', 'acknowledge', '--instruction', 'Established term in this module.')
    assert.equal(ack.state, 'acknowledged')
    assert.equal(ack.resolution.reason, 'Established term in this module.')

    assert.equal(ok('reopen', f.id, '--reason', 'Reviewer insisted.').state, 'new')
    const sha = commitFile('login.ts', 'renamed', 'rename client')
    const recorded = ok('record', f.id, '--data', data({
      optionId: 'custom', instruction: 'Renamed in an ad-hoc session.', commits: [sha],
      verification: { status: 'passed', checks: [{ name: 'build', result: 'passed' }] }, summary: 'Renamed LoginClient.'
    }))
    assert.equal(recorded.finding.state, 'completed')
    assert.deepEqual(recorded.finding.iterations.map((i: any) => [i.origin, i.outcome]), [['panel', 'acknowledged'], ['session', 'completed']])
    assert.equal(recorded.finding.iterations[1].queue, undefined)
    assert.equal(recorded.warning, undefined)

    ok('reply', 'draft', f.id, '--text', 'Renamed.', '--resolve-thread')
    assert.equal(cli('reply', 'posted', f.id, '--url', 'https://x').code, 2)
    ok('reply', 'approve', f.id)
    assert.equal(ok('reply', 'posted', f.id, '--url', 'https://x/r').reply.status, 'posted')
  })

  it('closes a finding resolved on GitHub', () => {
    const f = ok('finding', 'add', '--data', data({ title: 'Typo', summary: 'Typo.', sources: [{ sourceId: 'gh:thread:T1', excerpt: 'typo' }] }))
    assert.equal(ok('resolve-external', f.id).state, 'resolved_externally')
  })

  it('briefs an active session, and pausing makes writes refuse and the brief empty', () => {
    assert.match(cli('brief').stdout, /Docket is active in this worktree/)
    ok('pause', '--json')
    assert.equal(cli('view').code, 11)
    assert.equal(cli('list').code, 0)
    assert.equal(cli('brief', '--hook').stdout, '')
    ok('resume', '--json')
  })

  it('wrote only schema-valid events', () => {
    const events = readEvents(docketDir)
    for (const event of events) assertValid('event', event)
    assert.ok(events.length > 30)
  })
})
