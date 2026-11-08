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
 *
 * A busy machine is measured, not guessed at (`@mako/host/base/machine-load`):
 * the comparison waits a while for a quiet window, each run notes how many
 * cores other work kept busy meanwhile, and a row the rounds can't settle on
 * a busy machine is unsure, never slower. The local updater reads that from
 * the verdict file it names (`@mako/host/contracts/performance-verdict`).
 */
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { appendFile, mkdir, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { z } from "zod"
import { busyReasons, describeMachine, readMachine, type MachineReading } from "@mako/host/base/machine-load"
import { PERFORMANCE_VERDICT_VARIABLE, type MeasuredRow, type PerformanceVerdict } from "@mako/host/contracts/performance-verdict"
import { median } from "./performance-measure"

/** How many times each side runs at least: one run is one sample of the machine. */
export const ROUNDS = 3
/**
 * How many more rounds a row the first ones don't settle gets each time. A process is placed on a performance or an
 * efficiency core as a whole, and a memory-heavy row slows there more than the calibration does, so one side's three
 * processes can all draw the slower cores: unchanged code read 30% apart that way.
 */
export const CONFIRM_ROUNDS = 4
/**
 * The rounds a row gets at most before it's called unsure. A quiet CI runner's median alone read unchanged code 29%
 * to 36% slower (between -29% and +52% at 95%), so no machine's median decides a row over its allowance. Fifteen
 * rounds of noise that wide leave one row in a thousand twice as slow with an interval reaching under the allowance
 * (+76%, between +21% and +104%), and CI passes an unsure row, so a row over at its median gets twice that.
 */
export const MAX_ROUNDS = 31
/**
 * How far past its allowance, in multiples of it, a row's median is too large to pass as unsure once its rounds are
 * spent, so long as those rounds put head over reference at all: +50% against CI's 25%. No run of unchanged code has
 * read a median of many rounds past +36%.
 */
const GROSS_ALLOWANCES = 2
/** A row with at least this share of its runs measured busy is read as a busy machine's. */
export const BUSY_RUNS = 0.25
/** How long a comparison waits for a quiet window, all told, before it measures anyway. */
export const QUIET_WAIT_MS = 3 * 60_000
const QUIET_POLL_MS = 10_000
/**
 * How long a comparison measures on a busy machine, all told, before rows it
 * hasn't settled are unsure: three rows took about 5 minutes there, and the
 * updater runs two scripts that compare inside one check.
 */
export const BUSY_MEASURE_MS = 5 * 60_000
/**
 * How much slower than its reference a row may be before it fails: CI's
 * 25% unless the updater names its gross line (`MAKO_PERFORMANCE_ALLOWED`,
 * `local-update-checks.ts`).
 */
export function allowedRegression(env: NodeJS.ProcessEnv = process.env, fallback = 1.25): number {
  const named = Number(env.MAKO_PERFORMANCE_ALLOWED)
  return Number.isFinite(named) && named > 1 ? named : fallback
}
/** Each side of the interval misses the true median at most this often: the sign test's 95%, one-sided. */
const MISS = 0.05

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
  return { root, repository: buildRepository(root, process.env.MAKO_BUILD_SOURCE) }
}

const SourceSchema = z.string().min(1)

/**
 * The Git repository holding `root`'s history. A copy Settings › Updates
 * builds has no `.git`: its source is `MAKO_BUILD_SOURCE` when the updater
 * passes it, else the checkout `source.json` names in the folder above the
 * copy, which every build's updater writes, so an installed app from before
 * `MAKO_BUILD_SOURCE` still finds the history a reference is built from.
 */
export function buildRepository(root: string, named: string | undefined): string {
  if (named) return named
  if (existsSync(join(root, ".git"))) return root
  let recorded: unknown
  try {
    recorded = JSON.parse(readFileSync(join(dirname(root), "source.json"), "utf8"))
  } catch {
    return root
  }
  const source = SourceSchema.safeParse(recorded)
  return source.success && existsSync(join(source.data, ".git")) ? source.data : root
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
  /** Per round, whether the machine was busy during either of its two runs. */
  busy: boolean[]
}

/**
 * How the machine is read; tests pass a machine of their own. A reading
 * is taken with nothing measured running, so what it sees busy is other
 * work's: a measured process's own threads (its compiler, its collector)
 * would otherwise read as load.
 */
export interface Machine {
  read(): Promise<MachineReading>
  /** Waits `ms`; a test's machine waits for nothing. */
  wait(ms: number): Promise<void>
}

/** The window each run's reading covers, just before the run. */
const READING_MS = 1_000

