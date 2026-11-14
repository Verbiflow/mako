import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WatchEvent } from "@mako/host/contracts/watcher-child"
import { childBackend, childHistory, probeDelivery, type FileHistory, type WatchListener } from "@mako/host/workspaces/watch-backend"
import { WatchReadings } from "@mako/host/workspaces/watch-readings"
import { FileEventsServiceWatch } from "@mako/host/workspaces/file-events-service"
import { ranOut } from "./lib/ran-out.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-watch-backend-")))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, done: () => boolean, ms = 90_000): Promise<void> {
  for (const deadline = Date.now() + ms; !done(); await wait(25)) assert.ok(Date.now() < deadline, what)
}

function recorder() {
  const heard: string[] = []
  const mutes: boolean[] = []
  const lates: boolean[] = []
  let dropped = 0
  let gone = 0
  const listener: WatchListener = {
    events: (events: readonly WatchEvent[]) => heard.push(...events.map((event) => event.path)),
    dropped: () => { dropped += 1 },
    gone: () => { gone += 1 },
    muted: (muted) => { mutes.push(muted) },
    late: (late) => { lates.push(late) },
  }
  return { listener, heard, mutes, lates, dropped: () => dropped, gone: () => gone }
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
// written after a change arriving means the change has arrived too. A watch
// that says `dropped` meanwhile (its child restarted, as a silence on a loaded
// runner restarts it) has said what came before may be lost, which its
// consumers answer with a rescan: a fresh marker is then the barrier. A watch
// that goes quiet without saying so still fails, with what it did say.
let markers = 0
/** What a watch said while a drain waited, for a failure to name. */
const whatItSaid = (watch: ReturnType<typeof recorder>) =>
  `${watch.dropped()} dropped, muted ${JSON.stringify(watch.mutes)}, late ${JSON.stringify(watch.lates)}, watcher children ${JSON.stringify(watcherChildren())}`
/** Resolves once the watch is drained, saying whether it dropped events meanwhile: then what was written before may be lost. */
async function drained(folder: string, watch: ReturnType<typeof recorder>): Promise<boolean> {
  const deadline = Date.now() + 90_000
  const before = watch.dropped()
  let drops = before
  let marker = join(folder, `marker-${++markers}`)
  writeFileSync(marker, "")
  while (!watch.heard.includes(marker)) {
    assert.ok(Date.now() < deadline, `file events arrive (${marker}); the watch said ${whatItSaid(watch)}`)
    if (watch.dropped() > drops) {
      drops = watch.dropped()
      marker = join(folder, `marker-${++markers}`)
      writeFileSync(marker, "")
    }
    await wait(25)
  }
  return watch.dropped() > before
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
  await drained(kept, a)
  // A drop during the drain may have taken these writes with it, as a consumer's rescan would find: they're made
  // again, and drained again, until a drain passes without one.
  // Three drains at most: a watch that drops every time is broken, and says so here rather than at the step's limit.
  for (let attempt = 1, lost = true; lost; attempt += 1) {
    assert.ok(attempt <= 3, `file events arrive (index.ts): each of 3 drains saw a drop; the watch said ${whatItSaid(a)}`)
    mkdirSync(join(kept, "node_modules", "pkg"), { recursive: true })
    writeFileSync(join(kept, "node_modules", "pkg", "index.js"), "")
    writeFileSync(join(kept, "index.ts"), "")
    lost = await drained(kept, a)
  }
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
  await drained(kept, a)

  await subscription.unsubscribe()
  const after = a.heard.length
  writeFileSync(join(kept, "late.ts"), "")
  await wait(1500)
  assert.equal(a.heard.length, after, "nothing arrives after unsubscribing")

  await assert.rejects(backend(join(root, "missing"), [], recorder().listener), "a root that doesn't exist is refused")

  // A child that dies every time is given up after five tries.
  const dying = join(root, "dying.mjs")
  writeFileSync(dying, "process.on('message', () => process.exit(1))\n")
  // Within the backoff, by the waits it took rather than the runner's clock: each restart twice the last, then given up.
  const { waits } = await ranOut(() => assert.rejects(childBackend(dying)(kept, [], recorder().listener), /keeps stopping/))
  assert.deepEqual(waits.filter((ms) => ms >= 250), [250, 500, 1_000, 2_000], "within the backoff, not forever")

  // Late isn't silent: a canary heard 8 s late, as a degraded fseventsd
  // delivers, mutes nothing and restarts nothing, and its lag is read and
  // logged. The watch is told it's late.
  const deaf = join(root, "deaf")
  process.env.MAKO_WATCHER_CANARY_TEST = JSON.stringify({ everyMs: 1200, deafWhile: deaf })
  const lines: string[] = []
  const lateReadings = new WatchReadings((message) => lines.push(message))
  const late = recorder()
  const lateWatch = await childBackend(undefined, lateReadings)(kept, [], late.listener)
  await wait(3000)
  writeFileSync(deaf, "")
  await wait(8000)
  rmSync(deaf)
  await until("the late canary's lag is read", () => (lateReadings.reading().delivery.lagMs ?? 0) >= 6000, 15_000)
  await wait(2000)
  assert.deepEqual(late.mutes, [], "a canary heard late doesn't mute the watch")
  assert.equal(late.dropped(), 0, "or restart the child")
  assert.deepEqual(lateReadings.reading().starts, { first: 1, crash: 0, silence: 0, recovery: 0 })
  assert.ok(lines.includes("file events arrive late"), lines.join(", "))
  assert.equal(late.lates[0], true, "the watch hears it's late")
  const earlier = [second, lateReadings.reading().child?.pid]
  await lateWatch.unsubscribe()

  // A child whose own canary goes unheard: every watch is told, the child is
  // restarted once, and the watches hear delivery come back. The window is
  // longer than a degraded fseventsd was seen taking to deliver at all, 15 s.
  process.env.MAKO_WATCHER_CANARY_TEST = JSON.stringify({ everyMs: 1200, withinMs: 20_000, deafWhile: deaf })
  const readings = new WatchReadings()
  const canaried = childBackend(undefined, readings)
  const c = recorder()
  const quiet = await canaried(kept, [], c.listener)
  const [healthy] = watcherChildren().filter((pid) => !earlier.includes(pid))
  assert.ok(healthy)
  await wait(3000)
  assert.deepEqual(c.mutes, [], "a canary that's heard says nothing")
  const deafAt = Date.now()
  writeFileSync(deaf, "")
  await until("an unheard canary mutes the watch", () => c.mutes.length === 1, 60_000)
  const detected = Date.now() - deafAt
  assert.equal(c.mutes[0], true)
  await until("and restarts the child once, which re-reads", () => c.dropped() === 1, 60_000)
  const [recycled] = watcherChildren().filter((pid) => !earlier.includes(pid))
  assert.ok(recycled && recycled !== healthy, "in a new child")
  await wait(5000)
  assert.deepEqual(watcherChildren().filter((pid) => !earlier.includes(pid)), [recycled], "a restart that doesn't help isn't repeated")
  assert.deepEqual(c.mutes, [true])
  rmSync(deaf)
  await until("a canary heard again unmutes it", () => c.mutes.length === 2, 60_000)
  assert.equal(c.mutes[1], false)
  // A silence soon after is fseventsd's, not a stuck child: no second restart.
  writeFileSync(deaf, "")
  await until("a second silence mutes the watch again", () => c.mutes.length === 3, 60_000)
  await wait(3000)
  assert.equal(c.dropped(), 1, "without restarting the child again")
  assert.deepEqual(watcherChildren().filter((pid) => !earlier.includes(pid)), [recycled])
  assert.deepEqual(readings.reading().starts, { first: 1, crash: 0, silence: 1, recovery: 0 })
  rmSync(deaf)
  await until("and unmutes once heard", () => c.mutes.length === 4, 60_000)
  await quiet.unsubscribe()
  delete process.env.MAKO_WATCHER_CANARY_TEST
  console.log(`watch backend canary: silence detected in ${detected} ms at a 1.2 s beat and a 20 s window`)

  // A degraded fseventsd, simulated: every beat heard 1.2 s late, short of the
  // 5 s that makes watches poll. The host's read of the daemon says so once
  // 18 beats are in; the restart, through a stand-in for the privileged step (nothing
  // here touches the real daemon), starts the watcher child over, so every watch
  // hears dropped and rescans; delivery is measured again, and a read of history
  // from before the restart says every root is lost.
  process.env.MAKO_WATCHER_CANARY_TEST = JSON.stringify({ everyMs: 1_500, lagMs: 1_200 })
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "mako-watch-restart-")))
  const daemon = { pid: 338, residentBytes: 9 * 1024 ** 2 }
  const healthReadings = new WatchReadings()
  const healthBackend = childBackend(undefined, healthReadings)
  let healthHistory: FileHistory | undefined
  const service = new FileEventsServiceWatch({
    mac: true,
    readDaemon: async () => ({ ...daemon }),
    privileged: async () => {
      const made = mkdtempSync(join(scratch, "root-made."))
      writeFileSync(join(made, "sample.txt"), "    2 Thread_11: com.apple.fseventsd.client.645\n")
      daemon.pid = 19_513
      return { kind: "done", stdout: made }
    },
    probe: () => probeDelivery(),
    recover: () => {
      healthBackend.recover()
      healthHistory?.recover?.()
    },
    activity: () => ({ ...healthReadings.totals(), turnsRunning: 0 }),
    emit: () => {},
    log: () => {},
    evidenceRoot: join(scratch, "crashes"),
    evidenceTemporary: join(scratch, "root-made."),
    history: () => healthHistory,
    uid: process.getuid?.() ?? 0,
  })
  healthReadings.follow(service)
  healthHistory = process.platform === "darwin" ? childHistory(undefined, healthReadings, service) : undefined
  await service.tick()
  const d = recorder()
  const degrading = await healthBackend(kept, [], d.listener)
  const degradingAt = Date.now()
  await until("a canary 1.2 s late reads fseventsd degraded", () => service.snapshot().state === "degraded", 90_000)
  const degradedIn = Date.now() - degradingAt
  assert.ok((service.snapshot().lagMs ?? 0) >= 1_200, `the median beat is as late as it's heard (${service.snapshot().lagMs} ms)`)
  assert.deepEqual(d.mutes, [], "degraded is said, not polled around")
  const before = healthHistory ? await healthHistory.mark() : undefined
  process.env.MAKO_WATCHER_CANARY_TEST = JSON.stringify({ everyMs: 1_500 })
  const restarted = await service.restart()
  assert.equal(restarted.restart?.outcome, "restarted")
  // Measured again, not the late beats carried over: well under the lag it restarted from, whatever the runner's pace.
  assert.ok((restarted.restart?.after?.lagMs ?? Infinity) < (restarted.restart?.before.lagMs ?? 0) / 2, `delivery measured again after: ${restarted.restart?.after?.lagMs} ms, from ${restarted.restart?.before.lagMs} ms`)
  assert.ok((restarted.restart?.before.lagMs ?? 0) >= 1_200)
  assert.equal(restarted.state, "healthy", "and the notice goes")
  await until("every watch hears its events may have been dropped, and rescans", () => d.dropped() === 1, 30_000)
  assert.equal(healthReadings.reading().starts.recovery, 1, "the watcher child started over once")
  await drained(kept, d)
  if (healthHistory && before) {
    const across = await healthHistory.since(before, [kept])
    assert.deepEqual(across.lost, [kept], "a read from before the restart is reported lost, not returned as if complete")
    const after = await healthHistory.mark()
    writeFileSync(join(kept, "after-restart.ts"), "")
    assert.deepEqual((await healthHistory.since(after, [kept])).lost, [], "one from after it reads as usual")
  }
  await degrading.unsubscribe()
  delete process.env.MAKO_WATCHER_CANARY_TEST
  rmSync(scratch, { recursive: true, force: true })
  console.log(`watch backend fseventsd: a canary 1.2 s late read degraded in ${degradedIn} ms at a 1.5 s beat; the restart rescanned every watch and measured ${restarted.restart?.after?.lagMs} ms after`)

  // Only something else holding this process open lets an unref'd timer fire.
  setTimeout(() => {
    console.error("the watcher child still holds the process open with no watch left")
    process.exit(1)
  }, 5000).unref()
  console.log("watch backend: one child for every watch, ignores applied there, a killed child comes back with dropped events, a vanished root is given up, unsubscribe is final, a missing root is refused, a child that keeps dying is given up, and nothing holds the process open after")
} finally {
  rmSync(root, { recursive: true, force: true })
}
