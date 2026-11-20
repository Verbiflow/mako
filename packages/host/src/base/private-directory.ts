import { lstat, mkdir } from "node:fs/promises"
import { onWindows } from "./platform.js"

/**
 * Creates `path` if needed and refuses one another user or a symlink could have planted in a shared temp directory.
 * Windows keeps no Unix modes or owner ids (every folder reads as 0o777 to Node): what makes a folder private there is
 * where it is, in the user's own profile (`transport/pipe.ts`), so only a link in its place is refused.
 */
export async function ensurePrivateDirectory(path: string, name: string) {
  await mkdir(path, { mode: 0o700, recursive: true })
  const directory = await lstat(path)
  const foreign = !onWindows() && ((directory.mode & 0o077) !== 0 || (process.getuid && directory.uid !== process.getuid()))
  if (!directory.isDirectory() || directory.isSymbolicLink() || foreign)
    throw new Error(`The ${name} directory is not private to this user`)
}
