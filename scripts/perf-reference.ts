/**
 * A row over its budget measured beside the code its baseline timed, so a
 * loaded machine can't fail it (`perf-decoders.ts`, `test-performance-budgets.ts`).
 * Load doesn't scale every row alike: the calibration workload absorbs some
 * of it, but memory-heavy rows slow more, and under load macOS moves work
 * onto the efficiency cores. The baseline's own commit, built here and
 * measured in turns with this checkout on the same inputs, sees the same
 * machine.
 *
 * The reference is that commit exported with `git archive`, with a
 * `node_modules` of links: `@mako/*` to its own packages, everything else to
 * this checkout's. Its sessions and host packages are built with this
 * checkout's compiler, and its own script measures it.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { availableParallelism, loadavg, tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { z } from "zod"
import { median } from "./performance-measure"

/** How many times each side runs at least: one run is one sample of the machine. */
export const ROUNDS = 3

const SavedRunSchema = z.record(z.string(), z.object({ units: z.number() }))

/** The tree the scripts run from, and the Git repository holding its history. */
export interface Checkout {
  root: string
  /** A copy without `.git`, as a Settings build checks, names its source in `MAKO_BUILD_SOURCE`. */
  repository: string
}

/** This checkout: the tree above `scripts/`. */
export function checkout(): Checkout {
  const root = dirname(import.meta.dirname)
  return { root, repository: process.env.MAKO_BUILD_SOURCE ?? root }
}

