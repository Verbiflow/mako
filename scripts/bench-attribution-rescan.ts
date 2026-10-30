import "./lib/scratch-git.mjs"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { Git } from "@mako/git"
import type { TrackerPorts } from "@mako/protocol"
import { FakeEventSource } from "@mako/protocol/attribution-conformance"
import { gitRepository, nodeFileSystem } from "@mako/host/attribution/ports"
import { LaptopTracker } from "@mako/host/attribution/tracker"

/*
 * What the tracker spends finding changes after the watch lost events, on a
 * checkout shaped like Mako's own: a few thousand files Git tracks beside a
 * folder Git ignores holding 150,000 (reference repositories), and
 * `node_modules`. Measures one rescan (time, files stat-ed, the longest the
 * event loop was held), then losses heard every half second for fifteen
 * seconds, as an overloaded fseventsd sends them, and how many rescans they
 * cost; and 2,000 files written into the ignored folder, heard live.
 * `--ignored <n>` and `--tracked <n>` change the shape.
 */

const option = (name: string, fallback: number) => {
  const at = process.argv.indexOf(name)
  return at > 0 ? Number(process.argv[at + 1]) : fallback
}
const TRACKED = option("--tracked", 4_500)
const IGNORED = option("--ignored", 150_000)
const PER_FOLDER = 100

const repo = realpathSync(mkdtempSync(join(tmpdir(), "mako-bench-rescan-")))
const storage = mkdtempSync(join(tmpdir(), "mako-bench-rescan-journal-"))
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const fill = (folder: string, count: number, text: string) => {
  for (let index = 0; index < count; index++) {
    const dir = join(repo, folder, `d${Math.floor(index / PER_FOLDER)}`)
    if (index % PER_FOLDER === 0) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `f${index}.ts`), text)
  }
}

const made = performance.now()
git("init", "-q", "-b", "main")
git("config", "user.email", "bench@example.com")
git("config", "user.name", "Bench")
writeFileSync(join(repo, ".gitignore"), "ignore/\nnode_modules/\n")
fill("src", TRACKED, "export const value = 1\n")
git("add", "-A")
git("commit", "-q", "-m", "base")
fill("ignore", IGNORED, "")
fill("node_modules", 20_000, "")
console.log(`checkout: ${TRACKED} tracked files, ${IGNORED} in an ignored folder, 20000 in node_modules (made in ${Math.round(performance.now() - made)} ms)`)
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// Files written within two seconds of their stat can't be told from a later write and are read again: let them age past that.
await wait(2_500)

const files = nodeFileSystem()
let stats = 0
const events = new FakeEventSource()
const ports: TrackerPorts = {
  fs: { ...files, stat: (path) => (stats++, files.stat(path)) },
  events,
  clock: { now: () => Date.now() },
  storage,
  device: "bench",
}
const rescans: { files: number; ms: number }[] = []
const runner = new Git()
const tracker = await LaptopTracker.open(ports, {
  repository: async (path) => gitRepository(runner, path),
  log: (message, facts) => {
    if (message === "rescan") rescans.push({ files: Number(facts.files), ms: Number(facts.ms) })
  },
})
try {
  await tracker.track({ id: "repo", path: repo, kind: "workspace" })
  await tracker.settled()

  const loop = monitorEventLoopDelay({ resolution: 5 })
  stats = 0
  loop.enable()
  const started = performance.now()
  events.restore()
  await tracker.settled()
  const ms = performance.now() - started
  loop.disable()
  const one = rescans.at(-1)
  console.log(`one rescan: ${Math.round(ms)} ms, ${one?.files ?? 0} files walked, ${stats} stat-ed, event loop held at most ${Math.round(loop.max / 1e6)} ms`)

  // Losses every half second for fifteen seconds, then whatever is left runs.
  const before = rescans.length
  stats = 0
  loop.reset()
  loop.enable()
  const burst = performance.now()
  for (let at = 0; at < 15_000; at += 500) {
    events.restore()
    await wait(500)
  }
  const during = rescans.length - before
  await tracker.settled()
  loop.disable()
  console.log(
    `30 losses over 15 s: ${during} rescans while they came, ${rescans.length - before} in all, ${stats} files stat-ed, ` +
      `${Math.round(performance.now() - burst)} ms, event loop held at most ${Math.round(loop.max / 1e6)} ms`,
  )

  // A clone into the ignored folder, heard file by file as the watch hears it.
  mkdirSync(join(repo, "ignore/clone"))
  stats = 0
  const cloned = performance.now()
  for (let index = 0; index < 2_000; index++) {
    writeFileSync(join(repo, "ignore/clone", `f${index}.ts`), "")
    events.changed(join(repo, "ignore/clone", `f${index}.ts`))
  }
  await tracker.settled()
  console.log(`2000 files written in the ignored folder, heard live: ${stats} stat-ed, ${Math.round(performance.now() - cloned)} ms`)
} finally {
  await tracker.close()
  rmSync(repo, { recursive: true, force: true })
  rmSync(storage, { recursive: true, force: true })
}
process.exit(0)
