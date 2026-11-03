import { readFileSync } from "node:fs"
import { rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * The cloud a data root joined with `mako-host join --cloud`, kept beside its data so a plain `mako-host` after it
 * runs against the same one. Only the cloud's origin, never anything secret: the sign-in is in the secret store.
 */
function joinedCloudPath(dataRoot: string): string {
  return join(dataRoot, "joined-cloud")
}

export function readJoinedCloud(dataRoot: string): string | undefined {
  try {
    return readFileSync(joinedCloudPath(dataRoot), "utf8").trim() || undefined
  } catch {
    return undefined
  }
}

export async function writeJoinedCloud(dataRoot: string, origin: string): Promise<void> {
  const path = joinedCloudPath(dataRoot)
  await writeFile(`${path}.tmp`, `${origin}\n`, { mode: 0o644 })
  await rename(`${path}.tmp`, path)
}
