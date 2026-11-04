import "./lib/scratch-git.mjs"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Git } from "@mako/git"
import type { TrackerFileSystem, TrackerPorts } from "@mako/protocol"
import { gitRepository, nodeFileSystem, watcherEvents, type TreeWatcher } from "@mako/host/attribution/ports"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { childBackend, childHistory } from "@mako/host/workspaces/watch-backend"
import { WatchReadings } from "@mako/host/workspaces/watch-readings"
import { watchTree } from "@mako/host/workspaces/tree-watcher"

/*
 * What Mako's file watching and change tracking cost this machine over a
 * scripted stretch of work, against budgets. The host's own parts, as the
 * host wires them: one watcher child for every checkout, the history child,
 * the tracker over `--repos` scratch checkouts of `--files` files, and a
 * folder of Mako's own that churns all along as its stores do. Each turn
 * edits files in one checkout, commits every third, and reads the history
 * since it started, as a turn's footprint does. Turns run for `--minutes`.
 *
 *   --drops <s>        every checkout hears events dropped this often, as from a degraded fseventsd
 *   --slow-delivery    the watcher's canary is heard 12 s late, as from a degraded fseventsd delivering in batches
 *   --json             the readings as JSON on stdout
 *   --no-budgets       report without failing
 *
 * Measures CPU, peak memory and disk bytes of this process and the watcher
 * children (macOS: proc_pid_rusage; Linux: /proc), files stat-ed and walks,
 * rescans, FSEvents streams, events heard and dropped, watcher restarts,
 * and history reads. Budgets that hold on any machine fail the run.
 */

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(name)
const option = (name: string, fallback: number) => {
  const at = argv.indexOf(name)
  return at >= 0 ? Number(argv[at + 1]) : fallback
}
const repos = option("--repos", 6)
const filesPerRepo = option("--files", 1500)
const minutes = option("--minutes", 3)
const dropsEveryS = option("--drops", 0)
const slowDelivery = flag("--slow-delivery")
const json = flag("--json")
const budgets = !flag("--no-budgets")
const mac = process.platform === "darwin"
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))
const say = (line: string) => (json ? process.stderr : process.stdout).write(`${line}\n`)

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "mako-footprint-bench-")))
const own = join(scratch, "own")
const timers: NodeJS.Timeout[] = []
mkdirSync(own)
// Every beat is heard 12 s late and none is lost, as a degraded fseventsd delivers.
if (slowDelivery) process.env.MAKO_WATCHER_CANARY_TEST = JSON.stringify({ everyMs: 2_000, lagMs: 12_000 })

/** CPU, disk and memory of a process, read without root. */
interface Usage { cpuNs: number; diskWriteBytes: number; diskReadBytes: number; peakBytes: number }
const sampler = mac ? compileSampler() : undefined
function usage(pids: readonly number[]): Map<number, Usage> {
  const found = new Map<number, Usage>()
  if (sampler && pids.length) {
    // SAFETY: the sampler is scripts/rusage-sample.c, which prints exactly these rows.
    const rows = JSON.parse(execFileSync(sampler, pids.map(String), { encoding: "utf8" })) as ({ pid: number; error?: number; cpuNs: number; diskReadBytes: number; diskWriteBytes: number; peakPhysicalFootprintBytes: number })[]
    for (const row of rows) if (row.error === undefined) found.set(row.pid, { cpuNs: row.cpuNs, diskWriteBytes: row.diskWriteBytes, diskReadBytes: row.diskReadBytes, peakBytes: row.peakPhysicalFootprintBytes })
    return found
  }
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")
      const io = Object.fromEntries(readFileSync(`/proc/${pid}/io`, "utf8").trim().split("\n").map((line) => line.split(": ")).map(([key, value]) => [key, Number(value)]))
      const peakKb = Number(/VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0)
      // utime and stime, in clock ticks of 10 ms.
      found.set(pid, { cpuNs: (Number(stat[11]) + Number(stat[12])) * 1e7, diskWriteBytes: io.write_bytes ?? 0, diskReadBytes: io.read_bytes ?? 0, peakBytes: peakKb * 1024 })
    } catch {
      // Gone already: what it used is lost with it.
    }
  }
  return found
}
function compileSampler(): string {
  const binary = join(scratch, "rusage-sample")
  execFileSync("cc", ["-O2", "-o", binary, resolve("scripts/rusage-sample.c")])
  return binary
}

