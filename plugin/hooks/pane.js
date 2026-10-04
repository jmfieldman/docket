// The Docket pane for Claude Code.
//
// `/docket` opens a pane beside the transcript (or above the prompt in a
// narrow terminal). The pane reads and writes docket through the bundled CLI
// (`docket api ...`) and runs agent work as docket skills in this session.
//
// Dormancy: in a worktree where docket is not started, nothing opens by
// itself. `/docket` still opens the pane, which offers "Start docket".

const PANE = 'docket'
const POLL_MS = 2500

// [lane, heading, where it sits on the two triage axes, what to do]
const LANES = [
  ['attention', 'Needs attention', '', 'The applier stopped. Re-decide or discuss.'],
  ['quick', 'Quick', 'low complexity, high confidence', 'Accept and go.'],
  ['decide', 'Decide', 'low complexity, low confidence', 'A small change, but a judgment call.'],
  ['scope', 'Scope', 'high complexity, high confidence', 'Clear direction, large change: fix now or defer.'],
  ['dig', 'Dig', 'high complexity, low confidence', 'Discuss before deciding.'],
  ['research', 'Needs research', '', 'Not researched yet.']
]
const SEVERITY_COLOR = { critical: '#ff5f5f', high: '#ff8700', medium: '#d7af00', low: '#5fafd7' }
const OUTCOME = { completed: 'Completed', acknowledged: 'Acknowledged', deferred: 'Deferred', resolved_externally: 'Resolved on GitHub' }
const STATE_LABEL = { queued: 'queued', fixing: 'fixing', discussing: 'discussing', needs_attention: 'needs attention' }

// ---------- state ----------

let snap = null // the last `docket api snapshot` result
let snapKey = ''
let readError = null // why the last read failed
let details = {} // finding id -> { rev, data }
let expanded = null // the one finding shown in full
let tab = 'open' // open | closed
let paneOpen = false
let working = false // a turn is running in this session
let pending = [] // skill runs that wait for the turn to end
let sessionId = null
let choice = {} // finding id -> chosen option id
let notes = {} // finding id -> instruction text
let replyDrafts = {} // finding id -> edited reply text
let message = null // one line under the toolbar: what just happened
let confirmPlan = null // a plan with a warning, waiting for "Run anyway"
let busy = false

// ---------- docket CLI ----------

/** Runs `docket api <args>` in the session's directory and returns `result`, or throws its error. */
async function api($, args, data) {
  const argv = [$.plugin.root + '/bin/docket', 'api', ...args]
  if (data !== undefined) argv.push('--data', JSON.stringify(data))
  let run
  try {
    run = await $.process.run(argv, { timeoutMs: 30000 })
  } catch (error) {
    throw new Error('docket could not run: ' + (error && error.message ? error.message : String(error)))
  }
  let body
  try {
    body = JSON.parse(run.stdout)
  } catch {
    throw new Error((run.stderr || run.stdout || 'docket printed nothing').trim().split('\n').slice(-1)[0])
  }
  if (!body.ok) throw new Error(body.error ? body.error.message : 'docket failed')
  return body.result
}

/** Reads the snapshot, and the expanded finding when it changed. Redraws only on change. */
async function refresh($) {
  let next
  try {
    next = await api($, ['snapshot'])
    readError = null
  } catch (error) {
    if (readError !== error.message) {
      readError = error.message
      $.ui.invalidate('ui.render')
    }
    return
  }
  const key = JSON.stringify(next)
  let changed = key !== snapKey
  snap = next
  snapKey = key
  if (expanded) {
    const summary = summaryOf(expanded)
    if (!summary) {
      expanded = null
      changed = true
    } else if (!details[expanded] || details[expanded].rev !== summary.rev) {
      await loadDetail($, expanded)
      changed = true
    }
  }
  if (changed) $.ui.invalidate('ui.render')
}

async function loadDetail($, id) {
  try {
    const data = await api($, ['finding', id])
    details[id] = { rev: data.finding.rev, data }
  } catch (error) {
    message = error.message
  }
}

