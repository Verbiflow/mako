import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { statedVersion } from "./record-writers.js"

/**
 * The host's installed readings, as a capture observes them: what a write
 * heard as it lands is stamped with, where its harness's records state no
 * version of their own (`record-writers.ts`).
 */

/** Where the host keeps its installed readings (`RuntimeUpdates`), one file for every profile on the machine. */
export function makoRuntimeReadings(): string {
  return join(homedir(), ".mako", "runtime-updates.json")
}

/** The parts of the host's `runtime-updates.json` a capture reads: each installation's binary and the version read off it, by provider. */
const ReadingsSchema = z.object({
  updates: z.record(z.string(), z.object({ provider: z.string().optional(), binary: z.string().optional(), installed: z.string().optional() }).loose()),
  signatures: z.record(z.string(), z.object({ binary: z.string(), mtimeMs: z.number(), size: z.number(), installed: z.string().optional() }).loose()).optional(),
}).loose()

/**
 * The version a write heard as it lands was made by, from the host's
 * installed readings (`runtime-updates.json`, which `RuntimeUpdates` keeps):
 * only when every installation of `harness` the host read names the same
 * version, and the binary that version was read off is still there with the
 * same mtime and size, so it was the build installed when the write landed.
 * Null otherwise: a capture never guesses.
 */
export function observedInstall(file: string, harness: string): string | null {
  let readings: z.infer<typeof ReadingsSchema>
  try {
    readings = ReadingsSchema.parse(JSON.parse(readFileSync(file, "utf8")))
  } catch {
    return null
  }
  const rows = Object.entries(readings.updates).filter(([key, row]) => (row.provider ?? key.split(":")[0]) === harness && row.binary)
  const versions = new Set<string>()
  for (const [key, row] of rows) {
    // An installation whose version the host couldn't read may be the one that wrote it.
    if (!row.installed) return null
    const signature = readings.signatures?.[key]
    if (!signature || signature.binary !== row.binary || signature.installed !== row.installed) return null
    try {
      const info = statSync(signature.binary)
      if (info.mtimeMs !== signature.mtimeMs || info.size !== signature.size) return null
    } catch {
      return null
    }
    versions.add(row.installed)
  }
  const [only] = versions
  return versions.size === 1 ? statedVersion(only) : null
}
