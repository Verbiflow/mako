import { readFileSync, readdirSync } from "node:fs"
import * as fs from "node:fs"
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module"
import { join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { transformSync } from "esbuild"
import { packageSource, root } from "./lib/host-graph.mjs"

/**
 * Importing a host module does nothing: it only defines things. Every module
 * under packages/host/src is imported from source, and any file, network,
 * process, worker or timer call made while modules evaluate fails the check,
 * naming the line that made it. The modules Mako's packages bring in with
 * them are evaluated, and so held, the same way.
 *
 * A module that starts a process of its own (a worker's or a child's entry)
 * runs when it's loaded by design, and is listed in PROGRAMS with what loads
 * it; it's still type-checked and linted, just not imported here.
 */
const PROGRAMS = new Map([
  ["mako-host.ts", "the mako-host program: the package's executable, and the desktop's entry for its host"],
  ["host-main.ts", "the host process, from mako-host.ts"],
  ["usage-worker.ts", "the usage history reader's worker (usage/reader.ts)"],
  ["threads/catalog-worker.ts", "the catalog's worker (threads/catalog.ts)"],
  ["workspaces/watcher-child-main.ts", "the file watcher's child process (workspaces/watcher-child.ts)"],
  ["terminals/daemon.ts", "the terminal daemon's process (terminals/index.ts)"],
  ["harnesses/opencode/resume-worker.ts", "OpenCode's resume worker (harnesses/opencode/resume.ts)"],
  ["harnesses/opencode/agent-worker.ts", "OpenCode's agent reader (harnesses/opencode/agents.ts)"],
  ["harnesses/codex/question-worker.ts", "Codex's question reader (harnesses/codex/question-reader.ts)"],
  ["harnesses/claude/approval-settings-worker.ts", "Claude's settings worker (harnesses/claude/permission-observer.ts)"],
  ["harnesses/cursor/sdk/child.ts", "the Cursor SDK's child process (harnesses/cursor/sdk/client.ts)"],
])

const source = join(root, "packages/host/src")
const self = fileURLToPath(import.meta.url)
const hostGraph = fileURLToPath(new URL("./lib/host-graph.mjs", import.meta.url))
// ESM stacks use file URLs; source-mapped stacks can use decoded paths.
const loaderFrames = [self, hostGraph, import.meta.url, new URL("./lib/host-graph.mjs", import.meta.url).href]
const modules = (function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return walk(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [relative(source, path)] : []
  })
})(source).sort()
const missing = [...PROGRAMS.keys()].filter((program) => !modules.includes(program))

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@mako/")) return { url: pathToFileURL(packageSource(specifier)).href, shortCircuit: true }
    if (specifier.startsWith(".") && context.parentURL?.includes("/packages/") && !context.parentURL.includes("/node_modules/")) {
      const parent = fileURLToPath(context.parentURL)
      const ts = join(parent, "..", specifier).replace(/\.js$/, ".ts")
      if (specifier.endsWith(".js") && fs.existsSync(ts)) return { url: pathToFileURL(ts).href, shortCircuit: true }
      const tsx = ts.replace(/\.ts$/, ".tsx")
      if (specifier.endsWith(".js") && fs.existsSync(tsx)) return { url: pathToFileURL(tsx).href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (!/\.tsx?$/.test(url)) return next(url, context)
    const file = fileURLToPath(url)
    const { code } = transformSync(readFileSync(file, "utf8"), { loader: file.endsWith(".tsx") ? "tsx" : "ts", format: "esm", sourcefile: file, sourcemap: "inline", target: "node22" })
    return { format: "module", source: code, shortCircuit: true }
  },
})
process.setSourceMapsEnabled(true)

let evaluating = false
/** Calls a trapped call makes inside itself, such as `readFileSync` closing its file, are its own. */
let inside = 0
const violations = new Map()
/**
 * The nearest frame in a module, or nothing when Node's module loader, or
 * this check's own hooks, made the call: reading a file to load it.
 */
function culprit() {
  const frames = (new Error().stack ?? "").split("\n").slice(3).map((line) => line.trim())
  const place = (frame) => frame.replace(/^at (?:.* \()?(.*?)\)?$/, "$1").replace(`file://${root}/`, "").replace(`${root}/`, "")
  const modules = []
  for (const frame of frames) {
    if (frame.includes("node:internal/modules/")) break
    if (loaderFrames.some((file) => frame.includes(file)) || frame.includes("/node_modules/esbuild/")) return undefined
    if (!frame.includes("node:")) modules.push(place(frame))
  }
  if (!modules.length) return undefined
  const [nearest, top] = [modules[0], modules.at(-1)]
  return nearest === top ? nearest : `${nearest}, called at module scope from ${top}`
}
function trap(owner, name, kind) {
  const original = owner[name]
  if (!(original instanceof Function)) return
  const wrapped = function (...args) {
    if (evaluating && !inside) {
      const at = culprit()
      if (at) violations.set(`${at} ${kind}`, `${kind} (${name})`)
    }
    inside++
    try {
      return new.target ? new original(...args) : original.apply(this, args)
    } finally {
      inside--
    }
  }
  Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original))
  owner[name] = wrapped
}
const require = createRequire(import.meta.url)
const builtin = (name) => require(name)
for (const name of Object.keys(fs)) if (/^[a-z]/.test(name) && name !== "promises" && name !== "constants") trap(builtin("node:fs"), name, "file")
for (const name of Object.keys(fs.promises)) if (name !== "constants") trap(builtin("node:fs").promises, name, "file")
for (const name of Object.keys(builtin("node:fs/promises"))) if (name !== "constants") trap(builtin("node:fs/promises"), name, "file")
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) trap(builtin("node:child_process"), name, "process")
for (const name of ["createServer", "createConnection", "connect"]) trap(builtin("node:net"), name, "network")
for (const module of ["node:http", "node:https"]) for (const name of ["request", "get", "createServer"]) trap(builtin(module), name, "network")
trap(builtin("node:dgram"), "createSocket", "network")
trap(globalThis, "fetch", "network")
trap(builtin("node:worker_threads"), "Worker", "worker")
for (const name of ["setTimeout", "setInterval", "setImmediate"]) {
  trap(globalThis, name, "timer")
  trap(builtin("node:timers"), name, "timer")
  trap(builtin("node:timers/promises"), name, "timer")
}
syncBuiltinESMExports()

const failures = []
for (const module of modules) {
  if (PROGRAMS.has(module)) continue
  evaluating = true
  try {
    await import(pathToFileURL(join(source, module)).href)
  } catch (error) {
    failures.push(`${module} failed to import: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    evaluating = false
  }
}

for (const program of missing) failures.push(`${program} is listed as a program but no longer exists; remove it from PROGRAMS`)
for (const [at, what] of violations) failures.push(`${at.slice(0, at.lastIndexOf(" "))} makes a ${what} call while modules load. Do it in a factory or at first use, not at module scope.`)
if (failures.length) {
  for (const failure of failures) console.error(failure)
  process.exit(1)
}
console.log(`host pure import: ${modules.length - PROGRAMS.size} modules import without file, network, process, worker or timer calls (${PROGRAMS.size} programs skipped)`)
process.exit(0)
