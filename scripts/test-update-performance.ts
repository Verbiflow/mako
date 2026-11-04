/**
 * An update's performance check (`UPDATE_CHECKS.performance` in
 * `local-update-checks.ts`): the two comparisons that measure this code
 * beside the code before it on this Mac, in turns, so a busy Mac reads as
 * unsure and never as slower (`perf-reference.ts`), each at the updater's
 * gross line (`MAKO_PERFORMANCE_ALLOWED`) rather than CI's 25%.
 *
 * `test:performance` was the update's check until it failed three updates
 * in a row: it also runs the performance harness's own unit tests and
 * absolute budgets, one of which broke only under the updater's verdict
 * file, and on a busy Mac it took ten minutes. Those stay in
 * `test:performance` for CI and for anyone working on performance.
 *
 * A comparison none of whose inputs changed since the installed build is
 * skipped: the updater names the files the build differs in
 * (`MAKO_UPDATE_CHANGED`), and a comparison's inputs are every source file
 * its script imports, followed into the workspace packages' sources, plus
 * the fixtures and baselines it reads and the lockfile its reference build
 * installs from. Without that list every comparison runs.
 *
 *   npm run test:update-performance                          as the updater runs it
 *   npx tsx scripts/test-update-performance.ts --inputs       each comparison's inputs, and nothing measured
 */
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { build, type Plugin } from "esbuild"
import { z } from "zod"

const root = dirname(import.meta.dirname)
const CHANGED = "MAKO_UPDATE_CHANGED"

interface Comparison {
  name: string
  script: string
  args: string[]
  /** Files and folders it reads at run time, beyond what it imports. */
  reads: string[]
}

/** The comparisons, run one after the other: two at once would each measure the other. */
export const COMPARISONS: Comparison[] = [
  { name: "perf:decoders", script: "scripts/perf-decoders.ts", args: [], reads: ["scripts/fixtures/native-decoding/", "scripts/perf-decoders-baseline.json"] },
  { name: "performance budgets", script: "scripts/test-performance-budgets.ts", args: [], reads: ["scripts/performance-budgets.json"] },
]
/** What every comparison's reference build is installed and compiled from. */
const SHARED = ["package-lock.json", "package.json", "tsconfig.json", "tsconfig.app.json", "scripts/perf-reference.ts", "scripts/performance-measure.ts"]

const Exports = z.object({ exports: z.record(z.string(), z.string()) })

/** `@mako/<package>/<subpath>` to the source file its export's dist file is compiled from, or null for one without. */
function workspaceSource(specifier: string): string | null {
  const match = /^@mako\/([^/]+)(\/.*)?$/.exec(specifier)
  if (!match) return null
  const folder = join(root, "packages", match[1]!)
  const manifest = join(folder, "package.json")
  if (!existsSync(manifest)) return null
  const exports = Exports.safeParse(JSON.parse(readFileSync(manifest, "utf8")))
  if (!exports.success) return null
  const wanted = `.${match[2] ?? ""}`
  let target: string | undefined = exports.data.exports[wanted]
  if (!target)
    for (const [pattern, value] of Object.entries(exports.data.exports)) {
      if (!pattern.endsWith("/*")) continue
      const prefix = pattern.slice(0, -1)
      if (wanted.startsWith(prefix)) target = value.replace("*", wanted.slice(prefix.length))
    }
  if (!target) return null
  const base = join(folder, target.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ""))
  return [".ts", ".tsx", "/index.ts"].map((extension) => `${base}${extension}`).find(existsSync) ?? null
}

const workspaces: Plugin = {
  name: "workspace-sources",
  setup(builder) {
    builder.onResolve({ filter: /^@mako\// }, (args) => {
      const path = workspaceSource(args.path)
      return path ? { path } : { external: true }
    })
  },
}

/** Every file of this checkout `comparison` imports or reads, relative to it. */
export async function inputs(comparison: Comparison): Promise<string[]> {
  const result = await build({
    entryPoints: [join(root, comparison.script)],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    packages: "external",
    tsconfig: join(root, "tsconfig.app.json"),
    plugins: [workspaces],
    logLevel: "silent",
  })
  const imported = Object.keys(result.metafile.inputs).map((path) => relative(root, join(root, path)))
  return [...new Set([...imported, ...comparison.reads, ...SHARED])].sort()
}

/** Whether any of `changed` is one of `paths`, or inside one ending in `/`. */
export function touches(paths: string[], changed: string[]): string[] {
  return changed.filter((file) => paths.some((path) => path.endsWith("/") ? file.startsWith(path) : file === path))
}

async function changedFiles(): Promise<string[] | null> {
  const file = process.env[CHANGED]
  if (!file) return null
  return (await readFile(file, "utf8")).split("\n").filter(Boolean)
}

function run(comparison: Comparison): Promise<number> {
  return new Promise((resolve, reject) => {
    const tsx = join(root, "node_modules/.bin/tsx")
    const child = spawn(tsx, ["--tsconfig", "tsconfig.app.json", comparison.script, ...comparison.args], { cwd: root, stdio: "inherit", env: process.env })
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const listing = process.argv.includes("--inputs")
  const changed = listing ? null : await changedFiles()
  const failed: string[] = []
  const started = Date.now()
  for (const comparison of COMPARISONS) {
    const read = await inputs(comparison)
    if (listing) {
      console.log(`${comparison.name}: ${read.length} inputs\n${read.map((path) => `  ${path}`).join("\n")}`)
      continue
    }
    if (changed) {
      const hit = touches(read, changed)
      if (!hit.length) {
        console.log(`${comparison.name}: skipped; none of its ${read.length} inputs changed since the installed build`)
        continue
      }
      console.log(`${comparison.name}: ${hit.length} of its inputs changed since the installed build, such as ${hit.slice(0, 3).join(", ")}`)
    }
    const began = Date.now()
    const code = await run(comparison)
    console.log(`${comparison.name}: ${code === 0 ? "passed" : `failed (exit ${code})`} in ${Math.round((Date.now() - began) / 1000)} s`)
    if (code !== 0) failed.push(comparison.name)
  }
  if (!listing) console.log(`Update performance check: ${failed.length ? `${failed.join(" and ")} failed` : "passed"} in ${Math.round((Date.now() - started) / 1000)} s`)
  process.exitCode = failed.length ? 1 : 0
}
