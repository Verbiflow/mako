import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Git } from "@mako/git"
import type { TrackerPorts } from "@mako/protocol"
import { FakeClock, FakeEventSource } from "@mako/protocol/attribution-conformance"
import { gitRepository, nodeFileSystem, watcherEvents } from "@mako/host/attribution/ports"
import { partition, type JournalView } from "@mako/host/attribution/queries"
import { threadTrees } from "@mako/host/attribution/thread-tree"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { watchTree } from "@mako/host/workspaces/tree-watcher"
import { childBackend, childHistory } from "@mako/host/workspaces/watch-backend"

/*
 * The attribution budgets, measured on this Mac:
 *   - hashing: SHA-256 through Node against BLAKE3 in JavaScript;
 *   - tracking Mako's own checkout (read only; the journal goes to a
 *     temporary folder): the first baseline, memory, and a restart's
 *     catch-up from the FSEvents id;
 *   - idle CPU on a tracked repository nothing changes;
 *   - a change heard to journaled, on the real watcher, editing a 5,000-line file;
 *   - partition of 100 changed files between two Threads, and its Git tree.
 * Pass `--checkout <path>` to measure another checkout than this one.
 */

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const checkoutAt = process.argv.indexOf("--checkout")
const checkout = realpathSync(checkoutAt > 0 ? process.argv[checkoutAt + 1]! : here)
const runner = new Git()
const backend = childBackend()
const history = process.platform === "darwin" ? childHistory() : undefined
const watch = (path: string, changed: (paths: string[]) => void, gone: () => void, dropped: () => void) => watchTree(runner, backend, path, changed, gone, dropped)
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const temporary: string[] = []
const scratch = (name: string) => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `mako-bench-${name}-`)))
  temporary.push(path)
  return path
}
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const percentile = (values: number[], share: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(share * values.length))]!
const report: string[] = []
const say = (line: string) => {
  report.push(line)
  console.log(line)
}

