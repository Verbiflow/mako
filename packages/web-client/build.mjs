// Builds the web client from the renderer's own source: the packages it reads compiled first, then one Vite library
// build at the checkout's root, so its aliases, its Tailwind sources and its plugins are the desk's.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "../..")
const tsgo = resolve(root, "node_modules/@typescript/native-preview/bin/tsgo")
const vite = resolve(root, "node_modules/vite/bin/vite.js")

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run([tsgo, "-b", "packages/protocol", "packages/sessions", "packages/lazy", "packages/control", "packages/control-runtime"])
run([vite, "build", "-c", resolve(here, "vite.config.ts")])

// A library build inlines every font into the stylesheet, and the page can't paint before the stylesheet arrives. Each
// is put back in a file of its own beside it: a browser fetches only the subsets its glyphs need (each face names its
// `unicode-range`), once, and the app's build gives each a hashed name its service worker keeps.
const css = resolve(here, "dist/index.css")
mkdirSync(resolve(here, "dist/fonts"), { recursive: true })
let fonts = 0
const written = readFileSync(css, "utf8").replace(/url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/g, (_, data) => {
  const bytes = Buffer.from(data, "base64")
  const name = `fonts/${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.woff2`
  writeFileSync(resolve(here, "dist", name), bytes)
  fonts++
  return `url(./${name})`
})
writeFileSync(css, written)
console.log(`web-client: ${fonts} fonts as files of their own`)
