import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DocketError } from './errors.ts'

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** Writes through a temporary file and a rename, so a reader never sees a partial file. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temp, path)
}

export function appendLine(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`)
}

const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 5_000

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function lockHolderAlive(lockDir: string): boolean {
  try {
    const pid = Number(readFileSync(join(lockDir, 'pid'), 'utf8'))
    if (!Number.isInteger(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Runs `fn` while holding an exclusive lock at `lockDir`. mkdir is atomic, so
 * only one process creates the lock directory. A lock whose holder died, or
 * that is older than LOCK_STALE_MS, is broken.
 */
export function withLock<T>(lockDir: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      mkdirSync(lockDir)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const age = existsSync(lockDir) ? Date.now() - statSync(lockDir).mtimeMs : 0
      if (!lockHolderAlive(lockDir) || age > LOCK_STALE_MS) {
        rmSync(lockDir, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) throw new DocketError('locked', `another docket process holds ${lockDir}`)
      sleep(25)
    }
  }
  try {
    const fd = openSync(join(lockDir, 'pid'), 'w')
    writeFileSync(fd, String(process.pid))
    closeSync(fd)
    return fn()
  } finally {
    rmSync(lockDir, { recursive: true, force: true })
  }
}
