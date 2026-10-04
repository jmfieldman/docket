// Builds a throwaway repo with findings in every lane and state, then serves
// the Docket UI for it. Orca dispatch is disabled and DOCKET_HOME is a temp
// directory, so nothing touches real worktrees or deferrals.
//
//   pnpm run demo            # build the fixture and serve on port 4848
//   node scripts/demo.mjs --fixture-only
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'plugin', 'bin', 'docket.cjs')
const BASE = process.env.DOCKET_DEMO_DIR ?? '/tmp/docket-demo'
const REPO = join(BASE, 'app')
const env = { ...process.env, DOCKET_HOME: join(BASE, 'home'), DOCKET_NO_GH: '1', DOCKET_ORCA: 'none' }

const git = (...args) => execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', ...args], { cwd: REPO, env, encoding: 'utf8' }).trim()
const docket = (...args) => JSON.parse(execFileSync(process.execPath, [CLI, ...args, '--json'], { cwd: REPO, env, encoding: 'utf8' }) || 'null')
const data = (v) => JSON.stringify(v)
function commit(file, content, message) {
  writeFileSync(join(REPO, file), content)
  git('add', '-A')
  git('commit', '-q', '-m', message)
  return git('rev-parse', 'HEAD')
}
const opt = (id, kind, title, description, level, files, effort = 'small', extra = {}) => ({
  id, kind, title, description, effort,
  pros: extra.pros ?? ['Directly addresses the concern'], cons: extra.cons ?? ['Adds a little code'],
  blastRadius: { level, estimatedFiles: files, areas: extra.areas ?? ['Auth'], ...(extra.radius ?? {}) }
})
const research = (options, rec, cx, cf, extra = {}) => data({
  explanation: extra.explanation ?? 'LoginClient wraps the sign-in request and retries server errors with exponential backoff capped at 8 s. Nothing counts attempts.',
  severityRationale: extra.why ?? 'Medium: no data loss, but stuck clients add load to a failing service and users see an endless spinner.',
  research: { verdict: extra.verdict ?? 'valid', confidence: 'high', assessedSeverity: extra.sev ?? 'medium', analysis: 'The loop in `LoginClient.retry` runs while `status >= 500`.', evidence: [{ path: 'Sources/Auth/LoginClient.swift', symbol: 'LoginClient.retry', startLine: 12, note: 'while status >= 500' }], options, recommendedOptionId: rec },
  triage: { complexity: cx, complexityReason: extra.cxr ?? 'One guard and a test in one file.', confidence: cf, confidenceReason: extra.cfr ?? 'A cap is the standard fix.' }
})

