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

function readHolder(lockDir: string): string | null {
  try {
    return readFileSync(join(lockDir, 'pid'), 'utf8')
  } catch {
    return null
  }
}

function lockHolderAlive(lockDir: string): boolean {
  try {
    const pid = Number(readFileSync(join(lockDir, 'pid'), 'utf8'))
    if (!Number.isInteger(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // EPERM: the process exists but belongs to another user. ENOENT: the
    // holder released the lock between our checks; let the caller retry.
    return code === 'EPERM' || code === 'ENOENT'
  }
}

/**
 * Runs `fn` while holding an exclusive lock at `lockDir`. The lock directory
 * is built with its pid file in place and renamed into position, so a lock
 * never exists without an owner. A lock whose holder died, or that is older
 * than LOCK_STALE_MS, is broken.
 */
export function withLock<T>(lockDir: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS
  const staging = `${lockDir}.${process.pid}.${Math.random().toString(36).slice(2)}`
  mkdirSync(staging)
  const fd = openSync(join(staging, 'pid'), 'w')
  writeFileSync(fd, String(process.pid))
  closeSync(fd)
  try {
    for (;;) {
      try {
        renameSync(staging, lockDir)
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EISDIR') throw error
        const holder = readHolder(lockDir)
        const age = existsSync(lockDir) ? Date.now() - statSync(lockDir).mtimeMs : 0
        if (!lockHolderAlive(lockDir) || age > LOCK_STALE_MS) {
          // Break only the lock we judged: another process may have taken a
          // fresh lock since we read the holder.
          if (holder !== null && readHolder(lockDir) === holder) rmSync(lockDir, { recursive: true, force: true })
          continue
        }
        if (Date.now() > deadline) throw new DocketError('locked', `another docket process holds ${lockDir}`)
        sleep(25)
      }
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  try {
    return fn()
  } finally {
    rmSync(lockDir, { recursive: true, force: true })
  }
}
