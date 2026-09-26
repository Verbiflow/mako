import { lstat, mkdir } from "node:fs/promises"

/** Creates `path` if needed and refuses one another user or a symlink could have planted in a shared temp directory. */
export async function ensurePrivateDirectory(path: string, name: string) {
  await mkdir(path, { mode: 0o700, recursive: true })
  const directory = await lstat(path)
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 || (process.getuid && directory.uid !== process.getuid()))
    throw new Error(`The ${name} directory is not private to this user`)
}
