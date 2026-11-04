import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { monitorEventLoopDelay } from "node:perf_hooks"

/*
 * How responsive a process can be on this machine right now, for `bench:host-load` to judge the host against: a
 * process of its own beside the host, under the same contention, running none of Mako's code. It holds a heap as
 * large as the host's (a spawn forks the whole process on Linux, so its cost grows with the heap), starts `git
 * --version` as often as a quiet host starts Git, does a few milliseconds of JavaScript at a time, and times its own
 * event loop the way the prober times the host's: a timer every 20 ms, how late each one ran. On SIGTERM it writes
 * what it measured to `out`.
 */

const [out, heapMb = "300"] = process.argv.slice(2)
// Retained, and touched, so the pages are really there when a spawn forks.
const heap = Array.from({ length: Number(heapMb) }, (_, index) => Buffer.alloc(1024 * 1024, index % 251))
const late = []
const spawns = []
const chunks = []
const delay = monitorEventLoopDelay({ resolution: 10 })
delay.enable()

let due = performance.now() + 20
const tick = () => {
  const now = performance.now()
  late.push(Math.max(0, now - due))
  due = now + 20
  setTimeout(tick, 20)
}
setTimeout(tick, 20)

const work = { rows: Array.from({ length: 2000 }, (_, index) => ({ index, name: `row ${index}`, tags: ["a", "b", "c"] })) }
setInterval(() => {
  const started = performance.now()
  JSON.parse(JSON.stringify(work))
  chunks.push(performance.now() - started)
}, 100)

setInterval(() => {
  const started = performance.now()
  const child = spawn("git", ["--version"], { stdio: "ignore" })
  spawns.push(performance.now() - started)
  child.on("error", () => {})
}, 200)

const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (share) => Math.round((sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0) * 10) / 10
  return { n: sorted.length, p50: at(0.5), p99: at(0.99), max: at(1) }
}

process.on("SIGTERM", () => {
  writeFileSync(out, JSON.stringify({ heapMb: heap.length, late: summary(late), spawn: summary(spawns), chunk: summary(chunks), delayP99: Math.round(delay.percentile(99) / 1e5) / 10 }))
  process.exit(0)
})
