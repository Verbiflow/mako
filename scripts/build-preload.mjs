import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build, context } from "esbuild"

/**
 * The renderer preload as one classic script.
 *
 * Every Mako renderer runs sandboxed, and a sandboxed preload is loaded by
 * Chromium, not Node: it cannot `import`, and its `require` reaches only
 * Electron's renderer subset. `electron/preload.ts` imports the bridge from
 * `shared.ts`, so esbuild folds that into `dist-electron/preload.cjs` with
 * `electron` left external. Type-only re-exports fall away, which keeps the
 * bundle to the bridge itself.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export const preloadBuildOptions = {
  entryPoints: [join(root, "electron/preload.ts")],
  outfile: join(root, "dist-electron/preload.cjs"),
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "chrome150",
  external: ["electron"],
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
}

/** Build once, or keep rebuilding while `electron/` changes; returns the disposer. */
export async function buildPreload({ watch = false } = {}) {
  // The detached Settings installer survives replacement of the running ASAR.
  // Its startup probe must carry its dependencies outside that bundle too.
  const startupOptions = {
    entryPoints: [join(root, "electron/local-update-startup.ts")],
    outfile: join(root, "dist-electron/local-update-startup.mjs"),
    bundle: true, format: "esm", platform: "node", target: "node22",
    logLevel: "warning",
  }
  if (!watch) {
    await Promise.all([build(preloadBuildOptions), build(startupOptions)])
    return async () => {}
  }
  const watcher = await context(preloadBuildOptions)
  const startupWatcher = await context(startupOptions)
  await watcher.watch()
  await startupWatcher.watch()
  return () => Promise.all([watcher.dispose(), startupWatcher.dispose()])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPreload()
}
