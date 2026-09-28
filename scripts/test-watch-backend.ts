import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WatchEvent } from "../electron/contracts/watcher-child.ts"
import { childBackend, type WatchListener } from "../electron/watch-backend.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-watch-backend-")))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, done: () => boolean, ms = 90_000): Promise<void> {
  for (const deadline = Date.now() + ms; !done(); await wait(25)) assert.ok(Date.now() < deadline, what)
}

function recorder() {
  const heard: string[] = []
  let dropped = 0
  let gone = 0
  const listener: WatchListener = {
    events: (events: readonly WatchEvent[]) => heard.push(...events.map((event) => event.path)),
    dropped: () => { dropped += 1 },
    gone: () => { gone += 1 },
  }
  return { listener, heard, dropped: () => dropped, gone: () => gone }
}

/** Children of this process running the watcher, by pid. */
function watcherChildren(): number[] {
  try {
    return execFileSync("pgrep", ["-P", String(process.pid), "-f", "watcher-child-main"], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number)
  } catch {
    return []
  }
}

// FSEvents can deliver seconds late on a busy Mac, but in order: a marker
// written after a change arriving means the change has arrived too.
let markers = 0
async function drained(folder: string, heard: string[]): Promise<void> {
  const marker = join(folder, `marker-${++markers}`)
  writeFileSync(marker, "")
  await until(`file events arrive (${marker})`, () => heard.includes(marker))
}

try {
  const kept = join(root, "kept")
  const removed = join(root, "removed")
  mkdirSync(kept)
  mkdirSync(removed)
  const backend = childBackend()
  const a = recorder()
  const b = recorder()
  const subscription = await backend(kept, ["**/node_modules/**"], a.listener)
  await backend(removed, [], b.listener)
  assert.equal(watcherChildren().length, 1, "every watch shares one child")
  await drained(kept, a.heard)
  mkdirSync(join(kept, "node_modules", "pkg"), { recursive: true })
  writeFileSync(join(kept, "node_modules", "pkg", "index.js"), "")
  writeFileSync(join(kept, "index.ts"), "")
  await drained(kept, a.heard)
  assert.ok(a.heard.includes(join(kept, "index.ts")))
  assert.equal(a.heard.some((path) => path.includes("node_modules/pkg/")), false, "ignored folders stay in the child")

  // A crash in the watcher costs a restart, not the host.
  const [first] = watcherChildren()
  assert.ok(first)
  rmSync(removed, { recursive: true })
  process.kill(first, "SIGKILL")
  await until("the watch comes back after a crash and says events may be missed", () => a.dropped() === 1, 15_000)
  await until("a root gone meanwhile is given up", () => b.gone() === 1, 15_000)
  const [second] = watcherChildren()
  assert.ok(second && second !== first, "in a new child")
  await drained(kept, a.heard)

  await subscription.unsubscribe()
  const after = a.heard.length
  writeFileSync(join(kept, "late.ts"), "")
  await wait(1500)
  assert.equal(a.heard.length, after, "nothing arrives after unsubscribing")

  await assert.rejects(backend(join(root, "missing"), [], recorder().listener), "a root that doesn't exist is refused")

  // A child that dies every time is given up after five tries.
  const dying = join(root, "dying.mjs")
  writeFileSync(dying, "process.on('message', () => process.exit(1))\n")
  const started = Date.now()
  await assert.rejects(childBackend(dying)(kept, [], recorder().listener), /keeps stopping/)
  assert.ok(Date.now() - started < 10_000, "within the backoff, not forever")

  // Only something else holding this process open lets an unref'd timer fire.
  setTimeout(() => {
    console.error("the watcher child still holds the process open with no watch left")
    process.exit(1)
  }, 5000).unref()
  console.log("watch backend: one child for every watch, ignores applied there, a killed child comes back with dropped events, a vanished root is given up, unsubscribe is final, a missing root is refused, a child that keeps dying is given up, and nothing holds the process open after")
} finally {
  rmSync(root, { recursive: true, force: true })
}
