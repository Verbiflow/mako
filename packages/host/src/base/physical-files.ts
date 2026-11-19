import * as fs from "node:fs"
import * as files from "node:fs/promises"

/**
 * The file system as it is on disk. Under Electron's Node, `node:fs` reads into
 * `.asar` archives as if they were folders, so copying an app bundle with it
 * would unpack its archive; `original-fs` is that runtime's unpatched module.
 */
export async function physicalFiles(): Promise<typeof files> {
  if (!process.versions.electron) return files
  const original = await import("original-fs")
  return original.default.promises
}

/**
 * `physicalFiles` with the rest of the module, for a reader that must not open an archive it meets (attribution reads
 * whatever an agent wrote, an app bundle it built among it). Where `original-fs` can't load, `node:fs` as before.
 */
export async function physicalFileSystem(): Promise<typeof fs> {
  if (!process.versions.electron) return fs
  try {
    return (await import("original-fs")).default
  } catch {
    return fs
  }
}
