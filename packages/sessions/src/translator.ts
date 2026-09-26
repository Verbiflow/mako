import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

let identity: string | undefined

/**
 * The code that turns native records into entries. A translation saved by
 * other code is stale even when the native record is unchanged, so a parser
 * fix reaches conversations translated before it.
 */
export function translatorBuild(): string {
  if (identity !== undefined) return identity
  const root = dirname(fileURLToPath(import.meta.url))
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js"
  const hash = createHash("sha256")
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.endsWith(extension))
        hash.update(relative(root, path)).update("\0").update(readFileSync(path))
    }
  }
  visit(root)
  identity = hash.digest("hex").slice(0, 16)
  return identity
}
