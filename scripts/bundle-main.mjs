import { readFile, rm } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

/**
 * The packaged desktop's main process and its host, each as one entry file and
 * the chunks it imports on demand, instead of the ~450 (main) and ~1,370 (host)
 * modules Node resolved and read one at a time out of app.asar as they started.
 *
 * It bundles what tsgo and the packages already emitted, so each process runs
 * the same JavaScript the package ships: `dist-electron/entry.js` for
 * Electron's main (`dist-electron/main/`) and `@mako/host`'s `mako-host.js` for
 * the host (`dist-electron/host/`, which `hostCommand` starts in a package).
 * They are two builds: in one, esbuild has the entry import every chunk the two
 * programs share, and each would start by reading all of them.
 *
 * Mako's own packages are bundled. Every other package stays a package: a
 * native module, or one only reached with `import()` (`heavy-packages.json`).
 * zod stays a package too: the SDKs these processes load take zod schemas,
 * and two copies of zod in one process don't know each other's.
 *
 * Code that finds files beside itself (a preload, a child's script, a
 * package.json) reads `import.meta.url`. Each bundled module's is rewritten to
 * where that module ships, relative to the bundle, so it still names the same
 * file in a checkout and in app.asar. Mako's packages are named by the path
 * they ship at, `node_modules/@mako/<name>`, which in a checkout is the
 * workspace's link to `packages/<name>`.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
/** Packages bundled; any other stays external. */
const inlined = /^@mako\//

/** Where a resolved file ships, relative to the app's root. */
export function shippedPath(file) {
  const path = relative(root, file).split(sep).join("/")
  const workspace = /^packages\/([^/]+)\/(.*)$/.exec(path)
  return workspace ? `node_modules/@mako/${workspace[1]}/${workspace[2]}` : path
}

function shippedModules(outdir, external) {
  return {
    name: "shipped-modules",
    setup(plugin) {
      plugin.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.kind === "entry-point" || (inlined.test(args.path) && !external.includes(args.path))) return undefined
        return { path: args.path, external: true }
      })
      plugin.onLoad({ filter: /\.(m?js)$/ }, async (args) => {
        const source = await readFile(args.path, "utf8")
        if (!source.includes("import.meta.url")) return { contents: source, loader: "js" }
        const from = relative(outdir, join(root, shippedPath(args.path))).split(sep).join("/")
        return { contents: source.replaceAll("import.meta.url", `new URL(${JSON.stringify(from)}, import.meta.url).href`), loader: "js" }
      })
    },
  }
}

/** The programs bundled: where each starts, where it goes, and the chunk it awaits as it starts. */
export const programs = [
  // Electron's main: the host is another process, started on its own bundle.
  { name: "main", entry: "dist-electron/entry.js", external: ["@mako/host/mako-host"], awaits: "dist-electron/client-main.js" },
  { name: "host", entry: "packages/host/dist/mako-host.js", external: [], awaits: "packages/host/dist/host-main.js" },
]

async function bundle(program) {
  const outdir = join(root, "dist-electron", program.name)
  await rm(outdir, { recursive: true, force: true })
  const result = await build({
    entryPoints: { entry: join(root, program.entry) },
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node24",
    // Electron's main process resolves `electron`; `original-fs` is its unpatched fs.
    external: ["electron", "original-fs"],
    // The root tsconfig maps @mako/* to their sources for tsx and Vite; the bundle takes what ships, each package's dist.
    tsconfig: join(root, "tsconfig.electron.json"),
    chunkNames: "chunk-[hash]",
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
    plugins: [shippedModules(outdir, program.external)],
  })
  return result.metafile
}

/** The files a program reads as it starts: its entry, the chunk it awaits, and what each imports statically. */
function startSet(metafile, awaits) {
  const outputs = metafile.outputs
  const entry = Object.keys(outputs).find((path) => outputs[path].entryPoint)
  const awaited = Object.keys(outputs).find((path) => Object.keys(outputs[path].inputs).some((input) => input.endsWith(awaits)))
  const files = new Set()
  const visit = (path) => {
    if (files.has(path) || !outputs[path]) return
    files.add(path)
    for (const item of outputs[path].imports) if (item.kind === "import-statement") visit(item.path)
  }
  visit(entry)
  if (awaited) visit(awaited)
  return { files: files.size, bytes: [...files].reduce((total, path) => total + outputs[path].bytes, 0) }
}

export async function bundlePrograms() {
  const results = []
  for (const program of programs) {
    const metafile = await bundle(program)
    const outputs = Object.values(metafile.outputs)
    results.push({ name: program.name, modules: Object.keys(metafile.inputs).length, files: outputs.length, bytes: outputs.reduce((total, output) => total + output.bytes, 0), start: startSet(metafile, program.awaits) })
  }
  return results
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mib = (bytes) => (bytes / 2 ** 20).toFixed(2)
  for (const result of await bundlePrograms())
    console.log(`${result.name}: ${result.modules} modules into ${result.files} files, ${mib(result.bytes)} MiB; starts on ${result.start.files} of them, ${mib(result.start.bytes)} MiB`)
}
