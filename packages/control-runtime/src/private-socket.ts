import { constants } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir } from "node:fs/promises"
import { createConnection, createServer } from "node:net"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"
import { drawKeptPipe, makoLocalFolder, requireProof } from "@mako/sessions/private-pipe"
import { onWindows } from "./platform.js"

/**
 * Windows has no Unix sockets in Node: a control endpoint there is a named pipe drawn for its one listener, with a
 * secret every client proves it knows, and that proves the listener knows it, before anything crosses
 * (`@mako/sessions/private-pipe`). The secret travels only in the session file, in a launch folder under the user's own
 * `%LOCALAPPDATA%\Mako\control`, which no other account can read.
 */
export const windowsControlRoot = (): string => join(makoLocalFolder(), "control")

/** Global cleanup crosses tasks. Owned roots never sweep abandoned launches or fall back to global /tmp. */
export type ControlCleanupPolicy =
  | { readonly scope: "same-user-global" }
  | { readonly scope: "owned"; readonly root: string }

export const GLOBAL_CONTROL_CLEANUP: ControlCleanupPolicy = Object.freeze({ scope: "same-user-global" })

// sockaddr_un.sun_path includes a terminating NUL: macOS permits 103 bytes.
// Use the smaller Mac limit on Linux too. JavaScript string length is not bytes.
const MAX_SOCKET_BYTES = 103
const RUNTIME_SOCKET_RESERVE = 32

export function processAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH"
  }
}

export function socketUnused(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    const finish = (unused: boolean) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(unused)
    }
    const timer = setTimeout(() => finish(false), 10)
    socket.once("connect", () => finish(false))
    socket.once("error", (error) =>
      finish(
        "code" in error &&
          ["ECONNREFUSED", "ENOENT"].includes(String(error.code))
      )
    )
  })
}

/** Removes socket folders whose process is gone. Every socket made in `/tmp` sweeps, bounded to 25 ms and 128 checks. */
async function sweepUnusedSocketDirectories(): Promise<void> {
  // Windows makes no socket folders: its endpoints are pipes.
  if (onWindows()) return
  const names = await readdir("/tmp")
  const deadline = Date.now() + 25
  let checked = 0
  for (const name of names) {
    if (Date.now() >= deadline) break
    const match = /^mako-socket-([1-9]\d*)-[a-zA-Z0-9]{6}$/.exec(name)
    if (!match || ++checked > 128 || !processAbsent(Number(match[1]))) continue
    const directory = join("/tmp", name)
    try {
      const info = await lstat(directory)
      if (
        !info.isDirectory() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o777) !== 0o700
      )
        continue
      const files = await readdir(directory)
      if (files.some((file) => file !== "endpoint.sock")) continue
      if (files.length) {
        const path = join(directory, "endpoint.sock")
        const entry = await lstat(path)
        if (
          !entry.isSocket() ||
          entry.uid !== info.uid ||
          !(await socketUnused(path))
        )
          continue
        await rm(path)
      }
      // No recursive deletion: unexpected/new contents or a replacement survive.
      await rmdir(directory)
    } catch {
      /* Races and unverifiable ownership leave the directory untouched. */
    }
  }
}

/** Allocate an owned runtime root with room for its nested Unix sockets. */
export async function createControlDirectory(prefix: string, cleanup: ControlCleanupPolicy = GLOBAL_CONTROL_CLEANUP): Promise<string> {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(prefix))
    throw new Error("Invalid private runtime directory prefix")
  // Windows: under the user's own Mako folder, never a shared temp one; a pipe needs no short path. Its modes and owner
  // ids mean nothing there, and the folder is private by where it is.
  if (onWindows()) {
    const root = cleanup.scope === "owned" ? cleanup.root : windowsControlRoot()
    if (!isAbsolute(root)) throw new Error("An owned control root must be absolute")
    await mkdir(root, { recursive: true })
    return mkdtemp(join(root, prefix))
  }
  if (cleanup.scope === "owned") {
    if (!isAbsolute(cleanup.root)) throw new Error("An owned control root must be absolute")
    const handle = await open(cleanup.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      const current = await lstat(cleanup.root)
      if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700 || info.dev !== current.dev || info.ino !== current.ino || info.uid !== current.uid || info.mode !== current.mode || !current.isDirectory())
        throw new Error("An owned control root must be a private directory of this user")
    } finally {
      await handle.close()
    }
  }
  const preferred = join(cleanup.scope === "owned" ? cleanup.root : tmpdir(), prefix)
  if (cleanup.scope === "owned" && Buffer.byteLength(preferred) + 6 + RUNTIME_SOCKET_RESERVE > MAX_SOCKET_BYTES)
    throw new Error("The owned control root is too long for its sockets; use a shorter private root")
  const root =
    Buffer.byteLength(preferred) + 6 + RUNTIME_SOCKET_RESERVE <=
    MAX_SOCKET_BYTES
      ? preferred
      : join("/tmp", prefix)
  const directory = await mkdtemp(root)
  await chmod(directory, 0o700)
  return directory
}

