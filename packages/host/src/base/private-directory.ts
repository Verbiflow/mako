import { lstat, mkdir } from "node:fs/promises"
import { hostCommand } from "./host-command.js"
import { onWindows } from "./platform.js"
import { windowsIcacls } from "./system-tools.js"
import { windowsUserSid } from "./windows-helper.js"

/**
 * Creates `path` if needed and refuses one another user or a symlink could have planted in a shared temp directory.
 * Windows keeps no Unix modes or owner ids (every folder reads as 0o777 to Node), so there the folder's DACL is set
 * outright instead, each time: inheritance cut, full control for this user and SYSTEM alone.
 */
export async function ensurePrivateDirectory(path: string, name: string) {
  await mkdir(path, { mode: 0o700, recursive: true })
  const directory = await lstat(path)
  const foreign = !onWindows() && ((directory.mode & 0o077) !== 0 || (process.getuid && directory.uid !== process.getuid()))
  if (!directory.isDirectory() || directory.isSymbolicLink() || foreign)
    throw new Error(`The ${name} directory is not private to this user`)
  if (onWindows()) await windowsPrivate(path, name)
}

async function windowsPrivate(path: string, name: string): Promise<void> {
  // By this process's own SID, as its token says, never by names an environment could change; `S-1-5-18` is SYSTEM.
  const user = await windowsUserSid()
  if (!user) throw new Error(`The ${name} directory can't be made private: Windows didn't say who this user is`)
  await hostCommand(windowsIcacls(), [path, "/inheritance:r", "/grant:r", `*${user}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/q"], { timeout: 15_000, windowsHide: true })
    .catch((error: Error) => { throw new Error(`The ${name} directory couldn't be made private to this user: ${error.message}`, { cause: error }) })
}
