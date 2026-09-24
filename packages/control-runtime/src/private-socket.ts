import { chmod, lstat, mkdtemp, readdir, rm, rmdir } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

// sockaddr_un.sun_path includes a terminating NUL: macOS permits 103 bytes.
// Use the smaller Mac limit on Linux too. JavaScript string length is not bytes.
const MAX_SOCKET_BYTES = 103
const RUNTIME_SOCKET_RESERVE = 32
let swept: Promise<void> | undefined

function processAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH"
  }
}

function socketUnused(path: string): Promise<boolean> {
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

async function sweepUnusedSocketDirectories(): Promise<void> {
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
export async function createControlDirectory(prefix: string): Promise<string> {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(prefix))
    throw new Error("Invalid private runtime directory prefix")
  const preferred = join(tmpdir(), prefix)
  const root =
    Buffer.byteLength(preferred) + 6 + RUNTIME_SOCKET_RESERVE <=
    MAX_SOCKET_BYTES
      ? preferred
      : join("/tmp", prefix)
  const directory = await mkdtemp(root)
  await chmod(directory, 0o700)
  return directory
}

/** The owner closes this endpoint on startup failure, exit or cancellation. */
export async function createPrivateControlSocket(
  directory: string,
  name: string
) {
  if (!isAbsolute(directory) || !/^[a-zA-Z0-9.-]+\.sock$/.test(name))
    throw new Error(
      "A private socket needs an absolute directory and a socket filename"
    )
  const desired = join(directory, name)
  // Caller-owned metadata may live at a long path. Keep only the socket in an
  // independently random, mode-0700 directory; never hash/truncate its identity.
  let temporary: string | undefined
  if (Buffer.byteLength(desired) > MAX_SOCKET_BYTES) {
    void (swept ??= sweepUnusedSocketDirectories().catch(() => {}))
    temporary = await mkdtemp(`/tmp/mako-socket-${process.pid}-`)
    await chmod(temporary, 0o700)
  }
  const path = temporary ? join(temporary, "endpoint.sock") : desired
  let closing: Promise<void> | undefined
  return {
    path,
    close: () =>
      (closing ??= temporary
        ? rm(temporary, { recursive: true, force: true })
        : rm(path, { force: true })),
  }
}
