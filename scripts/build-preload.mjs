import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build, context } from "esbuild"

/**
 * The renderer preload as one classic script.
 *
 * Every Mako renderer runs sandboxed, and a sandboxed preload is loaded by
 * Chromium, not Node: it cannot `import`, and its `require` reaches only
 * Electron's renderer subset. `electron/preload.ts` imports the bridge from
 * `contracts/renderer-bridge.ts`, so esbuild folds that into
 * `dist-electron/preload.cjs` with `electron` left external. Type-only imports
 * fall away, which keeps the bundle to the bridge itself.
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

/**
 * The live video page (`src/live-video/page.ts`) as one script beside its own sandboxed preload and HTML. The page
 * has no window; the desktop's main process loads it to encode with WebCodecs (`electron/live-video-electron.ts`).
 */
export const liveVideoBuildOptions = [
  { ...preloadBuildOptions, entryPoints: [join(root, "electron/live-video-preload.ts")], outfile: join(root, "dist-electron/live-video-preload.cjs") },
  {
    entryPoints: [join(root, "src/live-video/page.ts")],
    outfile: join(root, "dist-electron/live-video-page.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome150",
    tsconfig: join(root, "tsconfig.app.json"),
    // The page needs only the packet's wire format; the package's barrel would bring every contract's zod schemas.
    alias: { "@mako/control-runtime/contracts": join(root, "packages/control-runtime/src/contracts/control-video.ts") },
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
  },
]

const LIVE_VIDEO_HTML = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src file:"><title>Mako live video</title><script src="live-video-page.js"></script>\n`

function writeLiveVideoPage() {
  mkdirSync(join(root, "dist-electron"), { recursive: true })
  writeFileSync(join(root, "dist-electron/live-video.html"), LIVE_VIDEO_HTML)
}

/** Build once, or keep rebuilding while `electron/` changes; returns the disposer. */
export async function buildPreload({ watch = false } = {}) {
  // The detached Settings installer survives replacement of the running ASAR.
  // Its startup probe must carry its dependencies outside that bundle too,
  // and the host copies it from beside its own installer.
  const startupOptions = {
    entryPoints: [join(root, "packages/host/src/application/local-update-startup.ts")],
    outfile: join(root, "packages/host/dist/application/local-update-startup.mjs"),
    bundle: true, format: "esm", platform: "node", target: "node22",
    logLevel: "warning",
  }
  writeLiveVideoPage()
  if (!watch) {
    await Promise.all([build(preloadBuildOptions), build(startupOptions), ...liveVideoBuildOptions.map((options) => build(options))])
    return async () => {}
  }
  const watchers = await Promise.all([preloadBuildOptions, startupOptions, ...liveVideoBuildOptions].map((options) => context(options)))
  await Promise.all(watchers.map((watcher) => watcher.watch()))
  return () => Promise.all(watchers.map((watcher) => watcher.dispose()))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPreload()
}
