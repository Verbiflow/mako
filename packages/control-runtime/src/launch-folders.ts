import { constants, type Stats } from "node:fs"
import { lstat, open, readdir, rmdir, unlink, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { createControlDirectory, processAbsent, socketUnused, stagingPath, type ControlCleanupPolicy } from "./private-socket.js"

const LAUNCH = /^mako-cli-(?:([1-9]\d*)-)?[a-zA-Z0-9]{6}$/

/** A task's launch folder, named for the process that owns it: its `session` files and `mako-control` command. */
export function createLaunchFolder(cleanup?: ControlCleanupPolicy): Promise<string> {
  return createControlDirectory(`mako-cli-${process.pid}-`, cleanup)
}

// A directory's link count changes when its session child is removed.
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid
const privateDirectory = (info: Stats) => info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o7777) === 0o700

async function directoryAt(path: string): Promise<{ info: Stats; handle: FileHandle }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!privateDirectory(info) || !same(info, await lstat(path))) throw new Error("Unverified launch directory")
    return { info, handle }
  } catch (error) {
    await handle.close()
    throw error
  }
}

/**
 * GLOBAL same-user cleanup in both the OS temp directory and /tmp, not a
 * Thread-local policy. Launch folders whose owner died before any worker took them; a worker that
 * ran removes its own. Only the files a launch makes are removed, so anything
 * else in such a folder keeps it. Folders from before launches carried their
 * owner's pid go only once their socket refuses connections.
 */
export async function sweepAbandonedLaunches(): Promise<void> {
  for (const root of new Set([tmpdir(), "/tmp"])) {
    // A shared temp folder can hold tens of thousands of names; listing them
    // runs off the event loop, so the budget covers only the checks.
    const names = await readdir(root).catch(() => [])
    const deadline = Date.now() + 25
    let checked = 0
    for (const name of names) {
      if (!name.startsWith("mako-cli-")) continue
      if (Date.now() >= deadline) break
      const launch = LAUNCH.exec(name)
      if (!launch) continue
      if (++checked > 128) break
      const pid = launch[1]
      if (pid && !processAbsent(Number(pid))) continue
      const directory = join(root, name)
      let owned: Awaited<ReturnType<typeof directoryAt>> | undefined
      let session: Awaited<ReturnType<typeof directoryAt>> | undefined
      try {
        owned = await directoryAt(directory)
        const entries = await readdir(directory)
        if (entries.some((entry) => entry !== "session" && entry !== "mako-control")) continue
        const files = join(directory, "session")
        if (entries.includes("session")) session = await directoryAt(files)
        const inside = entries.includes("session") ? await readdir(files) : []
        const socket = join(files, "session.sock")
        const expected = ["session.json", "session.sock", basename(stagingPath(socket))]
        if (inside.some((entry) => !expected.includes(entry))) continue
        const checkedFiles = new Map<string, Stats>()
        for (const entry of inside) {
          const path = join(files, entry)
          const info = await lstat(path)
          // Pre-PID primary sockets could be bound without chmod. Only their
          // ordinary permission bits may vary: both ancestors are verified
          // private, and the legacy liveness and identity gates still apply.
          const mode = info.mode & 0o7777
          const legacySocketMode = !pid && entry === "session.sock" && (mode & 0o7000) === 0
          if (info.uid !== owned.info.uid || (!legacySocketMode && mode !== 0o600) || (entry === "session.json" ? !info.isFile() || info.nlink !== 1 : !info.isSocket()))
            throw new Error("Unverified launch file")
          checkedFiles.set(path, info)
        }
        const command = join(directory, "mako-control")
        if (entries.includes("mako-control")) {
          const info = await lstat(command)
          if (!info.isFile() || info.nlink !== 1 || info.uid !== owned.info.uid || (info.mode & 0o7777) !== 0o700)
            throw new Error("Unverified launch command")
          checkedFiles.set(command, info)
        }
        if (!pid && !(inside.includes("session.sock") && (await socketUnused(socket)))) continue
        let sessionPresent = !!session
        const current = async () => {
          if (!same(owned!.info, await lstat(directory)) || (sessionPresent && !same(session!.info, await lstat(files))) || (pid && !processAbsent(Number(pid))))
            throw new Error("Launch identity changed")
        }
        const remove = async (path: string) => {
          const before = checkedFiles.get(path)!
          const now = await lstat(path)
          if (!same(before, now) || before.nlink !== now.nlink) throw new Error("Launch file changed")
          await current()
          await unlink(path)
        }
        if (entries.includes("session")) {
          for (const entry of inside) await remove(join(files, entry))
          await current()
          await rmdir(files)
          sessionPresent = false
        }
        if (entries.includes("mako-control")) await remove(command)
        await current()
        await rmdir(directory)
      } catch {
        // Unknown ownership or observed replacement stops further mutations.
        // Unlinks are path-based: a swap after the final check is not atomic,
        // and an earlier successful unlink cannot be rolled back on failure.
      } finally {
        await session?.handle.close().catch(() => {})
        await owned?.handle.close().catch(() => {})
      }
    }
  }
}
