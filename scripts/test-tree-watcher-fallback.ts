import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { useWatchBackend, watchTree } from "../electron/tree-watcher.ts"
import type { WatchListener } from "../electron/watch-backend.ts"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-watch-fallback-")))

/** A backend that delivers nothing on its own: the test says when it's muted, lost or refused. */
let listener: WatchListener | undefined
let refuse = false
useWatchBackend(async (_root, _ignore, next) => {
  if (refuse) throw new Error("ENOSPC: no inotify watches left")
  listener = next
  return { unsubscribe: async () => {} }
})

function watched(folder: string) {
  const heard: string[] = []
  const counts = { dropped: 0, errors: 0 }
  const watch = watchTree(folder, (paths) => heard.push(...paths), () => { counts.errors += 1 }, () => { counts.dropped += 1 })
  assert.ok(watch)
  return {
    watch,
    heard,
    counts,
    async hears(path: string, what: string) {
      for (const deadline = Date.now() + 8000; !heard.includes(path); await wait(25)) assert.ok(Date.now() < deadline, what)
      heard.length = 0
    },
  }
}

try {
  const muted = join(root, "muted")
  mkdirSync(muted)
  const a = watched(muted)
  await a.watch.ready
  const events = listener
  assert.ok(events)
  events.muted(true)
  assert.equal(a.counts.dropped, 1, "going quiet says anything may have changed")
  await wait(400)
  writeFileSync(join(muted, "while-muted.ts"), "")
  await a.hears("while-muted.ts", "a change made while nothing is delivered is found by polling")
  events.muted(true)
  assert.equal(a.counts.dropped, 1, "a second report changes nothing")
  events.muted(false)
  assert.equal(a.counts.dropped, 2, "delivery back: read everything once more")
  writeFileSync(join(muted, "after.ts"), "")
  await wait(2500)
  assert.equal(a.heard.includes("after.ts"), false, "and polling has stopped")
  assert.equal(a.counts.errors, 0)
  a.watch.close()

  const refused = join(root, "refused")
  mkdirSync(refused)
  refuse = true
  const b = watched(refused)
  await b.watch.ready
  refuse = false
  assert.equal(b.counts.errors, 0, "a watch that can't start on a folder that's there is not an error")
  await wait(400)
  writeFileSync(join(refused, "polled.ts"), "")
  await b.hears("polled.ts", "it polls instead")
  b.watch.close()

  const lost = join(root, "lost")
  mkdirSync(lost)
  const c = watched(lost)
  await c.watch.ready
  const lostEvents = listener
  assert.ok(lostEvents)
  lostEvents.gone()
  lostEvents.muted(false)
  await wait(400)
  writeFileSync(join(lost, "still.ts"), "")
  await c.hears("still.ts", "a watch lost while its folder stays keeps polling, whatever delivery says")
  c.watch.close()

  const deleted = join(root, "deleted")
  mkdirSync(deleted)
  const d = watched(deleted)
  await d.watch.ready
  const deletedEvents = listener
  assert.ok(deletedEvents)
  rmSync(deleted, { recursive: true })
  deletedEvents.gone()
  assert.equal(d.counts.errors, 1, "a folder that went away is an error")
  d.watch.close()

  console.log("tree watcher fallback: muted polls and recovers with one re-read, a refused watch polls, a lost watch keeps polling, a deleted folder is an error")
} finally {
  rmSync(root, { recursive: true, force: true })
}
