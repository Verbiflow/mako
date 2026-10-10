import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"

/** What a development host runs: the app's entry build and each local package's compiled output. */
export function devHostBuildDirectories(root: string): string[] {
  const packages = join(root, "packages")
  const compiled = existsSync(packages)
    ? readdirSync(packages, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => join(packages, entry.name, "dist"))
        .filter((dist) => existsSync(dist))
    : []
  return [join(root, "dist-electron"), ...compiled]
}

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
  for (const directory of devHostBuildDirectories(root)) visit(directory)
  return hash.digest("hex")
}
