import { expect, mock, test } from 'claude-code/testing'

// Snapshots in the shape `docket api snapshot` returns.
const dormant = { state: 'not_started', message: 'Docket is not started.', worktree: { branch: 'feature/x' }, unit: null, summaries: [], counts: {}, deferralsOpen: 0 }
const summary = (id: string, extra: Record<string, unknown> = {}) => ({
  id, rev: 1, title: 'Finding ' + id, state: 'ready', open: true, lane: 'quick', complexity: 1, confidence: 4, severity: 'medium',
  recommended: { id: 'A', kind: 'fix', title: 'Cap at 3' }, stale: null, isNew: false, replyStatus: 'none', ...extra
})
const active = {
  state: 'active', message: 'Docket is active.', worktree: { branch: 'fix/login' },
  unit: { branch: 'fix/login', pr: { number: 42, url: 'https://example.com/pr/42' }, applier: { state: 'idle' }, remoteCheck: null },
  summaries: [summary('f-0001'), summary('f-0002', { lane: 'dig', recommended: { id: 'B', kind: 'fix', title: 'Copy the token' } })],
  counts: { ready: 2 }, deferralsOpen: 0
}
const findingDetail = {
  finding: {
    id: 'f-0001', rev: 1, state: 'ready', title: 'Finding f-0001', summary: 'The retry loop has no bound.', sources: [{ sourceId: 'gh:1', excerpt: 'No upper bound' }], iterations: [],
    research: { verdict: 'valid', confidence: 'high', analysis: 'a', recommendedOptionId: 'A', options: [
      { id: 'A', kind: 'fix', title: 'Cap at 3', description: 'Add maxAttempts.', pros: ['small'], cons: [], effort: 'trivial', blastRadius: { level: 'surgical' } },
      { id: 'B', kind: 'acknowledge', title: 'Leave it', description: 'Gateway sheds load.', pros: [], cons: [], effort: 'trivial', blastRadius: { level: 'surgical' } }
    ] }
  },
  sources: { 'gh:1': { author: 'reviewer' } }
}