export const thisMachine: Machine = {
  read: () => readMachine(READING_MS),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/**
 * `keys` measured `rounds` times in each tree, in separate processes, the
 * two trees taking turns and swapping who goes first each round so neither
 * always meets the machine as the other left it. The machine is read before
 * each run, each reading going to `read`.
 */
export async function paired(head: string, reference: string, keys: string[], measure: Measurer, rounds = ROUNDS, machine = thisMachine, read: (reading: MachineReading) => void = () => {}): Promise<Paired[]> {
  const results = new Map<string, Paired>(keys.map((key) => [key, { key, reference: [], head: [], busy: [] }]))
  for (let round = 0; round < rounds; round++) {
    const sides = round % 2 === 0 ? (["reference", "head"] as const) : (["head", "reference"] as const)
    let busy = false
    for (const side of sides) {
      const reading = await machine.read()
      read(reading)
      busy ||= busyReasons(reading).length > 0
      const units = await measure(side === "head" ? head : reference, keys)
      for (const key of keys) if (units[key] !== undefined) results.get(key)![side].push(units[key])
    }
    for (const result of results.values()) result.busy.push(busy)
  }
  return [...results.values()]
}

/** One round's runs added to another's, row by row. */
function joined(results: Paired[], more: Paired[]): Paired[] {
  const again = new Map(more.map((result) => [result.key, result]))
  return results.map((result) => {
    const extra = again.get(result.key)
    return extra ? { key: result.key, reference: [...result.reference, ...extra.reference], head: [...result.head, ...extra.head], busy: [...result.busy, ...extra.busy] } : result
  })
}

/**
 * The order statistics bounding the median of `values` from below and above,
 * each missing it at most `MISS` of the time: the sign test's interval, which
 * assumes only that the rounds are independent. None with fewer than five.
 */
export function medianInterval(values: readonly number[]): [number, number] | undefined {
  const sorted = [...values].sort((left, right) => left - right)
  const n = sorted.length
  let trimmed = 0
  let below = 0
  let ways = 1
  for (let count = 0; count < n; count++) {
    below += ways / 2 ** n
    if (below > MISS) break
    trimmed = count + 1
    ways = (ways * (n - count)) / (count + 1)
  }
  return trimmed ? [sorted[trimmed - 1]!, sorted[n - trimmed]!] : undefined
}

export interface Judged {
  /** Undefined while more rounds could still settle it. */
  outcome: MeasuredRow["outcome"] | undefined
  /** The median of each round's head over its reference: the two met much the same machine. */
  change: number
  interval: [number, number] | undefined
  busyShare: number
}

/**
 * Whether a row is within `allowed` of its reference, slower, or can't be
 * told apart from the machine's noise. An interval wholly over the allowance
 * is slower and one wholly under it within, busy or not; past that a quiet
 * machine's median under the allowance is within, on its first rounds only
 * if none of them is over. A row over it at the median alone gets up to `MAX_ROUNDS`, or past `ROUNDS + CONFIRM_ROUNDS`
 * until the time a busy machine gets is spent (`outOfTime`), before it's
 * unsure: slower is every round of seven over it, nine of eleven, twelve of
 * fifteen, up to twenty-one of thirty-one. A row whose rounds are spent is
 * slower too, not unsure, when they put head over reference at 95% and its
 * median is `GROSS_ALLOWANCES` past the allowance: a run that passes on
 * "unsure" mustn't pass a slowdown that large.
 */
export function judge({ reference, head, busy }: Paired, allowed: number, outOfTime = false): Judged {
  const rounds = Math.min(reference.length, head.length)
  const ratios = Array.from({ length: rounds }, (_, round) => head[round]! / reference[round]!)
  const change = median(ratios)
  const interval = medianInterval(ratios)
  const busyShare = busy.length ? busy.filter(Boolean).length / busy.length : 0
  const quiet = busyShare < BUSY_RUNS
  const judged = (outcome: Judged["outcome"]): Judged => ({ outcome, change, interval, busyShare })
  if (interval && interval[0] > allowed) return judged("slower")
  if (interval && interval[1] <= allowed) return judged("within")
  // Three rounds have no interval, and a median of three can lie under the allowance with a round over it.
  if (quiet && change <= allowed && (interval || Math.max(...ratios) <= allowed)) return judged("within")
  // Seven rounds bound the median, so a regression that holds through the noise is caught before time runs out.
  if (rounds < MAX_ROUNDS && !(outOfTime && rounds >= ROUNDS + CONFIRM_ROUNDS)) return judged(undefined)
  return judged(interval && interval[0] > 1 && change - 1 >= GROSS_ALLOWANCES * (allowed - 1) ? "slower" : "unsure")
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
  /** The tree to build a reference commit in; this checkout's history by default. */
  reference?: (commit: string, scratch: string) => Promise<string>
  machine?: Machine
  /** How long to wait for a quiet window, all told; `QUIET_WAIT_MS` by default. */
  quietWaitMs?: number
  /** How long rounds on a busy machine may take, all told; `BUSY_MEASURE_MS` by default. */
  busyMeasureMs?: number
}

export interface Settled {
  /** Rows slower than allowed, and rows over budget that couldn't be measured beside a reference, a line each. */
  failed: string[]
  /** Rows the machine was too busy to settle, a line each. */
  unsure: string[]
  /** Of those, the ones whose rounds were cut short: CI can't call a row not slower on evidence it stopped gathering. */
  cut: string[]
  rows: MeasuredRow[]
  /** The machine while the rows were measured, and why it was busy, if it was. */
  machine: string
  busy: string[]
}

/** Waits, within what's left of the budget, until the machine is quiet; says what it found. */
async function quietWindow(machine: Machine, budget: { leftMs: number }, say: (line: string) => void, read: (reading: MachineReading) => void): Promise<void> {
  let reading = await machine.read()
  read(reading)
  let reasons = busyReasons(reading)
  if (!reasons.length || budget.leftMs <= 0) return
  say(`This machine is busy (${reasons.join(", ")}); waiting up to ${Math.round(budget.leftMs / 1000)} s for a quiet moment before measuring.`)
  let waited = 0
  while (budget.leftMs > 0) {
    const ms = Math.min(QUIET_POLL_MS, budget.leftMs)
    await machine.wait(ms)
    budget.leftMs -= ms
    waited += ms
    reading = await machine.read()
    read(reading)
    reasons = busyReasons(reading)
    if (!reasons.length) {
      say(`Quiet after ${Math.round(waited / 1000)} s (${describeMachine(reading)}); measuring.`)
      return
    }
  }
  say(`Still busy after ${Math.round(waited / 1000)} s (${reasons.join(", ")}); measuring anyway, in up to ${MAX_ROUNDS} rounds, and a row they can't settle is unsure, not slower.`)
}

/** The readings in one: the median of what other work took, and the worst of the rest. */
function summary(readings: readonly MachineReading[]): MachineReading | undefined {
  if (!readings.length) return undefined
  const worst = <T extends string>(order: readonly T[], values: (T | undefined)[]) => order[Math.max(...values.map((value) => (value === undefined ? -1 : order.indexOf(value))))]
  return {
    cores: readings[0]!.cores,
    othersBusy: median(readings.map((reading) => reading.othersBusy)),
    loadAverage: Math.max(...readings.map((reading) => reading.loadAverage)),
    memory: worst(["normal", "warning", "critical"] as const, readings.map((reading) => reading.memory)) ?? "normal",
    thermal: worst(["nominal", "moderate", "heavy", "critical"] as const, readings.map((reading) => reading.thermal)),
  }
}

/**
 * Each suspect measured beside its reference, in turns, each row judged on
 * its rounds (`judge`), with more rounds while they can't settle it; a row
 * over budget whose reference can't be built fails as it is, with the reason.
 */
export async function settle(suspects: Suspect[], settling: Settling): Promise<Settled> {
  const { allowed, rounds, say } = settling
  const machine = settling.machine ?? thisMachine
  const budget = { leftMs: settling.quietWaitMs ?? QUIET_WAIT_MS }
  // CI has the time, and passes an unsure row, so it measures on; only the updater has a window to end inside.
  const busyMeasureMs = settling.busyMeasureMs ?? (process.env[UNSURE_REPORTED_VARIABLE] === "1" ? Infinity : BUSY_MEASURE_MS)
  const busyTime = { leftMs: busyMeasureMs }
  let spent = false
  const here = checkout()
  const scratch = await mkdtemp(join(tmpdir(), "mako-perf-reference-"))
  const references = new References(here, join(scratch, "trees"))
  const build = settling.reference ?? ((commit: string) => references.build(commit))
  const failed: string[] = []
  const unsure: string[] = []
  const cut: string[] = []
  const rows: MeasuredRow[] = []
  const readings: MachineReading[] = []
  const read = (reading: MachineReading) => readings.push(reading)
  const table: string[][] = [["row", "beside", "reference runs", "this checkout's runs", "reference", "this checkout", "change", "between", "busy rounds", "verdict"]]
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
        const tree = await build(at, join(scratch, "trees"))
        const measurer = await settling.measurer(tree, keys, join(scratch, "runs", at))
        await quietWindow(machine, budget, say, read)
        const measured = async (which: string[], count: number) => {
          const started = Date.now()
          const more = await paired(here.root, tree, which, measurer, count, machine, read)
          if (more.some((result) => result.busy.some(Boolean))) busyTime.leftMs -= Date.now() - started
          return more
        }
        results = await measured(keys, rounds)
        for (;;) {
          const outOfTime = busyTime.leftMs <= 0
          const open = results.filter((result) => result.reference.length && result.head.length && judge(result, allowed, outOfTime).outcome === undefined)
          if (outOfTime && !spent && results.some((result) => judge(result, allowed).outcome === undefined && judge(result, allowed, true).outcome === "unsure")) {
            spent = true
            say(`Measured for the ${Math.round(busyMeasureMs / 1000)} s a busy machine gets; rows it hasn't settled are unsure.`)
          }
          if (!open.length) break
          const busy = open.some((result) => judge(result, allowed).busyShare >= BUSY_RUNS)
          say(`${open.map((result) => result.key).join(", ")}: unsettled after ${open[0]!.head.length} rounds${busy ? " on a busy machine" : ""}; ${CONFIRM_ROUNDS} more each.`)
          if (busy) await quietWindow(machine, budget, say, read)
          results = joined(results, await measured(open.map((result) => result.key), CONFIRM_ROUNDS))
        }
      } catch (error) {
        unsettled(group, `it can't be measured beside ${at.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      for (const result of results) {
        const { key, reference, head } = result
        if (!reference.length || !head.length) {
          unsettled(group.filter((suspect) => suspect.key === key), `${reference.length ? "this checkout" : at.slice(0, 8)} has no such row to measure`)
          continue
        }
        const { outcome = "unsure", change, interval, busyShare } = judge(result, allowed, busyTime.leftMs <= 0)
        const runs = (units: number[]) => units.map((value) => value.toFixed(3)).join(" ")
        const between = interval ? `${percent(interval[0] - 1)} to ${percent(interval[1] - 1)}` : "-"
        const busyRounds = `${result.busy.filter(Boolean).length}/${result.busy.length}`
        table.push([key, at.slice(0, 8), runs(reference), runs(head), median(reference).toFixed(3), median(head).toFixed(3), percent(change - 1), between, busyRounds, outcome])
        rows.push({ key, beside: at, outcome, reference: median(reference), head: median(head), change, ...interval && { interval }, rounds: head.length, busyShare })
        const bounds = interval ? `, between ${percent(interval[0] - 1)} and ${percent(interval[1] - 1)}` : ""
        const measured = `${percent(change - 1)} beside ${at.slice(0, 8)} (${median(head).toFixed(3)} against ${median(reference).toFixed(3)}${bounds}, ${head.length} rounds)`
        if (outcome === "slower") failed.push(`${key}: ${measured}: slower`)
        if (outcome === "unsure") unsure.push(`${key}: ${measured}: the machine was too busy to tell, ${busyRounds} rounds busy`)
        if (outcome === "unsure" && head.length < MAX_ROUNDS) cut.push(`${key}: ${measured}: the run was cut before its rounds could settle it`)
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  const overall = summary(readings)
  const busy = overall && unsure.length ? busyReasons(overall) : []
  if (table.length > 1) {
    say(`\nMedians in turns, each row's change the median of its rounds' head over reference, "between" where that lies at 95%; ${overall ? describeMachine(overall) : "the machine wasn't read"}.\n`)
    printTable(table, say)
  }
  return { failed, unsure, cut, rows, machine: overall ? describeMachine(overall) : "", busy }
}

/**
 * What a script makes of `settled`: the lines to fail on. Under the local
 * updater, which names a verdict file (`PERFORMANCE_VERDICT_VARIABLE`), the
 * verdict goes there and an unsure row doesn't fail. In CI
 * (`UNSURE_REPORTED_VARIABLE`) an unsure row is printed and passes once all
 * its rounds are in, and fails if they were cut short: CI fails a row `judge`
 * calls slower, not one a runner's noise moved. Anywhere
 * else a person runs it, so an unsure row fails beside a slower one, to be
 * measured again. `null` names no file even under the updater.
 */
export async function concluded(script: string, settled: Settled, allowed: number, file: string | null = process.env[PERFORMANCE_VERDICT_VARIABLE] ?? null, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  if (file) {
    const verdict: PerformanceVerdict = { script, allowed, rows: settled.rows, machine: settled.machine, busy: settled.busy }
    await appendFile(file, `${JSON.stringify(verdict)}\n`)
    return settled.failed
  }
  if (env[UNSURE_REPORTED_VARIABLE] === "1") return [...settled.failed, ...settled.cut]
  return [...settled.failed, ...settled.unsure.map((line) => `${line}; measure it again on a quieter machine`)]
}

/** Set to `1` where a row the rounds can't settle is reported rather than failed: CI's `performance` job. */
export const UNSURE_REPORTED_VARIABLE = "MAKO_PERFORMANCE_UNSURE_REPORTED"

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