function repository(index: number): string {
  const repo = join(scratch, `repo-${index}`)
  mkdirSync(join(repo, "src"), { recursive: true })
  for (let file = 0; file < filesPerRepo; file++) writeFileSync(join(repo, "src", `f${file}.ts`), `export const f${file} = ${file}\n`)
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=bench@example.com", "-c", "user.name=Bench", ...args], { cwd: repo, stdio: "ignore" })
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  return repo
}

let stats = 0
let walks = 0
const files = nodeFileSystem()
const counted: TrackerFileSystem = {
  ...files,
  stat: (path) => (stats++, files.stat(path)),
  walk: (path, skip) => (walks++, files.walk(path, skip)),
}

let slowestRead: Record<string, string | number | boolean> | undefined
const readings = new WatchReadings((message, fields) => {
  if (message === "slow history read" && Number(fields.ms) > Number(slowestRead?.ms ?? 0)) slowestRead = fields
})
const backend = childBackend(undefined, readings)
const history = mac ? childHistory(undefined, readings) : undefined
const runner = new Git()
let mutes = 0
let losses = 0
const watch: TreeWatcher = (root, changed, gone, dropped) => {
  const lost: typeof dropped = (why) => {
    if (why === "polling") mutes++
    if (why !== "listening" && counting) losses++
    dropped(why)
  }
  const watching = watchTree(runner, backend, root, changed, gone, lost)
  if (watching && dropsEveryS > 0) timers.push(setInterval(() => lost("dropped"), dropsEveryS * 1000))
  return watching
}

const checkouts = Array.from({ length: repos }, (_, index) => repository(index))
// The journal is one of Mako's own stores, as in the host.
const storage = join(own, "journal")
mkdirSync(storage)
const ports: TrackerPorts = { fs: counted, events: watcherEvents(watch, history, () => [own]), clock: { now: () => Date.now() }, storage, device: "bench" }
// Counted from the tracker's own lines, as the host log has them, so a run against an older tracker counts the same.
let counting = false
const rescans = { count: 0, files: 0, ms: 0, every: new Map<string, number>(), at: new Map<string, number[]>() }
let startedAt = Date.now()
const tracker = await LaptopTracker.open(ports, {
  repository: async (path) => gitRepository(runner, path),
  log: (message, facts) => {
    if (message !== "rescan" || !counting) return
    rescans.count++
    rescans.files += Number(facts.files)
    rescans.ms += Number(facts.ms)
    rescans.every.set(String(facts.root), Number(facts.everyMs ?? 0))
    const root = String(facts.root)
    rescans.at.set(root, [...(rescans.at.get(root) ?? []), Math.round((Date.now() - startedAt) / 100) / 10])
  },
})
for (const [index, path] of checkouts.entries()) await tracker.track({ id: `repo-${index}`, path, kind: "workspace" })
await tracker.settled()
const children = () => [readings.reading().child?.pid, readings.reading().historyChild?.pid].filter((pid): pid is number => pid !== undefined)
startedAt = Date.now()
const before = usage([process.pid, ...children()])
const baselineStats = stats
const baselineWalks = walks
counting = true

// Mako's own stores write all along; footprints never need them.
let ownWrites = 0
timers.push(setInterval(() => writeFileSync(join(own, `store-${ownWrites++ % 50}.sqlite-wal`), String(Date.now())), 200))

