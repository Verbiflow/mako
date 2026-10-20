import { lstat, readdir, rmdir, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { createControlDirectory, processAbsent, socketUnused, stagingPath } from "./private-socket.js"

const LAUNCH = /^mako-cli-(?:([1-9]\d*)-)?[a-zA-Z0-9]{6}$/

/** A task's launch folder, named for the process that owns it: its `session` files and `mako-control` command. */
export function createLaunchFolder(): Promise<string> {
  return createControlDirectory(`mako-cli-${process.pid}-`)
}

/**
 * Launch folders whose owner died before any worker took them; a worker that
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
    for (const name of names) {
      if (!name.startsWith("mako-cli-")) continue
      if (Date.now() >= deadline) break
      const launch = LAUNCH.exec(name)
      if (!launch) continue
      const pid = launch[1]
      if (pid && !processAbsent(Number(pid))) continue
      const directory = join(root, name)
      try {
        const info = await lstat(directory)
        if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) continue
        const entries = await readdir(directory)
        if (entries.some((entry) => entry !== "session" && entry !== "mako-control")) continue
        const files = join(directory, "session")
        const inside = entries.includes("session") ? await readdir(files) : []
        const socket = join(files, "session.sock")
        const expected = ["session.json", "session.sock", basename(stagingPath(socket))]
        if (inside.some((entry) => !expected.includes(entry))) continue
        if (!pid && !(inside.includes("session.sock") && (await socketUnused(socket)))) continue
        if (entries.includes("session")) {
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