try {
  // Hashing.
  const buffer = Buffer.alloc(16 * 1024 * 1024, 7)
  let started = performance.now()
  for (let i = 0; i < 8; i++) createHash("sha256").update(buffer).digest()
  const sha = (8 * 16) / ((performance.now() - started) / 1000)
  let blake = "not installed"
  try {
    const { blake3 } = await import("@noble/hashes/blake3.js")
    started = performance.now()
    blake3(buffer)
    blake = `${Math.round(16 / ((performance.now() - started) / 1000))} MB/s`
  } catch {
    // Only the comparison needs it; it's no dependency of Mako.
  }
  say(`hashing: SHA-256 (node:crypto) ${Math.round(sha)} MB/s; BLAKE3 in JavaScript (@noble/hashes) ${blake}`)

  // Mako's own checkout, read only.
  const storage = scratch("journal")
  const ports: TrackerPorts = { fs: nodeFileSystem(), events: watcherEvents(watch, history), clock: { now: () => Date.now() }, storage, device: "bench" }
  const options = { repository: async (path: string) => gitRepository(runner, path) }
  const heapBefore = process.memoryUsage()
  let tracker = await LaptopTracker.open(ports, options)
  started = performance.now()
  await tracker.track({ id: "checkout", path: checkout, kind: "workspace" })
  await tracker.settled()
  const baselineMs = performance.now() - started
  const state = tracker.rootStates().get("checkout")!
  const heapAfter = process.memoryUsage()
  const du = execFileSync("du", ["-sk", checkout], { encoding: "utf8" }).split("\t")[0]
  say(`${checkout} (${mb(Number(du) * 1024)} on disk, ignored files included): first baseline ${Math.round(baselineMs)} ms for ${state.stats.size} tracked files, ${state.files.size} with uncommitted changes; heap +${mb(heapAfter.heapUsed - heapBefore.heapUsed)}, RSS ${mb(heapAfter.rss)}; journal ${mb(tracker.store.blobSize().bytes)} of content`)
  let cpu = process.cpuUsage()
  await wait(10_000)
  let spent = process.cpuUsage(cpu)
  say(`  10 s tracked, other agents editing the checkout meanwhile: ${((spent.user + spent.system) / 1000).toFixed(0)} ms CPU in this process, ${tracker.changes(0).length} entries journaled so far`)
  await tracker.close()
  started = performance.now()
  let walks = 0
  const files = nodeFileSystem()
  tracker = await LaptopTracker.open({ ...ports, fs: { ...files, walk: (path, skip) => (walks++, files.walk(path, skip)) } }, options)
  await tracker.settled()
  say(`  restart: resumed and caught up from the FSEvents id in ${Math.round(performance.now() - started)} ms, ${walks} walks`)
  await tracker.close()

  // Idle CPU on a repository nothing changes.
  const quiet = scratch("quiet")
  execFileSync("git", ["init", "-q"], { cwd: quiet })
  for (let i = 0; i < 200; i++) writeFileSync(join(quiet, `file-${i}.ts`), `export const value${i} = ${i}\n`)
  const quietStorage = scratch("quiet-journal")
  tracker = await LaptopTracker.open({ ...ports, storage: quietStorage }, options)
  await tracker.track({ id: "quiet", path: quiet, kind: "workspace" })
  await tracker.settled()
  await wait(1_000)
  cpu = process.cpuUsage()
  await wait(20_000)
  spent = process.cpuUsage(cpu)
  say(`idle: ${((spent.user + spent.system) / 1000).toFixed(1)} ms CPU in 20 s with a repository tracked and nothing changing (the watcher child's own 10 s canary not included)`)

  // A 5,000-line file edited on the real watcher.
  const big = join(quiet, "big.ts")
  let lines = Array.from({ length: 5000 }, (_, i) => `export const line${i} = "${"x".repeat(40)}"\n`)
  writeFileSync(big, lines.join(""))
  await wait(500)
  await tracker.settled()
  const before = tracker.recent().length
  tracker.activity({ kind: "turn", id: "t1", edge: "start", at: Date.now(), thread: "T1", session: "S1", checkout: quiet })
  for (let i = 0; i < 100; i++) {
    lines = lines.map((line, at) => (at === (i * 47) % 5000 ? `export const changed${i} = ${i}\n` : line))
    writeFileSync(big, lines.join(""))
    await wait(60)
  }
  await wait(1_000)
  await tracker.settled()
  const flushes = tracker.recent().slice(before)
  const lags = flushes.map((flush) => flush.lagMs)
  const work = flushes.map((flush) => flush.statMs + flush.hashMs + flush.diffMs + flush.writeMs)
  say(`5,000-line file, 100 edits on the real watcher: heard to journaled p50 ${percentile(lags, 0.5)} ms, p95 ${percentile(lags, 0.95)} ms, max ${Math.max(...lags)} ms; stat+hash+line map+write per flush p50 ${percentile(work, 0.5).toFixed(2)} ms, max ${Math.max(...work).toFixed(2)} ms`)
  assert.ok(Math.max(...lags) <= 50, "every change journaled within 50 ms of the watcher's report")
  await tracker.close()

  // Partition of 100 changed files between two Threads, on scripted events.
  const repo = scratch("partition")
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
  git("init", "-q", "-b", "main")
  git("config", "user.email", "bench@example.com")
  git("config", "user.name", "Bench")
  const text = (file: number, edits: Record<number, string> = {}) => Array.from({ length: 300 }, (_, i) => `${edits[i] ?? `file ${file} line ${i} ${"y".repeat(30)}`}\n`).join("")
  for (let file = 0; file < 100; file++) writeFileSync(join(repo, `f${file}.ts`), text(file))
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  const clock = new FakeClock(Date.now())
  const events = new FakeEventSource()
  tracker = await LaptopTracker.open({ fs: nodeFileSystem(), events, clock, storage: scratch("partition-journal"), device: "bench" }, options)
  await tracker.track({ id: "repo", path: repo, kind: "workspace" })
  const write = (file: number, content: string) => {
    const path = join(repo, `f${file}.ts`)
    writeFileSync(path, content)
    utimesSync(path, clock.now() / 1000, clock.now() / 1000)
    events.changed(path)
  }
  /** One call that wrote a whole file and said so. */
  const call = async (thread: string, id: string, file: number, content: string) => {
    tracker.activity({ kind: "call", id, edge: "start", at: clock.now(), thread, session: thread, checkout: repo })
    write(file, content)
    tracker.reported({ thread, session: thread, call: id, status: "completed", endedAt: clock.now(), effects: [{ kind: "write", path: join(repo, `f${file}.ts`), content }] })
    tracker.activity({ kind: "call", id, edge: "end", at: clock.now(), thread, session: thread, checkout: repo })
    await tracker.settled()
  }
  for (let file = 0; file < 100; file++) {
    // T1 edits lines 10 and 200, T2 edits line 11: one hunk shared, one each.
    clock.advance(10_000)
    await call("T1", `a${file}`, file, text(file, { 10: "T1 was here", 200: "T1 again" }))
    clock.advance(10_000)
    await call("T2", `b${file}`, file, text(file, { 10: "T1 was here", 11: "T2 was here", 200: "T1 again" }))
  }
  clock.advance(20_000)
  tracker.sweep()
  const view: JournalView = { store: tracker.store, roots: () => tracker.rootStates().values(), author: (seq) => tracker.authorOf(seq) }
  const times: number[] = []
  let result = partition(view, repo, "T1")
  for (let i = 0; i < 10; i++) {
    result = partition(view, repo, "T1")
    times.push(result.ms)
  }
  assert.equal(result.files.length, 100)
  assert.equal(result.files[0]!.thread.kind === "text" && result.files[0]!.thread.text, text(0, { 10: "T1 was here", 200: "T1 again" }))
  started = performance.now()
  const [tree] = await threadTrees(runner, view, result)
  const treeMs = performance.now() - started
  assert.equal(git("show", `${tree!.tree}:f7.ts`) + "\n", text(7, { 10: "T1 was here", 200: "T1 again" }))
  say(`partition of 100 changed files (two Threads, one shared hunk each): p50 ${percentile(times, 0.5).toFixed(1)} ms, max ${Math.max(...times).toFixed(1)} ms; the Thread's side as a Git tree ${Math.round(treeMs)} ms`)
  await tracker.close()
  say(`5,000-line blame per change: see test-attribution-lines (diff and line map p50 under 1 ms)`)
} finally {
  for (const path of temporary) rmSync(path, { recursive: true, force: true })
}
process.exit(0)