let turns = 0
let historyPaths = 0
let historyFailed = 0
const childPeaks = new Map<number, Usage>()
const peek = () => {
  for (const [pid, use] of usage(children())) childPeaks.set(pid, use)
}
timers.push(setInterval(peek, 1_000))
for (const endAt = startedAt + minutes * 60_000; Date.now() < endAt; turns++) {
  const repo = checkouts[turns % repos]!
  const thread = `T${turns % 3}`
  const mark = history ? await history.mark().catch(() => undefined) : undefined
  const at = Date.now()
  tracker.activity({ kind: "turn", id: `turn-${turns}`, edge: "start", at, thread, session: `${thread}-session`, checkout: repo, cwd: repo })
  for (let edit = 0; edit < 30; edit++) {
    const file = (turns * 31 + edit * 7) % filesPerRepo
    writeFileSync(join(repo, "src", `f${file}.ts`), `export const f${file} = ${turns}\n`)
    await wait(100)
  }
  if (turns % 3 === 2) execFileSync("git", ["-c", "user.email=bench@example.com", "-c", "user.name=Bench", "commit", "-qam", `turn ${turns}`], { cwd: repo, stdio: "ignore" })
  await wait(2_000)
  tracker.activity({ kind: "turn", id: `turn-${turns}`, edge: "end", at: Date.now(), thread, session: `${thread}-session`, checkout: repo, cwd: repo })
  if (history && !mark) historyFailed++
  if (history && mark) {
    const found = await history.since(mark, [scratch], { ignore: checkouts, exclude: [own] }).catch(() => undefined)
    if (found) historyPaths += found.paths.length
    else historyFailed++
  }
  await wait(3_000)
}
const elapsedMs = Date.now() - startedAt
peek()
const after = usage([process.pid])
for (const timer of timers) clearInterval(timer)
const watching = readings.reading()
// Closing runs the rescans still waiting out their spacing: a cost of stopping, not of the stretch measured.
counting = false
const stated = stats - baselineStats
const walked = walks - baselineWalks
await tracker.close()
const backedOff = [...rescans.every.values()].filter((every) => every >= 60_000).length

const self = { before: before.get(process.pid), after: after.get(process.pid) }
const childCpuNs = [...childPeaks].reduce((sum, [pid, use]) => sum + use.cpuNs - (before.get(pid)?.cpuNs ?? 0), 0)
const childWrites = [...childPeaks].reduce((sum, [pid, use]) => sum + use.diskWriteBytes - (before.get(pid)?.diskWriteBytes ?? 0), 0)
const result = {
  machine: process.platform,
  script: { repos, filesPerRepo, minutes, dropsEveryS, slowDelivery, turns },
  elapsedS: Math.round(elapsedMs / 100) / 10,
  cpu: {
    trackerS: self.after && self.before ? (self.after.cpuNs - self.before.cpuNs) / 1e9 : null,
    watcherChildrenS: childCpuNs / 1e9,
    percentOfOneCore: self.after && self.before ? Math.round(((self.after.cpuNs - self.before.cpuNs + childCpuNs) / 1e6 / elapsedMs) * 1000) / 10 : null,
  },
  peakMemoryMb: Math.round((self.after?.peakBytes ?? 0) / 1024 ** 2),
  diskWritesMb: Math.round((((self.after?.diskWriteBytes ?? 0) - (self.before?.diskWriteBytes ?? 0) + childWrites) / 1024 ** 2) * 10) / 10,
  filesStated: stated,
  statsPerMinute: Math.round((stated / elapsedMs) * 60_000),
  statsOutsideRescansPerMinute: Math.round((Math.max(0, stated - rescans.files) / elapsedMs) * 60_000),
  walks: walked,
  streams: watching.streams,
  watcherStarts: watching.starts,
  mutes,
  eventsHeard: watching.eventsLastHour,
  dropped: watching.droppedLastHour,
  droppedBy: watching.droppedBy,
  rescans: { count: rescans.count, losses, files: rescans.files, ms: rescans.ms, backedOff, atS: Object.fromEntries([...rescans.at.values()].map((at, index) => [`checkout ${index}`, at])) },
  history: { reads: watching.history.readsLastHour, failed: historyFailed, paths: historyPaths, slowestMs: watching.history.slowestMs ?? null, slowest: slowestRead ?? null },
}

