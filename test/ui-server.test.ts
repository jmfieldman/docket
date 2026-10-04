import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { makeRepo } from './helpers.ts'

process.env.DOCKET_HOME = mkdtempSync(join(tmpdir(), 'docket-home-'))
process.env.DOCKET_NO_GH = '1'
const { createUiServer } = await import('../src/ui-server.ts')

const repo = makeRepo()
const server = createUiServer(0)
let base = ''
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => {
  server.close()
  repo.cleanup()
  rmSync(process.env.DOCKET_HOME as string, { recursive: true, force: true })
})

const get = async (route: string) => {
  const res = await fetch(base + route)
  return { status: res.status, body: (await res.json()) as any }
}
const post = async (route: string, body: unknown, headers: Record<string, string> = { 'x-docket': '1' }) => {
  const res = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as any }
}
const path = () => repo.worktree

describe('docket ui server', () => {
  it('serves the page and a health check', async () => {
    const page = await fetch(base + '/')
    assert.equal(page.status, 200)
    assert.match(await page.text(), /<title>Docket<\/title>/)
    assert.deepEqual((await get('/api/health')).body, { docket: true, version: 1 })
  })

  it('reports not started without creating anything', async () => {
    const { status, body } = await get('/api/snapshot?path=' + encodeURIComponent(path()))
    assert.equal(status, 200)
    assert.equal(body.state, 'not_started')
  })

  it('rejects writes without the x-docket header or from a foreign origin', async () => {
    assert.equal((await post('/api/action', { path: path(), name: 'start' }, {})).status, 403)
    assert.equal((await post('/api/action', { path: path(), name: 'start' }, { 'x-docket': '1', origin: 'https://evil.example' })).status, 403)
    assert.equal((await get('/api/snapshot?path=' + encodeURIComponent(path()))).body.state, 'not_started')
  })

  it('rejects relative paths', async () => {
    assert.equal((await get('/api/snapshot?path=relative/dir')).status, 400)
  })

  it('starts docket, decides, accepts and reads detail through the API', async () => {
    assert.equal((await post('/api/action', { path: path(), name: 'start' })).status, 200)
    const { execFileSync } = await import('node:child_process')
    const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), ...args, '--json'], { cwd: path(), env: process.env, encoding: 'utf8' }))
    cli('source', 'upsert', '--data', JSON.stringify({ sourceId: 'gh:comment:1', kind: 'github_issue_comment', externalId: '1', text: 'x' }))
    for (const title of ['One', 'Two']) {
      const f = cli('finding', 'add', '--data', JSON.stringify({ title, summary: 's', sources: [{ sourceId: 'gh:comment:1', excerpt: title }] }))
      cli('research', f.id, '--data', JSON.stringify({
        research: { verdict: 'valid', confidence: 'high', analysis: 'a', recommendedOptionId: 'A', options: ['A', 'B'].map((id) => ({ id, kind: id === 'A' ? 'fix' : 'acknowledge', title: id, description: id, pros: [], cons: [], effort: 'trivial', blastRadius: { level: 'surgical' } })) },
        triage: { complexity: 1, complexityReason: 'c', confidence: 4, confidenceReason: 'c' }
      }))
    }
    const snap = (await get('/api/snapshot?path=' + encodeURIComponent(path()))).body
    assert.equal(snap.state, 'active')
    assert.deepEqual(snap.summaries.map((s: any) => [s.id, s.lane, s.options.length]), [['f-0001', 'quick', 2], ['f-0002', 'quick', 2]])

    const detail = (await get(`/api/finding?path=${encodeURIComponent(path())}&id=f-0001`)).body
    assert.equal(detail.finding.title, 'One')
    assert.equal(detail.sources['gh:comment:1'].kind, 'github_issue_comment')

    const ack = await post('/api/action', { path: path(), name: 'decide', args: { id: 'f-0002', optionId: 'B', instruction: 'Not needed.' } })
    assert.equal(ack.body.result.state, 'acknowledged')
    const accepted = await post('/api/action', { path: path(), name: 'accept', args: { ids: ['f-0001'] } })
    assert.equal(accepted.body.result[0].state, 'queued')
    assert.equal(accepted.body.result[0].iterations[0].origin, 'quick')
  })

  it('accepts a leave-as-is recommendation, and applies a batch whole or not at all', async () => {
    const { execFileSync } = await import('node:child_process')
    const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), ...args, '--json'], { cwd: path(), env: process.env, encoding: 'utf8' }))
    const f = cli('finding', 'add', '--data', JSON.stringify({ title: 'Three', summary: 's', sources: [{ sourceId: 'gh:comment:1', excerpt: 'Three' }] }))
    cli('research', f.id, '--data', JSON.stringify({
      research: { verdict: 'not_valid', confidence: 'high', analysis: 'a', recommendedOptionId: 'B', options: ['A', 'B'].map((id) => ({ id, kind: id === 'A' ? 'fix' : 'acknowledge', title: id, description: id === 'B' ? 'The reviewer misread the loop.' : id, pros: [], cons: [], effort: 'trivial', blastRadius: { level: 'surgical' } })) },
      triage: { complexity: 1, complexityReason: 'c', confidence: 4, confidenceReason: 'c' }
    }))
    // f-0001 is already queued, so this batch must change nothing.
    const refused = await post('/api/action', { path: path(), name: 'accept', args: { ids: [f.id, 'f-0001'] } })
    assert.equal(refused.status, 400)
    assert.equal(cli('show', f.id).state, 'ready')
    const accepted = await post('/api/action', { path: path(), name: 'accept', args: { ids: [f.id] } })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.result[0].state, 'acknowledged')
    assert.equal(accepted.body.result[0].iterations[0].decision.instruction, 'The reviewer misread the loop.')
    assert.equal(accepted.body.result[0].resolution.reason, 'The reviewer misread the loop.')
  })

  it('records review output from a conversation once, keyed by session and text', async () => {
    const { execFileSync } = await import('node:child_process')
    const { writeFileSync } = await import('node:fs')
    const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), ...args, '--json'], { cwd: path(), env: process.env, encoding: 'utf8' }))
    const file = join(process.env.DOCKET_HOME as string, 'review.md')
    writeFileSync(file, '## Findings\n1. Retry loop has no bound.\n')
    const first = cli('source', 'session', '--file', file, '--session-id', 'sess-abc-123', '--title', 'multi-lens run 1')
    assert.equal(first.status, 'new')
    assert.match(first.sourceId, /^session:sess-abc-123:[0-9a-f]{16}$/)
    writeFileSync(file, '## Findings\n1.  Retry loop has no bound.\n\n')
    assert.equal(cli('source', 'session', '--file', file, '--session-id', 'sess-abc-123').status, 'unchanged')
    writeFileSync(file, '## Findings\n1. Retry loop has no bound.\n2. Token is logged.\n')
    const second = cli('source', 'session', '--file', file, '--session-id', 'sess-abc-123')
    assert.equal(second.status, 'new')
    assert.notEqual(second.sourceId, first.sourceId)
    const record = cli('source', 'list').sources[first.sourceId]
    assert.equal(record.kind, 'session_review')
    assert.equal(record.externalId, 'sess-abc-123')
    assert.equal(record.title, 'multi-lens run 1')
    const piped = JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'source', 'session', '--file', '-', '--session-id', 'sess-abc-123', '--json'], { cwd: path(), env: process.env, encoding: 'utf8', input: '## Findings\n1. Retry loop has no bound.\n2. Token is logged.\n' }))
    assert.deepEqual([piped.status, piped.sourceId], ['unchanged', second.sourceId])
    assert.throws(() => execFileSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'source', 'session', '--file', file, '--session-id', 'x y'], { cwd: path(), env: process.env, stdio: 'pipe' }))
  })

  it('refuses origin session from the UI', async () => {
    const res = await post('/api/action', { path: path(), name: 'decide', args: { id: 'f-0001', optionId: 'A', origin: 'session' } })
    assert.equal(res.status, 400)
  })

  it('plans agent work as docket skills', async () => {
    const ingest = await post('/api/plan', { path: path(), kind: 'ingest' })
    assert.equal(ingest.status, 200)
    assert.deepEqual(ingest.body.result, { command: 'docket:ingest', args: '', prompt: '/docket:ingest' })
    const research = await post('/api/plan', { path: path(), kind: 'research', args: { ids: ['f-0001', 'f-0002'] } })
    assert.equal(research.body.result.prompt, '/docket:research f-0001 f-0002')
    assert.equal((await post('/api/plan', { path: path(), kind: 'research', args: { ids: ['f-1; rm -rf /'] } })).status, 400)
  })

  it('quick fix records the decision and plans the applier', async () => {
    const { execFileSync } = await import('node:child_process')
    execFileSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'reopen', 'f-0002', '--reason', 'r'], { cwd: path(), env: process.env })
    const res = await post('/api/plan', { path: path(), kind: 'quickFix', args: { id: 'f-0002' } })
    assert.equal(res.status, 200)
    assert.equal(res.body.result.finding.state, 'queued')
    assert.equal(res.body.result.plan.prompt, '/docket:apply')
    assert.equal(res.body.result.plan.warning, undefined)
  })

  it('warns when an applier runs in another session', async () => {
    const { execFileSync } = await import('node:child_process')
    execFileSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'apply', 'next', '--session-id', 'other-session'], { cwd: path(), env: process.env })
    const elsewhere = await post('/api/plan', { path: path(), kind: 'apply', args: { sessionId: 'this-session' } })
    assert.match(elsewhere.body.result.warning, /another session/)
    const same = await post('/api/plan', { path: path(), kind: 'apply', args: { sessionId: 'other-session' } })
    assert.equal(same.body.result.warning, undefined)
  })

  it('takes a queued finding out of the queue, and re-decides a queued finding', async () => {
    // f-0001 is fixing (the applier took it); f-0002 is queued behind it.
    assert.equal((await post('/api/action', { path: path(), name: 'unqueue', args: { id: 'f-0001' } })).status, 400)
    const out = await post('/api/action', { path: path(), name: 'unqueue', args: { id: 'f-0002' } })
    assert.equal(out.status, 200)
    assert.equal(out.body.result.state, 'ready')
    assert.equal(out.body.result.iterations.at(-1).outcome, 'abandoned')
    assert.equal((await post('/api/action', { path: path(), name: 'unqueue', args: { id: 'f-0002' } })).status, 400)
    const queued = await post('/api/action', { path: path(), name: 'decide', args: { id: 'f-0002', optionId: 'A' } })
    assert.equal(queued.body.result.state, 'queued')
    const changed = await post('/api/action', { path: path(), name: 'decide', args: { id: 'f-0002', optionId: 'B', instruction: 'Not worth it.' } })
    assert.equal(changed.body.result.state, 'acknowledged')
    assert.deepEqual(changed.body.result.iterations.map((it: any) => it.outcome).slice(-2), ['abandoned', 'acknowledged'])
  })

  it('lists the repository worktrees from git', async () => {
    const { body } = await get('/api/worktrees?path=' + encodeURIComponent(path()))
    assert.equal(body.items.length >= 1, true)
    const current = body.items.find((w: any) => w.isCurrent)
    assert.equal(current.docket, 'active')
  })

  it('docket api answers in one JSON envelope', async () => {
    const { execFileSync } = await import('node:child_process')
    const api = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'api', ...args], { cwd: path(), env: process.env, encoding: 'utf8' }))
    const snap = api('snapshot')
    assert.equal(snap.ok, true)
    assert.equal(snap.result.state, 'active')
    assert.equal(api('finding', 'f-0001').result.finding.id, 'f-0001')
    assert.deepEqual(api('finding', 'f-0099').error.code, 'not_found')
    assert.equal(api('plan', 'discuss', '--data', '{"id":"f-0001"}').result.prompt, '/docket:discuss f-0001')
    assert.equal(api('action', 'pause').result.state, 'paused')
    assert.equal(api('snapshot').result.state, 'paused')
    assert.equal(api('action', 'resume').result.state, 'active')
    assert.equal(api('bogus').ok, false)
  })

  it('returns 404 for unknown routes and findings', async () => {
    assert.equal((await get('/api/nope')).status, 404)
    assert.equal((await get(`/api/finding?path=${encodeURIComponent(path())}&id=f-0099`)).status, 404)
  })
})
