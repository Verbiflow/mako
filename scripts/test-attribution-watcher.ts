import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import type { JournalEntry, TrackerPorts } from "@mako/protocol"
import { gitRepository, nodeFileSystem, watcherEvents } from "@mako/host/attribution/ports"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { watchTree } from "@mako/host/workspaces/tree-watcher"
import { childBackend, childHistory } from "@mako/host/workspaces/watch-backend"

/*
 * The tracker on the host's real watcher child and the system's history, on
 * a temporary repository: a change reaches the journal, a commit moves the
 * base, and a tracker opened again catches up on what changed while it was
 * closed from the FSEvents ids alone.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-attribution-watch-")))
const storage = mkdtempSync(join(tmpdir(), "mako-attribution-watch-journal-"))
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
git("init", "-q", "-b", "main")
git("config", "user.email", "test@example.com")
git("config", "user.name", "Test")
writeFileSync(join(root, "a.txt"), "one\n")
git("add", "-A")
git("commit", "-q", "-m", "base")

const runner = new Git()
const backend = childBackend()
const history = process.platform === "darwin" ? childHistory() : undefined
const files = nodeFileSystem()
let walks = 0
/** Times the live watch said it may have missed events (FSEvents dropped some, or went quiet and polling took over): each costs a walk. */
let losses = 0
const ports: TrackerPorts = {
  fs: { ...files, walk: (path, skip) => (walks++, files.walk(path, skip)) },
  events: watcherEvents((path, changed, gone, dropped) => watchTree(runner, backend, path, changed, gone, () => (losses++, dropped())), history),
  clock: { now: () => Date.now() },
  storage,
  device: "watcher-test",
}
const options = { repository: async (path: string) => gitRepository(runner, path) }
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until<T>(what: string, found: () => T | undefined, ms = 30_000): Promise<T> {
  for (const deadline = Date.now() + ms; ; await wait(5)) {
    const value = found()
    if (value !== undefined) return value
    assert.ok(Date.now() < deadline, what)
  }
}

let tracker = await LaptopTracker.open(ports, options)
try {
  await tracker.track({ id: "repo", path: root, kind: "workspace" })
  tracker.activity({ kind: "turn", id: "t1", edge: "start", at: Date.now(), thread: "T1", session: "S1", checkout: root })
  const latencies: number[] = []
  for (let i = 0; i < 20; i++) {
    const written = Date.now()
    writeFileSync(join(root, `file-${i}.txt`), `content ${i}\n`)
    const entry = await until(`file-${i}.txt reaches the journal`, () => tracker.changes(0).find((item: JournalEntry) => item.path === `file-${i}.txt`))
    latencies.push(entry.at - written)
    assert.equal(entry.author.certainty, "window")
  }
  latencies.sort((a, b) => a - b)
  const lags = tracker.recent().map((flush) => flush.lagMs).sort((a, b) => a - b)
  // Timings only: a flush heard near Git's own files waits for the HEAD check by design, and this Mac is shared. bench-attribution holds the 50 ms budget for edits.
  console.log(`write to journal: p50 ${latencies[10]} ms, max ${latencies.at(-1)} ms (FSEvents latency included); heard to journal: p50 ${lags[Math.floor(lags.length / 2)]} ms, max ${lags.at(-1)} ms`)

  // A commit made outside Mako moves the base.
  git("add", "-A")
  git("commit", "-q", "-m", "files")
  const head = git("rev-parse", "HEAD")
  await until("the base moves to the commit", () => (tracker.rootStates().get("repo")?.root.head === head ? true : undefined))
  assert.equal(tracker.rootStates().get("repo")?.files.size, 0, "nothing is uncommitted")
  tracker.activity({ kind: "turn", id: "t1", edge: "end", at: Date.now(), thread: "T1", session: "S1", checkout: root })

  if (history) {
    // Changed while no tracker ran, and opened again at once: the system reports the change after the new watch starts, yet it's caught up from the history.
    await tracker.close()
    writeFileSync(join(root, "a.txt"), "one\nwhile closed\n")
    const [walked, lost] = [walks, losses]
    tracker = await LaptopTracker.open(ports, options)
    await tracker.settled()
    // A busy fseventsd can leave the new watch deaf, and then it rescans after the history is read; the catch-up itself never walks.
    if (losses === lost) assert.equal(walks, walked, "caught up without walking the checkout")
    else console.log("restart: the live watch lost events and rescanned after the history caught up")
    const caught = tracker.changes(0).find((item) => item.path === "a.txt")
    assert.equal(caught?.observed, "history")
    assert.equal(caught?.kind, "modify")
    console.log(`restart: caught up from the FSEvents id${losses === lost ? ", without a walk" : ""}`)
  }
} finally {
  await tracker.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(storage, { recursive: true, force: true })
}
console.log("attribution watcher: ok")
process.exit(0)