/** Rescans the tracker's policy allows a root with losses all along: at once, then after 2 s doubling to 10 min, one root at a time. */
function rescansAllowed(ms: number): number {
  let count = 1
  for (let at = 0, every = 2_000; at + every <= ms; at += every, every = Math.min(every * 2, 600_000)) count++
  return count
}
const STATS_PER_MINUTE = 2_000
const failures: string[] = []
const check = (holds: boolean, what: string) => holds || failures.push(what)
check(watching.streams <= repos + 1, `FSEvents streams: ${watching.streams}, at most one per checkout and the canary's (${repos + 1})`)
check(watching.starts.crash === 0, `watcher child crashed ${watching.starts.crash} times`)
check(!slowDelivery || (watching.starts.silence === 0 && mutes === 0), `late delivery cost ${watching.starts.silence} watcher restarts and ${mutes} polls`)
check(rescans.count <= repos * rescansAllowed(elapsedMs), `rescans: ${rescans.count}, the policy allows ${repos * rescansAllowed(elapsedMs)}`)
check(rescans.ms <= elapsedMs * 0.06, `rescans held the disk ${rescans.ms} ms of ${elapsedMs}: over a twentieth`)
// Outside rescans, which the two checks above bound, only what the turns wrote is stat-ed: a few files per edit, never a checkout's worth.
// A stretch where macOS itself drops events hears several times as many, each stat-ed once.
check(result.dropped > 0 || result.statsOutsideRescansPerMinute <= STATS_PER_MINUTE, `${result.statsOutsideRescansPerMinute} files stat-ed a minute outside rescans with nothing dropped, over ${STATS_PER_MINUTE}`)
check(!history || historyPaths < ownWrites, `history reads returned ${historyPaths} paths; Mako's own folder alone wrote ${ownWrites}`)

if (json) process.stdout.write(`${JSON.stringify({ ...result, failures }, null, 2)}\n`)
else {
  say(`Mako footprint bench on ${process.platform}: ${turns} turns over ${result.elapsedS} s in ${repos} checkouts of ${filesPerRepo} files${dropsEveryS ? `, events dropped every ${dropsEveryS} s` : ""}${slowDelivery ? ", every beat heard 12 s late" : ""}`)
  say(`  CPU: tracker ${result.cpu.trackerS?.toFixed(1)} s, watcher children ${result.cpu.watcherChildrenS.toFixed(1)} s (${result.cpu.percentOfOneCore}% of one core); peak memory ${result.peakMemoryMb} MB; disk writes ${result.diskWritesMb} MB`)
  say(`  files stat-ed ${result.filesStated} (${result.statsPerMinute} a minute, ${result.statsOutsideRescansPerMinute} outside rescans) in ${result.walks} walks; ${watching.streams} FSEvents streams; watcher starts ${JSON.stringify(watching.starts)}; ${mutes} polls`)
  say(`  events heard ${result.eventsHeard}, dropped ${result.dropped} ${JSON.stringify(watching.droppedBy)}; rescans ${rescans.count} after ${losses} losses, ${rescans.files} files in ${rescans.ms} ms, ${backedOff} roots backed off`)
  say(`  rescans at (s): ${Object.entries(result.rescans.atS).map(([root, at]) => `${root} ${at.join(" ")}`).join("; ")}`)
  say(`  history reads ${result.history.reads} (${historyFailed} unanswered), ${historyPaths} paths (Mako's own folder wrote ${ownWrites}), slowest ${result.history.slowestMs ?? "-"} ms${slowestRead ? ` (waiting for the history to catch up ${slowestRead.caughtUpMs} ms, replaying ${slowestRead.readMs} ms, queued ${slowestRead.queuedMs} ms)` : ""}`)
  say(failures.length ? `Over budget:\n  ${failures.join("\n  ")}` : "Within every budget.")
}
rmSync(scratch, { recursive: true, force: true })
if (budgets && failures.length) process.exitCode = 1
