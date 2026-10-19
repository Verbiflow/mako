import { createHash } from "node:crypto"
import { closeSync, constants, mkdirSync, openSync, readFileSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { dirname } from "node:path"
import { onLinux, onMac, onWindows } from "./platform.js"

/**
 * Locks the record store's background work takes, held by the kernel and
 * dropped with the process however it ends, so a crash leaves nothing stale
 * and nothing is decided by a clock:
 *
 * - macOS: the file at `path`, opened with `O_EXLOCK`.
 * - Linux: a listening socket in the abstract namespace named for `path`,
 *   as the host's own lock (`host-lock.ts`) and the sync daemon's claim
 *   take theirs. No file, and no /proc needed. An abstract name is per
 *   network namespace, so two containers sharing one store through a mount
 *   don't exclude each other (`npm run test:linux-locks` shows it). That's
 *   left so: each container keeps its own `~/.mako`, and a store shared on
 *   purpose still has SQLite's lock on every write, keeps another
 *   namespace's capture intents unjudged (`record-intents.ts`), and a
 *   repack's switch moves a chunk only from where it copied it.
 * - Windows: a named pipe named for `path`.
 *
 * Where none can be had (no `AF_UNIX` under a sandbox's policy, a lock file
 * that can't be made), `takeLock` throws `LockUnavailableError` and the work
 * doesn't run.
 */

/** BSD's open(2) flag for an exclusive lock taken with the open; Node passes it through but doesn't name it. */
const O_EXLOCK = 0x20

export interface HeldLock {
  release(): Promise<void>
}

/**
 * The kernel can't hold a lock here: no abstract socket (a sandbox's policy
 * refusing `AF_UNIX`, as a seccomp profile can), or a lock file that can't
 * be made. Work that needs one doesn't run; nothing takes its place, since
 * a lock a crash could leave behind is the clock this module exists to avoid.
 */
export class LockUnavailableError extends Error {
  constructor(path: string, cause: unknown) {
    const code = cause instanceof Error && "code" in cause ? ` (${String(cause.code)})` : ""
    super(`The kernel can't hold the lock ${path} here${code}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = "LockUnavailableError"
  }
}

/** The lock at `path`, or null while another process (or another take in this one) holds it. Throws `LockUnavailableError` where no lock can be had. */
export async function takeLock(path: string): Promise<HeldLock | null> {
  if (onMac()) {
    let fd: number
    try {
      mkdirSync(dirname(path), { recursive: true })
      fd = openSync(path, constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK, 0o600)
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined
      if (code === "EAGAIN" || code === "EWOULDBLOCK") return null
      throw new LockUnavailableError(path, error)
    }
    return { release: async () => closeSync(fd) }
  }
  let server: Server | null
  try {
    server = await listen(lockName(path))
  } catch (error) {
    throw new LockUnavailableError(path, error)
  }
  if (!server) return null
  const held = server
  return { release: () => new Promise<void>((done) => held.close(() => done())) }
}

/**
 * Whether another process (or another take in this one) holds the lock at
 * `path`, without keeping it: `free` once its holder is gone however it
 * ended, `unknown` when the kernel can't be asked (no abstract socket under
 * a sandbox's policy, a folder that can't be opened). On macOS a lock file
 * that isn't there is free and isn't made.
 */
export async function probeLock(path: string): Promise<"held" | "free" | "unknown"> {
  if (onMac()) {
    let fd: number
    try {
      fd = openSync(path, constants.O_RDWR | O_EXLOCK | constants.O_NONBLOCK)
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined
      if (code === "ENOENT") return "free"
      return code === "EAGAIN" || code === "EWOULDBLOCK" ? "held" : "unknown"
    }
    closeSync(fd)
    return "free"
  }
  try {
    const server = await listen(lockName(path))
    if (!server) return "held"
    await new Promise<void>((done) => server.close(() => done()))
    return "free"
  } catch {
    return "unknown"
  }
}

/** The kernel's name for `path`'s lock where there's no file lock. */
export function lockName(path: string): string {
  const id = createHash("sha256").update(path).digest("hex").slice(0, 32)
  return onWindows() ? `\\\\.\\pipe\\mako-lock-${id}` : `\0mako-lock-${id}`
}

/** A server listening on `name`, unreferenced so it never keeps the process alive; null when the name is taken. */
function listen(name: string): Promise<Server | null> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy())
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(null)
      else reject(error)
    })
    server.listen(name, () => {
      server.unref()
      resolve(server)
    })
  })
}

/** USER_HZ: the kernel's clock ticks per second in /proc, 100 on every architecture Node runs Linux on. */
const USER_HZ = 100

/**
 * When `pid` started, in ms since the epoch, as Linux's /proc says (boot
 * time plus the process's start in ticks, to the 10 ms); null elsewhere or
 * when it's gone. With the pid it names one process: a pid the kernel gave
 * to another since has another start.
 */
export function processStart(pid: number): number | null {
  if (!onLinux()) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    // The command name in parentheses may hold spaces; the start time is the 20th field after it.
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19])
    const boot = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1])
    return Number.isSafeInteger(ticks) && Number.isSafeInteger(boot) ? boot * 1000 + (ticks * 1000) / USER_HZ : null
  } catch {
    return null
  }
}
