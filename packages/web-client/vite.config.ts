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
/**
 * The desk's artwork (`public/artwork`) is the app's to serve at `/artwork`, as the desk's own window serves its public
 * folder: an import of one for its address (`?url`) is that address, and `build.mjs` puts the files beside the bundle
 * for the app to copy there. Inlined, a library build would carry them in its first script.
 */
const artwork = {
  name: "mako-artwork",
  enforce: "pre" as const,
  resolveId: (id: string) => (id.startsWith("/artwork/") && id.endsWith("?url") ? `\0${id}` : undefined),
  load: (id: string) => (id.startsWith("\0/artwork/") ? `export default ${JSON.stringify(id.slice(1, -"?url".length))}` : undefined),
}

export default mergeConfig(
  desk,
  defineConfig({
    root,
    publicDir: false,
    plugins: [artwork],
    build: {
      outDir: resolve(here, "dist"),
      emptyOutDir: true,
      lib: { entry: resolve(root, "src/web-client/index.ts"), formats: ["es"], fileName: "index", cssFileName: "index" },
    },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  })
)
