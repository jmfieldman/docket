import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { makeRepo } from './helpers.ts'

process.env.DOCKET_HOME = mkdtempSync(join(tmpdir(), 'docket-home-'))
process.env.DOCKET_ORCA = 'none'
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

  it('refuses origin session from the UI', async () => {
    const res = await post('/api/action', { path: path(), name: 'decide', args: { id: 'f-0001', optionId: 'A', origin: 'session' } })
    assert.equal(res.status, 400)
  })

  it('explains how to run an agent when Orca is missing', async () => {
    const res = await post('/api/dispatch', { path: path(), kind: 'ingest' })
    assert.equal(res.status, 424)
    assert.match(res.body.error.message, /claude "\/docket:ingest"/)
  })

  it('quick fix keeps the decision and reports why the applier did not start', async () => {
    const { execFileSync } = await import('node:child_process')
    execFileSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'reopen', 'f-0002', '--reason', 'r'], { cwd: path(), env: process.env })
    const res = await post('/api/dispatch', { path: path(), kind: 'quickFix', args: { id: 'f-0002' } })
    assert.equal(res.status, 200)
    assert.equal(res.body.result.finding.state, 'queued')
    assert.match(res.body.result.applierError, /Orca CLI was not found/)
  })

  it('returns 404 for unknown routes and findings', async () => {
    assert.equal((await get('/api/nope')).status, 404)
    assert.equal((await get(`/api/finding?path=${encodeURIComponent(path())}&id=f-0099`)).status, 404)
  })
})
