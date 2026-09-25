import { extractFile, uncache } from "@electron/asar"
import { join } from "node:path"

/** The installed bundle may have been atomically replaced since our last read. */
export function readLocalAppMetadata(app) {
  const archive = join(app, "Contents/Resources/app.asar")
  // ASAR caches headers by pathname, even when that path now names a new file.
  // Reusing its old offsets can return unrelated bytes from the new archive.
  uncache(archive)
  return JSON.parse(extractFile(archive, "package.json").toString("utf8"))
}
