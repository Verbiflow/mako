import { lstat, readdir, rmdir, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { createControlDirectory, processAbsent, stagingPath } from "./private-socket.js"

const LAUNCH = /^mako-cli-([1-9]\d*)-[a-zA-Z0-9]{6}$/

/** A task's launch folder, named for the process that owns it: its `session` files and `mako-control` command. */
export function createLaunchFolder(): Promise<string> {
  return createControlDirectory(`mako-cli-${process.pid}-`)
}

/**
 * Launch folders whose owner died before any worker took them; a worker that
 * ran removes its own. Only the files a launch makes are removed, so anything
 * else in such a folder keeps it.
 */
export async function sweepAbandonedLaunches(): Promise<void> {
  const deadline = Date.now() + 25
  for (const root of new Set([tmpdir(), "/tmp"])) {
    const names = await readdir(root).catch(() => [])
    for (const name of names) {
      if (Date.now() >= deadline) return
      const pid = LAUNCH.exec(name)?.[1]
      if (!pid || !processAbsent(Number(pid))) continue
      const directory = join(root, name)
      try {
        const info = await lstat(directory)
        if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) continue
        const entries = await readdir(directory)
        if (entries.some((entry) => entry !== "session" && entry !== "mako-control")) continue
        if (entries.includes("session")) {
          const files = join(directory, "session")
          const inside = await readdir(files)
          const expected = ["session.json", "session.sock", basename(stagingPath(join(files, "session.sock")))]
          if (inside.some((entry) => !expected.includes(entry))) continue
          for (const entry of inside) await unlink(join(files, entry))
          await rmdir(files)
        }
        if (entries.includes("mako-control")) await unlink(join(directory, "mako-control"))
        await rmdir(directory)
      } catch {
        /* Races and unverifiable ownership leave the folder alone. */
      }
    }
  }
}