export interface Ran {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * A command's exit code and output; what a failure means is the caller's to
 * say. With `output`, its standard output goes to that file: a Node process
 * that exits on an uncaught error drops what it had queued for a pipe on
 * macOS, and a file is written as it prints.
 */
export async function run(command: string, args: string[], cwd?: string, output?: string): Promise<Ran> {
  const file = output === undefined ? undefined : await open(output, "w")
  try {
    const ran = await new Promise<Ran>((resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: ["ignore", file?.fd ?? "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
      child.on("error", reject)
      child.on("close", (code) => resolve({ code, stdout, stderr }))
    })
    return output === undefined ? ran : { ...ran, stdout: await readFile(output, "utf8") }
  } finally {
    await file?.close()
  }
}

/** Each reference built this run, by commit. */
export class References {
  private readonly built = new Map<string, Promise<string>>()

  constructor(private readonly checkout: Checkout, private readonly scratch: string) {}

  /** The folder holding `commit` built, or why it can't be built. */
  build(commit: string): Promise<string> {
    const cached = this.built.get(commit)
    if (cached) return cached
    const building = this.export(commit)
    this.built.set(commit, building)
    return building
  }

  private async export(commit: string): Promise<string> {
    const resolved = await run("git", ["-C", this.checkout.repository, "rev-parse", "--verify", "--quiet", `${commit}^{commit}`])
    const sha = resolved.code === 0 ? resolved.stdout.trim() : ""
    if (!sha) throw new Error(`${commit} isn't a commit in ${this.checkout.repository}`)
    const tree = join(this.scratch, sha.slice(0, 12))
    await mkdir(tree, { recursive: true })
    const archive = spawn("git", ["-C", this.checkout.repository, "archive", "--format=tar", sha], { stdio: ["ignore", "pipe", "pipe"] })
    const extract = spawn("tar", ["-x", "-C", tree], { stdio: ["pipe", "ignore", "pipe"] })
    archive.stdout!.pipe(extract.stdin!)
    await Promise.all([finished(archive, "git archive"), finished(extract, "tar")])
    await linkModules(this.checkout.root, tree)
    // Only its JavaScript runs, and its types were checked when it was committed. Some don't check
    // here (a declaration naming a dependency through these links isn't portable), but every one emits.
    const tsgo = join(this.checkout.root, "node_modules/@typescript/native-preview/bin/tsgo")
    const built = await run(process.execPath, [tsgo, "-b", "--noCheck", "packages/sessions", "packages/host"], tree)
    const missing = await unemitted(join(tree, "packages"))
    if (missing.length) {
      const diagnostics = `${built.stdout}${built.stderr}`.trim().split("\n").slice(0, 10).join("\n")
      throw new Error(`its packages didn't build (${missing.slice(0, 3).join(", ")} has no JavaScript):\n${diagnostics}`)
    }
    return tree
  }
}

/** `@mako/*` linked to the tree's own packages; every other dependency to the checkout's. */
async function linkModules(from: string, tree: string): Promise<void> {
  const modules = join(tree, "node_modules")
  await mkdir(join(modules, "@mako"), { recursive: true })
  for (const name of await readdir(join(from, "node_modules")))
    if (name !== "@mako") await symlink(join(from, "node_modules", name), join(modules, name))
  for (const folder of await readdir(join(tree, "packages"))) {
    const manifest = await readFile(join(tree, "packages", folder, "package.json"), "utf8").catch(() => undefined)
    const name = manifest === undefined ? undefined : z.object({ name: z.string() }).parse(JSON.parse(manifest)).name
    if (name?.startsWith("@mako/")) await symlink(relative(join(modules, "@mako"), join(tree, "packages", folder)), join(modules, name))
  }
}

/** Each built package's sources with no JavaScript beside them in its `dist`. */
async function unemitted(packages: string): Promise<string[]> {
  const missing: string[] = []
  for (const folder of await readdir(packages)) {
    const built = new Set((await readdir(join(packages, folder, "dist"), { recursive: true }).catch(() => [])).filter((path) => path.endsWith(".js")))
    if (!built.size) {
      // The packages the build doesn't reach have nothing to emit; these two it builds by name.
      if (folder === "sessions" || folder === "host") missing.push(join(folder, "dist"))
      continue
    }
    for (const path of await readdir(join(packages, folder, "src"), { recursive: true }).catch(() => []))
      if (/\.tsx?$/.test(path) && !path.endsWith(".d.ts") && !built.has(path.replace(/\.tsx?$/, ".js"))) missing.push(join(folder, "src", path))
  }
  return missing
}

function finished(child: ChildProcess, name: string): Promise<void> {
  let errors = ""
  child.stderr?.on("data", (chunk: Buffer) => (errors += chunk.toString()))
  return new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${name} exited ${code}: ${errors.trim().slice(-2000)}`)))
  })
}

/** Runs a tree's TypeScript script under its own `tsconfig.app.json`, with this checkout's tsx. */
export function script(tree: string, path: string, args: string[], output?: string): Promise<Ran> {
  const tsx = join(checkout().root, "node_modules/tsx/dist/cli.mjs")
  return run(process.execPath, [tsx, "--tsconfig", join(tree, "tsconfig.app.json"), join(tree, path), ...args], tree, output)
}

/** One run of a tree measuring `keys`: each one's calibration units, none for a key the tree has no row for. */
export type Measurer = (tree: string, keys: string[]) => Promise<Record<string, number>>

/**
 * How `perf-decoders.ts` measures `keys` in either tree, with the arguments the
 * reference understands, on the checkout's recordings. A reference whose
 * script takes `--rows` measures them all in one run; an older one measures
 * each harness's family, with whatever rows share it.
 */
export async function decoderRows(reference: string, keys: string[], fixtures: string, scratch: string): Promise<Measurer> {
  const text = await readFile(join(reference, "scripts/perf-decoders.ts"), "utf8")
  const groups = new Map<string, string[]>()
  if (/\brows: \{ type: "string"/.test(text)) groups.set(["--rows", keys.join(",")].join("\0"), keys)
  else for (const key of keys) {
    const [harness, measure] = [key.slice(0, key.indexOf("/")), key.slice(key.indexOf("/") + 1)]
    const family = measure.replace(/ \(.*\)$/, "")
    // The large merges are every harness's; the script measures them only unfiltered by harness.
    const args = harness === "merge" ? ["--measure", family] : ["--only", harness, "--measure", family]
    groups.set(args.join("\0"), [...groups.get(args.join("\0")) ?? [], key])
  }
  await mkdir(scratch, { recursive: true })
  // An empty baseline to compare against leaves each run nothing to fail, and nothing to re-measure.
  const empty = join(scratch, "no-baseline.json")
  await writeFile(empty, "{}\n")
  let runs = 0
  return async (tree) => {
    const units: Record<string, number> = {}
    for (const filter of groups.keys()) {
      const save = join(scratch, `${runs++}.json`)
      const ran = await script(tree, "scripts/perf-decoders.ts", [...filter.split("\0"), "--fixtures", fixtures, "--against", empty, "--json", "--save", save])
      if (ran.code !== 0) throw new Error(`perf-decoders.ts in ${tree} exited ${ran.code}:\n${ran.stderr.trim().split("\n").slice(-20).join("\n")}`)
      for (const [key, row] of Object.entries(SavedRunSchema.parse(JSON.parse(await readFile(save, "utf8"))))) units[key] = row.units
    }
    return units
  }
}

export interface Paired {
  key: string
  /** Each reference run's units, in the order they ran: none if the reference has no such row. */
  reference: number[]
  head: number[]
}

/**
 * `keys` measured `rounds` times in each tree, in separate processes, the
 * two trees taking turns and swapping who goes first each round so neither
 * always meets the machine as the other left it.
 */
export async function paired(head: string, reference: string, keys: string[], measure: Measurer, rounds = ROUNDS): Promise<Paired[]> {
  const results = new Map<string, Paired>(keys.map((key) => [key, { key, reference: [], head: [] }]))
  for (let round = 0; round < rounds; round++) {
    const sides = round % 2 === 0 ? (["reference", "head"] as const) : (["head", "reference"] as const)
    for (const side of sides) {
      const units = await measure(side === "head" ? head : reference, keys)
      for (const key of keys) if (units[key] !== undefined) results.get(key)![side].push(units[key])
    }
  }
  return [...results.values()]
}

/** A row over its budget, or one asked to be measured beside a reference. */
export interface Suspect {
  key: string
  /** The commit to measure beside. */
  at: string | undefined
  /** Why the row is over budget, if it is. */
  over: string | undefined
}

export interface Settling {
  /** How much slower than the reference a row may be, as a multiple. */
  allowed: number
  rounds: number
  /** What every suspect is measured beside, where it's one commit asked for rather than each baseline's own. */
  beside?: string
  /** Where the A/B table goes. */
  say: (line: string) => void
  /** How both trees measure the suspects, given the reference's tree and a folder of its own. */
  measurer: (reference: string, keys: string[], scratch: string) => Promise<Measurer>
}

/**
 * Each suspect measured beside its reference, in turns, and the rows that
 * stay more than `allowed` times as slow there; a row over budget whose reference
 * can't be built fails as it is, with the reason.
 */
export async function settle(suspects: Suspect[], settling: Settling): Promise<string[]> {
  const { allowed, rounds, say } = settling
  const here = checkout()
  const scratch = await mkdtemp(join(tmpdir(), "mako-perf-reference-"))
  const references = new References(here, join(scratch, "trees"))
  const failed: string[] = []
  const table: string[][] = [["row", "beside", "reference runs", "this checkout's runs", "reference", "this checkout", "change"]]
  const loadBefore = loadavg()
  const commits = new Map<string | undefined, Suspect[]>()
  for (const suspect of suspects) commits.set(suspect.at, [...(commits.get(suspect.at) ?? []), suspect])
  const overBudget = suspects.filter((suspect) => suspect.over).length
  const beside = settling.beside ?? `the commit${commits.size === 1 ? "" : "s"} the baseline measured`
  say(overBudget
    ? `\n${overBudget} ${overBudget === 1 ? "row is" : "rows are"} over budget; measuring ${suspects.length === 1 ? "it" : "them"} beside ${beside}, ${rounds} rounds each.`
    : `\nMeasuring ${suspects.length} ${suspects.length === 1 ? "row" : "rows"} beside ${beside}, ${rounds} rounds each.`)
  const unsettled = (group: Suspect[], why: string) => {
    for (const { over } of group) if (over) failed.push(`${over}; ${why}`)
    if (!group.some((suspect) => suspect.over)) say(`${group.map((suspect) => suspect.key).join(", ")}: ${why}`)
  }
  try {
    for (const [at, group] of commits) {
      if (!at) {
        unsettled(group, "its baseline names no commit to measure beside; record it with --update on a committed tree")
        continue
      }
      const keys = group.map((suspect) => suspect.key)
      let results: Paired[]
      try {
        const tree = await references.build(at)
        results = await paired(here.root, tree, keys, await settling.measurer(tree, keys, join(scratch, "runs", at)), rounds)
      } catch (error) {
        unsettled(group, `it can't be measured beside ${at.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      for (const { key, reference, head } of results) {
        if (!reference.length || !head.length) {
          unsettled(group.filter((suspect) => suspect.key === key), `${reference.length ? "this checkout" : at.slice(0, 8)} has no such row to measure`)
          continue
        }
        const change = median(head) / median(reference)
        const runs = (units: number[]) => units.map((value) => value.toFixed(3)).join(" ")
        table.push([key, at.slice(0, 8), runs(reference), runs(head), median(reference).toFixed(3), median(head).toFixed(3), percent(change - 1)])
        if (change > allowed)
          failed.push(`${key}: ${percent(change - 1)} over ${at.slice(0, 8)} measured beside it (${median(head).toFixed(3)} against ${median(reference).toFixed(3)})`)
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  if (table.length > 1) {
    const load = (averages: number[]) => averages.map((value) => value.toFixed(2)).join(" ")
    say(`\nMedians of ${rounds} runs each, in turns; load average ${load(loadBefore)} before, ${load(loadavg())} after, on ${availableParallelism()} cores.\n`)
    printTable(table, say)
  }
  return failed
}

/** HEAD, if the tree holds nothing uncommitted but `baseline` itself: the code a baseline recorded now measured. */
export async function committed(baseline: string): Promise<string | undefined> {
  const { root } = checkout()
  const status = await run("git", ["-C", root, "status", "--porcelain", "--untracked-files=no", "--", ".", `:(exclude)${relative(root, baseline)}`])
  if (status.code !== 0 || status.stdout.trim()) return undefined
  const head = await run("git", ["-C", root, "rev-parse", "HEAD"])
  return head.code === 0 ? head.stdout.trim() : undefined
}

export function percent(change: number): string {
  return `${change >= 0 ? "+" : ""}${(change * 100).toFixed(0)}%`
}

export function printTable(table: string[][], say: (line: string) => void = console.log): void {
  const widths = table[0]!.map((_, column) => Math.max(...table.map((row) => row[column]!.length)))
  for (const [index, row] of table.entries()) {
    say(row.map((cell, column) => column >= 2 ? cell.padStart(widths[column]!) : cell.padEnd(widths[column]!)).join("  "))
    if (index === 0) say(widths.map((width) => "-".repeat(width)).join("  "))
  }
}
