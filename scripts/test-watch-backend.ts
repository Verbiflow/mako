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
  const mutes: boolean[] = []
  let dropped = 0
  let gone = 0
  const listener: WatchListener = {
    events: (events: readonly WatchEvent[]) => heard.push(...events.map((event) => event.path)),
    dropped: () => { dropped += 1 },
    gone: () => { gone += 1 },
    muted: (muted) => { mutes.push(muted) },
  }
  return { listener, heard, mutes, dropped: () => dropped, gone: () => gone }
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

  // A child whose own canary goes unheard: every watch is told, the child is
  // restarted once, and the watches hear delivery come back.
  const deaf = join(root, "deaf")
  process.env.MAKO_WATCHER_CANARY_TEST = JSON.stringify({ everyMs: 1200, withinMs: 1000, deafWhile: deaf })
  const canaried = childBackend()
  const c = recorder()
  const quiet = await canaried(kept, [], c.listener)
  const [healthy] = watcherChildren().filter((pid) => pid !== second)
  assert.ok(healthy)
  await wait(3000)
  assert.deepEqual(c.mutes, [], "a canary that's heard says nothing")
  const deafAt = Date.now()
  writeFileSync(deaf, "")
  await until("an unheard canary mutes the watch", () => c.mutes.length === 1, 15_000)
  const detected = Date.now() - deafAt
  assert.equal(c.mutes[0], true)
  await until("and restarts the child once, which re-reads", () => c.dropped() === 1, 15_000)
  const [recycled] = watcherChildren().filter((pid) => pid !== second)
  assert.ok(recycled && recycled !== healthy, "in a new child")
  await wait(5000)
  assert.deepEqual(watcherChildren().filter((pid) => pid !== second), [recycled], "a restart that doesn't help isn't repeated")
  assert.deepEqual(c.mutes, [true])
  rmSync(deaf)
  await until("a canary heard again unmutes it", () => c.mutes.length === 2, 15_000)
  assert.equal(c.mutes[1], false)
  await quiet.unsubscribe()
  delete process.env.MAKO_WATCHER_CANARY_TEST
  console.log(`watch backend canary: silence detected in ${detected} ms at a 1.2 s beat`)

  // Only something else holding this process open lets an unref'd timer fire.
  setTimeout(() => {
    console.error("the watcher child still holds the process open with no watch left")
    process.exit(1)
  }, 5000).unref()
  console.log("watch backend: one child for every watch, ignores applied there, a killed child comes back with dropped events, a vanished root is given up, unsubscribe is final, a missing root is refused, a child that keeps dying is given up, and nothing holds the process open after")
} finally {
  rmSync(root, { recursive: true, force: true })
}
