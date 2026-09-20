import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"

/** Snapshot once at development host startup, never recompute for health calls.
 * Content hashes survive a no-op rebuild; source edits alone aren't executable. */
export function devHostBuild(root: string): string {
  const hash = createHash("sha256")
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && /\.(?:c?js|mjs|json)$/.test(entry.name)) {
        const bytes = readFileSync(path)
        hash.update(relative(root, path)).update("\0").update(String(bytes.length)).update("\0").update(bytes)
      }
    }
  }
  visit(join(root, "dist-electron"))
  // Local runtime packages execute their compiled output too.
  const packages = join(root, "packages")
  if (existsSync(packages)) {
    for (const entry of readdirSync(packages, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const dist = join(packages, entry.name, "dist")
      if (entry.isDirectory() && existsSync(dist)) visit(dist)
    }
  }
  return hash.digest("hex")
}
