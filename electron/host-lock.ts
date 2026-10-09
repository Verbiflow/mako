import { createHash } from "node:crypto"
import { closeSync, constants, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs"
import { connect, createServer } from "node:net"
import { join, resolve } from "node:path"

/**
 * One host per data root.
 *
 * The kernel holds the lock and drops it when the process dies, however it
 * dies, so a crash leaves nothing stale to clean up; and no child inherits it,
 * so an agent outliving a crashed host never keeps the next one out.
 *
 * - macOS: `host.lock` in the data root, opened with `O_EXLOCK`, which takes an
 *   exclusive lock in the same call and is refused at once while another
 *   process holds it. The file is never removed: a process could open the old
 *   one just as another creates a new one, and both would hold a lock.
 * - Linux and Windows: a listening socket in the abstract namespace, or a named
 *   pipe, named for the data root; the kernel frees the name with the process.
 *   An abstract name is per network namespace, so containers sharing one data
 *   root through a mount wouldn't exclude each other, and another local user
 *   could take the name first.
 */
export type HostLock =
  | { kind: "held"; release(): Promise<void> }
  | { kind: "taken"; holder: number | null }

/** BSD's open(2) flag for an exclusive lock taken with the open; Node passes it through but doesn't name it. */
const O_EXLOCK = 0x20

export interface HostLockOptions {
  platform?: NodeJS.Platform
  /** A restarted host's predecessor: while it holds the lock, wait for it to exit rather than give up. */
  predecessor?: number
  /** How long to wait for the predecessor. */
  waitMs?: number
}

export async function acquireHostLock(dataRoot: string, options: HostLockOptions = {}): Promise<HostLock> {
  const platform = options.platform ?? process.platform
  const attempt = () => (platform === "darwin" ? fileLock(dataRoot) : nameLock(dataRoot, platform))
  const until = Date.now() + (options.waitMs ?? 30_000)
  for (;;) {
    const lock = await attempt()
    if (lock.kind === "held" || options.predecessor === undefined || lock.holder !== options.predecessor || Date.now() >= until)
      return lock
    await new Promise((done) => setTimeout(done, 50))
  }
}

/** Where the lock lives, for messages and tests. */
export function hostLockName(dataRoot: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return join(resolve(dataRoot), "host.lock")
  const id = createHash("sha256").update(resolve(dataRoot)).digest("hex").slice(0, 32)
  return platform === "win32" ? `\\\\.\\pipe\\mako-host-${id}` : `\0mako-host-${id}`
}

function fileLock(dataRoot: string): HostLock {
  mkdirSync(dataRoot, { recursive: true })
  const path = hostLockName(dataRoot, "darwin")
  const fd = openLocked(path)
  if (fd === null) return { kind: "taken", holder: pidIn(readFileSync(path, "utf8")) }
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

/** The locked file's descriptor, or `null` while another process holds the lock. */
function openLocked(path: string): number | null {
  try {
    return openSync(path, constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK, 0o600)
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")) return null
    throw error
  }
}

async function nameLock(dataRoot: string, platform: NodeJS.Platform): Promise<HostLock> {
  const name = hostLockName(dataRoot, platform)
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

function pidIn(text: string): number | null {
  const pid = Number(text.trim())
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}
