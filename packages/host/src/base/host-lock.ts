import { createHash } from "node:crypto"
import { closeSync, constants, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs"
import { connect, createServer } from "node:net"
import { join, resolve } from "node:path"
import { nodePlatform } from "./platform.js"

/**
 * One host per data root, or one holder of anything else kept in a folder
 * (`purpose`: the device's record of changes has one owner).
 *
 * The kernel holds the lock and drops it when the process dies, however it
 * dies, so a crash leaves nothing stale to clean up; and no child inherits it,
 * so an agent outliving a crashed host never keeps the next one out.
 *
 * - macOS: `<purpose>.lock` in the folder, opened with `O_EXLOCK`, which takes
 *   an exclusive lock in the same call and is refused at once while another
 *   process, or another open in this one, holds it. The file is never
 *   removed: a process could open the old one just as another creates a new
 *   one, and both would hold a lock.
 * - Linux and Windows: a listening socket in the abstract namespace, or a named
 *   pipe, named for the folder; the kernel frees the name with the process.
 *   An abstract name is per network namespace, so containers sharing one data
 *   root through a mount wouldn't exclude each other, and another local user
 *   could take the name first.
 */
export type HostLock =
  | { kind: "held"; release(): Promise<void> }
  | { kind: "taken"; holder: number | null }

/** BSD's open(2) flag for an exclusive lock taken with the open; Node passes it through but doesn't name it. */
const O_EXLOCK = 0x20
/** A holder writes its pid just after it takes the lock; until then the file is empty or names the last holder. */
const HOLDER_WRITE_MS = 250

export interface HostLockOptions {
  platform?: NodeJS.Platform
  /** A restarted host's predecessor: while it holds the lock, wait for it to exit rather than give up. */
  predecessor?: number
  /** How long to wait for the predecessor. */
  waitMs?: number
  /** What the lock is for, in its name: `host` unless said. Letters, digits and dashes. */
  purpose?: string
}

export async function acquireHostLock(dataRoot: string, options: HostLockOptions = {}): Promise<HostLock> {
  const platform = options.platform ?? nodePlatform()
  const purpose = options.purpose ?? "host"
  const attempt = () => (platform === "darwin" ? fileLock(dataRoot, purpose) : nameLock(dataRoot, platform, purpose))
  const until = Date.now() + (options.waitMs ?? 30_000)
  for (;;) {
    const lock = await attempt()
    if (lock.kind === "held" || options.predecessor === undefined || lock.holder !== options.predecessor || Date.now() >= until)
      return lock
    await new Promise((done) => setTimeout(done, 50))
  }
}

/** Where the lock lives, for messages and tests. */
export function hostLockName(dataRoot: string, platform: NodeJS.Platform = nodePlatform(), purpose = "host"): string {
  if (!/^[a-z0-9-]{1,40}$/.test(purpose)) throw new Error(`A lock's purpose is lowercase letters, digits and dashes: ${purpose}`)
  if (platform === "darwin") return join(resolve(dataRoot), `${purpose}.lock`)
  const id = createHash("sha256").update(resolve(dataRoot)).digest("hex").slice(0, 32)
  return platform === "win32" ? `\\\\.\\pipe\\mako-${purpose}-${id}` : `\0mako-${purpose}-${id}`
}

async function fileLock(dataRoot: string, purpose: string): Promise<HostLock> {
  mkdirSync(dataRoot, { recursive: true })
  const path = hostLockName(dataRoot, "darwin", purpose)
  const fd = openLocked(path)
  if (fd === null) return { kind: "taken", holder: await fileHolder(path) }
  ftruncateSync(fd, 0)
  writeSync(fd, `${process.pid}\n`, 0)
  let released = false
  return {
    kind: "held",
    release: async () => {
      if (released) return
      released = true
      closeSync(fd)
    },
  }
}

/** The live process the lock file names, waiting out a holder that hasn't written its pid yet. */
async function fileHolder(path: string): Promise<number | null> {
  const until = Date.now() + HOLDER_WRITE_MS
  for (;;) {
    const pid = pidIn(readFileSync(path, "utf8"))
    if (pid !== null && running(pid)) return pid
    if (Date.now() >= until) return null
    await new Promise((done) => setTimeout(done, 10))
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

/** The locked file's descriptor, or `null` while another process holds the lock. */
function openLocked(path: string): number | null {
  try {
    return openSync(path, constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK, 0o600)
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")) return null
    throw error
  }
}

async function nameLock(dataRoot: string, platform: NodeJS.Platform, purpose: string): Promise<HostLock> {
  const name = hostLockName(dataRoot, platform, purpose)
  const server = createServer((socket) => socket.end(`${process.pid}\n`))
  const outcome = await new Promise<"held" | "taken">((settle, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") settle("taken")
      else reject(error)
    })
    server.listen(name, () => settle("held"))
  })
  if (outcome === "taken") return { kind: "taken", holder: await askHolder(name) }
  server.unref()
  return {
    kind: "held",
    release: () => new Promise((done) => server.close(() => done())),
  }
}

function askHolder(name: string): Promise<number | null> {
  return new Promise((settle) => {
    let reply = ""
    const socket = connect(name)
    const timer = setTimeout(() => socket.destroy(), 500)
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => { reply += chunk })
    socket.on("close", () => {
      clearTimeout(timer)
      settle(pidIn(reply))
    })
    socket.on("error", () => undefined)
  })
}

/**
 * The live process holding the data root's host lock, read without taking
 * it (a take, however brief, could turn a starting host away): the pid the
 * lock file names while that process runs on macOS, the listener's answer
 * elsewhere. Null when nothing holds it. A pid the kernel gave to another
 * process since reads as held, which a caller deciding to wait can live with.
 */
export async function hostLockHolder(dataRoot: string, platform: NodeJS.Platform = nodePlatform()): Promise<number | null> {
  if (platform !== "darwin") return askHolder(hostLockName(dataRoot, platform))
  let text: string
  try {
    text = readFileSync(hostLockName(dataRoot, "darwin"), "utf8")
  } catch {
    return null
  }
  const pid = pidIn(text)
  return pid !== null && running(pid) ? pid : null
}

function pidIn(text: string): number | null {
  const pid = Number(text.trim())
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}
