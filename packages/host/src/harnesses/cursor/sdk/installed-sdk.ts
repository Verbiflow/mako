import { realpathSync } from "node:fs"
import { registerHooks } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

/**
 * Loaded into the Cursor SDK's child before its entry (`--import`, `client.ts`) on a host that carries no
 * `@cursor/sdk` of its own: the child's imports of the SDK and its platform's build resolve from the copy Settings
 * installed (`MAKO_CURSOR_SDK_ROOT`, `installed.ts`), as they would from the host's install. That copy is the SDK's two
 * packages alone, so what the SDK itself imports (zod, its protobuf and connect packages) resolves from the host's
 * install, as it does when the host carries the SDK. A host with its own SDK never loads this.
 */
const named = process.env.MAKO_CURSOR_SDK_ROOT
if (named) {
  // Node names a loaded module by its real path, which a folder reached through a link isn't under by name.
  const root = realpathSync(named)
  const from = pathToFileURL(join(root, "package.json")).href
  const inside = pathToFileURL(join(root, "node_modules", "@cursor")).href + "/"
  const host = import.meta.url
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@cursor/sdk" || specifier.startsWith("@cursor/sdk/") || specifier.startsWith("@cursor/sdk-")) return nextResolve(specifier, { ...context, parentURL: from })
      const bare = !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.includes(":")
      if (!bare || !context.parentURL?.startsWith(inside)) return nextResolve(specifier, context)
      try {
        return nextResolve(specifier, context)
      } catch {
        return nextResolve(specifier, { ...context, parentURL: host })
      }
    },
  })
}
