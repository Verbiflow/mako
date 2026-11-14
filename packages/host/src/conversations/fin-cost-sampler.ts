import { basename } from "node:path"
import type { ProcessRow } from "../usage/index.js"

/** A Fin at work on this device: the conversation whose provider processes are its own, and its harness. */
export interface FinAtWork {
  conversation: string
  harness: string
}

/** A provider process the host started (`ProviderChildren.processes`): `owner` is the conversation it runs for. */
export interface OwnedProcess {
  pid: number
  owner: string
}

/** One Fin's reading, as `FinCostModel.add` takes it: what its processes used since the last reading, by harness. */
export interface FinCostReading {
  harness: string
  /** CPU seconds per second its processes spent over the window. */
  cores: number
  /** Its processes' resident memory now. */
  memoryBytes: number
  /** One of its processes was a build or a test run (`buildProcess`). */
  build?: boolean
}

export interface FinCostSamplerDeps {
  /** Every process on the machine now (`readProcessTable`). */
  table(): Promise<ProcessRow[]>
  owned(): readonly OwnedProcess[]
  now?(): number
}

/** A window shorter than this says more about CPU time read to a tenth of a second (`cpuTime`) than about a Fin. */
const LEAST_WINDOW_MS = 1_000

/**
 * What each Fin at work costs, read from the process table: its provider's processes and everything they started
 * (shells, MCP servers, what the agent ran), their resident memory now and the CPU time they spent since the last
 * reading, per harness, each reading marked when a build or test ran in it. The first reading only sets the window;
 * a Fin whose provider isn't running yet gives none. A process that started and ended between two readings isn't
 * seen, so a build of many short compiler processes reads lower than it ran.
 */
export class FinCostSampler {
  readonly #deps: FinCostSamplerDeps
  #last: { at: number; cpu: Map<number, number> } | undefined

  constructor(deps: FinCostSamplerDeps) {
    this.#deps = deps
  }

  /** Undefined when it measured nothing: its first reading, or a window too short. An empty list means no Fin took anything. */
  async sample(fins: readonly FinAtWork[]): Promise<FinCostReading[] | undefined> {
    const rows = await this.#deps.table()
    const at = this.#deps.now?.() ?? Date.now()
    const last = this.#last
    const elapsed = last ? (at - last.at) / 1000 : 0
    if (last && elapsed < LEAST_WINDOW_MS / 1000) return undefined
    this.#last = { at, cpu: new Map(rows.map((row) => [row.pid, row.cpuSeconds])) }
    if (!last) return undefined
    const byPid = new Map(rows.map((row) => [row.pid, row]))
    const children = new Map<number, ProcessRow[]>()
    // Each list grows in place: copied at every row, launchd's thousand children were half a million copies a sample.
    for (const row of rows) {
      const siblings = children.get(row.ppid)
      if (siblings) siblings.push(row)
      else children.set(row.ppid, [row])
    }
    const roots = new Map<string, number[]>()
    for (const owned of this.#deps.owned()) {
      const pids = roots.get(owned.owner)
      if (pids) pids.push(owned.pid)
      else roots.set(owned.owner, [owned.pid])
    }
    const readings: FinCostReading[] = []
    for (const fin of fins) {
      const tree = subtree((roots.get(fin.conversation) ?? []).flatMap((pid) => byPid.get(pid) ?? []), children)
      if (!tree.length) continue
      let spent = 0
      let memoryBytes = 0
      let build = false
      for (const row of tree) {
        const before = last.cpu.get(row.pid)
        // A process new since the last reading spent all its time in this window.
        spent += Math.max(0, row.cpuSeconds - (before ?? 0))
        memoryBytes += row.rssKb * 1024
        build ||= buildProcess(row.command)
      }
      readings.push({ harness: fin.harness, cores: spent / elapsed, memoryBytes, ...(build && { build: true }) })
    }
    return readings
  }
}

/** `roots` and every process under them, each once. */
function subtree(roots: readonly ProcessRow[], children: ReadonlyMap<number, readonly ProcessRow[]>): ProcessRow[] {
  const seen = new Set<number>()
  const found: ProcessRow[] = []
  const stack = [...roots]
  while (stack.length) {
    const row = stack.pop()!
    if (seen.has(row.pid)) continue
    seen.add(row.pid)
    found.push(row)
    stack.push(...(children.get(row.pid) ?? []))
  }
  return found
}

/** Compilers, linkers and build drivers, by executable. */
const NATIVE_BUILDS = new Set([
  "cargo", "rustc", "cc1", "cc1plus", "clang", "clang++", "gcc", "g++", "ld", "ld64", "swift-frontend", "swiftc", "swift-build",
  "xcodebuild", "make", "ninja", "cmake", "gradle", "gradlew", "mvn", "dotnet", "msbuild", "tsgo", "esbuild", "pytest",
])
/** JavaScript build and test tools, by the script a runtime runs. */
const SCRIPT_BUILDS = new Set(["tsc", "tsgo", "vite", "vitest", "jest", "webpack", "rollup", "esbuild", "next", "turbo", "mocha", "playwright", "eslint", "nx"])
/** What a package manager or toolchain runs that's a build or a test: `npm run build:electron`, `cargo test`, `go build`. */
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "npx", "cargo", "go", "swift", "deno"])
const BUILD_VERBS = /^(build|test|check|lint|typecheck|compile|bench)(\W|$)/
const RUNTIMES = new Set(["node", "bun", "deno", "tsx", "python", "python3"])

/** Whether a process (its `ps` command line) is a build or test run. */
export function buildProcess(command: string): boolean {
  const words = command.trim().split(/\s+/)
  const executable = basename(words[0] ?? "")
  if (NATIVE_BUILDS.has(executable)) return true
  const args = words.slice(1).filter((word) => !word.startsWith("-"))
  if (RUNNERS.has(executable) && args.slice(0, 2).some((word) => BUILD_VERBS.test(word))) return true
  if (!RUNTIMES.has(executable)) return false
  const script = args[0]
  if (!script) return false
  if (executable.startsWith("python") && script === "pytest") return true
  const name = basename(script).replace(/\.(c|m)?js$/, "")
  return SCRIPT_BUILDS.has(name) || (RUNNERS.has(name) && args.slice(1, 3).some((word) => BUILD_VERBS.test(word)))
}
