import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

export function isMainModule(url: string): boolean {
  const invoked = process.argv[1]
  if (!invoked) return false
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(url))
  } catch {
    return false
  }
}
