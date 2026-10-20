import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

/**
 * What a Cursor start executes: not `cursor-agent`, but Cursor's SDK in a child of the host's own Node, which loads
 * `@cursor/sdk` and its platform's build (`@cursor/sdk-<platform>`) from the same scope folder.
 */
export function cursorSdkStartFiles(): string[] {
  try {
    // The export map hides package.json from `resolve`: walk up from the entry it exposes.
    let directory = dirname(createRequire(import.meta.url).resolve("@cursor/sdk"))
    for (let depth = 0; depth < 5 && !existsSync(join(directory, "package.json")); depth += 1) directory = dirname(directory)
    return [dirname(directory)]
  } catch {
    return []
  }
}
