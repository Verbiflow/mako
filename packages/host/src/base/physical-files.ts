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
