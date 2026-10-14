import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { WatchEvent } from "@mako/host/contracts/watcher-child"
import { childBackend } from "@mako/host/workspaces/watch-backend"

/*
 * The host's watcher child on this Mac, through the host's own
 * `childBackend`: a change written to heard, one at a time and in a burst,
 * and the child's CPU and memory idle and under the burst. Pass
 * `--child <script>` to measure another build of the child (an older
 * commit's copy, say) against this one.
 *
 *   npx tsx scripts/bench-watcher.ts [--child <script>] [--writes 200] [--burst 5000] [--idle 30]
 */

const argv = process.argv.slice(2)
const option = (name: string) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}
const child = option("--child")
const writes = Number(option("--writes") ?? 200)
const burst = Number(option("--burst") ?? 5000)
const idleS = Number(option("--idle") ?? 30)

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-bench-watcher-")))
const heard = new Map<string, number>()
let waiting: { path: string; done(): void } | undefined
const listener = {
  events(events: readonly WatchEvent[]) {
    const at = performance.now()
    for (const event of events) {
      if (!heard.has(event.path)) heard.set(event.path, at)
      if (waiting?.path === event.path) waiting.done()
    }
  },
  dropped: () => console.log("dropped"),
  gone: () => console.log("gone"),
  muted: (muted: boolean) => console.log(muted ? "muted" : "heard again"),
}

/** The child's CPU seconds and resident memory, from `ps`. */
function usage(pid: number) {
  const [rss = "0", time = "0"] = execFileSync("ps", ["-o", "rss=,time=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/)
  return { cpuS: time.split(":").reduce((total, part) => total * 60 + Number(part), 0), rssMb: Number(rss) / 1024 }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const percentile = (values: readonly number[], at: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * at))] ?? Number.NaN

try {
  const subscription = await childBackend(child && resolve(child))(root, [], listener)
  const pid = Number(execFileSync("pgrep", ["-P", String(process.pid), "-f", "watcher-child-main"], { encoding: "utf8" }).trim().split("\n")[0])
  await sleep(1_000)

  const idleFrom = usage(pid)
  await sleep(idleS * 1000)
  const idleTo = usage(pid)

  const latencies: number[] = []
  let missed = 0
  for (let index = 0; index < writes; index++) {
    const path = join(root, `one-${index}`)
    const arrived = new Promise<void>((done) => (waiting = { path, done }))
    const sent = performance.now()
    writeFileSync(path, String(index))
    await Promise.race([arrived, sleep(2_000)])
    const at = heard.get(path)
    if (at === undefined) missed += 1
    else latencies.push(at - sent)
    await sleep(20)
  }
  waiting = undefined

  const burstFrom = usage(pid)
  const started = performance.now()
  for (let index = 0; index < burst; index++) writeFileSync(join(root, `burst-${index}`), "x")
  const writtenMs = performance.now() - started
  const deadline = Date.now() + 30_000
  const burstHeard = () => [...heard.keys()].filter((path) => path.includes("/burst-")).length
  while (burstHeard() < burst && Date.now() < deadline) await sleep(10)
  const lastHeard = Math.max(...[...heard].filter(([path]) => path.includes("/burst-")).map(([, at]) => at))
  await sleep(500)
  const burstTo = usage(pid)

  console.log(`child ${child ?? "(this checkout's)"}, pid ${pid}`)
  console.log(`idle ${idleS} s: cpu ${((idleTo.cpuS - idleFrom.cpuS) * 1000).toFixed(0)} ms, rss ${idleTo.rssMb.toFixed(1)} MB`)
  console.log(`one write heard: p50 ${percentile(latencies, 0.5).toFixed(1)} ms, p95 ${percentile(latencies, 0.95).toFixed(1)} ms, max ${Math.max(...latencies).toFixed(1)} ms over ${writes}, ${missed} unheard within 2 s`)
  console.log(`burst of ${burst}: written in ${writtenMs.toFixed(0)} ms, ${burstHeard()} heard, last ${(lastHeard - started).toFixed(0)} ms after the first write; child cpu ${((burstTo.cpuS - burstFrom.cpuS) * 1000).toFixed(0)} ms, rss ${burstTo.rssMb.toFixed(1)} MB`)
  await subscription.unsubscribe()
} finally {
  rmSync(root, { recursive: true, force: true })
}
process.exit(0)
