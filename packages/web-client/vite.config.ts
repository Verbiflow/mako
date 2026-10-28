import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, mergeConfig } from "vite"
import desk from "../../vite.config"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "../..")

/**
 * The web client as one ES library with its own React: `startWebApp` and the stylesheet. Its conversation (the desk's
 * transcript and live state) is a chunk of its own, read after the list paints.
 */
export default mergeConfig(
  desk,
  defineConfig({
    root,
    publicDir: false,
    build: {
      outDir: resolve(here, "dist"),
      emptyOutDir: true,
      lib: { entry: resolve(root, "src/web-client/index.ts"), formats: ["es"], fileName: "index", cssFileName: "index" },
    },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  })
)
