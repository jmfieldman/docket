import { spawn } from 'node:child_process'
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { action, finding, plan, snapshot, worktrees, type ActionName, type PlanKind } from './api.ts'
import { DocketError } from './errors.ts'
import { UI_HTML } from './ui.generated.ts'

export const DEFAULT_PORT = Number(process.env.DOCKET_UI_PORT ?? 4747)
const MAX_BODY = 256 * 1024
const VERSION = 1

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  const text = type === 'application/json' ? JSON.stringify(body) : String(body)
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  })
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new DocketError('bad_input', 'request body too large', 2))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new DocketError('bad_input', 'request body is not valid JSON', 2))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Writes must carry `x-docket: 1` and come from this origin (or no origin). A
 * web page on another site cannot set that header without a CORS preflight,
 * which this server never answers, so it cannot drive docket.
 */
function allowedWrite(req: IncomingMessage, port: number): boolean {
  if (req.headers['x-docket'] !== '1') return false
  const origin = req.headers.origin
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
}

function errorStatus(error: DocketError): number {
  if (error.code === 'not_found') return 404
  if (error.code === 'rev_conflict') return 409
  if (['bad_input', 'invalid_state', 'not_started', 'paused', 'branch_mismatch', 'no_discussion'].includes(error.code)) return 400
  return 500
}

export function createUiServer(port: number): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, UI_HTML, 'text/html')
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { docket: true, version: VERSION })
      if (req.method === 'GET' && url.pathname === '/api/worktrees') return send(res, 200, worktrees(url.searchParams.get('path') ?? ''))
      if (req.method === 'GET' && url.pathname === '/api/snapshot') return send(res, 200, snapshot(url.searchParams.get('path') ?? ''))
      if (req.method === 'GET' && url.pathname === '/api/finding') {
        return send(res, 200, finding(url.searchParams.get('path') ?? '', url.searchParams.get('id') ?? ''))
      }
      if (req.method === 'POST' && (url.pathname === '/api/action' || url.pathname === '/api/plan')) {
        if (!allowedWrite(req, port)) return send(res, 403, { error: { code: 'forbidden', message: 'missing x-docket header or foreign origin' } })
        const body = await readBody(req)
        const result =
          url.pathname === '/api/action'
            ? action(body.path, body.name as ActionName, body.args ?? {})
            : plan(body.path, body.kind as PlanKind, body.args ?? {})
        return send(res, 200, { ok: true, result: result ?? null })
      }
      return send(res, 404, { error: { code: 'not_found', message: `no route ${req.method} ${url.pathname}` } })
    } catch (error) {
      if (error instanceof DocketError) return send(res, errorStatus(error), { error: { code: error.code, message: error.message } })
      return send(res, 500, { error: { code: 'internal', message: (error as Error).message } })
    }
  })
}

/** True when a docket UI server already answers on the port. */
export function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/health', timeout: 800 }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).docket === true)
        } catch {
          resolve(false)
        }
      })
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

function openInBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  try {
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
  } catch {
    // The URL is printed either way.
  }
}

export function uiUrl(port: number, path?: string): string {
  return `http://127.0.0.1:${port}/${path ? `?path=${encodeURIComponent(path)}` : ''}`
}

/**
 * `docket ui`: serve in the foreground. `docket ui --open`: make sure a server
 * runs (detached when it must start one), then open the UI for the worktree
 * in the system browser.
 */
export async function runUi(options: { port: number; open: boolean; cwd: string }): Promise<number> {
  const url = uiUrl(options.port, options.cwd)
  if (options.open) {
    if (!(await probe(options.port))) {
      const child = spawn(process.execPath, [...process.execArgv, process.argv[1] as string, 'ui', '--port', String(options.port)], {
        detached: true,
        stdio: 'ignore',
        env: process.env
      })
      child.unref()
      for (let i = 0; i < 40 && !(await probe(options.port)); i++) await new Promise((r) => setTimeout(r, 100))
    }
    openInBrowser(url)
    console.log(url)
    return 0
  }
  if (await probe(options.port)) {
    console.log(`Docket UI is already running: ${url}`)
    return 0
  }
  const server = createUiServer(options.port)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, '127.0.0.1', () => resolve())
  })
  console.log(`Docket UI: ${url}`)
  return await new Promise<number>(() => {})
}
