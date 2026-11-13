import { readdirSync } from "node:fs"
import path from "node:path"
import { defineConfig, mergeConfig } from "vite"
import base from "./vite.config.ts"

/**
 * The renderer as the UI suites load it, built once for every UI shard (`npm run build:ui-test`) and served there
 * statically (`scripts/ci-ui-serve.mjs`, `MAKO_UI_VITE_URL`), where each suite used to start a dev server of its own
 * and compile every page it opened cold. Built in development mode, so `import.meta.env.DEV` holds and `?mock`, the
 * fixtures and React's development build are what a suite saw from its dev server; with the desk's `index.html`, every
 * page the suites open under `scripts/`, at the same paths.
 */
const root = import.meta.dirname
const pages = readdirSync(path.join(root, "scripts"))
  .filter((name) => name.endsWith(".html"))
  .map((name) => path.join(root, "scripts", name))

export default mergeConfig(
  base,
  defineConfig({
    mode: "development",
    build: {
      outDir: "dist-ui-test",
      emptyOutDir: true,
      minify: false,
      rollupOptions: { input: [path.join(root, "index.html"), ...pages] },
    },
  })
)