function summaryOf(id) {
  return ((snap && snap.summaries) || []).find((s) => s.id === id)
}

// ---------- actions ----------

/** A UI action (decide, accept, start ...), then a fresh read. */
async function act($, name, args, done) {
  if (busy) return
  busy = true
  try {
    await api($, ['action', name], args || {})
    message = done || null
  } catch (error) {
    message = error.message
  }
  busy = false
  await refresh($)
  $.ui.invalidate('ui.render')
}

/** Plans agent work and runs the skill in this session. */
async function plan($, kind, args) {
  if (busy) return
  busy = true
  let result
  try {
    result = await api($, ['plan', kind], { ...(args || {}), sessionId })
  } catch (error) {
    message = error.message
    busy = false
    $.ui.invalidate('ui.render')
    return
  }
  busy = false
  const next = result && 'plan' in result ? result.plan : result
  if (kind === 'quickFix') message = 'Queued ' + args.id + '.'
  if (next && next.warning) {
    confirmPlan = next
    message = next.warning
  } else if (next) {
    await runSkill($, next)
  }
  await refresh($)
  $.ui.invalidate('ui.render')
}

/** Runs a docket skill as a turn in this session, or queues it while Claude works. */
async function runSkill($, next) {
  confirmPlan = null
  if (working) {
    if (!pending.some((p) => p.prompt === next.prompt)) pending.push(next)
    message = 'Waiting for Claude to finish, then ' + next.prompt + ' runs.'
    $.ui.invalidate('ui.render')
    return
  }
  message = 'Running ' + next.prompt
  $.ui.invalidate('ui.render')
  $.command.run({ command: next.command, args: next.args }).catch((error) => {
    message = next.prompt + ' could not start: ' + (error && error.message ? error.message : String(error))
    $.ui.invalidate('ui.render')
  })
}

/** After a turn ends, start the first waiting skill. Its own turn starts the rest. */
async function flush($) {
  if (working || pending.length === 0) return
  const next = pending.shift()
  await runSkill($, next)
}

async function openPane($, focus) {
  paneOpen = true
  const pane = { id: PANE, title: 'Docket', columns: 72 }
  await $.ui.open(focus ? { ...pane, focus: true } : pane)
  await refresh($)
}

// ---------- drawing helpers ----------

function capped(text, limit) {
  const s = String(text == null ? '' : text)
  return s.length > limit ? s.slice(0, limit - 1) + '…' : s
}

function laneOf(s) {
  if (s.state === 'needs_attention') return 'attention'
  return s.lane || 'research'
}

// ---------- register ----------

