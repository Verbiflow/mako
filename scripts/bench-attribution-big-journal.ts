import "./lib/scratch-git.mjs"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { Git } from "@mako/git"
import { FakeEventSource } from "@mako/protocol/attribution-conformance"
import { gitRepository, nodeFileSystem } from "@mako/host/attribution/ports"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { makeSyntheticJournal } from "./lib/synthetic-journal.ts"

/*
 * What the record of changes holds the host's loop for, and the memory it keeps, on a journal the size of the
 * person's (`npx tsx scripts/bench-attribution-big-journal.ts [--journal <file>] [--files 7754]`). A made-up journal of
 * 1.7 GB (`synthetic-journal.ts`), cloned per run so the original stays as made; one checkout of `--files` files
 * tracked in it; then the steps the person's host held its loop on (2026-11-11/12 `held loop profiled`):
 *
 * - `track`: a root of that size taken in (its stat cache read and written).
 * - `gap rescan`: events lost, files written meanwhile, a rescan that finds them: what changed in a gap is attributed
 *   from the journal's activity (`activityBetween`, 2.7 s on the person's host).
 * - `rescan`: events lost with nothing changed (a rescan of every file).
 * - `settled flush`: files written and heard.
 * - `commit`: `--committed` files edited and heard, then committed: the base moves under each, read from the journal.
 *
 * Each step prints its time and the longest the event loop went without turning while it ran (sampled every
 * millisecond); the run ends with the heap and resident memory the tracker holds.
 */
const { values } = parseArgs({
  options: {
    journal: { type: "string" },
    files: { type: "string", default: "7754" },
    changed: { type: "string", default: "40" },
    committed: { type: "string", default: "400" },
    keep: { type: "boolean", default: false },
  },
})
const FILES = Number(values.files)
const CHANGED = Number(values.changed)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "mako-bench-big-journal-")))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const source = values.journal ?? join(scratch, "made", "journal.sqlite")
if (!values.journal || !existsSync(source)) {
  const made = makeSyntheticJournal(source, { log: (line) => console.log(`  made ${line}`) })
  console.log(`journal made: ${Math.round(made.bytes / 1024 / 1024)} MB in ${made.ms} ms`)
}
const storage = join(scratch, "storage")
mkdirSync(storage)
// `LaptopTracker.open` keeps its journal as `journal.sqlite` in its storage: a clone, so every run starts from the same file.
execFileSync("cp", ["-c", source, join(storage, "journal.sqlite")])

const repo = join(scratch, "checkout")
mkdirSync(repo)
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
git("init", "-q", "-b", "main")
git("config", "user.email", "bench@example.com")
git("config", "user.name", "Bench")
const fileAt = (index: number) => join(repo, "src", `d${Math.floor(index / 100)}`, `f${index}.ts`)
for (let index = 0; index < FILES; index++) {
  if (index % 100 === 0) mkdirSync(join(repo, "src", `d${Math.floor(index / 100)}`), { recursive: true })
  writeFileSync(fileAt(index), `export const value${index} = ${index}\n`.repeat(20))
}
git("add", "-A")
git("commit", "-q", "-m", "base")
// Files written within two seconds of their stat are read again: let the checkout age past that.
const old = new Date(Date.now() - 60_000)
for (let index = 0; index < FILES; index++) utimesSync(fileAt(index), old, old)

async function measured<Value>(what: string, work: () => Promise<Value>): Promise<Value> {
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
  await pause(5)
  const started = performance.now()
  const value = await work()
  const ms = performance.now() - started
  await pause(20)
  running = false
  longest = Math.max(longest, performance.now() - last)
  console.log(JSON.stringify({ step: what, ms: Math.round(ms), loopHeldMs: Math.round(longest) }))
  return value
}

const events = new FakeEventSource()
const heapBefore = process.memoryUsage()
const tracker = await measured("open", () =>
  LaptopTracker.open({ fs: nodeFileSystem(), events, clock: { now: () => Date.now() }, storage, device: "bench" }, { repository: async (path) => gitRepository(new Git(), path) }),
)
await measured("track", async () => {
  await tracker.track({ id: "bench", path: repo, kind: "workspace" })
  await tracker.settled()
})
await pause(2_500)
await measured("settled flush", async () => {
  for (let index = 0; index < CHANGED; index++) {
    writeFileSync(fileAt(index * 7), `export const changed${index} = 1\n`)
    events.changed(fileAt(index * 7))
  }
  await tracker.settled()
})
await pause(2_500)
await measured("gap rescan", async () => {
  events.drop()
  for (let index = 0; index < CHANGED; index++) writeFileSync(fileAt(index * 11 + 1), `export const lost${index} = 1\n`)
  events.restore()
  await tracker.settled()
})
await pause(2_500)
await measured("rescan", async () => {
  events.restore()
  await tracker.settled()
})
await pause(2_500)
const COMMITTED = Number(values.committed)
for (let index = 0; index < COMMITTED; index++) {
  writeFileSync(fileAt(index * 13 + 2), `export const edited${index} = ${index}\n`.repeat(30))
  events.changed(fileAt(index * 13 + 2))
}
await tracker.settled()
await pause(2_500)
// Git runs before the step: its own spawns would hold this process's loop, not the tracker's.
git("add", "-A")
git("commit", "-q", "-m", "work")
await measured("commit", async () => {
  events.changed(join(repo, ".git", "HEAD"))
  events.changed(join(repo, ".git", "index"))
  await tracker.settled()
})
global.gc?.()
const heapAfter = process.memoryUsage()
console.log(JSON.stringify({
  heapUsedMb: Math.round((heapAfter.heapUsed - heapBefore.heapUsed) / 1024 / 1024),
  rssMb: Math.round((heapAfter.rss - heapBefore.rss) / 1024 / 1024),
  externalMb: Math.round((heapAfter.external - heapBefore.external) / 1024 / 1024),
}))
await tracker.close()
if (!values.keep) rmSync(scratch, { recursive: true, force: true })
else console.log(`kept: ${scratch}`)
