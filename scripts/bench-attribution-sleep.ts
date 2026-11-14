import "./lib/scratch-git.mjs"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { Git } from "@mako/git"
import { FakeClock, FakeEventSource } from "@mako/protocol/attribution-conformance"
import { gitRepository, nodeFileSystem } from "@mako/host/attribution/ports"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { makeSyntheticJournal } from "./lib/synthetic-journal.ts"

/*
 * What quiet roots asleep give back (`node --expose-gc --import tsx scripts/bench-attribution-sleep.ts
 * [--journal <file>] [--roots 8] [--files 7754]`): `--roots` worktree checkouts of `--files` files each, tracked in a
 * clone of a journal the size of the person's, then left quiet past the sleep window. Prints the heap with every root
 * awake, after `sleepIdle`, and after one root wakes, with how long waking took and the longest the loop held then.
 * On 2026-11-12 the person's tracker held 154 roots, mostly finished Threads' worktrees of about 7,750 files.
 */
const { values } = parseArgs({ options: { journal: { type: "string" }, roots: { type: "string", default: "8" }, files: { type: "string", default: "7754" } } })
const ROOTS = Number(values.roots)
const FILES = Number(values.files)
const gc = globalThis.gc
if (!gc) throw new Error("Run with --expose-gc.")
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "mako-bench-sleep-")))
const source = values.journal ?? join(scratch, "made.sqlite")
if (!values.journal) makeSyntheticJournal(source)
const storage = join(scratch, "storage")
mkdirSync(storage)
execFileSync("cp", ["-c", source, join(storage, "journal.sqlite")])

const old = new Date(Date.now() - 60_000)
function checkout(index: number): string {
  const repo = join(scratch, `worktree-${index}`)
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "bench@example.com")
  git("config", "user.name", "Bench")
  for (let file = 0; file < FILES; file++) {
    const folder = join(repo, "packages", `module-${Math.floor(file / 100)}`)
    if (file % 100 === 0) mkdirSync(folder, { recursive: true })
    const path = join(folder, `file-with-a-longer-name-${file}.ts`)
    writeFileSync(path, `export const value${file} = ${file}\n`)
    utimesSync(path, old, old)
  }
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  return repo
}
const repos = Array.from({ length: ROOTS }, (_, index) => checkout(index))

const heapMb = () => {
  gc()
  const usage = process.memoryUsage()
  return (usage.heapUsed + usage.arrayBuffers) / 1024 / 1024
}
const clock = new FakeClock(Date.now())
const events = new FakeEventSource()
const before = heapMb()
const tracker = await LaptopTracker.open({ fs: nodeFileSystem(), events, clock, storage, device: "bench" }, { repository: async (path) => gitRepository(new Git(), path) })
for (const [index, repo] of repos.entries()) await tracker.track({ id: `bench-${index}`, path: repo, kind: "workspace" })
await tracker.settled()
const awake = heapMb() - before
clock.advance(7 * 3_600_000)
const slept = await tracker.sleepIdle()
const asleep = heapMb() - before

let longest = 0
let last = performance.now()
let running = true
const tick = () => {
  const now = performance.now()
  longest = Math.max(longest, now - last)
  last = now
  if (running) setTimeout(tick, 1)
}
setTimeout(tick, 1)
const started = performance.now()
await tracker.track({ id: "bench-0", path: repos[0]!, kind: "workspace" })
await tracker.settled()
const wakeMs = performance.now() - started
running = false
const oneAwake = heapMb() - before
const rows = ROOTS * FILES
console.log(JSON.stringify({
  roots: ROOTS, rows, slept: slept.length,
  awakeMb: Math.round(awake), asleepMb: Math.round(asleep), oneWokenMb: Math.round(oneAwake),
  awakeBytesPerRow: Math.round((awake * 1024 * 1024) / rows), freedPerRootMb: Math.round(((awake - asleep) / ROOTS) * 10) / 10,
  wakeMs: Math.round(wakeMs), wakeLoopHeldMs: Math.round(longest),
}))
await tracker.close()
rmSync(scratch, { recursive: true, force: true })