export function register(on) {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      sessionId = await $.session.id()
    } catch {
      sessionId = null
    }
    $.clock.every(POLL_MS, async () => {
      if (paneOpen && !busy) await refresh($)
    })
    // Open by itself only where docket is active. Elsewhere the pane waits for /docket.
    if (e.isInteractive) {
      try {
        snap = await api($, ['snapshot'])
        snapKey = JSON.stringify(snap)
        if (snap.state === 'active') await openPane($, false)
      } catch {
        snap = null
      }
    }
    await $.command.register({ name: 'docket', description: 'Open the Docket pane for this worktree', immediate: true })
    return started
  })

  on('command.run', { command: 'docket' }, async ($) => {
    await openPane($, true)
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    working = true
    if (paneOpen) $.ui.invalidate('ui.render')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    working = false
    if (message && message.startsWith('Running ')) message = null
    if (paneOpen) $.clock.after(300, async () => {
      await refresh($)
      await flush($)
      $.ui.invalidate('ui.render')
    })
    else if (pending.length) $.clock.after(300, async () => flush($))
    return result
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Input, Markdown } = $.ui.resolve(e)
    const redraw = () => $.ui.invalidate('ui.render')
    const rows = []
    const line = (text, style) => rows.push(Text({ ...(style || {}), wrap: 'wrap', children: [capped(text, 9000)] }))
    const dim = (text) => line(text, { dimColor: true })
    const gap = () => rows.push(Text({ children: [' '] }))
    const buttons = (list) => rows.push(Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: list.filter(Boolean) }))

    if (readError && !snap) {
      line('Docket cannot read this worktree.', { bold: true })
      dim(readError)
      return Box({ flexDirection: 'column', children: rows })
    }
    if (!snap) {
      dim('Loading…')
      return Box({ flexDirection: 'column', children: rows })
    }

    const state = snap.state
    const unit = snap.unit || {}
    const branch = unit.branch || (snap.worktree && snap.worktree.branch) || ''
    const head = ['Docket', branch, { active: 'active', paused: 'paused', not_started: 'not started', branch_mismatch: 'branch changed' }[state] || state]
    if (unit.pr) head.push('PR #' + unit.pr.number)
    if (working) head.push('Claude is working')
    line(head.filter(Boolean).join(' · '), { bold: true })

    if (state === 'not_started') {
      gap()
      line('Docket is not started in this worktree.')
      dim('It stays dormant here until you start it: no skills run on their own and no session brief appears. Start runs /docket:start, which also ingests the reviews in this conversation and on the PR.')
      gap()
      buttons([Button({ key: 'start', label: 's: Start docket', hotkey: 's', autoFocus: true, onPress: () => runSkill($, { command: 'docket:start', args: '', prompt: '/docket:start' }) })])
      if (snap.deferralsOpen) {
        gap()
        dim(snap.deferralsOpen + ' deferred item(s) are waiting. Run /docket:deferrals to pick one up.')
      }
      if (message) dim(message)
      return Box({ flexDirection: 'column', children: rows })
    }
    if (state === 'branch_mismatch' || state === 'error' || state === 'invalid') {
      gap()
      line(snap.message || 'Docket cannot use this worktree right now.')
      return Box({ flexDirection: 'column', children: rows })
    }

    // ---------- toolbar ----------
    const sums = snap.summaries || []
    const counts = snap.counts || {}
    const untriaged = sums.filter((s) => s.open && !s.lane && s.state === 'new').length
    const queued = (counts.queued || 0) + (counts.fixing || 0)
    const drafts = sums.filter((s) => !s.open && s.replyStatus === 'drafted').length
    const newCount = sums.filter((s) => s.isNew).length
    const remoteNew = unit.remoteCheck ? unit.remoteCheck.newSourceCount : 0
    const applierRunning = unit.applier && unit.applier.state === 'running'
    const badge = (label, n) => label + (n ? ' (' + n + ')' : '')
    if (state === 'paused') {
      gap()
      line('Docket is paused. Skills and the session brief are dormant here; the data stays.')
      buttons([Button({ key: 'resume', label: 'p: Resume', hotkey: 'p', onPress: () => act($, 'resume', {}, 'Docket resumed.') })])
    } else {
      buttons([
        Button({ key: 'ingest', label: badge('Ingest', remoteNew), hotkey: 'i', plain: true, onPress: () => plan($, 'ingest') }),
        Button({ key: 'research', label: badge('Research', untriaged), hotkey: 'r', plain: true, onPress: () => plan($, 'research') }),
        Button({ key: 'apply', label: badge(applierRunning ? 'Applying' : 'Apply', queued), hotkey: 'a', plain: true, onPress: () => plan($, 'apply') }),
        Button({ key: 'replies', label: badge('Replies', drafts), hotkey: 'y', plain: true, onPress: () => plan($, 'reply') }),
        Button({ key: 'pause', label: 'Pause', hotkey: 'p', plain: true, dimColor: true, onPress: () => act($, 'pause', {}, 'Docket paused.') })
      ])
    }
    buttons([
      Button({ key: 'tab-open', label: 'Open (' + sums.filter((s) => s.open).length + ')', hotkey: 'o', plain: true, dimColor: tab !== 'open', onPress: () => { tab = 'open'; redraw() } }),
      Button({ key: 'tab-closed', label: 'Closed (' + sums.filter((s) => !s.open).length + ')', hotkey: 'c', plain: true, dimColor: tab !== 'closed', onPress: () => { tab = 'closed'; redraw() } }),
      newCount ? Button({ key: 'seen', label: newCount + ' new · mark seen', hotkey: 'n', plain: true, dimColor: true, onPress: () => act($, 'view', {}, null) }) : null,
      Button({ key: 'browser', label: 'Browser view', hotkey: 'b', plain: true, dimColor: true, onPress: async () => {
        try {
          await $.process.run([$.plugin.root + '/bin/docket', 'ui', '--open'], { timeoutMs: 15000 })
          message = 'Opened the Docket view in your browser.'
        } catch (error) {
          message = 'Could not open the browser view: ' + error.message
        }
        redraw()
      } })
    ])
    const meta = []
    if (snap.unpushedCommits) meta.push(snap.unpushedCommits + ' unpushed commit' + (snap.unpushedCommits === 1 ? '' : 's'))
    if (pending.length) meta.push('waiting: ' + pending.map((p) => p.prompt).join(', '))
    if (meta.length) dim(meta.join(' · '))
    if (message) dim(message)
    if (readError) dim('Last read failed: ' + readError)
    if (confirmPlan) {
      const held = confirmPlan
      buttons([
        Button({ key: 'run-anyway', label: 'Run ' + held.prompt + ' anyway', onPress: () => runSkill($, held) }),
        Button({ key: 'run-cancel', label: 'Cancel', onPress: () => { confirmPlan = null; message = null; redraw() } })
      ])
    }

    // ---------- findings ----------
    const active = state === 'active'
    if (!sums.length) {
      gap()
      line('No findings yet.')
      dim('Ingest the review comments on your PR (press i), or run /docket:ingest <path> for a local review report.')
      return Box({ flexDirection: 'column', children: rows })
    }

    let shown = 0
    const row = (s) => {
      const open = expanded === s.id
      shown += 1
      const hotkey = shown <= 9 ? { hotkey: String(shown) } : {}
      const flags = []
      if (s.open && STATE_LABEL[s.state]) flags.push(STATE_LABEL[s.state])
      if (s.stale) flags.push('stale')
      if (s.isNew) flags.push('new')
      // The button carries the id; the title beside it wraps instead of clipping.
      rows.push(Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Button({
            key: 'f-' + s.id,
            label: (open ? '▾ ' : '▸ ') + s.id,
            plain: true,
            ...hotkey,
            onPress: async () => {
              expanded = open ? null : s.id
              redraw()
              if (expanded && (!details[s.id] || details[s.id].rev !== s.rev)) {
                await loadDetail($, s.id)
                redraw()
              }
            }
          }),
          Box({ flexGrow: 1, flexShrink: 1, children: [Text({ wrap: 'wrap', children: [s.title, flags.length ? Text({ dimColor: true, children: ['  [' + flags.join(', ') + ']'] }) : ''] })] })
        ]
      }))
      const sub = []
      if (s.open) {
        const severity = s.severity || 'unknown'
        sub.push(Text({ color: SEVERITY_COLOR[severity], dimColor: !SEVERITY_COLOR[severity], bold: severity === 'critical', children: [severity] }))
        if (s.recommended) sub.push(Text({ dimColor: true, children: ['  → ' + s.recommended.id + ' ' + s.recommended.title] }))
      } else {
        sub.push(Text({ dimColor: true, children: [(OUTCOME[s.state] || s.state) + (s.resolutionSummary ? ' — ' + s.resolutionSummary : '')] }))
      }
      rows.push(Box({ paddingLeft: 4, children: [Text({ wrap: 'wrap', children: sub })] }))
      if (open) detail(s)
    }

    // The expanded finding: a framed block of labeled sections. Indented text
    // uses Box padding, so wrapped lines keep their indent.
    const detail = (s) => {
      const cached = details[s.id]
      if (!cached) {
        rows.push(Box({ paddingLeft: 4, children: [Text({ dimColor: true, children: ['Loading…'] })] }))
        return
      }
      const f = cached.data.finding
      const sources = cached.data.sources || {}
      const parts = []
      const blank = () => parts.push(Text({ children: [' '] }))
      const section = (title) => {
        if (parts.length) blank()
        parts.push(Text({ bold: true, color: '#87afd7', children: [title.toUpperCase()] }))
      }
      const para = (children, style) => parts.push(Box({ paddingLeft: 2, children: [Text({ ...(style || {}), wrap: 'wrap', children })] }))
      const field = (label, value) => parts.push(Box({
        flexDirection: 'row',
        paddingLeft: 2,
        children: [Box({ width: 7, flexShrink: 0, children: [Text({ dimColor: true, children: [label] })] }), Box({ flexGrow: 1, flexShrink: 1, children: [Text({ wrap: 'wrap', children: [value] })] })]
      }))
      const markdown = (key, text) => parts.push(Box({ paddingLeft: 2, children: [Markdown({ key, text: capped(text || '', 4000) })] }))
      const actions = (list) => parts.push(Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, paddingLeft: 2, children: list.filter(Boolean) }))

      const last = f.iterations.at(-1) || null
      const queuedOption = f.state === 'queued' && last ? last.decision.optionId : null
      // Queued findings stay editable: f toggles the queue, or switches to another option.
      const editable = active && s.open && f.state !== 'fixing'

      section('Summary')
      markdown('md-summary-' + f.id, f.summary)
      if (f.location) field('Where', f.location.path + (f.location.startLine ? ':' + f.location.startLine : '') + (f.location.symbol ? ' · ' + f.location.symbol : ''))
      if (f.severityRationale) field('Why', f.severityRationale)

      if (f.research) {
        section('Verdict')
        para([Text({ bold: true, children: [f.research.verdict.replace('_', ' ')] }), ' · ' + f.research.confidence + ' confidence'])
        if (f.triage) para([f.triage.complexityReason + ' ' + f.triage.confidenceReason], { dimColor: true })

        section('Options')
        const selected = choice[f.id] || queuedOption || f.research.recommendedOptionId
        for (const o of f.research.options) {
          const isSel = o.id === selected
          const isRec = o.id === f.research.recommendedOptionId
          const br = o.blastRadius || {}
          const tag = [o.kind, o.effort, br.level, br.estimatedFiles != null ? '~' + br.estimatedFiles + ' files' : ''].filter(Boolean).join(' · ')
          parts.push(Box({
            flexDirection: 'row',
            columnGap: 1,
            paddingLeft: 2,
            children: [
              Button({ key: 'opt-' + f.id + '-' + o.id, label: (isSel ? '(•) ' : '( ) ') + o.id + '.', plain: true, dimColor: !isSel, onPress: () => { choice[f.id] = o.id; redraw() } }),
              Box({ flexGrow: 1, flexShrink: 1, children: [Text({ wrap: 'wrap', children: [
                Text({ bold: isSel, dimColor: !isSel && !isRec, children: [o.title] }),
                isRec ? Text({ color: '#5faf5f', bold: true, children: ['  ★ recommended'] }) : '',
                o.id === queuedOption ? Text({ color: SEVERITY_COLOR.medium, children: ['  ● queued'] }) : '',
                Text({ dimColor: true, children: ['  [' + tag + ']'] })
              ] })] })
            ]
          }))
          if (isSel) {
            parts.push(Box({ paddingLeft: 8, flexDirection: 'column', children: [
              Markdown({ key: 'md-opt-' + f.id + '-' + o.id, text: capped(o.description || '', 4000) }),
              ...o.pros.map((x) => Text({ wrap: 'wrap', children: [Text({ color: '#5faf5f', children: ['+ '] }), x] })),
              ...o.cons.map((x) => Text({ wrap: 'wrap', children: [Text({ color: '#d75f5f', children: ['− '] }), x] }))
            ] }))
          }
        }

        if (editable) {
          section('Decide')
          if (f.state === 'queued') para(['Queued' + (last && last.queue ? ' at position ' + last.queue.position : '') + ' with option ' + queuedOption + '.'], { color: SEVERITY_COLOR.medium })
          parts.push(Box({ paddingLeft: 2, children: [Input({
            key: 'note-' + f.id,
            label: 'Note',
            placeholder: 'Extra direction, or why you leave or defer it',
            value: notes[f.id] || '',
            submitLabel: 'save',
            onInput: (value) => { notes[f.id] = value },
            onSubmit: (value) => { notes[f.id] = value; message = 'Note saved for ' + f.id + '.'; redraw() }
          })] }))
          const chosen = f.research.options.find((o) => o.id === selected) || {}
          const note = (notes[f.id] || '').trim()
          const isQueuedChoice = selected === queuedOption
          const decideLabel = isQueuedChoice ? 'f: Remove from queue'
            : chosen.kind === 'fix' ? (queuedOption ? 'f: Queue ' + selected + ' instead' : 'f: Queue ' + selected)
            : chosen.kind === 'defer' ? 'f: Defer' : 'f: Leave as is'
          actions([
            Button({ key: 'decide-' + f.id, label: decideLabel, hotkey: 'f', onPress: async () => {
              if (isQueuedChoice) return act($, 'unqueue', { id: f.id }, 'Removed ' + f.id + ' from the queue.')
              if (chosen.kind !== 'fix' && !note) {
                message = 'Add a note saying why, then decide again.'
                return redraw()
              }
              delete notes[f.id]
              await act($, 'decide', { id: f.id, optionId: selected, instruction: note || undefined }, (chosen.kind === 'fix' ? 'Queued ' : chosen.kind === 'defer' ? 'Deferred ' : 'Acknowledged ') + f.id + '.')
            } }),
            chosen.kind === 'fix' ? Button({ key: 'quick-' + f.id, label: isQueuedChoice ? 'q: Apply now' : 'q: Quick fix', hotkey: 'q', onPress: async () => {
              if (isQueuedChoice) return plan($, 'apply')
              if (note) {
                delete notes[f.id]
                await act($, 'decide', { id: f.id, optionId: selected, instruction: note, origin: 'quick' }, 'Queued ' + f.id + '.')
                return plan($, 'apply')
              }
              return plan($, 'quickFix', { id: f.id, optionId: selected })
            } }) : null,
            Button({ key: 'ack-' + f.id, label: 'l: Leave as is', hotkey: 'l', dimColor: true, onPress: async () => {
              if (!note) {
                message = 'Add a note saying why no change is needed.'
                return redraw()
              }
              delete notes[f.id]
              await act($, 'decide', { id: f.id, optionId: 'custom', kind: 'acknowledge', instruction: note }, 'Acknowledged ' + f.id + '.')
            } }),
            Button({ key: 'discuss-' + f.id, label: f.state === 'discussing' ? 'd: Continue discussion' : 'd: Discuss', hotkey: 'd', onPress: () => plan($, 'discuss', { id: f.id }) }),
            f.stale ? Button({ key: 'unstale-' + f.id, label: 'u: Clear stale', hotkey: 'u', dimColor: true, onPress: () => act($, 'unstale', { id: f.id }, 'Stale flag cleared.') }) : null
          ])
        } else if (f.state === 'fixing') {
          section('Status')
          para(['The applier is working on this finding.'], { color: SEVERITY_COLOR.medium })
        }
      } else if (active && s.open) {
        section('Next')
        actions([Button({ key: 'research-' + f.id, label: 'e: Research this finding', hotkey: 'e', onPress: () => plan($, 'research', { ids: [f.id] }) })])
      }

      if (f.discussion && f.discussion.entries.length) {
        section('Discussion')
        for (const entry of f.discussion.entries.slice(-3)) {
          para([Text({ bold: true, children: ['Q '] }), entry.question])
          parts.push(Box({ paddingLeft: 4, children: [Markdown({ key: 'md-entry-' + f.id + '-' + entry.at, text: capped(entry.answer, 3000) })] }))
        }
      }

      section('Review comments')
      for (const ref of f.sources.slice(0, 3)) {
        const src = sources[ref.sourceId] || {}
        parts.push(Box({ paddingLeft: 2, flexDirection: 'column', children: [
          Text({ wrap: 'wrap', italic: true, children: ['“' + capped(ref.excerpt, 3000) + '”'] }),
          Text({ dimColor: true, children: ['— ' + (src.author || src.title || ref.sourceId)] })
        ] }))
      }

      if (!s.open) {
        section('Resolution')
        field('Outcome', (OUTCOME[f.state] || f.state) + (f.resolution && f.resolution.summary ? ' — ' + f.resolution.summary : ''))
        if (f.resolution && f.resolution.reason) field('Reason', f.resolution.reason)
        if (f.resolution && f.resolution.deferral) field('File', f.resolution.deferral.path)
        if (f.reply && f.reply.status === 'drafted' && active) {
          section('Reply draft')
          markdown('md-reply-' + f.id, replyDrafts[f.id] != null ? replyDrafts[f.id] : f.reply.draft || '')
          parts.push(Box({ paddingLeft: 2, children: [Input({
            key: 'reply-' + f.id,
            label: 'Edit',
            placeholder: 'Type a new reply and press Enter to save it',
            value: '',
            submitLabel: 'save',
            onSubmit: async (value) => {
              if (!value.trim()) return
              replyDrafts[f.id] = value.trim()
              await act($, 'replyEdit', { id: f.id, text: value.trim() }, 'Reply saved.')
            }
          })] }))
          actions([
            Button({ key: 'reply-approve-' + f.id, label: 'v: Approve reply', hotkey: 'v', onPress: () => act($, 'replyApprove', { id: f.id }, 'Reply approved. Press y to post approved replies.') }),
            Button({ key: 'reply-skip-' + f.id, label: 'k: Skip reply', hotkey: 'k', dimColor: true, onPress: () => act($, 'replySkip', { id: f.id }, 'Reply skipped.') })
          ])
        }
        if (active && f.state !== 'resolved_externally') {
          blank()
          actions([Button({ key: 'reopen-' + f.id, label: 'x: Reopen', hotkey: 'x', dimColor: true, onPress: () => act($, 'reopen', { id: f.id, reason: 'Reopened from the Docket pane.' }, 'Reopened ' + f.id + '.') })])
        }
      }

      rows.push(Box({ flexDirection: 'column', borderStyle: 'round', borderDimColor: true, paddingX: 1, marginLeft: 2, marginTop: 1, marginBottom: 1, children: parts }))
    }

    if (tab === 'closed') {
      const closed = sums.filter((s) => !s.open)
      gap()
      if (!closed.length) dim('Nothing closed yet.')
      for (const s of closed) row(s)
    } else {
      const open = sums.filter((s) => s.open)
      if (!open.length) {
        gap()
        dim('No open findings. Press c to see closed ones, or i to ingest new review comments.')
      }
      for (const [lane, label, axes, hint] of LANES) {
        const items = open.filter((s) => laneOf(s) === lane)
        if (!items.length) continue
        gap()
        line(label + (axes ? ' (' + axes + ')' : '') + ' · ' + items.length, { bold: true })
        dim(hint)
        const quickReady = lane === 'quick' ? items.filter((s) => s.state === 'ready' || s.state === 'discussing') : []
        if (active && quickReady.length > 1) {
          buttons([Button({ key: 'accept-all', label: 'z: Accept all ' + quickReady.length + ' recommendations', hotkey: 'z', onPress: () => act($, 'accept', { ids: quickReady.map((s) => s.id) }, 'Accepted ' + quickReady.length + '. Press a to apply.') })])
        }
        if (active && lane === 'research') {
          buttons([Button({ key: 'research-all', label: 'Research all', onPress: () => plan($, 'research') })])
        }
        for (const s of items) row(s)
      }
    }
    return Box({ flexDirection: 'column', children: rows })
  })
}
