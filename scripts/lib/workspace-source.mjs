import { register } from "node:module"
import { register as registerTypeScript } from "tsx/esm/api"

/**
 * Load Mako's own packages (`@mako/host/...`, `@mako/git`, every workspace
 * package) from the checkout's TypeScript source for the rest of this
 * process, instead of from `packages/<name>/dist`, which holds whatever was
 * last compiled.
 *
 * `npm run update:local` acts on a checkout before building it: it reads it,
 * fast-forwards it and installs its dependencies with the host's own code.
 * Imported from dist under plain node, that code was the last compile's: the
 * fetch, fast-forward and dependency logic that ran was stale, and on a
 * checkout last built before a module existed the import failed outright
 * (`ERR_MODULE_NOT_FOUND`). Each package's `exports` names its compiled file;
 * the source beside it (`dist/x.js` → `src/x.ts`) is loaded instead, and tsx
 * strips its types. Only imports that start after this call are affected, so
 * call it before the first dynamic import of a workspace package.
 */
let registered = false

export function useWorkspaceSource(root) {
  if (registered) return
  registered = true
  registerTypeScript()
  register(new URL("./workspace-source-hooks.mjs", import.meta.url), { data: { root } })
}
