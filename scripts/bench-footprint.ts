import parcel from "@parcel/watcher"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { HOME_NOISE } from "@mako/host/attribution/footprint"
import { childHistory } from "@mako/host/workspaces/watch-backend"

/*
 * What a history read costs on this Mac, read only. Takes one mark of the
 * FSEvents history, lets the machine run for `--wait` seconds, then reads
 * everything since the mark under each `--root <folder>` (repeatable)
 * three ways, interleaved over `--rounds`:
 *   - all:    every path crosses to the host;
 *   - js:     parcel returns every path and the child leaves the ignore folders out, counting them;
 *   - native: parcel leaves the ignore folders out itself, before it stats a path or makes an event of it.
 * Then the host's real history child end to end, with and without the
 * ignore folders. Reports wall time, this process's CPU, fseventsd's CPU and
 * the paths and bytes that would cross to the host. A turn's footprint reads
 * only the folders the turn claimed, so pass one such folder as `--root` for
 * what a turn costs; with none, the roots are the home and temporary
 * folders, which footprints once read whole at every turn. Pass
 * `--ignore <folder>` (repeatable) to add folders, as the checkouts and
 * stores inside a claimed folder would be.
 */

if (process.platform !== "darwin") {
  console.log("The FSEvents history is macOS only.")
  process.exit(0)
}

const argv = process.argv.slice(2)
const option = (name: string, fallback: number) => {
  const at = argv.indexOf(name)
  return at >= 0 ? Number(argv[at + 1]) : fallback
}
const waitS = option("--wait", 60)
const rounds = option("--rounds", 5)
const home = homedir()
const named = (name: string) => argv.flatMap((item, index) => (argv[index - 1] === name ? [item] : []))
const given = named("--root").map((folder) => realpathSync(folder))
const roots = given.length ? given : [home, "/private/tmp"]
const extra = named("--ignore")
const stores = [".claude", ".claude.json", ".codex", ".cursor", ".grok", ".local/share/opencode", ".mako", "Library/Application Support/mako"].map((item) => join(home, item))
const ignore = [...new Set([...HOME_NOISE.map((folder) => join(home, folder)), ...stores, ...extra])].filter((folder) => existsSync(folder))

const fseventsd = Number(execFileSync("pgrep", ["-x", "fseventsd"], { encoding: "utf8" }).trim().split("\n")[0])
/** fseventsd's CPU seconds so far, from `ps` (hundredths of a second). */
const daemonCpu = () => {
  const time = execFileSync("ps", ["-o", "time=", "-p", String(fseventsd)], { encoding: "utf8" }).trim()
  return time.split(":").reduce((total, part) => total * 60 + Number(part), 0)
}

const snapshot = mkdtempSync(join(tmpdir(), "mako-bench-footprint-"))
const file = join(snapshot, "mark")

const innermost = (folders: ReadonlyMap<string, number>, path: string) => {
  for (let end = path.length; end > 0; end = path.lastIndexOf("/", end - 1)) {
    const at = folders.get(end === path.length ? path : path.slice(0, end))
    if (at !== undefined) return at
  }
  return -1
}

const WAYS = ["all", "js", "native"] as const
type Way = (typeof WAYS)[number]
interface Sample {
  way: Way
  ms: number
  cpuMs: number
  daemonMs: number
  paths: number
  ignored: number
  bytes: number
}
/** One read through the host's history child, end to end. */
interface ChildRun {
  ms: number
  paths: number
}

async function read(way: Way): Promise<Sample> {
  const folders = new Map(ignore.map((folder, index) => [folder, index]))
  const counts = ignore.map(() => 0)
  const paths: string[] = []
  const daemon = daemonCpu()
  const cpu = process.cpuUsage()
  const started = performance.now()
  for (const root of roots) {
    const events = await parcel.getEventsSince(root, file, way === "native" ? { backend: "fs-events", ignore } : { backend: "fs-events" })
    for (const event of events) {
      const at = way === "js" ? innermost(folders, event.path) : -1
      if (at < 0) paths.push(event.path)
      else counts[at]! += 1
    }
  }
  const ms = performance.now() - started
  const used = process.cpuUsage(cpu)
  return {
    way,
    ms,
    cpuMs: (used.user + used.system) / 1000,
    daemonMs: (daemonCpu() - daemon) * 1000,
    paths: paths.length,
    ignored: counts.reduce((total, count) => total + count, 0),
    bytes: Buffer.byteLength(JSON.stringify(paths)),
  }
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
const line = (name: string, samples: Sample[]) =>
  `${name.padEnd(22)} ${median(samples.map((item) => item.ms)).toFixed(0).padStart(6)} ms  cpu ${median(samples.map((item) => item.cpuMs)).toFixed(0).padStart(5)} ms  fseventsd ${median(samples.map((item) => item.daemonMs)).toFixed(0).padStart(4)} ms  ${String(samples[0]!.paths).padStart(7)} paths  ${String(samples[0]!.ignored).padStart(7)} left out  ${(samples[0]!.bytes / 1024).toFixed(0).padStart(6)} KB`

try {
  await parcel.writeSnapshot(tmpdir(), file, { backend: "fs-events" })
  const [id = "", at = ""] = readFileSync(file, "utf8").trim().split(/\s+/)
  console.log(`reading ${roots.join(", ")} with ${ignore.length} ignore folders; waiting ${waitS} s for the machine's own churn…`)
  await new Promise((resolve) => setTimeout(resolve, waitS * 1000))
  writeFileSync(file, `${id}\n${at}`)
  const samples: Sample[] = []
  for (let round = 0; round < rounds; round++)
    for (const way of round % 2 ? [...WAYS].reverse() : WAYS) samples.push(await read(way))
  console.log(`after ${waitS} s, median of ${rounds}:`)
  for (const way of WAYS) console.log(line(way, samples.filter((item) => item.way === way)))

  const history = childHistory()
  const mark = { id, at }
  const timed = async (ignored: readonly string[]): Promise<ChildRun> => {
    const started = performance.now()
    const found = await history.since(mark, roots, { ignore: ignored })
    return { ms: performance.now() - started, paths: found.paths.length }
  }
  const all: ChildRun[] = []
  const ruled: ChildRun[] = []
  for (let round = 0; round < rounds; round++) {
    all.push(await timed([]))
    ruled.push(await timed(ignore))
  }
  const summary = (runs: readonly ChildRun[]) => `${median(runs.map((run) => run.ms)).toFixed(0)} ms (${runs.at(-1)?.paths ?? 0} paths)`
  console.log(`history child, end to end: all ${summary(all)}, with ignore folders ${summary(ruled)}`)
} finally {
  rmSync(snapshot, { recursive: true, force: true })
}
process.exit(0)