rmSync(BASE, { recursive: true, force: true })
mkdirSync(REPO, { recursive: true })
git('init', '-q', '-b', 'fix/login-retry')
git('remote', 'add', 'origin', 'git@github.com:example/app.git')
mkdirSync(join(REPO, 'Sources/Auth'), { recursive: true })
commit('Sources/Auth/LoginClient.swift', Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`).join('\n'), 'add login client')
docket('start')

docket('source', 'upsert', '--data', data({ sourceId: 'gh:comment:9001', kind: 'github_issue_comment', externalId: '9001', text: 'review bot summary', url: 'https://github.com/example/app/pull/42#issuecomment-9001', author: 'review-bot', isBot: true }))
docket('source', 'upsert', '--data', data({ sourceId: 'gh:thread:T1', kind: 'github_review_thread', externalId: 'T1', text: 'thread', url: 'https://github.com/example/app/pull/42#discussion_r1', author: 'teammate' }))
const add = (title, summary, sev, location, ordinal, source = 'gh:comment:9001') =>
  docket('finding', 'add', '--data', data({ title, summary, reviewerSeverity: sev, category: 'reliability', location, sources: [{ sourceId: source, excerpt: `${ordinal + 1}. ${title}.`, ordinal }] })).id

// quick
const q1 = add('Retry loop has no upper bound', 'LoginClient.retry retries every 5xx with no attempt limit.', 'high', { path: 'Sources/Auth/LoginClient.swift', symbol: 'LoginClient.retry', startLine: 12, endLine: 20 }, 0)
docket('research', q1, '--data', research([opt('A', 'fix', 'Cap at 3 attempts', 'Add `maxAttempts = 3` and surface the last error.', 'surgical', 2, 'trivial'), opt('B', 'fix', 'Cap from remote config', 'Read the cap from a config flag, default 3.', 'contained', 4, 'small', { radius: { featureFlag: true } }), opt('C', 'acknowledge', 'Leave as is', 'The gateway sheds load during outages.', 'surgical', 0, 'trivial')], 'A', 1, 4))
const q2 = add('Unused import in TokenStore', 'Foundation is imported twice.', 'nit', { path: 'Sources/Auth/TokenStore.swift', startLine: 2 }, 1)
docket('research', q2, '--data', research([opt('A', 'fix', 'Remove the duplicate import', 'Delete line 2.', 'surgical', 1, 'trivial'), opt('B', 'acknowledge', 'Leave it', 'Harmless.', 'surgical', 0, 'trivial')], 'A', 1, 4, { sev: 'nit', why: 'Nit: no runtime effect.' }))
const q3 = add('Comment says 5 retries, code does 3', 'The doc comment is stale.', 'low', { path: 'Sources/Auth/LoginClient.swift', startLine: 10 }, 2)
docket('research', q3, '--data', research([opt('A', 'acknowledge', 'Not valid: comment refers to the old client', 'The comment documents LegacyLoginClient, which still does 5.', 'surgical', 0, 'trivial'), opt('B', 'fix', 'Reword the comment', 'Name both clients.', 'surgical', 1, 'trivial')], 'A', 1, 3, { verdict: 'not_valid', sev: 'low', why: 'Low.' }))
// decide
const d1 = add('Error copy says "Something went wrong"', 'Reviewer wants specific copy for timeouts.', 'low', { path: 'Sources/Auth/LoginView.swift', startLine: 30 }, 3)
docket('research', d1, '--data', research([opt('A', 'fix', 'Specific timeout copy', 'Show "The server took too long. Try again."', 'surgical', 1, 'trivial'), opt('B', 'fix', 'Generic copy with retry button', 'Keep copy, add a retry button.', 'contained', 2), opt('C', 'acknowledge', 'Keep current copy', 'Design owns copy; out of scope.', 'surgical', 0, 'trivial')], 'A', 1, 2, { cfr: 'Product preference: two reasonable answers.' }))
// scope
const s1 = add('Session refresh races with sign-out', 'A refresh that finishes after sign-out writes the token back.', 'medium', { path: 'Sources/Auth/TokenStore.swift', symbol: 'TokenStore.refresh', startLine: 55 }, 4)
docket('research', s1, '--data', research([opt('A', 'fix', 'Session generation counter', 'Stamp each refresh with a session generation; drop stale results.', 'broad', 9, 'medium', { areas: ['Auth', 'Networking'] }), opt('B', 'defer', 'Generation counter in a follow-up PR', 'Same fix, its own PR after this lands.', 'broad', 9, 'medium', { areas: ['Auth', 'Networking'] }), opt('C', 'fix', 'Cancel refresh in signOut()', 'Keep a task handle and cancel it.', 'contained', 3)], 'A', 3, 3, { cxr: 'Touches every token writer, about 9 files.', cfr: 'Known pattern for late writes.' }))
// dig
const g1 = add('Keychain access group may break app extensions', 'Reviewer suspects the widget loses tokens.', 'high', { path: 'Sources/Auth/Keychain.swift', startLine: 8 }, 0, 'gh:thread:T1')
docket('research', g1, '--data', research([opt('A', 'fix', 'Shared access group', 'Move tokens to the shared group with a migration.', 'sweeping', 14, 'large', { radius: { migration: true } }), opt('B', 'fix', 'Copy token to the widget on refresh', 'Write a read-only copy for the extension.', 'contained', 4, 'medium')], 'B', 3, 2, { verdict: 'unclear', sev: 'high', cxr: 'Keychain migration risk.', cfr: 'Depends on whether the widget needs refresh rights.' }))
docket('discuss', 'start', g1, '--session-id', 'demo-session-0001')
docket('discuss', 'entry', g1, '--data', data({ question: 'Does the widget ever refresh tokens itself?', answer: 'No. It only reads the access token; refresh happens in the app.' }))
// research needed
add('Analytics event fires twice on retry', 'login_failed is logged per attempt.', 'medium', { path: 'Sources/Auth/LoginClient.swift', startLine: 40 }, 5)

// queue + complete two, one with two iterations and an inferred session iteration
docket('accept', q2)
let task = docket('apply', 'next')
let sha = commit('Sources/Auth/TokenStore.swift', 'import Foundation\n', `chore: remove duplicate import (docket ${q2})`)
docket('apply', 'commit', q2, sha)
docket('apply', 'verify', q2, '--data', data({ status: 'passed', checks: [{ name: 'swift build', result: 'passed' }, { name: 'concern re-check', result: 'passed' }] }))
docket('apply', 'complete', q2, '--summary', 'Removed the duplicate import.')
docket('apply', 'next')

const c2 = add('Token written to the debug log', 'TokenStore logs the refresh token.', 'critical', { path: 'Sources/Auth/TokenStore.swift', startLine: 41 }, 6)
sha = commit('Sources/Auth/TokenStore.swift', 'import Foundation\n// redacted\n', 'fix: redact token')
docket('record', c2, '--data', data({ optionId: 'custom', instruction: 'Redacted in an ad-hoc session.', commits: [sha], verification: { status: 'passed', checks: [{ name: 'concern re-check', result: 'passed' }] }, summary: 'Token is redacted in logs.' }))
docket('reply', 'draft', c2, '--text', `Fixed in ${sha.slice(0, 7)}: the token is redacted.`, '--resolve-thread')

const a1 = add('Rename LoginClient to SignInClient', 'Naming preference.', 'nit', null, 7)
docket('decide', a1, '--option', 'custom', '--kind', 'acknowledge', '--instruction', 'Login is the established term in this module.')
docket('decide', s1, '--option', 'B', '--instruction', 'Own PR after #42 lands.')
docket('reopen', s1, '--reason', 'Demo: show a reopened scope finding.')

// one bounced
const b1 = add('Retry delay ignores Retry-After header', 'Server-provided delay is ignored.', 'medium', { path: 'Sources/Auth/LoginClient.swift', startLine: 25 }, 8)
docket('research', b1, '--data', research([opt('A', 'fix', 'Honor Retry-After', 'Parse the header and wait that long.', 'surgical', 1), opt('B', 'acknowledge', 'Leave as is', 'Backoff is close enough.', 'surgical', 0, 'trivial')], 'A', 2, 3))
docket('accept', b1)
docket('apply', 'next')
docket('apply', 'bounce', b1, '--reason', 'The HTTP client strips Retry-After before LoginClient sees it.')
docket('apply', 'next')

console.log(`Fixture ready: ${REPO}`)
if (!process.argv.includes('--fixture-only')) {
  const port = process.env.DOCKET_UI_PORT ?? '4848'
  console.log(`Open http://127.0.0.1:${port}/?path=${encodeURIComponent(REPO)}`)
  spawn(process.execPath, [CLI, 'ui', '--port', port], { cwd: REPO, env, stdio: 'inherit' })
}
