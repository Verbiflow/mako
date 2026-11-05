import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs"
import { dirname } from "node:path"

/**
 * The patched SDK (`scripts/patch-cursor-sdk.mjs`) runs every write of a
 * transcript file, an append or a full rewrite, inside the function stored
 * here, so one writer at a time touches a file and a recovery never cuts a
 * line another process is still writing. Without it installed the writes run
 * unlocked, as in the unpatched SDK.
 */
export const CURSOR_TRANSCRIPT_LOCK = Symbol.for("mako:cursor-transcript-lock")

const LOCK_SUFFIX = ".mako-lock"
const BREAK_SUFFIX = ".mako-lock-break"
/** How long a write waits for another process's write to the same file. */
const WAIT_MS = 30_000
/** A lock or break file nobody finished writing is abandoned after this long. */
const UNWRITTEN_MS = 5_000
const LIVE_RECHECK_MS = 500

interface Owner {
  pid: number
  /** `ps`'s start time for `pid`: a reused pid has another one. Empty where the platform has no `ps`. */
  start: string
  /** One acquisition of the lock, so a holder only ever removes its own file. */
  token: string
}

/**
 * When a process started, as one string every process computes the same way, or
 * undefined when `pid` isn't running. Where `ps` is missing the pid alone
 * identifies a process.
 */
export function processStart(pid: number): string | undefined {
  try {
    process.kill(pid, 0)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EPERM") return undefined
  }
  if (process.platform === "win32") return ""
  try {
    const start = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return start || undefined
  } catch (cause) {
    // `ps` ran and found no such process, or couldn't run at all.
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? "" : undefined
  }
}

let ownStart: string | undefined
const ownOwner = (): Owner => {
  ownStart ??= processStart(process.pid) ?? ""
  return { pid: process.pid, start: ownStart, token: randomBytes(8).toString("hex") }
}

export interface LockOptions {
  /** Where the process-identity lookup is replaced, by tests. */
  start?: (pid: number) => string | undefined
  waitMs?: number
}

/** A lock file's owner, `null` for one that is empty or unreadable, `undefined` once it is gone. */
function readOwner(path: string): Owner | null | undefined {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null
  }
  try {
    const value = JSON.parse(text) as Partial<Owner>
    return typeof value.pid === "number" && typeof value.start === "string" && typeof value.token === "string" ? (value as Owner) : null
  } catch {
    return null
  }
}

function ageMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** Creates `path` holding `text` only if nothing is there. */
function createExclusive(path: string, text: string): boolean {
  let fd: number
  try {
    fd = openSync(path, "wx")
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code === "EEXIST") return false
    if (code !== "ENOENT") throw cause
    mkdirSync(dirname(path), { recursive: true })
    return createExclusive(path, text)
  }
  try {
    writeSync(fd, text)
  } finally {
    closeSync(fd)
  }
  return true
}

const remove = (path: string) => {
  try {
    unlinkSync(path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Runs `work` holding the exclusive lock of the transcript at `file`: a lock
 * file beside it naming the process by pid and start time. It is held until
 * `work` ends, and stale only once that process is gone. A dead holder may
 * have died halfway through a write, so `recover` runs before its lock is
 * taken over, while no one else can take the lock.
 */
export async function withTranscriptLock<T>(file: string, work: () => Promise<T>, recover?: (file: string) => void, options: LockOptions = {}): Promise<T> {
  const lock = `${file}${LOCK_SUFFIX}`
  const breaker = `${file}${BREAK_SUFFIX}`
  const startOf = options.start ?? processStart
  const mine = ownOwner()
  const text = JSON.stringify(mine)
  const deadline = Date.now() + (options.waitMs ?? WAIT_MS)
  // A holder seen alive isn't looked up again for a moment: the lookup runs `ps`.
  let liveToken: string | undefined
  let liveAt = 0
  for (let delay = 5; !createExclusive(lock, text); delay = Math.min(delay * 2, 50)) {
    const owner = readOwner(lock)
    if (owner === undefined) continue
    let dead: boolean
    if (owner === null) dead = ageMs(lock) > UNWRITTEN_MS
    else if (owner.token === liveToken && Date.now() - liveAt < LIVE_RECHECK_MS) dead = false
    else {
      const running = startOf(owner.pid)
      dead = running === undefined || (owner.start !== "" && running !== owner.start)
      if (!dead) {
        liveToken = owner.token
        liveAt = Date.now()
      }
    }
    if (dead) {
      // Only the holder of the break file takes a lock over, and only the one it saw, so a lock another
      // process took in the meantime is left alone.
      if (createExclusive(breaker, text)) {
        try {
          const now = readOwner(lock)
          if (now !== undefined && JSON.stringify(now) === JSON.stringify(owner)) {
            recover?.(file)
            remove(lock)
          }
        } finally {
          remove(breaker)
        }
        continue
      }
      if (ageMs(breaker) > UNWRITTEN_MS) remove(breaker)
    }
    if (Date.now() > deadline) throw new Error(`The transcript ${file} is being written by process ${owner?.pid ?? "unknown"}`)
    await sleep(delay)
  }
  try {
    return await work()
  } finally {
    if (readOwner(lock)?.token === mine.token) remove(lock)
  }
}