const PANE = {
  plugin: 'docket', component: 'Pane', requestId: 'docket', viewport: { columns: 160, rows: 50 },
  props: { title: 'Docket', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
} as const

/** Stubs `docket api` with a snapshot, and records every call. */
function stubDocket(on: any, state: { snap: any }, calls: string[][]) {
  on('process.run', ($: any, e: any) => {
    const args = e.argv.slice(2)
    calls.push(args)
    const reply = (result: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' } })
    if (args[0] === 'snapshot') return reply(state.snap)
    if (args[0] === 'finding') return reply(findingDetail)
    if (args[0] === 'action' && args[1] === 'start') { state.snap = active; return reply({ state: 'active' }) }
    if (args[0] === 'action') return reply({})
    if (args[0] === 'plan' && args[1] === 'quickFix') return reply({ finding: { state: 'queued' }, plan: { command: 'docket:apply', args: '', prompt: '/docket:apply' } })
    if (args[0] === 'plan') return reply({ command: 'docket:' + args[1], args: '', prompt: '/docket:' + args[1] })
    return { value: { exitCode: 0, stdout: JSON.stringify({ ok: false, error: { message: 'unexpected ' + args.join(' ') } }), stderr: '' } }
  })
}

function stubSession(on: any, opened: unknown[], skills: string[]) {
  mock.clock(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', ($: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  on('command.run', ($: any, e: any) => { skills.push(e.command + (e.args ? ' ' + e.args : '')); return { text: '' } })
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
}

test('stays closed in a dormant worktree, and /docket offers Start', async ($, on) => {
  const state = { snap: dormant as any }
  const calls: string[][] = [], opened: unknown[] = [], skills: string[] = []
  stubDocket(on, state, calls)
  stubSession(on, opened, skills)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(opened.length).toBe(0)

  await $.command.run({ command: 'docket', args: '' })
  expect(opened.length).toBe(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Docket is not started in this worktree.' })).toBeDefined()
  await ui.press({ key: 'start' })
  // Start runs the skill, which starts docket and ingests in this session.
  expect(calls.some((c) => c[0] === 'action' && c[1] === 'start')).toBe(false)
  expect(skills).toEqual(['docket:start'])
})

test('opens by itself where docket is active and draws findings by lane', async ($, on) => {
  const state = { snap: active as any }
  const calls: string[][] = [], opened: unknown[] = [], skills: string[] = []
  stubDocket(on, state, calls)
  stubSession(on, opened, skills)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(opened.length).toBe(1)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Docket · fix\/login · active · PR #42/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Quick (low complexity, high confidence) · 1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Dig (high complexity, low confidence) · 1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  → B Copy the token' })).toBeDefined()
    await ui.unmount()
  }
})

test('quick fix records the decision, then runs /docket:apply in this session', async ($, on) => {
  const state = { snap: active as any }
  const calls: string[][] = [], opened: unknown[] = [], skills: string[] = []
  stubDocket(on, state, calls)
  stubSession(on, opened, skills)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'f-f-0001' })
  expect(calls.some((c) => c[0] === 'finding' && c[1] === 'f-0001')).toBe(true)
  expect(await ui.find({ key: 'quick-f-0001' })).toBeDefined()
  await ui.press({ key: 'quick-f-0001' })
  const planned = calls.find((c) => c[0] === 'plan' && c[1] === 'quickFix') as string[]
  expect(JSON.parse(planned[3])).toEqual({ id: 'f-0001', optionId: 'A', sessionId: 'session-1' })
  expect(skills).toEqual(['docket:apply'])
})

test('leaving a finding as is needs a note first', async ($, on) => {
  const state = { snap: active as any }
  const calls: string[][] = [], opened: unknown[] = [], skills: string[] = []
  stubDocket(on, state, calls)
  stubSession(on, opened, skills)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'f-f-0001' })
  await ui.press({ key: 'ack-f-0001' })
  expect(calls.some((c) => c[0] === 'action' && c[1] === 'decide')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /Add a note/ })).toBeDefined()
  await ui.input({ key: 'note-f-0001', text: 'The gateway sheds load.' })
  await ui.press({ key: 'ack-f-0001' })
  const decided = calls.find((c) => c[0] === 'action' && c[1] === 'decide') as string[]
  expect(JSON.parse(decided[3])).toEqual({ id: 'f-0001', optionId: 'custom', kind: 'acknowledge', instruction: 'The gateway sheds load.' })
})

test('agent work waits while Claude is working, then runs when the turn ends', async ($, on) => {
  const state = { snap: active as any }
  const calls: string[][] = [], opened: unknown[] = [], skills: string[] = []
  stubDocket(on, state, calls)
  const clock = mock.clock(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.run', ($: any, e: any) => { skills.push(e.command); return { text: '' } })
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'research' })
  expect(skills).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Waiting for Claude to finish, then \/docket:research runs/ })).toBeDefined()
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, usage: null } as any)
  await clock.advance(400)
  expect(skills).toEqual(['docket:research'])
})

test('a plan with a warning waits for "Run anyway"', async ($, on) => {
  const state = { snap: active as any }
  const calls: string[][] = [], opened: unknown[] = [], skills: string[] = []
  on('process.run', ($: any, e: any) => {
    const args = e.argv.slice(2)
    calls.push(args)
    const result = args[0] === 'plan' ? { command: 'docket:apply', args: '', prompt: '/docket:apply', warning: 'An applier has been running in another session.' } : state.snap
    return { value: { exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' } }
  })
  stubSession(on, opened, skills)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'apply' })
  expect(skills).toEqual([])
  expect(await ui.find({ type: 'Text', text: /another session/ })).toBeDefined()
  await ui.press({ key: 'run-anyway' })
  expect(skills).toEqual(['docket:apply'])
})

test('reports a docket that cannot run', async ($, on) => {
  const opened: unknown[] = [], skills: string[] = []
  on('process.run', () => ({ deny: 'spawn ENOENT' }))
  stubSession(on, opened, skills)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(opened.length).toBe(0)
  await $.command.run({ command: 'docket', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Docket cannot read this worktree.' })).toBeDefined()
})
