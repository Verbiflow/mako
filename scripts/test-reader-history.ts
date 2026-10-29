import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { keepHostLog, openHostLog } from "@mako/host/base/host-log"
import { connectOnDemandCatalog, type ReaderExit } from "@mako/host/threads/catalog-connection"
import { READER_EVENTS_KEPT, ReaderHistory } from "@mako/host/threads/reader-history"

/**
 * The host records each time the reader serving its session list is adopted, lost or exits, with the reason it
 * knows, bounded in memory and written to host.log; and a reader it started that dies (a SIGKILL, an out-of-memory
 * abort, which the reader can't log itself) is logged by the host with its code or signal. A reader once restarted
 * every 20 to 60 s for an hour and nothing said why.
 */

const dir = await mkdtemp(join(tmpdir(), "mako-reader-history-"))
const log = openHostLog(join(dir, "host.log"))
const stopKeeping = keepHostLog(log)
try {
  let clock = Date.parse("2026-10-28T21:55:00.000Z")
  const history = new ReaderHistory(() => new Date(clock))
  history.note("adopted", "shared", { pid: 101 })
  clock += 30_000
  history.note("lost", "shared", { reason: "closed", pid: 101 })
  history.note("exited", "shared", { reason: "signal SIGKILL", pid: 101 })
  const snapshot = history.snapshot("")
  assert.equal(snapshot.lost, 1, "only losses are counted")
  assert.equal(snapshot.since, "2026-10-28T21:55:00.000Z")
  assert.deepEqual(snapshot.events.map(({ event, reason }) => `${event} ${reason ?? ""}`.trim()), ["exited signal SIGKILL", "lost closed", "adopted"], "newest first, with the reason the host knew")
  assert.equal(snapshot.events[1]?.at, "2026-10-28T21:55:30.000Z")

  for (let index = 0; index < READER_EVENTS_KEPT + 20; index += 1) history.note("lost", "worker", { reason: `exit ${index}` })
  const bounded = history.snapshot("/x/syncd.log")
  assert.equal(bounded.lost, READER_EVENTS_KEPT + 21, "every loss is counted")
  assert.equal(bounded.events.length, READER_EVENTS_KEPT, "but only the newest events are kept")
  assert.equal(bounded.events[0]?.reason, `exit ${READER_EVENTS_KEPT + 19}`)
  assert.equal(bounded.logPath, "/x/syncd.log")

  // A reader this host started that dies is logged with how it died, whenever that is.
  const script = join(dir, "reader.mjs")
  await writeFile(script, "process.exit(3)\n")
  const exits: ReaderExit[] = []
  await assert.rejects(
    connectOnDemandCatalog(AbortSignal.timeout(15_000), { script, identity: "a".repeat(64), onExit: (exit) => exits.push(exit) }),
    /The shared catalog reader exited with code 3/
  )
  assert.equal(exits.length, 1)
  assert.equal(exits[0]?.code, 3)
  assert.equal(exits[0]?.signal, null)

  await log.flush()
  const written = await readFile(log.path, "utf8")
  assert.match(written, /info  threads session reader adopted kind=shared pid=101\n/)
  assert.match(written, /warn  threads session reader lost kind=shared reason=closed pid=101 lost=1\n/)
  assert.match(written, /warn  threads session reader exited kind=shared reason="signal SIGKILL" pid=101 lost=1\n/)
  assert.match(written, /info  threads shared catalog reader started pid=\d+\n/)
  assert.match(written, /warn  threads shared catalog reader exited pid=\d+ code=3 signal=- livedMs=\d+\n/)
} finally {
  stopKeeping()
  await rm(dir, { recursive: true, force: true })
}
console.log("Reader history: each adoption, loss and exit kept with its reason and time, bounded, and logged; a reader the host started is logged when it dies")
