import "./lib/scratch-git.mjs"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { Git } from "@mako/git"
import { FakeEventSource } from "@mako/protocol/attribution-conformance"
import { gitRepository, nodeFileSystem } from "@mako/host/attribution/ports"
import { LaptopTracker } from "@mako/host/attribution/tracker"

/*
 * What a turn's end costs the host while the watch keeps losing events
 * (`npx tsx scripts/bench-attribution-turn-ends.ts`). On 2026-11-12 the
 * person's host lost events in worktrees of 7,754 and 5,300 files every
 * minute or so while Fins ended turns; each end asked the journal to settle,
 * and the shared journal's caller gave up at 15 s about once a minute.
 *
 * Two checkouts of that size, a loss in each every `--loss-ms`, a file
 * written every 200 ms, and a turn ending every `--turn-ms` for `--seconds`.
 * Each mode runs on a fresh tracker in the same process: `full` waits as a
 * turn's end did (`settled()`), `heard` as it does now
 * (`settled({ rescans: false })`). Prints, per mode, how long each turn's end
 * waited, how many waited past 15 s, the rescans run, and the longest the
 * event loop was held.
 */

const option = (name: string, fallback: number) => {
  const at = process.argv.indexOf(name)
  return at > 0 ? Number(process.argv[at + 1]) : fallback
}
const SIZES = [option("--first", 7_754), option("--second", 5_300)]
const LOSS_MS = option("--loss-ms", 1_000)
const TURN_MS = option("--turn-ms", 2_000)
const SECONDS = option("--seconds", 30)
const PATIENCE_MS = 15_000
const PER_FOLDER = 100

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const runner = new Git()

function checkout(files: number): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "mako-bench-turn-ends-")))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init", "-q", "-b", "main")
  git("config", "user.email", "bench@example.com")
  git("config", "user.name", "Bench")
  for (let index = 0; index < files; index++) {
    const dir = join(repo, "src", `d${Math.floor(index / PER_FOLDER)}`)
    if (index % PER_FOLDER === 0) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `f${index}.ts`), `export const value${index} = 1\n`)
  }
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  return repo
}

const percentile = (values: number[], p: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!
}

async function run(mode: "full" | "heard", repos: string[]) {
  const storage = mkdtempSync(join(tmpdir(), "mako-bench-turn-ends-journal-"))
  const events = new FakeEventSource()
  let rescans = 0
  let rescanMs = 0
  const tracker = await LaptopTracker.open(
    { fs: nodeFileSystem(), events, clock: { now: () => Date.now() }, storage, device: "bench" },
    {
      repository: async (path) => gitRepository(runner, path),
      log: (message, facts) => {
        if (message !== "rescan") return
        rescans++
        rescanMs += Number(facts.ms ?? 0)
      },
    },
  )
  for (const [index, repo] of repos.entries()) await tracker.track({ id: `r${index}`, path: repo, kind: "workspace" })
  await tracker.settled()
  // Files written within two seconds of their stat are read again: let the baseline age past that.
  await wait(2_500)
  rescans = 0
  rescanMs = 0
  const delay = monitorEventLoopDelay({ resolution: 5 })
  delay.enable()
  const cpu = process.cpuUsage()
  const waits: number[] = []
  const pending = new Set<Promise<void>>()
  const ends = Date.now() + SECONDS * 1_000
  let written = 0
  const loss = setInterval(() => events.restore(), LOSS_MS)
  const writes = setInterval(() => {
    const repo = repos[written % repos.length]!
    const path = join(repo, "src", "d0", `f${written % PER_FOLDER}.ts`)
    writeFileSync(path, `export const value = ${written++}\n`)
    events.changed(path)
  }, 200)
  const turn = setInterval(() => {
    const started = performance.now()
    const settling = (mode === "full" ? tracker.settled() : tracker.settled({ rescans: false })).then(() => {
      waits.push(performance.now() - started)
    })
    pending.add(settling)
    void settling.finally(() => pending.delete(settling))
  }, TURN_MS)
  await wait(ends - Date.now())
  clearInterval(loss)
  clearInterval(writes)
  clearInterval(turn)
  // A turn's end still waiting is counted at what it has waited so far, as the shared journal's caller sees it.
  const cut = performance.now()
  const outstanding = pending.size
  const settledIn = Promise.all(pending).then(() => performance.now() - cut)
  const left = await Promise.race([settledIn, wait(PATIENCE_MS).then(() => -1)])
  delay.disable()
  const used = process.cpuUsage(cpu)
  await tracker.close()
  rmSync(storage, { recursive: true, force: true })
  return {
    mode,
    turnEnds: waits.length + outstanding,
    waitP50Ms: Math.round(percentile(waits, 0.5)),
    waitMaxMs: Math.round(Math.max(0, ...waits)),
    overPatience: waits.filter((ms) => ms > PATIENCE_MS).length + (left < 0 ? outstanding : 0),
    stillWaitingAtEnd: outstanding,
    rescans,
    rescanMs: Math.round(rescanMs),
    loopHeldMaxMs: Math.round(delay.max / 1e6),
    loopHeldP99Ms: Math.round(delay.percentile(99) / 1e6),
    cpuMs: Math.round((used.user + used.system) / 1_000),
  }
}

const made = performance.now()
const repos = SIZES.map(checkout)
console.log(`checkouts: ${SIZES.join(" and ")} files (made in ${Math.round(performance.now() - made)} ms); a loss each ${LOSS_MS} ms, a turn's end each ${TURN_MS} ms, for ${SECONDS} s`)
const results = []
for (const mode of ["full", "heard"] as const) {
  const result = await run(mode, repos)
  console.log(JSON.stringify(result))
  results.push(result)
}
console.table(results)
for (const repo of repos) rmSync(repo, { recursive: true, force: true })