/** Where a control server listens: a socket's path, or on Windows a pipe with the secret its clients prove. */
export interface ControlEndpoint {
  path: string
  proof: string | undefined
  close(): Promise<void>
}

/** The owner closes this endpoint on startup failure, exit or cancellation. */
export async function createPrivateControlSocket(
  directory: string,
  name: string,
  cleanup: ControlCleanupPolicy = GLOBAL_CONTROL_CLEANUP
): Promise<ControlEndpoint> {
  if (!isAbsolute(directory) || !/^[a-zA-Z0-9.-]+\.sock$/.test(name))
    throw new Error(
      "A private socket needs an absolute directory and a socket filename"
    )
  // Windows: a pipe drawn for this one listener and the secret its clients prove they know; nothing to remove.
  if (onWindows()) {
    const drawn = drawKeptPipe("mako-control")
    return { path: drawn.pipe, proof: drawn.proof, close: () => Promise.resolve() }
  }
  const desired = join(directory, name)
  if (cleanup.scope === "owned") {
    const within = relative(cleanup.root, directory)
    if (!isAbsolute(cleanup.root) || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`) || Buffer.byteLength(desired) > MAX_SOCKET_BYTES)
      throw new Error("A control socket must stay inside its short owned root")
  }
  // Caller-owned metadata may live at a long path. Keep only the socket in an
  // independently random, mode-0700 directory; never hash/truncate its identity.
  let temporary: string | undefined
  if (Buffer.byteLength(desired) > MAX_SOCKET_BYTES) {
    void sweepUnusedSocketDirectories().catch(() => {})
    temporary = await mkdtemp(`/tmp/mako-socket-${process.pid}-`)
    await chmod(temporary, 0o700)
  }
  const path = temporary ? join(temporary, "endpoint.sock") : desired
  let closing: Promise<void> | undefined
  return {
    path,
    proof: undefined,
    close: () =>
      (closing ??= temporary
        ? rm(temporary, { recursive: true, force: true })
        : rm(path, { force: true })),
  }
}

/** Where a handed-over listener binds before it's renamed into place; no longer than the socket's own path. */
export function stagingPath(path: string): string {
  return join(dirname(path), `.${basename(path).slice(1)}`)
}

/**
 * A private socket one process listens on and another takes over: connections
 * wait, paused and unread, until `release` or a handover. Closing a Unix
 * listener unlinks the path it was bound to, so it binds a staging name and
 * renames the socket into place; the first owner releasing its copy after a
 * handover leaves the socket file to the process that took it.
 */
export async function listenPrivateControlSocket(directory: string, name: string, cleanup: ControlCleanupPolicy = GLOBAL_CONTROL_CLEANUP) {
  const endpoint = await createPrivateControlSocket(directory, name, cleanup)
  if (endpoint.proof) return listenProvenControlPipe(endpoint, endpoint.proof)
  const staging = stagingPath(endpoint.path)
  const server = createServer({ pauseOnConnect: true })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(staging, () => {
        server.off("error", reject)
        resolve()
      })
    })
    await chmod(staging, 0o600)
    await rename(staging, endpoint.path)
  } catch (error) {
    server.close()
    await endpoint.close()
    throw error
  }
  let released: Promise<void> | undefined
  const release = () => (released ??= new Promise<void>((resolve) => server.close(() => resolve())))
  return {
    path: endpoint.path,
    proof: endpoint.proof,
    server,
    /** Stop accepting here; a process the listener was handed to goes on accepting. */
    release,
    /**
     * Closing a listener resets the connections still queued on it, which
     * their clients can only take as an unknown outcome. So the socket file
     * goes first, and no new client finds it; then a full poll phase of the
     * loop accepts what's queued, for the connection handler to answer.
     */
    close: async () => {
      await rm(endpoint.path, { force: true })
      for (let turn = 0; turn < 2; turn++) await new Promise((resolve) => setImmediate(resolve))
      await release()
      await endpoint.close()
    },
  }
}

/**
 * `listenPrivateControlSocket` on Windows: the drawn pipe, every connection proving itself first and then held paused,
 * as a Unix listener's are, for whoever serves it. A pipe's listener can't be handed to another process there (Node
 * passes only TCP handles on Windows), so its connections are passed on instead (`ControlWorker.hand`).
 */
async function listenProvenControlPipe(endpoint: ControlEndpoint, proof: string) {
  const path = endpoint.path
  const server = createServer({ pauseOnConnect: true })
  requireProof(server, () => proof)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, () => {
      server.off("error", reject)
      resolve()
    })
  })
  let released: Promise<void> | undefined
  const release = () => (released ??= new Promise<void>((resolve) => server.close(() => resolve())))
  return {
    path,
    proof: endpoint.proof,
    server,
    release,
    close: async () => {
      for (let turn = 0; turn < 2; turn++) await new Promise((resolve) => setImmediate(resolve))
      await release()
    },
  }
}
